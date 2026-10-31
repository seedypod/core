//! Driver traits. A driver is dumb: it reads a value or sets a level. All
//! policy (limits, interlocks, latching) lives in [`crate::safety`], so a new
//! driver — a pH probe, a dosing pump — gets the same protection for free.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::contract::{ActuatorId, CalibrationCommand, Quality, Reading, SensorId};
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
    /// Store a calibration point; returns how many points the probe now holds,
    /// if it reports that. Only probes that calibrate in-circuit (EZO) override this.
    fn calibrate(&mut self, _cmd: &CalibrationCommand) -> Result<Option<u8>, DeviceError> {
        Err(DeviceError::Other(format!(
            "{} does not support calibration",
            serde_json::to_value(self.id())
                .ok()
                .and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_default()
        )))
    }
}

pub trait Actuator: Send {
    fn id(&self) -> ActuatorId;
    fn probe(&mut self) -> Result<(), DeviceError>;
    /// Apply a level 0–100 (0 = off). Drivers never clamp; the guard already did.
    fn set_level(&mut self, level: f64) -> Result<(), DeviceError>;
    fn level(&self) -> f64;
}

/// A digital input that is either asserted or not (the PCB over-temperature
/// alert line). Surfaces as an alert / HA `binary_sensor`, not a `Reading`.
pub trait BinarySensor: Send {
    fn name(&self) -> &str;
    fn probe(&mut self) -> Result<(), DeviceError>;
    fn is_active(&mut self) -> Result<bool, DeviceError>;
}

/// A still camera. `capture` returns a complete JPEG; callers serialise access
/// (one reader per device — upstream garden-of-eden #117).
pub trait Camera: Send {
    fn name(&self) -> &str;
    fn capture(&mut self) -> Result<Vec<u8>, DeviceError>;
}

/// One quantity from a device that reports several at once
/// (INA219: V/A/W; DHT20: temperature + humidity).
#[derive(Debug, Clone, PartialEq)]
pub struct Measurement {
    pub id: SensorId,
    pub value: f64,
    pub unit: &'static str,
}

/// A driver that yields several [`Measurement`]s per bus transaction. Split it
/// into per-id [`Sensor`]s with [`split_multi`]; the facets share one cached
/// transaction so the bus is touched once per `ttl`, not once per quantity.
pub trait MultiSensor: Send {
    fn ids(&self) -> Vec<SensorId>;
    fn probe(&mut self) -> Result<(), DeviceError>;
    fn measure(&mut self) -> Result<Vec<Measurement>, DeviceError>;
}

struct Cached {
    inner: Box<dyn MultiSensor>,
    ttl: Duration,
    at: Option<Instant>,
    last: Vec<Measurement>,
}

impl Cached {
    fn fresh(&mut self, now: Instant) -> Result<&[Measurement], DeviceError> {
        if self.at.map_or(true, |t| now.duration_since(t) >= self.ttl) {
            self.last = self.inner.measure()?;
            self.at = Some(now);
        }
        Ok(&self.last)
    }
}

/// Per-quantity view over a shared [`MultiSensor`].
pub struct Facet {
    id: SensorId,
    source: Arc<Mutex<Cached>>,
}

impl Sensor for Facet {
    fn id(&self) -> SensorId {
        self.id
    }
    fn probe(&mut self) -> Result<(), DeviceError> {
        let mut c = self
            .source
            .lock()
            .map_err(|e| DeviceError::Other(e.to_string()))?;
        c.at = None;
        c.inner.probe()
    }
    fn read(&mut self) -> Result<Reading, DeviceError> {
        let mut c = self
            .source
            .lock()
            .map_err(|e| DeviceError::Other(e.to_string()))?;
        let id = self.id;
        let m = c
            .fresh(Instant::now())?
            .iter()
            .find(|m| m.id == id)
            .ok_or_else(|| DeviceError::Other(format!("{id:?} missing from measurement")))?;
        Ok(Reading::new(m.value, m.unit))
    }
}

/// Split a multi-quantity driver into one [`Sensor`] per id, sharing a cache
/// that is refreshed at most once per `ttl`.
pub fn split_multi(inner: Box<dyn MultiSensor>, ttl: Duration) -> Vec<Box<dyn Sensor>> {
    let ids = inner.ids();
    let shared = Arc::new(Mutex::new(Cached {
        inner,
        ttl,
        at: None,
        last: Vec::new(),
    }));
    ids.into_iter()
        .map(|id| {
            Box::new(Facet {
                id,
                source: shared.clone(),
            }) as Box<dyn Sensor>
        })
        .collect()
}

/// The unit string the contract expects for each sensor id.
pub fn canonical_unit(id: SensorId) -> &'static str {
    match id {
        SensorId::AirTemp | SensorId::PcbTemp | SensorId::WaterTemp => "°C",
        SensorId::Humidity | SensorId::WaterLevelPct => "%",
        SensorId::WaterDistance => "cm",
        SensorId::PumpV => "V",
        SensorId::PumpA => "A",
        SensorId::PumpW => "W",
        SensorId::Ph => "pH",
        SensorId::Ec => "mS/cm",
    }
}

impl Reading {
    /// A good-quality reading stamped now, rounded to 2 decimals.
    pub fn new(value: f64, unit: &str) -> Self {
        Self {
            ts: now_rfc3339(),
            value: (value * 100.0).round() / 100.0,
            unit: unit.to_owned(),
            quality: Quality::Good,
        }
    }
}

/// RFC 3339 timestamp without pulling in chrono (good enough for telemetry).
pub fn now_rfc3339() -> String {
    rfc3339_from_epoch(now_epoch_s())
}

/// Seconds since the Unix epoch (0 if the clock is before 1970).
pub fn now_epoch_s() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// RFC 3339 (UTC, second precision) for an epoch-seconds value.
pub fn rfc3339_from_epoch(secs: u64) -> String {
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
    use super::*;

    #[test]
    fn timestamp_looks_like_rfc3339() {
        let t = now_rfc3339();
        assert_eq!(t.len(), 20, "{t}");
        assert!(t.ends_with('Z') && t.contains('T'));
    }

    #[test]
    fn civil_date_is_correct_for_known_epochs() {
        assert_eq!(rfc3339_from_epoch(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339_from_epoch(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(rfc3339_from_epoch(1_793_419_043), "2026-10-31T03:57:23Z");
    }

    struct Fake {
        calls: usize,
    }
    impl MultiSensor for Fake {
        fn ids(&self) -> Vec<SensorId> {
            vec![SensorId::PumpV, SensorId::PumpA]
        }
        fn probe(&mut self) -> Result<(), DeviceError> {
            Ok(())
        }
        fn measure(&mut self) -> Result<Vec<Measurement>, DeviceError> {
            self.calls += 1;
            Ok(vec![
                Measurement {
                    id: SensorId::PumpV,
                    value: 12.0 + self.calls as f64,
                    unit: "V",
                },
                Measurement {
                    id: SensorId::PumpA,
                    value: 0.5,
                    unit: "A",
                },
            ])
        }
    }

    #[test]
    fn split_multi_shares_one_transaction_within_ttl() {
        let mut facets = split_multi(Box::new(Fake { calls: 0 }), Duration::from_secs(60));
        assert_eq!(facets.len(), 2);
        assert_eq!(facets[0].id(), SensorId::PumpV);
        let v = facets[0].read().unwrap();
        let a = facets[1].read().unwrap();
        assert_eq!((v.value, v.unit.as_str()), (13.0, "V"));
        assert_eq!((a.value, a.unit.as_str()), (0.5, "A"));
        // Second read within ttl: same transaction (calls still 1 → 13.0).
        assert_eq!(facets[0].read().unwrap().value, 13.0);
        // Probe invalidates the cache.
        facets[0].probe().unwrap();
        assert_eq!(facets[0].read().unwrap().value, 14.0);
    }

    #[test]
    fn split_multi_refreshes_after_ttl() {
        let mut facets = split_multi(Box::new(Fake { calls: 0 }), Duration::ZERO);
        assert_eq!(facets[0].read().unwrap().value, 13.0);
        assert_eq!(facets[0].read().unwrap().value, 14.0);
    }

    struct Partial;
    impl MultiSensor for Partial {
        fn ids(&self) -> Vec<SensorId> {
            vec![SensorId::Ph]
        }
        fn probe(&mut self) -> Result<(), DeviceError> {
            Ok(())
        }
        fn measure(&mut self) -> Result<Vec<Measurement>, DeviceError> {
            Ok(vec![])
        }
    }

    #[test]
    fn facet_errors_when_its_quantity_is_missing() {
        let mut f = split_multi(Box::new(Partial), Duration::ZERO);
        assert!(matches!(f[0].read(), Err(DeviceError::Other(_))));
    }

    #[test]
    fn canonical_units_cover_every_id() {
        assert_eq!(canonical_unit(SensorId::Ec), "mS/cm");
        assert_eq!(canonical_unit(SensorId::WaterDistance), "cm");
        assert_eq!(canonical_unit(SensorId::Ph), "pH");
        assert_eq!(Reading::new(1.2345, "x").value, 1.23);
    }
}
