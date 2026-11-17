//! HAL contract v1. Keep in lock-step with `src/hardware/contract.ts` and
//! `hal/contract/v1.schema.json` (ADR-0007).

use serde::{Deserialize, Serialize};

pub const CONTRACT_VERSION: u8 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SensorId {
    AirTemp,
    Humidity,
    PcbTemp,
    WaterDistance,
    WaterLevelPct,
    PumpV,
    PumpA,
    PumpW,
    Ph,
    Ec,
    WaterTemp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActuatorId {
    Light,
    Pump,
    #[serde(rename = "dose_1")]
    Dose1,
    #[serde(rename = "dose_2")]
    Dose2,
    #[serde(rename = "dose_3")]
    Dose3,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AlertKind {
    WaterLow,
    PumpFault,
    /// A dosing pump hit its daily cap or lockout (ADR-0014). Separate from
    /// `PumpFault` so acknowledging one never re-arms the other.
    DoseFault,
    OverTemp,
    CameraMissing,
    HalOffline,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Quality {
    #[default]
    Good,
    Stale,
    Suspect,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Reading {
    /// RFC 3339 timestamp.
    pub ts: String,
    pub value: f64,
    pub unit: String,
    #[serde(default)]
    pub quality: Quality,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActuatorState {
    pub on: bool,
    /// 0–100.
    pub level: f64,
    pub since: String,
    /// Latched fault; cleared only by an explicit acknowledge.
    pub fault: Option<String>,
    /// Remaining seconds on a bounded run, if any.
    pub remaining_s: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActuatorCommand {
    pub on: Option<bool>,
    pub level: Option<f64>,
    /// Bounded run; the HAL clamps to its own max.
    pub duration_s: Option<u64>,
}

/// Which dry-run guard stops a running pump. hal.toml (`[limits]
/// pump_dry_guard`) sets it; the app may pick another with a
/// [`PumpGuardCommand`] unless hal.toml locks it (`pump_dry_guard_app = false`).
/// Every one of them guards the pump: there is no "off".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DryGuard {
    /// The tank level (ultrasonic) only.
    Level,
    /// The pump current (INA219) only.
    Current,
    /// Either one stops the pump.
    #[default]
    Both,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub pump_max_run_s: u64,
    pub pump_max_duty: f64,
    pub water_low_cm: Option<f64>,
    /// The dry-run guard in effect, after hald's fallbacks; absent from an older hald.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pump_dry_guard: Option<DryGuard>,
    /// The current guard's spin-up grace in effect (ms), and the bounds a
    /// [`PumpGuardCommand`] is clamped into; absent from an older hald.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pump_dry_grace_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pump_dry_grace_min_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pump_dry_grace_max_ms: Option<u64>,
    /// The mode asked for (hal.toml's, or the one the app set and hald kept),
    /// and why the one in effect differs from it, present only when it does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pump_dry_guard_asked: Option<DryGuard>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pump_dry_guard_why: Option<String>,
    /// Whether the app may change the mode (hal.toml `pump_dry_guard_app`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pump_dry_guard_app: Option<bool>,
    /// The current guard's cutoff (A), hal.toml's or the app's; null when none
    /// is set. Reported whatever the mode, so it shows before it's in use.
    #[serde(default)]
    pub pump_dry_current_a: Option<f64>,
    /// The bounds a cutoff from the app is clamped into.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pump_dry_current_min_a: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pump_dry_current_max_a: Option<f64>,
    /// The bounds a `waterLowCm` from the app is clamped into.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub water_low_min_cm: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub water_low_max_cm: Option<f64>,
    /// How long (ms) a running pump's tank must read past `waterLowCm` before
    /// the level guard stops it, and the bounds it's clamped into.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub water_low_hold_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub water_low_hold_min_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub water_low_hold_max_ms: Option<u64>,
    /// The brown-out guard, as hal.toml sets it and the unit can run it: the
    /// supply cutoff (V), absent when it's off or there is no pump monitor; how
    /// long a sag must last (ms), present from every hald that has the guard;
    /// and whether the Pi's under-voltage flag is read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pump_brownout_v: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pump_brownout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pump_brownout_pi: Option<bool>,
}

/// `pump/guard/set`: core asks for dry-run guard settings, each optional, at
/// least one. hald clamps every number into hal.toml's bounds, keeps it in
/// `state.json`, and republishes `system`. Nothing here can clear a cutoff or
/// turn the guard off: `null` is the same as leaving a field out. A payload
/// with any other field, or with none, is refused.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "PumpGuardFields")]
pub struct PumpGuardCommand {
    /// The current guard's spin-up grace (ms).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_grace_ms: Option<u64>,
    /// The current guard's cutoff (A).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_current_a: Option<f64>,
    /// The mode; refused when hal.toml locks it, or when it would leave no guard.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_guard: Option<DryGuard>,
    /// The level guard's cutoff (cm from the ranger).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub water_low_cm: Option<f64>,
    /// How long (ms) the level must read past the cutoff to stop a running pump.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub water_low_hold_ms: Option<u64>,
}

/// The wire form of [`PumpGuardCommand`], before "at least one setting" is checked.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PumpGuardFields {
    dry_grace_ms: Option<u64>,
    dry_current_a: Option<f64>,
    dry_guard: Option<DryGuard>,
    water_low_cm: Option<f64>,
    water_low_hold_ms: Option<u64>,
}

impl TryFrom<PumpGuardFields> for PumpGuardCommand {
    type Error = &'static str;

    fn try_from(f: PumpGuardFields) -> Result<Self, Self::Error> {
        let c = PumpGuardCommand {
            dry_grace_ms: f.dry_grace_ms,
            dry_current_a: f.dry_current_a,
            dry_guard: f.dry_guard,
            water_low_cm: f.water_low_cm,
            water_low_hold_ms: f.water_low_hold_ms,
        };
        if c == PumpGuardCommand::default() {
            return Err("a pump guard command needs at least one setting");
        }
        Ok(c)
    }
}

/// How a pump run ended, in its [`PumpRun`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PumpRunEnd {
    /// Its bounded duration ran out.
    Deadline,
    /// Someone stopped it: the app, the button, a shutdown.
    Stop,
    /// A guard stopped it and latched a fault.
    Fault,
}

/// `pump/run` (retained): one per pump run, published when it ends. The pump
/// monitor's reads over the first [`PUMP_RUN_SAMPLES_S`] seconds, and the
/// median current past the spin-up grace, so a cutoff can be set from real runs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PumpRun {
    pub started_at: String,
    pub ended_at: String,
    /// How often the monitor was read (ms).
    pub every_ms: u64,
    /// `[ms since the start, amps, volts]`, `null` where a read failed or there's
    /// no pump monitor; at most [`PUMP_RUN_MAX_SAMPLES`].
    pub samples: Vec<(u64, Option<f64>, Option<f64>)>,
    /// Median current past the grace to the end; `null` when the run ended
    /// inside the grace or there's no pump monitor.
    pub wet_a: Option<f64>,
    pub ended_by: PumpRunEnd,
    /// The fault latched at the end, if any.
    pub fault: Option<String>,
    /// The last tank reading at the end.
    pub level_pct: Option<f64>,
    pub level_cm: Option<f64>,
}

/// How much of a run [`PumpRun::samples`] covers (s), and so how many at most at 100 ms.
pub const PUMP_RUN_SAMPLES_S: u64 = 12;
pub const PUMP_RUN_MAX_SAMPLES: usize = 120;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Caps {
    pub sensors: Vec<SensorId>,
    pub actuators: Vec<ActuatorId>,
    pub cameras: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub contract: u8,
    pub unit_id: String,
    pub model: String,
    /// The Raspberry Pi hald runs on, from the device tree ("Raspberry Pi Zero 2 W Rev 1.0");
    /// absent in the simulator and from a hald older than this field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub board: Option<String>,
    pub hal_version: String,
    pub caps: Caps,
    pub limits: Limits,
}

/// Which calibration point a probe should store. Atlas EZO naming: pH uses
/// `mid` (first, required), `low`, `high`; EC uses `dry` then `single` or
/// `low` + `high`; RTD uses `single`. `clear` wipes stored points.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CalibrationPoint {
    Mid,
    Low,
    High,
    Dry,
    Single,
    Clear,
}

/// `sensor/<id>/calibrate` payload. `value` is the reference solution in the
/// sensor's reported unit (pH, mS/cm, °C); `dry` and `clear` take none.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CalibrationCommand {
    pub point: CalibrationPoint,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
}

/// `sensor/<id>/calibration` (retained): outcome of the last calibrate command.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationResult {
    pub ts: String,
    pub point: CalibrationPoint,
    pub ok: bool,
    /// Points the probe reports as stored after the command, when it says.
    pub points: Option<u8>,
    pub detail: String,
}

/// One step of a probe's calibration procedure, shown by the app's wizard.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationStep {
    pub point: CalibrationPoint,
    pub label: String,
    pub instruction: String,
    /// Reference value to suggest (pH, mS/cm, °C); `None` for `dry`/`clear`.
    pub default_value: Option<f64>,
    /// Steps the wizard may skip (pH low/high after mid).
    pub optional: bool,
}

/// A kind of sensor the daemon can add at runtime: the serialised form of a
/// `SensorKind` implementation, so clients (UI, MCP) need no per-kind code.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceKindInfo {
    pub kind: String,
    pub label: String,
    pub description: String,
    pub ids: Vec<SensorId>,
    /// Bus the device sits on; `i2c` today.
    pub bus: String,
    pub default_addr: Option<u16>,
    pub calibration: Vec<CalibrationStep>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceSource {
    /// From `hal.toml` (stock or explicit `[[sensor]]`); not removable from the app.
    Config,
    /// Added at runtime; persisted in the state-dir overlay.
    User,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceStatus {
    Ready,
    /// Configured but did not probe; `detail` says why.
    Absent,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceEntry {
    pub kind: String,
    /// Human name for the part ("pH probe", "Water level (ultrasonic)").
    pub label: String,
    pub addr: Option<u16>,
    pub ids: Vec<SensorId>,
    pub source: DeviceSource,
    pub status: DeviceStatus,
    pub detail: String,
}

/// `devices` (retained): every configured sensor device and what can be added.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInventory {
    pub sensors: Vec<DeviceEntry>,
    pub addable: Vec<DeviceKindInfo>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceOp {
    Add,
    Remove,
}

/// `devices/set`: add or remove a user sensor.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCommand {
    pub request_id: String,
    pub op: DeviceOp,
    pub kind: String,
    pub addr: u16,
}

/// `devices/result`: outcome of a `devices/set`, matched by `requestId`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceResult {
    pub request_id: String,
    pub ok: bool,
    pub detail: String,
}

/// Physical button gesture, published on `event/button` as `{"press": "single"}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ButtonPress {
    Single,
    Double,
    Long,
    /// Held for `setup_hold_ms` (10 s): core opens its Wi-Fi setup hotspot.
    Setup,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ButtonEvent {
    pub press: ButtonPress,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Alert {
    pub kind: AlertKind,
    pub active: bool,
    pub ts: String,
    #[serde(default)]
    pub detail: String,
}

/// MQTT topic layout under `seedypod/<unit-id>/`.
pub mod topics {
    use super::{ActuatorId, AlertKind, SensorId};

    fn snake<T: serde::Serialize>(v: &T) -> String {
        serde_json::to_value(v)
            .ok()
            .and_then(|j| j.as_str().map(str::to_owned))
            .unwrap_or_default()
    }

    pub fn prefix(unit: &str) -> String {
        format!("seedypod/{unit}")
    }
    pub fn availability(unit: &str) -> String {
        format!("{}/availability", prefix(unit))
    }
    pub fn system(unit: &str) -> String {
        format!("{}/system", prefix(unit))
    }
    pub fn sensor(unit: &str, id: SensorId) -> String {
        format!("{}/sensor/{}", prefix(unit), snake(&id))
    }
    pub fn actuator_state(unit: &str, id: ActuatorId) -> String {
        format!("{}/actuator/{}/state", prefix(unit), snake(&id))
    }
    pub fn actuator_set(unit: &str, id: ActuatorId) -> String {
        format!("{}/actuator/{}/set", prefix(unit), snake(&id))
    }
    pub fn sensor_calibrate(unit: &str, id: SensorId) -> String {
        format!("{}/sensor/{}/calibrate", prefix(unit), snake(&id))
    }
    pub fn sensor_calibration(unit: &str, id: SensorId) -> String {
        format!("{}/sensor/{}/calibration", prefix(unit), snake(&id))
    }
    pub fn devices(unit: &str) -> String {
        format!("{}/devices", prefix(unit))
    }
    pub fn devices_set(unit: &str) -> String {
        format!("{}/devices/set", prefix(unit))
    }
    pub fn devices_result(unit: &str) -> String {
        format!("{}/devices/result", prefix(unit))
    }
    pub fn button(unit: &str) -> String {
        format!("{}/event/button", prefix(unit))
    }
    pub fn alert(unit: &str, kind: AlertKind) -> String {
        format!("{}/alert/{}", prefix(unit), snake(&kind))
    }
    pub fn alert_ack(unit: &str, kind: AlertKind) -> String {
        format!("{}/alert/{}/ack", prefix(unit), snake(&kind))
    }
    pub fn pump_guard_set(unit: &str) -> String {
        format!("{}/pump/guard/set", prefix(unit))
    }
    pub fn pump_run(unit: &str) -> String {
        format!("{}/pump/run", prefix(unit))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_serialize_as_snake_case_matching_the_ts_contract() {
        assert_eq!(
            serde_json::to_string(&SensorId::WaterDistance).unwrap(),
            "\"water_distance\""
        );
        assert_eq!(serde_json::to_string(&ActuatorId::Dose1).unwrap(), "\"dose_1\"");
        assert_eq!(
            serde_json::to_string(&AlertKind::PumpFault).unwrap(),
            "\"pump_fault\""
        );
        assert_eq!(
            serde_json::to_string(&AlertKind::DoseFault).unwrap(),
            "\"dose_fault\""
        );
    }

    #[test]
    fn button_event_matches_adr_0007() {
        let e = ButtonEvent {
            press: ButtonPress::Double,
        };
        assert_eq!(serde_json::to_string(&e).unwrap(), r#"{"press":"double"}"#);
        assert_eq!(topics::button("u1"), "seedypod/u1/event/button");
    }

    #[test]
    fn topics_match_the_ts_helpers() {
        assert_eq!(topics::sensor("u1", SensorId::Ph), "seedypod/u1/sensor/ph");
        assert_eq!(
            topics::actuator_set("u1", ActuatorId::Pump),
            "seedypod/u1/actuator/pump/set"
        );
        assert_eq!(
            topics::alert_ack("u1", AlertKind::WaterLow),
            "seedypod/u1/alert/water_low/ack"
        );
        assert_eq!(
            topics::sensor_calibrate("u1", SensorId::Ph),
            "seedypod/u1/sensor/ph/calibrate"
        );
        assert_eq!(
            topics::sensor_calibration("u1", SensorId::Ec),
            "seedypod/u1/sensor/ec/calibration"
        );
        assert_eq!(topics::pump_guard_set("u1"), "seedypod/u1/pump/guard/set");
        assert_eq!(topics::pump_run("u1"), "seedypod/u1/pump/run");
    }

    #[test]
    fn the_pump_guard_command_takes_any_of_its_settings_and_nothing_else() {
        let c: PumpGuardCommand = serde_json::from_str(r#"{"dryGraceMs":1500}"#).unwrap();
        assert_eq!(
            c,
            PumpGuardCommand {
                dry_grace_ms: Some(1500),
                ..Default::default()
            }
        );
        assert_eq!(serde_json::to_string(&c).unwrap(), r#"{"dryGraceMs":1500}"#);
        let all: PumpGuardCommand = serde_json::from_str(
            r#"{"dryGraceMs":2000,"dryCurrentA":0.8,"dryGuard":"current","waterLowCm":15.5,"waterLowHoldMs":4000}"#,
        )
        .unwrap();
        assert_eq!(
            all,
            PumpGuardCommand {
                dry_grace_ms: Some(2000),
                dry_current_a: Some(0.8),
                dry_guard: Some(DryGuard::Current),
                water_low_cm: Some(15.5),
                water_low_hold_ms: Some(4000),
            }
        );
        for one in [
            r#"{"dryCurrentA":0.8}"#,
            r#"{"dryGuard":"level"}"#,
            r#"{"waterLowCm":12}"#,
            r#"{"waterLowHoldMs":0}"#,
            r#"{"dryGuard":"both","dryCurrentA":null}"#,
        ] {
            assert!(serde_json::from_str::<PumpGuardCommand>(one).is_ok(), "{one}");
        }
        for bad in [
            r#"{"dryGraceMs":1500,"pumpDryGuard":"current"}"#,
            r#"{"dryGraceMs":1500,"mode":"level"}"#,
            r#"{"dryGraceMs":1500,"pumpDryCurrentA":0.1}"#,
            r#"{"pumpDryGuard":"current"}"#,
            r#"{"dryGraceMs":-1}"#,
            r#"{"waterLowHoldMs":-5}"#,
            r#"{"dryGuard":"off"}"#,
            r#"{"dryGuard":null}"#,
            r#"{"dryCurrentA":null}"#,
            r#"{}"#,
            "",
        ] {
            assert!(serde_json::from_str::<PumpGuardCommand>(bad).is_err(), "{bad}");
        }
        assert_eq!(
            serde_json::to_value(DryGuard::Both).unwrap(),
            serde_json::json!("both")
        );
        assert_eq!(DryGuard::default(), DryGuard::Both);
    }

    #[test]
    fn a_pump_run_serialises_its_samples_as_triples() {
        let run = PumpRun {
            started_at: "2026-11-16T10:00:00Z".into(),
            ended_at: "2026-11-16T10:00:30Z".into(),
            every_ms: 100,
            samples: vec![(100, Some(0.42), Some(12.1)), (200, None, None)],
            wet_a: Some(0.93),
            ended_by: PumpRunEnd::Deadline,
            fault: None,
            level_pct: Some(80.0),
            level_cm: Some(8.0),
        };
        assert_eq!(
            serde_json::to_value(&run).unwrap(),
            serde_json::json!({
                "startedAt": "2026-11-16T10:00:00Z", "endedAt": "2026-11-16T10:00:30Z", "everyMs": 100,
                "samples": [[100, 0.42, 12.1], [200, null, null]], "wetA": 0.93, "endedBy": "deadline",
                "fault": null, "levelPct": 80.0, "levelCm": 8.0
            })
        );
        for (end, s) in [
            (PumpRunEnd::Deadline, "deadline"),
            (PumpRunEnd::Stop, "stop"),
            (PumpRunEnd::Fault, "fault"),
        ] {
            assert_eq!(serde_json::to_value(end).unwrap(), serde_json::json!(s));
        }
        assert_eq!(PUMP_RUN_MAX_SAMPLES as u64, PUMP_RUN_SAMPLES_S * 10);
    }

    #[test]
    fn actuator_state_uses_camel_case_like_the_ts_side() {
        let s = ActuatorState {
            on: true,
            level: 30.0,
            since: "t".into(),
            fault: None,
            remaining_s: Some(5),
        };
        let j = serde_json::to_string(&s).unwrap();
        assert!(j.contains("\"remainingS\":5"), "{j}");
    }
}

#[cfg(test)]
mod fixture_tests {
    use super::*;

    fn fixture(name: &str) -> String {
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../contract/fixtures/");
        std::fs::read_to_string(format!("{p}{name}.json")).expect("fixture exists")
    }

    #[test]
    fn fixtures_parse_on_the_rust_side() {
        let s: SystemInfo = serde_json::from_str(&fixture("system")).unwrap();
        assert_eq!(s.limits.pump_max_duty, 100.0);
        assert_eq!(
            (
                s.limits.pump_brownout_v,
                s.limits.pump_brownout_ms,
                s.limits.pump_brownout_pi
            ),
            (Some(10.8), Some(300), Some(true))
        );
        assert_eq!(s.limits.pump_dry_guard, Some(DryGuard::Level));
        assert_eq!(
            (
                s.limits.pump_dry_grace_ms,
                s.limits.pump_dry_grace_min_ms,
                s.limits.pump_dry_grace_max_ms
            ),
            (Some(1200), Some(300), Some(5000))
        );
        let back = serde_json::to_value(&s).unwrap();
        let golden: serde_json::Value = serde_json::from_str(&fixture("system")).unwrap();
        for k in [
            "pumpDryGuard",
            "pumpDryGraceMs",
            "pumpDryGraceMinMs",
            "pumpDryGraceMaxMs",
            "pumpDryGuardAsked",
            "pumpDryGuardWhy",
            "pumpDryGuardApp",
            "pumpDryCurrentA",
            "pumpDryCurrentMinA",
            "pumpDryCurrentMaxA",
            "waterLowMinCm",
            "waterLowMaxCm",
            "waterLowHoldMs",
            "waterLowHoldMinMs",
            "waterLowHoldMaxMs",
            "pumpBrownoutV",
            "pumpBrownoutMs",
            "pumpBrownoutPi",
        ] {
            assert!(!golden["limits"][k].is_null(), "{k} is in the fixture");
            assert_eq!(back["limits"][k], golden["limits"][k], "{k} round-trips");
        }
        let l = &s.limits;
        assert_eq!(
            (l.pump_dry_guard_asked, l.pump_dry_guard_app, l.pump_dry_current_a),
            (Some(DryGuard::Current), Some(true), Some(0.8))
        );
        assert!(l.pump_dry_guard_why.as_deref().unwrap().contains("ina219"));
        assert_eq!(
            (l.pump_dry_current_min_a, l.pump_dry_current_max_a),
            (Some(0.3), Some(3.0))
        );
        assert_eq!((l.water_low_min_cm, l.water_low_max_cm), (Some(8.0), Some(19.0)));
        assert_eq!(
            (
                l.water_low_hold_ms,
                l.water_low_hold_min_ms,
                l.water_low_hold_max_ms
            ),
            (Some(0), Some(0), Some(60_000))
        );
        assert_eq!(s.board.as_deref(), Some("Raspberry Pi Zero 2 W Rev 1.0"));
        let old: SystemInfo = serde_json::from_str(&fixture("system_without_board")).unwrap();
        assert_eq!(old.board, None);
        assert_eq!(old.limits.pump_dry_guard, None);
        assert_eq!(old.limits.pump_dry_current_a, None);
        let old_json = serde_json::to_value(&old).unwrap();
        assert_eq!(old.limits.pump_brownout_ms, None);
        // An older hald's limits come back with nothing new but a null cutoff.
        let mut keys: Vec<&String> = old_json["limits"].as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(
            keys,
            ["pumpDryCurrentA", "pumpMaxDuty", "pumpMaxRunS", "waterLowCm"]
        );
        assert!(old_json.get("board").is_none());
        let pg: PumpGuardCommand = serde_json::from_str(&fixture("pump_guard_command")).unwrap();
        assert_eq!(pg.dry_grace_ms, Some(1200));
        assert_eq!(
            serde_json::to_value(&pg).unwrap(),
            serde_json::from_str::<serde_json::Value>(&fixture("pump_guard_command")).unwrap()
        );
        let a: ActuatorState = serde_json::from_str(&fixture("actuator_state")).unwrap();
        assert_eq!(a.remaining_s, Some(19));
        let r: Reading = serde_json::from_str(&fixture("reading")).unwrap();
        assert_eq!(r.unit, "cm");
        let al: Alert = serde_json::from_str(&fixture("alert")).unwrap();
        assert_eq!(al.kind, AlertKind::PumpFault);
        let dl: Alert = serde_json::from_str(&fixture("alert_dose_fault")).unwrap();
        assert_eq!(dl.kind, AlertKind::DoseFault);
        let c: ActuatorCommand = serde_json::from_str(&fixture("command")).unwrap();
        assert_eq!(c.duration_s, Some(300));
        let cc: CalibrationCommand = serde_json::from_str(&fixture("calibration_command")).unwrap();
        assert_eq!(cc.point, CalibrationPoint::Mid);
        assert_eq!(cc.value, Some(7.0));
        let inv: DeviceInventory = serde_json::from_str(&fixture("device_inventory")).unwrap();
        assert_eq!(inv.sensors[1].source, DeviceSource::User);
        assert_eq!(inv.sensors[2].status, DeviceStatus::Absent);
        assert_eq!(inv.addable[0].default_addr, Some(0x63));
        assert!(inv.addable[0].calibration[1].optional);
        let dc: DeviceCommand = serde_json::from_str(&fixture("device_command")).unwrap();
        assert_eq!(dc.op, DeviceOp::Add);
        let be: ButtonEvent = serde_json::from_str(&fixture("button_event")).unwrap();
        assert_eq!(be.press, ButtonPress::Setup);
        let dr: DeviceResult = serde_json::from_str(&fixture("device_result")).unwrap();
        assert!(!dr.ok);
        let cr: CalibrationResult = serde_json::from_str(&fixture("calibration_result")).unwrap();
        assert!(cr.ok);
        assert_eq!(cr.points, Some(1));
    }
}
