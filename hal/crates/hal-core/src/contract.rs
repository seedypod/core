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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub pump_max_run_s: u64,
    pub pump_max_duty: f64,
    pub water_low_cm: Option<f64>,
}

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

/// Physical button gesture, published on `event/button` as `{"press": "single"}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ButtonPress {
    Single,
    Double,
    Long,
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
    pub fn button(unit: &str) -> String {
        format!("{}/event/button", prefix(unit))
    }
    pub fn alert(unit: &str, kind: AlertKind) -> String {
        format!("{}/alert/{}", prefix(unit), snake(&kind))
    }
    pub fn alert_ack(unit: &str, kind: AlertKind) -> String {
        format!("{}/alert/{}/ack", prefix(unit), snake(&kind))
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
        assert_eq!(s.limits.pump_max_duty, 30.0);
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
        let cr: CalibrationResult = serde_json::from_str(&fixture("calibration_result")).unwrap();
        assert!(cr.ok);
        assert_eq!(cr.points, Some(1));
    }
}
