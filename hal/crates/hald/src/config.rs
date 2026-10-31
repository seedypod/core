//! `hal.toml` — every pin, address and limit lives here, never in a driver
//! (upstream garden-of-eden rule, kept).

use hal_core::PumpLimits;
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct Config {
    pub unit_id: Option<String>,
    pub model: Option<String>,
    pub mqtt_url: Option<String>,
    pub http_bind: String,
    pub telemetry_interval_s: u64,
    pub pins: Pins,
    pub i2c: I2c,
    pub limits: Limits,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct Pins {
    pub light_pwm: u8,
    pub light_hz: u32,
    pub pump_pwm: u8,
    pub pump_hz: u32,
    pub distance_trigger: u8,
    pub distance_echo: u8,
    pub button: u8,
    pub over_temp_alert: u8,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct I2c {
    pub bus: u8,
    pub pct2075: u16,
    pub ina219: u16,
    pub dht20: u16,
    pub am2320: u16,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct Limits {
    pub pump_max_run_s: u64,
    pub pump_max_duty: f64,
    pub water_low_cm: Option<f64>,
    pub over_temp_c: Option<f64>,
    pub distance_samples: usize,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            unit_id: None,
            model: None,
            mqtt_url: None,
            http_bind: "0.0.0.0:3001".into(),
            telemetry_interval_s: 10,
            pins: Pins::default(),
            i2c: I2c::default(),
            limits: Limits::default(),
        }
    }
}

impl Default for Pins {
    fn default() -> Self {
        // BCM numbering, from iot-root/garden-of-eden config.py.
        Self {
            light_pwm: 18,
            light_hz: 8000,
            pump_pwm: 24,
            pump_hz: 50,
            distance_trigger: 26,
            distance_echo: 19,
            button: 13,
            over_temp_alert: 25,
        }
    }
}

impl Default for I2c {
    fn default() -> Self {
        Self {
            bus: 1,
            pct2075: 0x48,
            ina219: 0x40,
            dht20: 0x38,
            am2320: 0x5C,
        }
    }
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            pump_max_run_s: 900,
            pump_max_duty: 30.0,
            water_low_cm: Some(16.0),
            over_temp_c: Some(36.0),
            distance_samples: 5,
        }
    }
}

impl From<&Limits> for PumpLimits {
    fn from(l: &Limits) -> Self {
        PumpLimits {
            max_run_s: l.pump_max_run_s,
            max_duty: l.pump_max_duty,
            water_low_cm: l.water_low_cm,
            over_temp_c: l.over_temp_c,
        }
    }
}

impl Config {
    pub fn load(path: Option<&std::path::Path>) -> anyhow::Result<Self> {
        match path {
            Some(p) => Ok(toml::from_str(&std::fs::read_to_string(p)?)?),
            None => Ok(Self::default()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_the_documented_pin_map() {
        let c = Config::default();
        assert_eq!((c.pins.light_pwm, c.pins.pump_pwm), (18, 24));
        assert_eq!((c.pins.distance_trigger, c.pins.distance_echo), (26, 19));
        assert_eq!(c.i2c.ina219, 0x40);
    }

    #[test]
    fn partial_toml_overrides_only_what_it_names() {
        let c: Config = toml::from_str("[limits]\npump_max_duty = 25\n").unwrap();
        assert_eq!(c.limits.pump_max_duty, 25.0);
        assert_eq!(c.limits.pump_max_run_s, 900);
        assert_eq!(c.pins.light_pwm, 18);
    }
}
