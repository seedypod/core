//! `hal.toml` — every pin, address and limit lives here, never in a driver
//! (upstream garden-of-eden rule, kept).
//!
//! Two layers: the classic `[pins]` / `[i2c]` / `[limits]` tables hold the
//! documented Gardyn defaults, and optional `[[sensor]]` / `[[actuator]]`
//! tables override the device list entirely (kind + addr/pin + params).
//! When no `[[sensor]]` / `[[actuator]]` table is present the device list is
//! derived from the defaults, so a stock unit needs an empty config.

use std::path::PathBuf;

use hal_core::{DoseLimits, PumpLimits};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    /// Override the unit id (default: derived from the Pi serial).
    pub unit_id: Option<String>,
    /// Override the model string (default: detected from the I²C fingerprint).
    pub model: Option<String>,
    /// `mqtt://host:port`; also `--mqtt-url` / `HAL_MQTT_URL`.
    pub mqtt_url: Option<String>,
    pub mqtt_username: Option<String>,
    pub mqtt_password: Option<String>,
    pub http_bind: String,
    pub telemetry_interval_s: u64,
    /// Where `state.json` (last light level, dose ledgers) is kept.
    pub state_dir: PathBuf,
    pub pins: Pins,
    pub i2c: I2c,
    pub limits: Limits,
    pub tank: Tank,
    pub button: Button,
    pub dosing: Dosing,
    pub ha: HomeAssistant,
    pub mdns: bool,
    pub camera: Vec<CameraEntry>,
    pub sensor: Vec<SensorEntry>,
    pub actuator: Vec<ActuatorEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Pins {
    pub light_pwm: u8,
    /// Hardware PWM channel for the light (0 on Pi ≤ 4, 2 on Pi 5 for GPIO18).
    pub light_pwm_channel: u8,
    pub light_hz: u32,
    pub pump_pwm: u8,
    pub pump_hz: u32,
    pub distance_trigger: u8,
    pub distance_echo: u8,
    pub button: u8,
    pub over_temp_alert: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct I2c {
    pub bus: u8,
    pub pct2075: u16,
    pub ina219: u16,
    pub dht20: u16,
    pub am2320: u16,
    pub ezo_ph: u16,
    pub ezo_ec: u16,
    pub ezo_rtd: u16,
    /// INA219 shunt resistor (Ω) and the largest current to resolve (A).
    pub ina219_shunt_ohms: f64,
    pub ina219_max_amps: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Limits {
    pub pump_max_run_s: u64,
    pub pump_max_duty: f64,
    pub water_low_cm: Option<f64>,
    pub over_temp_c: Option<f64>,
    pub distance_samples: usize,
    pub distance_timeout_ms: u64,
}

/// Distance from the ranger to the surface when full / empty (cm).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Tank {
    pub full_cm: f64,
    pub empty_cm: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Button {
    pub debounce_ms: u64,
    pub double_window_ms: u64,
    pub long_press_ms: u64,
    pub active_low: bool,
    /// Bounded pump run started by a double press (clamped by the guard).
    pub pump_run_s: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Dosing {
    pub enabled: bool,
    pub ml_per_s: f64,
    pub default_dose_ml: f64,
    pub max_single_ml: f64,
    pub max_daily_ml: f64,
    pub max_doses_per_day: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct HomeAssistant {
    pub discovery: bool,
    pub prefix: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CameraEntry {
    pub name: String,
    pub device: PathBuf,
    #[serde(default = "default_resolution")]
    pub resolution: String,
    #[serde(default = "default_skip")]
    pub skip_frames: u32,
}

fn default_resolution() -> String {
    "1280x720".into()
}
fn default_skip() -> u32 {
    15
}

/// Known sensor kinds (`hald --check` rejects anything else).
pub const SENSOR_KINDS: &[&str] = &[
    "pct2075",
    "ina219",
    "dht20",
    "am2320",
    "dyp_a01",
    "over_temp_alert",
    "ezo_ph",
    "ezo_ec",
    "ezo_rtd",
];
pub const ACTUATOR_KINDS: &[&str] = &["pwm_light", "pwm_pump", "dosing"];
const I2C_KINDS: &[&str] = &[
    "pct2075", "ina219", "dht20", "am2320", "ezo_ph", "ezo_ec", "ezo_rtd",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SensorEntry {
    pub kind: String,
    /// I²C address for bus devices.
    pub addr: Option<u16>,
    /// GPIO (BCM) for `over_temp_alert`.
    pub pin: Option<u8>,
    /// `dyp_a01` trigger / echo GPIOs.
    pub trigger: Option<u8>,
    pub echo: Option<u8>,
    /// Keep going when the probe fails (model-dependent parts).
    #[serde(default)]
    pub optional: bool,
    #[serde(default)]
    pub active_low: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ActuatorEntry {
    /// `light`, `pump`, `dose_1`, `dose_2`, `dose_3`.
    pub id: String,
    pub kind: String,
    pub pin: Option<u8>,
    pub hz: Option<u32>,
    /// Hardware PWM channel (`pwm_light`).
    pub channel: Option<u8>,
    #[serde(default)]
    pub active_low: Option<bool>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            unit_id: None,
            model: None,
            mqtt_url: None,
            mqtt_username: None,
            mqtt_password: None,
            http_bind: "0.0.0.0:3001".into(),
            telemetry_interval_s: 10,
            state_dir: PathBuf::from("/var/lib/leafypod"),
            pins: Pins::default(),
            i2c: I2c::default(),
            limits: Limits::default(),
            tank: Tank::default(),
            button: Button::default(),
            dosing: Dosing::default(),
            ha: HomeAssistant::default(),
            mdns: true,
            camera: vec![
                CameraEntry {
                    name: "upper".into(),
                    device: "/dev/video0".into(),
                    resolution: default_resolution(),
                    skip_frames: default_skip(),
                },
                CameraEntry {
                    name: "lower".into(),
                    device: "/dev/video2".into(),
                    resolution: default_resolution(),
                    skip_frames: default_skip(),
                },
            ],
            sensor: Vec::new(),
            actuator: Vec::new(),
        }
    }
}

impl Default for Pins {
    fn default() -> Self {
        // BCM numbering, from iot-root/garden-of-eden config.py.
        Self {
            light_pwm: 18,
            light_pwm_channel: 0,
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
            ezo_ph: 0x63,
            ezo_ec: 0x64,
            ezo_rtd: 0x66,
            ina219_shunt_ohms: 0.1,
            ina219_max_amps: 3.2,
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
            distance_timeout_ms: 60,
        }
    }
}

impl Default for Tank {
    fn default() -> Self {
        Self {
            full_cm: 5.0,
            empty_cm: 20.0,
        }
    }
}

impl Default for Button {
    fn default() -> Self {
        Self {
            debounce_ms: 30,
            double_window_ms: 400,
            long_press_ms: 1000,
            active_low: true,
            pump_run_s: 300,
        }
    }
}

impl Default for Dosing {
    fn default() -> Self {
        let d = DoseLimits::default();
        Self {
            enabled: d.enabled,
            ml_per_s: d.ml_per_s,
            default_dose_ml: d.default_dose_ml,
            max_single_ml: d.max_single_ml,
            max_daily_ml: d.max_daily_ml,
            max_doses_per_day: d.max_doses_per_day,
        }
    }
}

impl Default for HomeAssistant {
    fn default() -> Self {
        Self {
            discovery: true,
            prefix: "homeassistant".into(),
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

impl From<&Dosing> for DoseLimits {
    fn from(d: &Dosing) -> Self {
        DoseLimits {
            enabled: d.enabled,
            ml_per_s: d.ml_per_s,
            default_dose_ml: d.default_dose_ml,
            max_single_ml: d.max_single_ml,
            max_daily_ml: d.max_daily_ml,
            max_doses_per_day: d.max_doses_per_day,
        }
    }
}

impl From<&Tank> for hal_core::derived::TankGeometry {
    fn from(t: &Tank) -> Self {
        Self {
            full_cm: t.full_cm,
            empty_cm: t.empty_cm,
        }
    }
}

fn i2c(kind: &str, addr: u16, optional: bool) -> SensorEntry {
    SensorEntry {
        kind: kind.into(),
        addr: Some(addr),
        pin: None,
        trigger: None,
        echo: None,
        optional,
        active_low: None,
    }
}

impl Config {
    pub fn load(path: Option<&std::path::Path>) -> anyhow::Result<Self> {
        match path {
            Some(p) => {
                let text = std::fs::read_to_string(p)
                    .map_err(|e| anyhow::anyhow!("reading {}: {e}", p.display()))?;
                let cfg: Self = toml::from_str(&text).map_err(|e| anyhow::anyhow!("{}: {e}", p.display()))?;
                Ok(cfg)
            }
            None => Ok(Self::default()),
        }
    }

    /// The sensor list: explicit `[[sensor]]` tables, else the stock Gardyn set.
    pub fn sensors(&self) -> Vec<SensorEntry> {
        if !self.sensor.is_empty() {
            return self.sensor.clone();
        }
        vec![
            i2c("pct2075", self.i2c.pct2075, false),
            i2c("ina219", self.i2c.ina219, false),
            // One of these answers depending on the Gardyn generation.
            i2c("dht20", self.i2c.dht20, true),
            i2c("am2320", self.i2c.am2320, true),
            SensorEntry {
                kind: "dyp_a01".into(),
                addr: None,
                pin: None,
                trigger: Some(self.pins.distance_trigger),
                echo: Some(self.pins.distance_echo),
                optional: false,
                active_low: None,
            },
            SensorEntry {
                kind: "over_temp_alert".into(),
                addr: None,
                pin: Some(self.pins.over_temp_alert),
                trigger: None,
                echo: None,
                optional: true,
                active_low: Some(false),
            },
        ]
    }

    /// The actuator list: explicit `[[actuator]]` tables, else light + pump.
    pub fn actuators(&self) -> Vec<ActuatorEntry> {
        if !self.actuator.is_empty() {
            return self.actuator.clone();
        }
        vec![
            ActuatorEntry {
                id: "light".into(),
                kind: "pwm_light".into(),
                pin: Some(self.pins.light_pwm),
                hz: Some(self.pins.light_hz),
                channel: Some(self.pins.light_pwm_channel),
                active_low: None,
            },
            ActuatorEntry {
                id: "pump".into(),
                kind: "pwm_pump".into(),
                pin: Some(self.pins.pump_pwm),
                hz: Some(self.pins.pump_hz),
                channel: None,
                active_low: None,
            },
        ]
    }

    /// Everything `hald --check` complains about, in one pass.
    pub fn validate(&self) -> Vec<String> {
        let mut errs = Vec::new();
        if self.telemetry_interval_s == 0 {
            errs.push("telemetry_interval_s must be ≥ 1".into());
        }
        if self.http_bind.parse::<std::net::SocketAddr>().is_err() {
            errs.push(format!("http_bind {:?} is not host:port", self.http_bind));
        }
        if let Some(u) = &self.mqtt_url {
            if !(u.starts_with("mqtt://") || u.starts_with("mqtts://")) {
                errs.push(format!("mqtt_url {u:?} must start with mqtt:// or mqtts://"));
            }
        }
        if !(0.0..=100.0).contains(&self.limits.pump_max_duty) {
            errs.push("limits.pump_max_duty must be 0–100".into());
        }
        if self.limits.pump_max_run_s == 0 {
            errs.push("limits.pump_max_run_s must be ≥ 1".into());
        }
        if self.limits.distance_samples == 0 {
            errs.push("limits.distance_samples must be ≥ 1".into());
        }
        if self.tank.full_cm >= self.tank.empty_cm {
            errs.push("tank.full_cm must be smaller than tank.empty_cm".into());
        }
        if self.dosing.ml_per_s <= 0.0 {
            errs.push("dosing.ml_per_s must be > 0".into());
        }
        let mut names = std::collections::BTreeSet::new();
        for c in &self.camera {
            if !names.insert(c.name.clone()) {
                errs.push(format!("camera {:?} listed twice", c.name));
            }
        }
        for (i, s) in self.sensors().iter().enumerate() {
            let k = s.kind.as_str();
            if !SENSOR_KINDS.contains(&k) {
                errs.push(format!("sensor[{i}]: unknown kind {k:?}"));
                continue;
            }
            if I2C_KINDS.contains(&k) && s.addr.is_none() {
                errs.push(format!("sensor[{i}] ({k}): addr required"));
            }
            if k == "dyp_a01" && (s.trigger.is_none() || s.echo.is_none()) {
                errs.push(format!("sensor[{i}] (dyp_a01): trigger and echo required"));
            }
            if k == "over_temp_alert" && s.pin.is_none() {
                errs.push(format!("sensor[{i}] (over_temp_alert): pin required"));
            }
        }
        let mut ids = std::collections::BTreeSet::new();
        for (i, a) in self.actuators().iter().enumerate() {
            let k = a.kind.as_str();
            if !ACTUATOR_KINDS.contains(&k) {
                errs.push(format!("actuator[{i}]: unknown kind {k:?}"));
            }
            if parse_actuator_id(&a.id).is_none() {
                errs.push(format!("actuator[{i}]: unknown id {:?}", a.id));
            } else if !ids.insert(a.id.clone()) {
                errs.push(format!("actuator[{i}]: id {:?} listed twice", a.id));
            }
            if a.pin.is_none() {
                errs.push(format!("actuator[{i}] ({k}): pin required"));
            }
            if k == "dosing" && !a.id.starts_with("dose_") {
                errs.push(format!("actuator[{i}]: dosing kind needs a dose_N id"));
            }
        }
        errs
    }
}

pub fn parse_actuator_id(s: &str) -> Option<hal_core::ActuatorId> {
    serde_json::from_value(serde_json::Value::String(s.to_owned())).ok()
}

/// The commented `hal.toml` written by the installer and `--print-default-config`.
pub const DEFAULT_CONFIG_TOML: &str = r##"# leafypod hald configuration. Every pin, address and limit lives here;
# drivers take them as arguments. Values shown are the defaults for a stock
# Gardyn (BCM GPIO numbering). Uncomment to change.

# unit_id = "gardyn-1a2b3c4d"        # default: derived from the Pi serial
# model = "gardyn 3.0"               # default: detected (DHT20 => 3.0/Studio)
# mqtt_url = "mqtt://127.0.0.1:1883" # also --mqtt-url / HAL_MQTT_URL
# mqtt_username = ""
# mqtt_password = ""
# http_bind = "0.0.0.0:3001"
# telemetry_interval_s = 10
# state_dir = "/var/lib/leafypod"
# mdns = true

[pins]
# light_pwm = 18          # hardware PWM
# light_pwm_channel = 0   # 0 on Pi <= 4; GPIO18 is channel 2 on a Pi 5
# light_hz = 8000
# pump_pwm = 24           # software PWM
# pump_hz = 50
# distance_trigger = 26
# distance_echo = 19
# button = 13
# over_temp_alert = 25

[i2c]
# bus = 1
# pct2075 = 0x48
# ina219 = 0x40
# dht20 = 0x38            # Gardyn 3.0 / Studio
# am2320 = 0x5C           # Gardyn 1.0 / 2.0
# ezo_ph = 0x63           # Atlas EZO (Phase 6, only with [[sensor]] entries)
# ezo_ec = 0x64
# ezo_rtd = 0x66
# ina219_shunt_ohms = 0.1
# ina219_max_amps = 3.2

[limits]
# pump_max_run_s = 900    # every pump run is bounded (ADR-0009)
# pump_max_duty = 30.0    # the board browns out above ~30 %
# water_low_cm = 16.0     # dry-run interlock; comment out to disable
# over_temp_c = 36.0      # PCB cutoff; comment out to disable
# distance_samples = 5    # median of N pings
# distance_timeout_ms = 60

[tank]
# full_cm = 5.0           # ranger-to-surface distance when full
# empty_cm = 20.0

[button]
# debounce_ms = 30
# double_window_ms = 400
# long_press_ms = 1000
# active_low = true
# pump_run_s = 300        # double press => bounded pump run

[dosing]                  # Phase 6.3 — OFF by default (ADR-0014)
# enabled = false
# ml_per_s = 1.0
# default_dose_ml = 5.0
# max_single_ml = 10.0
# max_daily_ml = 30.0
# max_doses_per_day = 4   # lockout after N; acknowledge to clear

[ha]
# discovery = true
# prefix = "homeassistant"

# [[camera]]
# name = "upper"
# device = "/dev/video0"
# resolution = "1280x720"
# skip_frames = 15
# [[camera]]
# name = "lower"
# device = "/dev/video2"

# Explicit device list. When absent, the stock set above is used. Kinds:
# pct2075 | ina219 | dht20 | am2320 | dyp_a01 | over_temp_alert |
# ezo_ph | ezo_ec | ezo_rtd      (sensors)
# pwm_light | pwm_pump | dosing  (actuators; ids light, pump, dose_1..3)
#
# [[sensor]]
# kind = "ezo_ph"
# addr = 0x63
# optional = true
#
# [[actuator]]
# id = "dose_1"
# kind = "dosing"
# pin = 5
"##;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_the_documented_pin_map() {
        let c = Config::default();
        assert_eq!((c.pins.light_pwm, c.pins.pump_pwm), (18, 24));
        assert_eq!((c.pins.distance_trigger, c.pins.distance_echo), (26, 19));
        assert_eq!(c.i2c.ina219, 0x40);
        assert_eq!(c.i2c.ezo_ph, 0x63);
        assert!(!c.dosing.enabled);
        assert!(c.validate().is_empty());
    }

    #[test]
    fn partial_toml_overrides_only_what_it_names() {
        let c: Config = toml::from_str("[limits]\npump_max_duty = 25\n").unwrap();
        assert_eq!(c.limits.pump_max_duty, 25.0);
        assert_eq!(c.limits.pump_max_run_s, 900);
        assert_eq!(c.pins.light_pwm, 18);
    }

    #[test]
    fn the_commented_default_config_parses_to_the_defaults() {
        let c: Config = toml::from_str(DEFAULT_CONFIG_TOML).unwrap();
        let d = Config::default();
        assert_eq!(toml::to_string(&c).unwrap(), toml::to_string(&d).unwrap());
    }

    #[test]
    fn unknown_keys_are_rejected() {
        assert!(toml::from_str::<Config>("[pins]\nlihgt_pwm = 1\n").is_err());
        assert!(toml::from_str::<Config>("bogus = 1\n").is_err());
    }

    #[test]
    fn stock_device_list_is_derived_from_pins_and_i2c() {
        let mut c = Config::default();
        c.i2c.pct2075 = 0x49;
        c.pins.pump_pwm = 23;
        let s = c.sensors();
        assert_eq!(s[0].kind, "pct2075");
        assert_eq!(s[0].addr, Some(0x49));
        assert!(s
            .iter()
            .any(|e| e.kind == "dyp_a01" && e.trigger == Some(26) && e.echo == Some(19)));
        assert!(s.iter().filter(|e| e.optional).count() >= 2);
        let a = c.actuators();
        assert_eq!(a[1].id, "pump");
        assert_eq!(a[1].pin, Some(23));
    }

    #[test]
    fn explicit_tables_replace_the_stock_list() {
        let c: Config = toml::from_str(
            r#"
[[sensor]]
kind = "ezo_ph"
addr = 0x63
[[actuator]]
id = "dose_1"
kind = "dosing"
pin = 5
"#,
        )
        .unwrap();
        assert_eq!(c.sensors().len(), 1);
        assert_eq!(c.actuators().len(), 1);
        assert!(c.validate().is_empty());
    }

    #[test]
    fn validate_flags_unknown_kinds_missing_fields_and_bad_values() {
        let c: Config = toml::from_str(
            r#"
telemetry_interval_s = 0
http_bind = "nope"
mqtt_url = "http://x"
[limits]
pump_max_duty = 150
[tank]
full_cm = 30
[[sensor]]
kind = "bme280"
[[sensor]]
kind = "ina219"
[[sensor]]
kind = "dyp_a01"
[[sensor]]
kind = "over_temp_alert"
[[actuator]]
id = "pump"
kind = "relay"
[[actuator]]
id = "pump"
kind = "pwm_pump"
pin = 24
[[actuator]]
id = "light"
kind = "dosing"
pin = 5
[[actuator]]
id = "fan"
kind = "pwm_pump"
"#,
        )
        .unwrap();
        let errs = c.validate();
        let joined = errs.join("\n");
        for needle in [
            "telemetry_interval_s",
            "http_bind",
            "mqtt_url",
            "pump_max_duty",
            "tank.full_cm",
            "unknown kind \"bme280\"",
            "(ina219): addr required",
            "(dyp_a01): trigger and echo required",
            "(over_temp_alert): pin required",
            "unknown kind \"relay\"",
            "id \"pump\" listed twice",
            "dosing kind needs a dose_N id",
            "unknown id \"fan\"",
            "(pwm_pump): pin required",
        ] {
            assert!(joined.contains(needle), "missing {needle:?} in:\n{joined}");
        }
    }

    #[test]
    fn load_reports_missing_file_and_parse_errors_with_the_path() {
        let err = Config::load(Some(std::path::Path::new("/nonexistent/hal.toml"))).unwrap_err();
        assert!(err.to_string().contains("/nonexistent/hal.toml"));
        let dir = std::env::temp_dir().join(format!("hald-cfg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("hal.toml");
        std::fs::write(&p, "this is = not toml = at all").unwrap();
        assert!(Config::load(Some(&p)).is_err());
        std::fs::write(&p, "telemetry_interval_s = 5").unwrap();
        assert_eq!(Config::load(Some(&p)).unwrap().telemetry_interval_s, 5);
        assert_eq!(Config::load(None).unwrap().telemetry_interval_s, 10);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn limits_convert_to_guard_types() {
        let c = Config::default();
        let p: PumpLimits = (&c.limits).into();
        assert_eq!(p.max_duty, 30.0);
        let d: DoseLimits = (&c.dosing).into();
        assert_eq!(d, DoseLimits::default());
        let t: hal_core::derived::TankGeometry = (&c.tank).into();
        assert_eq!(t.empty_cm, 20.0);
        assert_eq!(parse_actuator_id("dose_2"), Some(hal_core::ActuatorId::Dose2));
        assert_eq!(parse_actuator_id("x"), None);
    }
}
