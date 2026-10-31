//! `hald` — the one process that owns the Gardyn's hardware.
//!
//! Phase 0 scope: boots the registry (simulated with `--sim`), runs the pump
//! guard loop, and prints telemetry as JSON lines. MQTT (rumqttc), the HTTP
//! still server (axum) and real drivers (rppal) arrive in Phase 2.5–2.7 behind
//! the `hardware` feature; the contract and safety code they plug into is
//! already here and tested.

mod config;
mod identity;

use std::path::PathBuf;
use std::time::{Duration, Instant};

use clap::Parser;
use hal_core::device::now_rfc3339;
use hal_core::registry::Registry;
use hal_core::safety::{median, Decision, Env};
use hal_core::{
    ActuatorCommand, ActuatorId, Caps, Limits, PumpGuard, SensorId, SystemInfo, CONTRACT_VERSION,
};
use tracing::{info, warn};

#[derive(Parser, Debug)]
#[command(name = "hald", version, about = "leafypod hardware daemon")]
struct Cli {
    /// Path to hal.toml (defaults are the documented Gardyn pin map).
    #[arg(short, long, env = "HAL_CONFIG")]
    config: Option<PathBuf>,
    /// Run against simulated hardware (no GPIO/I²C needed).
    #[arg(long, env = "HAL_SIM")]
    sim: bool,
    /// Validate the config and exit.
    #[arg(long)]
    check: bool,
    /// Simulated seconds per real second (sim only).
    #[arg(long, default_value_t = 1.0)]
    time_scale: f64,
    /// Exit after this many telemetry ticks (for smoke tests).
    #[arg(long)]
    ticks: Option<u64>,
}

fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env().add_directive("info".parse()?))
        .init();
    let cli = Cli::parse();
    let cfg = config::Config::load(cli.config.as_deref())?;
    if cli.check {
        println!(
            "{}",
            serde_json::to_string_pretty(
                &serde_json::json!({ "ok": true, "unit_id": identity::unit_id(cfg.unit_id.as_deref()), "limits": { "pump_max_run_s": cfg.limits.pump_max_run_s, "pump_max_duty": cfg.limits.pump_max_duty } })
            )?
        );
        return Ok(());
    }

    let unit_id = identity::unit_id(cfg.unit_id.as_deref());
    let mut registry = Registry::default();
    let world = if cli.sim {
        let w = hal_sim::world();
        for id in [
            SensorId::AirTemp,
            SensorId::Humidity,
            SensorId::PcbTemp,
            SensorId::WaterDistance,
            SensorId::WaterLevelPct,
            SensorId::PumpV,
            SensorId::PumpA,
            SensorId::PumpW,
        ] {
            registry.add_sensor(Box::new(hal_sim::SimSensor::new(id, w.clone())));
        }
        registry.add_actuator(Box::new(hal_sim::SimActuator::new(ActuatorId::Light, w.clone())));
        registry.add_actuator(Box::new(hal_sim::SimActuator::new(ActuatorId::Pump, w.clone())));
        Some(w)
    } else {
        anyhow::bail!("real drivers are not built yet (Phase 2.5); run with --sim");
    };

    let system = SystemInfo {
        contract: CONTRACT_VERSION,
        unit_id: unit_id.clone(),
        model: cfg.model.clone().unwrap_or_else(|| {
            if cli.sim {
                "gardyn 3.0 (sim)".into()
            } else {
                "gardyn".into()
            }
        }),
        hal_version: env!("CARGO_PKG_VERSION").into(),
        caps: Caps {
            sensors: registry.sensor_ids(),
            actuators: registry.actuator_ids(),
            cameras: vec!["upper".into(), "lower".into()],
        },
        limits: Limits {
            pump_max_run_s: cfg.limits.pump_max_run_s,
            pump_max_duty: cfg.limits.pump_max_duty,
            water_low_cm: cfg.limits.water_low_cm,
        },
    };
    info!(unit = %unit_id, model = %system.model, "hald starting");
    println!(
        "{}",
        serde_json::to_string(
            &serde_json::json!({ "topic": hal_core::topics::system(&unit_id), "payload": system })
        )?
    );

    let mut guard = PumpGuard::new((&cfg.limits).into());
    // Phase 0 demo: start one bounded pump run so the guard loop has work.
    let start = Instant::now();
    let env0 = read_env(&mut registry, cfg.limits.distance_samples);
    match guard.request(
        &ActuatorCommand {
            on: Some(true),
            level: Some(100.0),
            duration_s: Some(20),
        },
        env0,
        start,
    ) {
        Ok(Decision::Run { level, deadline_in }) => {
            info!(level, secs = deadline_in.as_secs(), "pump run accepted (clamped)");
            if let Some(p) = registry.actuator_mut(ActuatorId::Pump) {
                p.set_level(level)?;
            }
        }
        Ok(Decision::Stop) => {}
        Err(e) => warn!(%e, "pump run refused"),
    }

    let interval = Duration::from_secs(cfg.telemetry_interval_s.max(1));
    let mut ticks = 0u64;
    loop {
        if let Some(w) = &world {
            w.lock().unwrap().step(interval.as_secs_f64() * cli.time_scale);
        }
        let now = Instant::now();
        let env = read_env(&mut registry, cfg.limits.distance_samples);
        if let Some(Decision::Stop) = guard.tick(env, now) {
            if let Some(p) = registry.actuator_mut(ActuatorId::Pump) {
                p.set_level(0.0)?;
            }
            match guard.fault() {
                Some(f) => warn!(fault = f, "pump stopped by guard; latched until acknowledged"),
                None => info!("pump run complete"),
            }
        }
        for s in registry.sensors_mut() {
            match s.read() {
                Ok(r) => println!(
                    "{}",
                    serde_json::to_string(
                        &serde_json::json!({ "topic": hal_core::topics::sensor(&unit_id, s.id()), "payload": r })
                    )?
                ),
                Err(e) => {
                    warn!(sensor = ?s.id(), %e, "read failed; reprobing");
                    let _ = s.probe();
                }
            }
        }
        let pump_state = hal_core::ActuatorState {
            on: guard.is_running(now),
            level: guard.level(),
            since: now_rfc3339(),
            fault: guard.fault().map(str::to_owned),
            remaining_s: guard.remaining(now),
        };
        println!(
            "{}",
            serde_json::to_string(
                &serde_json::json!({ "topic": hal_core::topics::actuator_state(&unit_id, ActuatorId::Pump), "payload": pump_state })
            )?
        );

        ticks += 1;
        if cli.ticks.is_some_and(|n| ticks >= n) {
            break;
        }
        std::thread::sleep(if cli.sim {
            Duration::from_millis(200)
        } else {
            interval
        });
    }
    Ok(())
}

/// Gather what the guard needs: median distance over N samples, PCB temp.
fn read_env(registry: &mut Registry, samples: usize) -> Env {
    let mut dist = Vec::with_capacity(samples);
    if let Some(s) = registry.sensor_mut(SensorId::WaterDistance) {
        for _ in 0..samples.max(1) {
            if let Ok(r) = s.read() {
                dist.push(r.value);
            }
        }
    }
    let pcb = registry
        .sensor_mut(SensorId::PcbTemp)
        .and_then(|s| s.read().ok())
        .map(|r| r.value);
    Env {
        water_distance_cm: median(&mut dist),
        pcb_temp_c: pcb,
    }
}
