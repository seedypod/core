//! Driver traits. A driver is dumb: it reads a value or sets a level. All
//! policy (limits, interlocks, latching) lives in [`crate::safety`], so a new
//! driver — a pH probe, a dosing pump — gets the same protection for free.

use crate::contract::{ActuatorId, Reading, SensorId};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DeviceError {
    #[error("device not present")]
    NotPresent,
    #[error("bus error: {0}")]
    Bus(String),
    #[error("read timed out")]
    Timeout,
    #[error("{0}")]
    Other(String),
}

pub trait Sensor: Send {
    fn id(&self) -> SensorId;
    /// (Re)initialise. Called lazily and again after a read failure.
    fn probe(&mut self) -> Result<(), DeviceError>;
    fn read(&mut self) -> Result<Reading, DeviceError>;
}

pub trait Actuator: Send {
    fn id(&self) -> ActuatorId;
    fn probe(&mut self) -> Result<(), DeviceError>;
    /// Apply a level 0–100 (0 = off). Drivers never clamp; the guard already did.
    fn set_level(&mut self, level: f64) -> Result<(), DeviceError>;
    fn level(&self) -> f64;
}

/// RFC 3339 timestamp without pulling in chrono (good enough for telemetry).
pub fn now_rfc3339() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Civil-from-days (Howard Hinnant's algorithm).
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn timestamp_looks_like_rfc3339() {
        let t = super::now_rfc3339();
        assert_eq!(t.len(), 20, "{t}");
        assert!(t.ends_with('Z') && t.contains('T'));
    }
}
