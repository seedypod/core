//! Registry builder: turns the `[[sensor]]` / `[[actuator]]` / `[[camera]]`
//! tables into live devices. `--sim` instantiates `hal-sim` fakes for the
//! same list, so a config can be exercised on a laptop before it reaches the
//! unit; real drivers need the `hardware` feature.

use std::collections::BTreeMap;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};

use hal_core::registry::Registry;
use hal_core::{ActuatorId, BinarySensor, ButtonPress, SensorId};
#[cfg(feature = "hardware")]
use tracing::{info, warn};

use crate::config::{Config, SensorEntry};
use crate::http::SharedCamera;

pub struct Built {
    pub registry: Registry,
    pub cameras: BTreeMap<String, SharedCamera>,
    pub over_temp: Option<Box<dyn BinarySensor>>,
    pub button: Option<Receiver<ButtonPress>>,
    /// Simulated world (so the daemon loop can step its physics).
    pub world: Option<hal_sim::Shared>,
    /// Model inferred from which air sensor answered.
    pub detected_model: Option<String>,
    /// Set to stop driver threads (button poller) on shutdown.
    pub stop: Arc<AtomicBool>,
    /// Builds drivers for sensors added at runtime (same bus / world as above).
    pub factory: Box<dyn crate::kinds::SensorFactory>,
    /// Each configured sensor entry and why it failed, if it did.
    pub status: Vec<(SensorEntry, Option<String>)>,
}

/// Which contract sensor ids a kind provides (used by the simulator and by
/// `--check` to describe the resulting capability set).
pub fn sensor_ids_for(kind: &str) -> Vec<SensorId> {
    match kind {
        "pct2075" => vec![SensorId::PcbTemp],
        "ina219" => vec![SensorId::PumpV, SensorId::PumpA, SensorId::PumpW],
        "dht20" | "am2320" => vec![SensorId::Humidity, SensorId::AirTemp],
        "dyp_a01" => vec![SensorId::WaterDistance, SensorId::WaterLevelPct],
        "ezo_ph" => vec![SensorId::Ph],
        "ezo_ec" => vec![SensorId::Ec],
        "ezo_rtd" => vec![SensorId::WaterTemp],
        _ => vec![],
    }
}

/// The capability set a config yields (before probing), for `--check`.
pub fn planned_capabilities(cfg: &Config) -> (Vec<SensorId>, Vec<ActuatorId>) {
    let mut sensors: Vec<SensorId> = Vec::new();
    for s in cfg.sensors() {
        for id in sensor_ids_for(&s.kind) {
            if !sensors.contains(&id) {
                sensors.push(id);
            }
        }
    }
    let actuators = cfg
        .actuators()
        .iter()
        .filter_map(|a| crate::config::parse_actuator_id(&a.id))
        .collect();
    (sensors, actuators)
}

pub fn build_sim(cfg: &Config) -> Built {
    let world = hal_sim::world();
    let mut registry = Registry::default();
    let (sensors, actuators) = planned_capabilities(cfg);
    for id in sensors {
        registry.add_sensor(Box::new(hal_sim::SimSensor::new(id, world.clone())));
    }
    for id in actuators {
        registry.add_actuator(Box::new(hal_sim::SimActuator::new(id, world.clone())));
    }
    let cameras = cfg
        .camera
        .iter()
        .map(|c| {
            let cam: SharedCamera = Arc::new(Mutex::new(Box::new(hal_sim::SimCamera::new(&c.name))));
            (c.name.clone(), cam)
        })
        .collect();
    Built {
        registry,
        cameras,
        over_temp: None,
        button: None,
        world: Some(world.clone()),
        detected_model: Some("gardyn 3.0 (sim)".into()),
        stop: Arc::new(AtomicBool::new(false)),
        factory: Box::new(crate::kinds::SimFactory(world)),
        status: cfg.sensors().into_iter().map(|s| (s, None)).collect(),
    }
}

#[cfg(not(feature = "hardware"))]
pub fn build_hardware(_cfg: &Config) -> anyhow::Result<Built> {
    anyhow::bail!("this hald was built without the `hardware` feature; run with --sim or rebuild with --features hardware")
}

#[cfg(feature = "hardware")]
pub fn build_hardware(cfg: &Config) -> anyhow::Result<Built> {
    use std::time::Duration;

    use hal_core::derived::{LevelPctSensor, MedianSensor};
    use hal_core::device::split_multi;
    use hal_drivers::bus::{StdClock, StdDelay};
    use hal_drivers::hw::{HwPwm, RppalI2c, RppalIn, RppalOut, SoftPwm};

    let mut registry = Registry::default();
    let mut over_temp: Option<Box<dyn BinarySensor>> = None;
    let mut detected_model = None;
    let mut i2c: Option<RppalI2c> = None;
    let bus = |i2c: &mut Option<RppalI2c>| -> anyhow::Result<RppalI2c> {
        if i2c.is_none() {
            *i2c = Some(
                RppalI2c::open(cfg.i2c.bus).map_err(|e| anyhow::anyhow!("open i2c-{}: {e}", cfg.i2c.bus))?,
            );
        }
        Ok(i2c.clone().expect("just opened"))
    };
    let cache = Duration::from_millis(500);
    let tank = (&cfg.tank).into();
    let mut status = Vec::new();

    for s in cfg.sensors() {
        let kind = s.kind.as_str();
        let outcome: anyhow::Result<()> = (|| {
            match kind {
                "pct2075" => {
                    let mut d = hal_drivers::pct2075::Pct2075::new(bus(&mut i2c)?, addr(&s)?);
                    probe_sensor(&mut d, &s)?;
                    registry.add_sensor(Box::new(d));
                }
                "ina219" => {
                    let c = hal_drivers::ina219::Ina219Config {
                        addr: addr(&s)?,
                        shunt_ohms: cfg.i2c.ina219_shunt_ohms,
                        max_expected_amps: cfg.i2c.ina219_max_amps,
                    };
                    let mut d = hal_drivers::ina219::Ina219::new(bus(&mut i2c)?, c);
                    probe_multi(&mut d, &s)?;
                    for f in split_multi(Box::new(d), cache) {
                        registry.add_sensor(f);
                    }
                }
                "dht20" => {
                    let mut d = hal_drivers::dht20::Dht20::new(bus(&mut i2c)?, StdDelay, addr(&s)?);
                    probe_multi(&mut d, &s)?;
                    detected_model.get_or_insert_with(|| "gardyn 3.0".to_owned());
                    for f in split_multi(Box::new(d), cache) {
                        registry.add_sensor(f);
                    }
                }
                "am2320" => {
                    let mut d = hal_drivers::am2320::Am2320::new(bus(&mut i2c)?, StdDelay, addr(&s)?);
                    probe_multi(&mut d, &s)?;
                    detected_model.get_or_insert_with(|| "gardyn 1.0/2.0".to_owned());
                    for f in split_multi(Box::new(d), cache) {
                        registry.add_sensor(f);
                    }
                }
                "dyp_a01" => {
                    let (trig, echo) = (
                        s.trigger.ok_or_else(|| anyhow::anyhow!("trigger required"))?,
                        s.echo.ok_or_else(|| anyhow::anyhow!("echo required"))?,
                    );
                    let d = hal_drivers::dyp_a01::DypA01::new(
                        RppalOut::open(trig).map_err(|e| anyhow::anyhow!("GPIO{trig}: {e}"))?,
                        RppalIn::open(echo, false).map_err(|e| anyhow::anyhow!("GPIO{echo}: {e}"))?,
                        StdClock,
                        StdDelay,
                        hal_drivers::dyp_a01::DypConfig {
                            timeout: Duration::from_millis(cfg.limits.distance_timeout_ms),
                            ..Default::default()
                        },
                    );
                    let mut m = MedianSensor::new(Box::new(d), cfg.limits.distance_samples);
                    probe_sensor(&mut m, &s)?;
                    let level = LevelPctSensor::new(m.shared(), tank);
                    registry.add_sensor(Box::new(m));
                    registry.add_sensor(Box::new(level));
                }
                "over_temp_alert" => {
                    let pin = s.pin.ok_or_else(|| anyhow::anyhow!("pin required"))?;
                    let input = RppalIn::open(pin, false).map_err(|e| anyhow::anyhow!("GPIO{pin}: {e}"))?;
                    let mut b = hal_drivers::gpio_binary::OverTempAlert::new(
                        "over_temp",
                        input,
                        s.active_low.unwrap_or(false),
                    );
                    b.probe().map_err(|e| anyhow::anyhow!("{e}"))?;
                    over_temp = Some(Box::new(b));
                }
                k if crate::kinds::find(k).is_some() => {
                    let spec = crate::kinds::find(k).expect("matched above");
                    for d in spec.build_hw(bus(&mut i2c)?, addr(&s)?)? {
                        registry.add_sensor(d);
                    }
                }
                other => anyhow::bail!("unknown sensor kind {other:?}"),
            }
            Ok(())
        })();
        match &outcome {
            Ok(()) => info!(kind, addr = ?s.addr, pin = ?s.pin, "sensor ready"),
            Err(e) if s.optional => info!(kind, %e, "optional sensor absent; skipping"),
            Err(e) => warn!(kind, %e, "sensor unavailable; continuing without it"),
        }
        status.push((s.clone(), outcome.err().map(|e| e.to_string())));
    }

    let stop = Arc::new(AtomicBool::new(false));
    let button = match RppalIn::open(cfg.pins.button, true) {
        Ok(pin) => {
            let (tx, rx) = std::sync::mpsc::channel();
            let poller = hal_drivers::button::ButtonPoller::new(
                pin,
                StdClock,
                StdDelay,
                hal_drivers::button::ButtonConfig {
                    debounce: Duration::from_millis(cfg.button.debounce_ms),
                    double_window: Duration::from_millis(cfg.button.double_window_ms),
                    long_press: Duration::from_millis(cfg.button.long_press_ms),
                    setup_hold: Duration::from_millis(cfg.button.setup_hold_ms),
                    active_low: cfg.button.active_low,
                },
                Duration::from_millis(5),
            );
            let stop2 = stop.clone();
            std::thread::Builder::new()
                .name("button".into())
                .spawn(move || poller.run(tx, stop2))
                .map_err(|e| anyhow::anyhow!("button thread: {e}"))?;
            Some(rx)
        }
        Err(e) => {
            warn!(pin = cfg.pins.button, %e, "button unavailable");
            None
        }
    };

    for a in cfg.actuators() {
        let Some(id) = crate::config::parse_actuator_id(&a.id) else {
            warn!(id = %a.id, "unknown actuator id; skipping");
            continue;
        };
        let pin = a.pin.unwrap_or(0);
        let outcome: anyhow::Result<()> = (|| {
            match a.kind.as_str() {
                "pwm_light" => {
                    let out = HwPwm::open(
                        a.channel.unwrap_or(cfg.pins.light_pwm_channel),
                        a.hz.unwrap_or(cfg.pins.light_hz) as f64,
                    )
                    .map_err(|e| anyhow::anyhow!("hardware PWM (is dtoverlay=pwm enabled?): {e}"))?;
                    let mut d = hal_drivers::pwm::PwmLight::new(id, out);
                    hal_core::Actuator::probe(&mut d).map_err(|e| anyhow::anyhow!("{e}"))?;
                    registry.add_actuator(Box::new(d));
                }
                "pwm_pump" => {
                    let out = SoftPwm::open(pin, a.hz.unwrap_or(cfg.pins.pump_hz) as f64)
                        .map_err(|e| anyhow::anyhow!("GPIO{pin}: {e}"))?;
                    let mut d = hal_drivers::pwm::PwmPump::new(id, out);
                    hal_core::Actuator::probe(&mut d).map_err(|e| anyhow::anyhow!("{e}"))?;
                    registry.add_actuator(Box::new(d));
                }
                "dosing" => {
                    let out = RppalOut::open(pin).map_err(|e| anyhow::anyhow!("GPIO{pin}: {e}"))?;
                    let mut d = hal_drivers::dosing::DosingPump::new(id, out, a.active_low.unwrap_or(false));
                    hal_core::Actuator::probe(&mut d).map_err(|e| anyhow::anyhow!("{e}"))?;
                    registry.add_actuator(Box::new(d));
                }
                other => anyhow::bail!("unknown actuator kind {other:?}"),
            }
            Ok(())
        })();
        match outcome {
            Ok(()) => info!(id = %a.id, kind = %a.kind, pin, "actuator ready"),
            Err(e) => warn!(id = %a.id, kind = %a.kind, %e, "actuator unavailable; commands will be ignored"),
        }
    }

    let scratch = std::env::temp_dir();
    let cameras = cfg
        .camera
        .iter()
        .map(|c| {
            let mut ucfg = hal_drivers::uvc::UvcConfig::new(c.device.clone());
            ucfg.resolution = c.resolution.clone();
            ucfg.skip_frames = c.skip_frames;
            let cam: SharedCamera = Arc::new(Mutex::new(Box::new(hal_drivers::uvc::UvcCamera::new(
                &c.name,
                ucfg,
                hal_drivers::uvc::ProcessRunner,
                scratch.clone(),
            ))));
            (c.name.clone(), cam)
        })
        .collect();

    Ok(Built {
        registry,
        cameras,
        over_temp,
        button,
        world: None,
        detected_model,
        stop,
        factory: Box::new(crate::kinds::HwFactory {
            bus: cfg.i2c.bus,
            i2c,
        }),
        status,
    })
}

#[cfg(feature = "hardware")]
fn addr(s: &SensorEntry) -> anyhow::Result<u16> {
    s.addr.ok_or_else(|| anyhow::anyhow!("addr required"))
}

#[cfg(feature = "hardware")]
fn probe_sensor<S: hal_core::Sensor>(d: &mut S, s: &SensorEntry) -> anyhow::Result<()> {
    d.probe()
        .map_err(|e| anyhow::anyhow!("probe {} at {:?}: {e}", s.kind, s.addr.or(s.pin.map(u16::from))))
}

#[cfg(feature = "hardware")]
fn probe_multi<S: hal_core::MultiSensor>(d: &mut S, s: &SensorEntry) -> anyhow::Result<()> {
    d.probe()
        .map_err(|e| anyhow::anyhow!("probe {} at {:?}: {e}", s.kind, s.addr))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stock_config_plans_the_documented_capability_set() {
        let (s, a) = planned_capabilities(&Config::default());
        assert_eq!(
            s,
            vec![
                SensorId::PcbTemp,
                SensorId::PumpV,
                SensorId::PumpA,
                SensorId::PumpW,
                SensorId::Humidity,
                SensorId::AirTemp,
                SensorId::WaterDistance,
                SensorId::WaterLevelPct,
            ]
        );
        assert_eq!(a, vec![ActuatorId::Light, ActuatorId::Pump]);
        assert!(sensor_ids_for("nope").is_empty());
        assert_eq!(sensor_ids_for("ezo_rtd"), vec![SensorId::WaterTemp]);
    }

    #[test]
    fn sim_build_mirrors_the_config() {
        let cfg: Config = toml::from_str(
            r#"
[[sensor]]
kind = "ezo_ph"
addr = 0x63
[[sensor]]
kind = "dyp_a01"
trigger = 26
echo = 19
[[actuator]]
id = "dose_1"
kind = "dosing"
pin = 5
[[camera]]
name = "upper"
device = "/dev/video0"
"#,
        )
        .unwrap();
        let b = build_sim(&cfg);
        assert_eq!(
            b.registry.sensor_ids(),
            vec![SensorId::Ph, SensorId::WaterDistance, SensorId::WaterLevelPct]
        );
        assert_eq!(b.registry.actuator_ids(), vec![ActuatorId::Dose1]);
        assert_eq!(b.cameras.keys().cloned().collect::<Vec<_>>(), vec!["upper"]);
        assert!(b.world.is_some());
        assert!(b.over_temp.is_none() && b.button.is_none());
        assert_eq!(b.detected_model.as_deref(), Some("gardyn 3.0 (sim)"));
    }

    #[cfg(not(feature = "hardware"))]
    #[test]
    fn hardware_build_is_refused_without_the_feature() {
        let err = match build_hardware(&Config::default()) {
            Ok(_) => panic!("built without the feature"),
            Err(e) => e.to_string(),
        };
        assert!(err.contains("hardware"));
    }

    #[cfg(feature = "hardware")]
    #[test]
    fn hardware_build_off_a_pi_degrades_instead_of_crashing() {
        if std::path::Path::new("/dev/gpiomem").exists() {
            return;
        }
        // No I²C bus, no GPIO: every device is skipped with a warning, the
        // registry is empty, and cameras are still listed (they fail lazily).
        let b = build_hardware(&Config::default()).unwrap();
        assert!(b.registry.sensor_ids().is_empty());
        assert!(b.registry.actuator_ids().is_empty());
        assert_eq!(b.cameras.len(), 2);
        assert!(b.button.is_none());
        assert!(b.detected_model.is_none());
    }
}
