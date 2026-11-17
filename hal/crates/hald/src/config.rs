//! `hal.toml` — every pin, address and limit lives here, never in a driver
//! (upstream garden-of-eden rule, kept).
//!
//! Two layers: the classic `[pins]` / `[i2c]` / `[limits]` tables hold the
//! documented Gardyn defaults, and optional `[[sensor]]` / `[[actuator]]`
//! tables override the device list entirely (kind + addr/pin + params).
//! When no `[[sensor]]` / `[[actuator]]` table is present the device list is
//! derived from the defaults, so a stock unit needs an empty config.

use std::path::PathBuf;

use hal_core::{DoseLimits, DryGuard, PumpLimits};
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
    /// How long a full swing of the light takes; 0 for no fade.
    pub light_fade_ms: u64,
    /// Where `state.json` (last light level, dose ledgers) is kept.
    pub state_dir: PathBuf,
    pub pins: Pins,
    pub i2c: I2c,
    pub limits: Limits,
    pub tank: Tank,
    pub button: Button,
    pub dosing: Dosing,
    pub ha: HomeAssistant,
    pub usb_recovery: UsbRecovery,
    pub mdns: bool,
    pub camera: Vec<CameraEntry>,
    pub sensor: Vec<SensorEntry>,
    pub actuator: Vec<ActuatorEntry>,
    /// Sensors added from the app (the state-dir overlay), appended to `sensors()`.
    #[serde(skip)]
    pub extra_sensors: Vec<SensorEntry>,
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
    /// The pump's duty cap (%). 100, the default, holds the pin high with no
    /// software PWM, as the stock firmware does. Lower it only for a board that
    /// browns out; pumps differ between units.
    pub pump_max_duty: f64,
    /// The level guard's cutoff (cm from the ranger). It's the default: the app
    /// may set it within the two bounds below, but never clear it. Unset, the
    /// level interlock is off, and the app can't turn it on.
    pub water_low_cm: Option<f64>,
    pub water_low_min_cm: f64,
    pub water_low_max_cm: f64,
    /// How long the level must read past `water_low_cm`, without a good reading
    /// between, to stop a running pump; under 500 ms, 500 ms. The default: the
    /// app may set it within the two bounds below.
    pub water_low_hold_ms: u64,
    pub water_low_hold_min_ms: u64,
    pub water_low_hold_max_ms: u64,
    pub over_temp_c: Option<f64>,
    /// Below this pump current (A) the running pump is pulling air. Unset (the
    /// default until a wet and a dry run are measured) or no INA219: off. It's
    /// the default: the app may set one within the two bounds below, never clear it.
    pub pump_dry_current_a: Option<f64>,
    pub pump_dry_current_min_a: f64,
    pub pump_dry_current_max_a: f64,
    /// How long the current must stay below `pump_dry_current_a` to stop the
    /// pump (at least three reads in a row; hald reads it every 100 ms while the
    /// pump runs). Unset: [`PUMP_DRY_AFTER_MS`].
    pub pump_dry_after_ms: Option<u64>,
    /// How long after a start the current isn't judged, while the pump spins up.
    /// Unset: [`PUMP_DRY_GRACE_MS`]. It's the default: the app may set the grace
    /// within the two bounds below.
    pub pump_dry_grace_ms: Option<u64>,
    pub pump_dry_grace_min_ms: u64,
    pub pump_dry_grace_max_ms: u64,
    /// Which dry-run guard stops a running pump: `level`, `current` or `both`.
    /// It's the default: the app may pick another, unless `pump_dry_guard_app`
    /// is false. Whichever it is, hald falls back to one the unit can run.
    pub pump_dry_guard: DryGuard,
    /// Whether the app may change `pump_dry_guard`. False locks it to this file's.
    pub pump_dry_guard_app: bool,
    /// The same two in whole seconds, as hald read them before milliseconds.
    /// Still read so an older `hal.toml` loads; the `_ms` keys are preferred.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pump_dry_after_s: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pump_dry_grace_s: Option<u64>,
    /// Below this pump supply (V, the INA219's bus voltage), past the spin-up
    /// grace, for `pump_brownout_ms`, the pump stops and latches a brown-out.
    /// 0 turns the voltage check off; it's off without an INA219 too.
    pub pump_brownout_v: f64,
    /// How long the supply must stay low (at least three reads, 100 ms apart).
    pub pump_brownout_ms: u64,
    /// Also stop on the Pi's own under-voltage flag ([`PI_THROTTLED`]), read once
    /// a second while the pump runs, when it's readable.
    pub pump_brownout_pi: bool,
    pub distance_samples: usize,
    pub distance_timeout_ms: u64,
    /// Quiet time between pings, so one doesn't hear the last one's echo.
    pub distance_gap_ms: u64,
    /// A ping further than this is a stray echo, not water. Unset: the empty depth plus half again.
    pub distance_max_cm: Option<f64>,
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
    /// Keep holding this long to open core's Wi-Fi setup hotspot.
    pub setup_hold_ms: u64,
    pub active_low: bool,
    /// Bounded pump run started by a double press (clamped by the guard).
    pub pump_run_s: u64,
}

/// `hald --usb-recover`, for a USB hub that didn't enumerate at boot.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct UsbRecovery {
    pub enabled: bool,
    /// Seconds after boot before an empty bus counts as a failure.
    pub boot_wait_s: u64,
    /// Root hub re-probes before anything else. Some hubs have connected late after
    /// them; whether they helped or the wait did is still being tested.
    pub attempts: u32,
    /// Seconds to wait for the bus to fill after each re-probe.
    pub settle_s: u64,
    /// Reboots in a row to try for a missing hub. 0, the default, turns this off
    /// until the timing is proved on a unit. The count only resets when the hub is
    /// seen, so a power cycle doesn't start it again.
    pub reboot_attempts: u32,
    /// Looks at the pump and dosers before rebooting, and the wait between looks.
    /// Long enough to outlast a full pump run; after that this boot goes without.
    pub busy_checks: u32,
    pub busy_wait_s: u64,
    /// WARNING: has no effect, and must not get one back: binding `dwc_otg` again
    /// segfaults the kernel. It stays only so a `hal.toml` that sets it still loads.
    pub rebind_controller: bool,
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

/// Which camera each hub port feeds, confirmed with markers on a 3.0. Only a
/// default for naming a lone camera: pins in the udev rules always win.
pub const STOCK_CAMERA_PORTS: [(&str, &str); 2] = [("upper", "1-1.3:1.0"), ("lower", "1-1.4:1.0")];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CameraEntry {
    pub name: String,
    /// Normally the stable udev name `/dev/seedypod/camera-<name>` (`hald --camera-rules`).
    pub device: PathBuf,
    /// Used while `device` doesn't exist, e.g. before the udev rules are installed.
    #[serde(default)]
    pub fallback: Option<PathBuf>,
    /// The sensor's own 4:3 shape, so nothing is cropped, at a size a Pi Zero
    /// decodes and re-encodes in a few seconds.
    #[serde(default = "default_resolution")]
    pub resolution: String,
    /// Always sent: left unset, each camera keeps whatever format it last used.
    #[serde(default = "default_palette")]
    pub palette: String,
    #[serde(default = "default_skip")]
    pub skip_frames: u32,
    /// Tries per still; the worst case is about `attempts × attempt_timeout_s`.
    #[serde(default = "default_capture_attempts")]
    pub capture_attempts: u32,
    /// Wait before retry N is this times N.
    #[serde(default = "default_capture_retry_ms")]
    pub capture_retry_ms: u64,
    /// `fswebcam` is killed after this long.
    #[serde(default = "default_capture_timeout_s")]
    pub capture_timeout_s: u64,
    /// Check each raw frame for tearing. Turn off only if a camera's good
    /// frames are being refused; damaged frames then reach the store.
    #[serde(default = "default_inspect_frames")]
    pub inspect_frames: bool,
    /// The pod-ID still's size (#224), taken only when core asks for one.
    #[serde(default = "default_full_resolution")]
    pub full_resolution: String,
    /// `fswebcam` is killed after this long on a pod-ID still.
    #[serde(default = "default_full_capture_timeout_s")]
    pub full_capture_timeout_s: u64,
}

fn default_resolution() -> String {
    "1280x960".into()
}
fn default_palette() -> String {
    "MJPEG".into()
}
fn default_skip() -> u32 {
    15
}
fn default_capture_attempts() -> u32 {
    3
}
fn default_capture_retry_ms() -> u64 {
    1000
}
fn default_capture_timeout_s() -> u64 {
    15
}
fn default_inspect_frames() -> bool {
    true
}
fn default_full_resolution() -> String {
    "2592x1944".into()
}
fn default_full_capture_timeout_s() -> u64 {
    60
}

impl CameraEntry {
    fn stock(name: &str, fallback: &str) -> Self {
        Self {
            name: name.into(),
            device: format!("/dev/seedypod/camera-{name}").into(),
            fallback: Some(fallback.into()),
            resolution: default_resolution(),
            palette: default_palette(),
            skip_frames: default_skip(),
            capture_attempts: default_capture_attempts(),
            capture_retry_ms: default_capture_retry_ms(),
            capture_timeout_s: default_capture_timeout_s(),
            inspect_frames: default_inspect_frames(),
            full_resolution: default_full_resolution(),
            full_capture_timeout_s: default_full_capture_timeout_s(),
        }
    }
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
/// Usable 7-bit I²C addresses (0x00–0x07 and 0x78–0x7F are reserved).
pub const I2C_ADDR_RANGE: std::ops::RangeInclusive<u16> = 0x08..=0x77;
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
            light_fade_ms: 800,
            state_dir: PathBuf::from("/var/lib/seedypod"),
            pins: Pins::default(),
            i2c: I2c::default(),
            limits: Limits::default(),
            tank: Tank::default(),
            button: Button::default(),
            dosing: Dosing::default(),
            ha: HomeAssistant::default(),
            usb_recovery: UsbRecovery::default(),
            mdns: true,
            camera: vec![
                CameraEntry::stock("upper", "/dev/video0"),
                CameraEntry::stock("lower", "/dev/video2"),
            ],
            sensor: Vec::new(),
            actuator: Vec::new(),
            extra_sensors: Vec::new(),
        }
    }
}

impl Default for Pins {
    fn default() -> Self {
        // BCM numbering, from iot-root/garden-of-eden config.py; pins and the
        // 20 kHz light PWM match the stock Gardyn 3.0 firmware.
        Self {
            light_pwm: 18,
            light_pwm_channel: 0,
            light_hz: 20_000,
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
            // The stock Gardyn firmware calibrates against a 0.08 Ω shunt.
            ina219_shunt_ohms: 0.08,
            ina219_max_amps: 3.2,
        }
    }
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            pump_max_run_s: 900,
            // Stock drives the pump plain on/off; ADR-0009's 30 % was never measured on a 3.0.
            pump_max_duty: 100.0,
            water_low_cm: Some(16.0),
            // The Gardyn tank reads ~5 cm full and ~20 cm empty: a cutoff from the
            // app stays clear of the full surface and short of the bottom.
            water_low_min_cm: 8.0,
            water_low_max_cm: 19.0,
            water_low_hold_ms: 0,
            water_low_hold_min_ms: 0,
            water_low_hold_max_ms: WATER_LOW_HOLD_MAX_MS,
            // The board runs ~47 °C with the lights at 100 %; stock sets the
            // PCT2075 alert at 70 °C.
            over_temp_c: Some(65.0),
            pump_dry_current_a: None,
            // Low enough for the sim's pump (0.5 A wet, tests/sim/bringup.mjs sets 0.15 A).
            pump_dry_current_min_a: 0.1,
            pump_dry_current_max_a: 3.0,
            pump_dry_after_ms: None,
            pump_dry_grace_ms: None,
            pump_dry_grace_min_ms: 300,
            pump_dry_grace_max_ms: 5000,
            pump_dry_guard: DryGuard::Both,
            pump_dry_guard_app: true,
            pump_dry_after_s: None,
            pump_dry_grace_s: None,
            pump_brownout_v: PUMP_BROWNOUT_V,
            pump_brownout_ms: PUMP_BROWNOUT_MS,
            pump_brownout_pi: true,
            distance_samples: 5,
            distance_timeout_ms: 60,
            distance_gap_ms: 60,
            distance_max_cm: None,
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

impl Default for UsbRecovery {
    fn default() -> Self {
        Self {
            enabled: true,
            boot_wait_s: 90,
            attempts: 2,
            settle_s: 20,
            reboot_attempts: 0,
            busy_checks: 20,
            busy_wait_s: 60,
            rebind_controller: false,
        }
    }
}

impl Default for Button {
    fn default() -> Self {
        Self {
            debounce_ms: 30,
            double_window_ms: 400,
            long_press_ms: 1000,
            setup_hold_ms: 10_000,
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
            water_low_hold_ms: l.water_low_hold_ms,
            over_temp_c: l.over_temp_c,
            dry_current_a: l.pump_dry_current_a,
            dry_after_ms: l.dry_after_ms(),
            dry_grace_ms: l.dry_grace_ms(),
            // What hal.toml asks for; the engine resolves what the unit can run.
            dry_guard: l.pump_dry_guard,
            brownout_v: (l.pump_brownout_v > 0.0).then_some(l.pump_brownout_v),
            brownout_ms: l.pump_brownout_ms,
        }
    }
}

/// Three reads at the guard's 100 ms: a pump pulling air stops in about a third of a second.
pub const PUMP_DRY_AFTER_MS: u64 = 300;
/// Spin-up and priming after a start, before the current is judged: the unit's
/// pump takes ~2.3 s to reach its wet current at 100 % duty (2026-11-16 traces).
pub const PUMP_DRY_GRACE_MS: u64 = 3000;
/// No setting may hold the current guard off longer than this after a start.
pub const PUMP_DRY_MAX_MS: u64 = 10_000;
/// No setting may let a running pump's tank read low longer than this before it stops.
pub const WATER_LOW_HOLD_MAX_MS: u64 = 60_000;
/// The brown-out cutoff: a 12 V supply 10 % low, the bottom of its usual
/// tolerance. The supply idles at ~12.6 V, and a healthy one under the pump's
/// 0.95 A reads ~12 V or more past the shunt, so this is ≥ 1.2 V clear of it.
pub const PUMP_BROWNOUT_V: f64 = 10.8;
/// Three reads at the guard's 100 ms, as for the current guard.
pub const PUMP_BROWNOUT_MS: u64 = 300;
/// The range `pump_brownout_v` may be set in (besides 0, off): above 12 V a
/// healthy supply under load would trip it.
pub const PUMP_BROWNOUT_RANGE: std::ops::RangeInclusive<f64> = 6.0..=12.0;
/// The Pi's throttling flags (bit 0: under-voltage now), readable without root.
/// The same as `vcgencmd get_throttled`, without the subprocess.
pub const PI_THROTTLED: &str = "/sys/devices/platform/soc/soc:firmware/get_throttled";

impl Limits {
    /// `pump_dry_after_ms`, or the older `pump_dry_after_s`, or the default.
    pub fn dry_after_ms(&self) -> u64 {
        ms_or_s(self.pump_dry_after_ms, self.pump_dry_after_s, PUMP_DRY_AFTER_MS)
    }

    /// `pump_dry_grace_ms`, or the older `pump_dry_grace_s`, or the default.
    pub fn dry_grace_ms(&self) -> u64 {
        ms_or_s(self.pump_dry_grace_ms, self.pump_dry_grace_s, PUMP_DRY_GRACE_MS)
    }
}

fn ms_or_s(ms: Option<u64>, s: Option<u64>, default: u64) -> u64 {
    ms.or(s.map(|s| s.saturating_mul(1000))).unwrap_or(default)
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

    /// The sensor list: explicit `[[sensor]]` tables, else the stock Gardyn set;
    /// then any sensors added from the app.
    pub fn sensors(&self) -> Vec<SensorEntry> {
        let mut v = self.configured_sensors();
        v.extend(self.extra_sensors.iter().cloned());
        v
    }

    /// `hal.toml` only: explicit `[[sensor]]` tables, else the stock Gardyn set.
    pub fn configured_sensors(&self) -> Vec<SensorEntry> {
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
                // PCT2075 OS is active-low at power-up (OS_POL = 0): the idle line reads high.
                active_low: Some(true),
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
        if self.light_fade_ms > 60_000 {
            errs.push("light_fade_ms must be ≤ 60000".into());
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
        if let Some(a) = self.limits.pump_dry_current_a {
            if !(a > 0.0 && a < self.i2c.ina219_max_amps) {
                errs.push(format!(
                    "limits.pump_dry_current_a must be above 0 and below i2c.ina219_max_amps ({})",
                    self.i2c.ina219_max_amps
                ));
            }
        }
        let l = &self.limits;
        for (ms, s, name) in [
            (l.pump_dry_after_ms, l.pump_dry_after_s, "after"),
            (l.pump_dry_grace_ms, l.pump_dry_grace_s, "grace"),
        ] {
            if ms.is_some() && s.is_some() {
                errs.push(format!(
                    "limits: set pump_dry_{name}_ms or the older pump_dry_{name}_s, not both"
                ));
            }
        }
        if !(100..=PUMP_DRY_MAX_MS).contains(&l.dry_after_ms()) {
            errs.push(format!("limits.pump_dry_after_ms must be 100–{PUMP_DRY_MAX_MS}"));
        }
        let (min, grace, max) = (l.pump_dry_grace_min_ms, l.dry_grace_ms(), l.pump_dry_grace_max_ms);
        if !(min <= grace && grace <= max) {
            errs.push(format!(
                "limits: pump_dry_grace_min_ms ({min}) ≤ pump_dry_grace_ms ({grace}) ≤ pump_dry_grace_max_ms ({max}) must hold"
            ));
        }
        if max > PUMP_DRY_MAX_MS {
            errs.push(format!(
                "limits.pump_dry_grace_max_ms must be ≤ {PUMP_DRY_MAX_MS}"
            ));
        }
        // The bounds of what the app may set. A cutoff of 0 A, or one past the
        // tank's bottom, would never trip: the app must not be able to reach either.
        let (amin, amax) = (l.pump_dry_current_min_a, l.pump_dry_current_max_a);
        if !(amin > 0.0 && amin <= amax) {
            errs.push(format!(
                "limits: 0 < pump_dry_current_min_a ({amin}) ≤ pump_dry_current_max_a ({amax}) must hold"
            ));
        }
        if let Some(a) = l.pump_dry_current_a.filter(|a| !(amin..=amax).contains(a)) {
            errs.push(format!(
                "limits: pump_dry_current_a ({a}) must lie within pump_dry_current_min_a ({amin}) and pump_dry_current_max_a ({amax})"
            ));
        }
        let (wmin, wmax) = (l.water_low_min_cm, l.water_low_max_cm);
        if !(wmin > 0.0 && wmin <= wmax) {
            errs.push(format!(
                "limits: 0 < water_low_min_cm ({wmin}) ≤ water_low_max_cm ({wmax}) must hold"
            ));
        }
        if wmax > self.tank.empty_cm {
            errs.push(format!(
                "limits.water_low_max_cm ({wmax}) must be ≤ tank.empty_cm ({}): a cutoff past the bottom never trips",
                self.tank.empty_cm
            ));
        }
        if let Some(cm) = l.water_low_cm.filter(|cm| !(wmin..=wmax).contains(cm)) {
            errs.push(format!(
                "limits: water_low_cm ({cm}) must lie within water_low_min_cm ({wmin}) and water_low_max_cm ({wmax})"
            ));
        }
        let (hmin, hold, hmax) = (
            l.water_low_hold_min_ms,
            l.water_low_hold_ms,
            l.water_low_hold_max_ms,
        );
        if !(hmin <= hold && hold <= hmax) {
            errs.push(format!(
                "limits: water_low_hold_min_ms ({hmin}) ≤ water_low_hold_ms ({hold}) ≤ water_low_hold_max_ms ({hmax}) must hold"
            ));
        }
        if hmax > WATER_LOW_HOLD_MAX_MS {
            errs.push(format!(
                "limits.water_low_hold_max_ms must be ≤ {WATER_LOW_HOLD_MAX_MS}"
            ));
        }
        let v = l.pump_brownout_v;
        if v != 0.0 && !PUMP_BROWNOUT_RANGE.contains(&v) {
            errs.push(format!(
                "limits.pump_brownout_v must be {}–{} V, or 0 for off",
                PUMP_BROWNOUT_RANGE.start(),
                PUMP_BROWNOUT_RANGE.end()
            ));
        }
        if !(100..=PUMP_DRY_MAX_MS).contains(&l.pump_brownout_ms) {
            errs.push(format!("limits.pump_brownout_ms must be 100–{PUMP_DRY_MAX_MS}"));
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
            if c.capture_timeout_s == 0 {
                errs.push(format!("camera {:?}: capture_timeout_s must be ≥ 1", c.name));
            }
            if c.full_capture_timeout_s == 0 {
                errs.push(format!("camera {:?}: full_capture_timeout_s must be ≥ 1", c.name));
            }
        }
        let mut addrs = std::collections::BTreeMap::new();
        for (i, s) in self.sensors().iter().enumerate() {
            let k = s.kind.as_str();
            if !SENSOR_KINDS.contains(&k) {
                errs.push(format!("sensor[{i}]: unknown kind {k:?}"));
                continue;
            }
            if I2C_KINDS.contains(&k) && s.addr.is_none() {
                errs.push(format!("sensor[{i}] ({k}): addr required"));
            }
            if let (true, Some(a)) = (I2C_KINDS.contains(&k), s.addr) {
                if !I2C_ADDR_RANGE.contains(&a) {
                    errs.push(format!("sensor[{i}] ({k}): addr 0x{a:02X} is outside 0x08–0x77"));
                } else if let Some(other) = addrs.insert(a, k) {
                    errs.push(format!(
                        "sensor[{i}] ({k}): addr 0x{a:02X} already used by {other}"
                    ));
                }
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
pub const DEFAULT_CONFIG_TOML: &str = r##"# seedypod hald configuration. Every pin, address and limit lives here;
# drivers take them as arguments. Values shown are the defaults for a stock
# Gardyn (BCM GPIO numbering). Uncomment to change.

# unit_id = "gardyn-1a2b3c4d"        # default: derived from the Pi serial
# model = "gardyn 3.0"               # default: detected (DHT20 => 3.0/Studio)
# mqtt_url = "mqtt://127.0.0.1:1883" # also --mqtt-url / HAL_MQTT_URL
# mqtt_username = ""
# mqtt_password = ""
# http_bind = "0.0.0.0:3001"
# telemetry_interval_s = 10
# light_fade_ms = 800     # how long a full swing of the light takes; 0 for no fade
# state_dir = "/var/lib/seedypod"
# mdns = true

[pins]
# light_pwm = 18          # hardware PWM
# light_pwm_channel = 0   # 0 on Pi <= 4; GPIO18 is channel 2 on a Pi 5
# light_hz = 20000
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
# ina219_shunt_ohms = 0.08
# ina219_max_amps = 3.2

[limits]
# pump_max_run_s = 900    # every pump run is bounded (ADR-0009)
# pump_max_duty = 100.0   # stock runs the pump at 100 % (the pin held high, no PWM).
#                          # Lower it only if your board browns out; pumps differ between
#                          # units, and below 100 a weak one may not lift to the top.
# water_low_cm = 16.0     # dry-run interlock; comment out to disable (the app can't turn it on)
# water_low_min_cm = 8.0  # the app may set water_low_cm within these, never clear it;
# water_low_max_cm = 19.0 # min ≤ water_low_cm ≤ max ≤ tank.empty_cm
# water_low_hold_ms = 0   # a running pump stops once the level has read past water_low_cm this
#                          # long with no good reading between (at least 0.5 s); rides out a noisy
#                          # ranger. A start is still refused on one low reading.
# water_low_hold_min_ms = 0      # the app may set the hold within these;
# water_low_hold_max_ms = 60000  # min ≤ hold ≤ max ≤ 60000
# over_temp_c = 65.0      # PCB cutoff; comment out to disable
# pump_dry_current_a = 1.2 # pump current guard: off until set (needs the ina219). Stops a running
#                          # pump that draws less than this, past the grace, for pump_dry_after_ms.
#                          # Set it below the wet current at the lowest duty you run.
#                          # hald reads the current every 100 ms while the pump runs.
# pump_dry_current_min_a = 0.1 # the app may set the cutoff within these, never clear it;
# pump_dry_current_max_a = 3.0 # 0 < min ≤ pump_dry_current_a ≤ max
# pump_dry_after_ms = 300  # at least 3 low reads in a row; 100–10000
# pump_dry_grace_ms = 1000 # spin-up after a start, not judged. The default: the app may set it
# pump_dry_grace_min_ms = 300  # within these bounds;
# pump_dry_grace_max_ms = 5000 # min ≤ default ≤ max ≤ 10000
#                          # (pump_dry_after_s / pump_dry_grace_s, in seconds, still load)
# pump_dry_guard = "both"  # which dry-run guard stops the pump: "level" (tank), "current"
#                          # (pump current) or "both". The default: the app may pick another.
#                          # "current" needs pump_dry_current_a and the ina219, else it falls
#                          # back to "level"; there, and in "both", a low tank refuses a start.
# pump_dry_guard_app = true # false: the app can't change pump_dry_guard
# pump_brownout_v = 10.8   # brown-out guard: a running pump whose supply (ina219 bus voltage)
# pump_brownout_ms = 300   # stays below this, past the grace, stops and latches. 6–12 V, 0 = off.
#                          # The supply idles ~12.6 V; 10.8 is a 12 V supply 10 % low.
# pump_brownout_pi = true  # also stop on the Pi's under-voltage flag (get_throttled), if readable
# distance_samples = 5    # median of N pings
# distance_timeout_ms = 60
# distance_gap_ms = 60    # between pings, so one doesn't hear the last one's echo
# distance_max_cm = 30.0  # further is a stray echo; default tank.empty_cm × 1.5

[tank]
# full_cm = 5.0           # ranger-to-surface distance when full
# empty_cm = 20.0

[button]
# debounce_ms = 30
# double_window_ms = 400
# long_press_ms = 1000    # long press => acknowledge latched faults
# setup_hold_ms = 10000   # keep holding => Wi-Fi setup hotspot (core)
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

# [usb_recovery]          # reboot to try again when the USB hub didn't come up
# enabled = true
# boot_wait_s = 90
# reboot_attempts = 0     # reboots in a row; 0 (the default) turns this off
# busy_checks = 20        # waits for the pump and dosers to finish first,
# busy_wait_s = 60        # then leaves this boot alone
# attempts = 2            # root hub re-probes before any reboot
# settle_s = 20

# Cameras get stable names from udev rules keyed on their USB port
# (`hald --list-cameras`, `hald --camera-rules`); /dev/videoN is only a
# fallback because the numbering can swap across reboots.
# [[camera]]
# name = "upper"
# device = "/dev/seedypod/camera-upper"
# fallback = "/dev/video0"
# resolution = "1280x960"
# palette = "MJPEG"
# skip_frames = 15
# capture_attempts = 3
# capture_retry_ms = 1000
# capture_timeout_s = 15
# inspect_frames = true
# full_resolution = "2592x1944"   # pod-ID stills only, when core asks (#224)
# full_capture_timeout_s = 60
# [[camera]]
# name = "lower"
# device = "/dev/seedypod/camera-lower"
# fallback = "/dev/video2"

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
    fn stock_over_temp_line_is_active_low() {
        let stock = Config::default().sensors();
        let alert = stock.iter().find(|s| s.kind == "over_temp_alert").unwrap();
        assert_eq!(alert.active_low, Some(true));
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
    fn app_sensors_append_to_the_stock_set_and_share_its_validation() {
        let ph = |addr| SensorEntry {
            kind: "ezo_ph".into(),
            addr: Some(addr),
            pin: None,
            trigger: None,
            echo: None,
            optional: false,
            active_low: None,
        };
        let mut c = Config::default();
        let stock = c.sensors().len();
        c.extra_sensors = vec![ph(0x63)];
        assert_eq!(c.sensors().len(), stock + 1);
        assert_eq!(c.configured_sensors().len(), stock);
        assert!(c.validate().is_empty());
        c.extra_sensors = vec![ph(0x40)];
        assert!(
            c.validate()
                .iter()
                .any(|e| e.contains("0x40 already used by ina219")),
            "{:?}",
            c.validate()
        );
        c.extra_sensors = vec![ph(0x7A)];
        assert!(c.validate().iter().any(|e| e.contains("outside 0x08–0x77")));
    }

    #[test]
    fn a_capture_timeout_of_zero_would_kill_every_capture_and_is_refused() {
        let c: Config = toml::from_str(
            r#"
[[camera]]
name = "upper"
device = "/dev/video0"
capture_timeout_s = 0
"#,
        )
        .unwrap();
        assert!(c.validate().iter().any(|e| e.contains("capture_timeout_s")));
    }

    #[test]
    fn a_camera_takes_full_size_pod_id_stills_by_default() {
        let c: Config = toml::from_str(
            r#"
[[camera]]
name = "upper"
device = "/dev/video0"
"#,
        )
        .unwrap();
        assert_eq!(c.camera[0].resolution, "1280x960");
        assert_eq!(c.camera[0].full_resolution, "2592x1944");
        assert_eq!(c.camera[0].full_capture_timeout_s, 60);
        assert!(c.validate().is_empty());
        let c: Config = toml::from_str(
            r#"
[[camera]]
name = "upper"
device = "/dev/video0"
full_capture_timeout_s = 0
"#,
        )
        .unwrap();
        assert!(c.validate().iter().any(|e| e.contains("full_capture_timeout_s")));
    }

    /// `install-hal --version <older>` runs an older hald on a file written by a
    /// newer one, and unknown sections are refused: hald then crash-loops, and takes
    /// pump and light control with it. New sections must stay commented out.
    #[test]
    fn the_default_file_stays_readable_by_a_hald_without_usb_recovery() {
        let keys: toml::Table = toml::from_str(DEFAULT_CONFIG_TOML).unwrap();
        assert!(!keys.contains_key("usb_recovery"));
        let c: Config = toml::from_str(DEFAULT_CONFIG_TOML).unwrap();
        assert!(c.usb_recovery.enabled);
        // An unattended reboot is opt-in (AGENTS.md: auto-recovery is default-off).
        assert_eq!(c.usb_recovery.reboot_attempts, 0);
    }

    /// Dropping the key would make a `hal.toml` that set it crash-loop hald.
    #[test]
    fn a_hal_toml_that_set_rebind_controller_still_loads() {
        let c: Config = toml::from_str("[usb_recovery]\nrebind_controller = true\n").unwrap();
        assert!(c.usb_recovery.rebind_controller);
    }

    #[test]
    fn validate_flags_unknown_kinds_missing_fields_and_bad_values() {
        let c: Config = toml::from_str(
            r#"
telemetry_interval_s = 0
light_fade_ms = 60001
http_bind = "nope"
mqtt_url = "http://x"
[limits]
pump_max_duty = 150
pump_dry_current_a = 5.0
pump_dry_after_s = 0
pump_dry_grace_ms = 10001
pump_dry_grace_max_ms = 20000
pump_dry_grace_min_ms = 12000
pump_dry_grace_s = 1
pump_brownout_v = 12.5
pump_brownout_ms = 50
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
            "light_fade_ms",
            "http_bind",
            "mqtt_url",
            "pump_max_duty",
            "pump_dry_current_a must be above 0 and below i2c.ina219_max_amps (3.2)",
            "pump_dry_after_ms must be 100–10000",
            "pump_dry_grace_min_ms (12000) ≤ pump_dry_grace_ms (10001) ≤ pump_dry_grace_max_ms (20000) must hold",
            "pump_dry_grace_max_ms must be ≤ 10000",
            "set pump_dry_grace_ms or the older pump_dry_grace_s, not both",
            "pump_brownout_v must be 6–12 V, or 0 for off",
            "pump_brownout_ms must be 100–10000",
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
    fn the_bounds_of_what_the_app_may_set_are_checked() {
        let l = Config::default().limits;
        assert_eq!((l.pump_dry_current_min_a, l.pump_dry_current_max_a), (0.1, 3.0));
        assert_eq!((l.water_low_min_cm, l.water_low_max_cm), (8.0, 19.0));
        assert_eq!(
            (
                l.water_low_hold_ms,
                l.water_low_hold_min_ms,
                l.water_low_hold_max_ms
            ),
            (0, 0, 60_000)
        );
        assert!(l.pump_dry_guard_app);
        assert_eq!(PumpLimits::from(&l).water_low_hold_ms, 0);
        for (toml, needle) in [
            (
                "pump_dry_current_min_a = 2\npump_dry_current_max_a = 1\n",
                "limits: 0 < pump_dry_current_min_a (2) ≤ pump_dry_current_max_a (1) must hold",
            ),
            ("pump_dry_current_min_a = 0\n", "0 < pump_dry_current_min_a (0)"),
            (
                "pump_dry_current_a = 0.05\n",
                "limits: pump_dry_current_a (0.05) must lie within pump_dry_current_min_a (0.1) and pump_dry_current_max_a (3)",
            ),
            (
                "water_low_min_cm = 12\nwater_low_max_cm = 10\n",
                "limits: 0 < water_low_min_cm (12) ≤ water_low_max_cm (10) must hold",
            ),
            (
                "water_low_cm = 19.5\n",
                "limits: water_low_cm (19.5) must lie within water_low_min_cm (8) and water_low_max_cm (19)",
            ),
            (
                "water_low_max_cm = 25\n",
                "limits.water_low_max_cm (25) must be ≤ tank.empty_cm (20)",
            ),
            (
                "water_low_hold_ms = 70000\n",
                "water_low_hold_ms (70000) ≤ water_low_hold_max_ms (60000) must hold",
            ),
            (
                "water_low_hold_max_ms = 90000\nwater_low_hold_ms = 70000\n",
                "limits.water_low_hold_max_ms must be ≤ 60000",
            ),
            (
                "water_low_hold_min_ms = 1000\n",
                "water_low_hold_min_ms (1000) ≤ water_low_hold_ms (0)",
            ),
        ] {
            let c: Config = toml::from_str(&format!("[limits]\n{toml}")).unwrap();
            let errs = c.validate().join("\n");
            assert!(errs.contains(needle), "{toml}: missing {needle:?} in:\n{errs}");
        }
        // On the bounds is fine, and so is locking the mode.
        let edge: Config = toml::from_str(
            "[limits]\npump_dry_current_a = 0.3\nwater_low_cm = 19\nwater_low_hold_ms = 60000\npump_dry_guard_app = false\n",
        )
        .unwrap();
        assert!(edge.validate().is_empty(), "{:?}", edge.validate());
        assert!(!edge.limits.pump_dry_guard_app);
        assert_eq!(PumpLimits::from(&edge.limits).water_low_hold_ms, 60_000);
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
        assert_eq!(p.max_duty, 100.0);
        assert_eq!((p.brownout_v, p.brownout_ms), (Some(10.8), 300));
        assert!(c.limits.pump_brownout_pi);
        let off: Config = toml::from_str("[limits]\npump_brownout_v = 0\n").unwrap();
        assert_eq!(PumpLimits::from(&off.limits).brownout_v, None);
        assert!(off.validate().is_empty());
        // No baseline yet: the current guard ships off, with the guard's own timings.
        let guard = PumpLimits::default();
        assert_eq!(p.dry_current_a, None);
        assert_eq!((p.dry_after_ms, p.dry_grace_ms), (300, 3000));
        assert_eq!(
            (p.dry_after_ms, p.dry_grace_ms),
            (guard.dry_after_ms, guard.dry_grace_ms)
        );
        let on: Config = toml::from_str(
            "[limits]\npump_dry_current_a = 1.2\npump_dry_after_ms = 400\npump_dry_grace_ms = 1500\n",
        )
        .unwrap();
        let p: PumpLimits = (&on.limits).into();
        assert_eq!(
            (p.dry_current_a, p.dry_after_ms, p.dry_grace_ms),
            (Some(1.2), 400, 1500)
        );
        assert!(on.validate().is_empty());
        // A hal.toml from before milliseconds still loads, in seconds.
        let old: Config = toml::from_str(
            "[limits]\npump_dry_current_a = 1.2\npump_dry_after_s = 4\npump_dry_grace_s = 2\n",
        )
        .unwrap();
        let p: PumpLimits = (&old.limits).into();
        assert_eq!((p.dry_after_ms, p.dry_grace_ms), (4000, 2000));
        assert!(old.validate().is_empty());
        assert!(!toml::to_string(&c).unwrap().contains("pump_dry_after_s"));
        // The dry-run guard: both unless hal.toml says otherwise, and only a known one loads.
        assert_eq!(p.dry_guard, DryGuard::Both);
        assert_eq!(
            (
                c.limits.pump_dry_grace_min_ms,
                c.limits.dry_grace_ms(),
                c.limits.pump_dry_grace_max_ms
            ),
            (300, 3000, 5000)
        );
        let level: Config = toml::from_str("[limits]\npump_dry_guard = \"current\"\n").unwrap();
        assert_eq!(PumpLimits::from(&level.limits).dry_guard, DryGuard::Current);
        assert!(toml::from_str::<Config>("[limits]\npump_dry_guard = \"none\"\n").is_err());
        // The bounds may sit on the default, up to the ceiling.
        let edge: Config = toml::from_str(
            "[limits]\npump_dry_grace_min_ms = 1000\npump_dry_grace_ms = 1000\npump_dry_grace_max_ms = 10000\n",
        )
        .unwrap();
        assert!(edge.validate().is_empty(), "{:?}", edge.validate());
        let d: DoseLimits = (&c.dosing).into();
        assert_eq!(d, DoseLimits::default());
        let t: hal_core::derived::TankGeometry = (&c.tank).into();
        assert_eq!(t.empty_cm, 20.0);
        assert_eq!(parse_actuator_id("dose_2"), Some(hal_core::ActuatorId::Dose2));
        assert_eq!(parse_actuator_id("x"), None);
    }
}
