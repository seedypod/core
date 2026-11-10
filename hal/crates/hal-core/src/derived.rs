//! Sensors derived from other sensors, hardware-free:
//!
//! * [`MedianSensor`] — wraps a noisy driver (the ultrasonic ranger) and
//!   returns the median of N raw samples, so the guard and the alert path see
//!   the same number (upstream garden-of-eden #111).
//! * [`LevelPctSensor`] — turns the last median distance into a tank-level
//!   percentage from the configured full/empty geometry, as trusted as the
//!   distance it came from.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::contract::{Quality, Reading, SensorId};
use crate::device::{DeviceError, Sensor};
use crate::safety::median;

/// Last median distance and its quality, shared with [`LevelPctSensor`].
pub type SharedDistance = Arc<Mutex<Option<(f64, Quality)>>>;

pub struct MedianSensor {
    inner: Box<dyn Sensor>,
    samples: usize,
    gap: Duration,
    last: SharedDistance,
}

impl MedianSensor {
    pub fn new(inner: Box<dyn Sensor>, samples: usize) -> Self {
        Self {
            inner,
            samples: samples.max(1),
            gap: Duration::ZERO,
            last: Arc::new(Mutex::new(None)),
        }
    }

    /// Wait this long between samples. An ultrasonic ping fired while the
    /// last one still rings round a small tank hears its echo, or nothing.
    pub fn with_gap(mut self, gap: Duration) -> Self {
        self.gap = gap;
        self
    }

    /// Handle to the last median, for a derived [`LevelPctSensor`].
    pub fn shared(&self) -> SharedDistance {
        self.last.clone()
    }
}

impl Sensor for MedianSensor {
    fn id(&self) -> SensorId {
        self.inner.id()
    }
    fn probe(&mut self) -> Result<(), DeviceError> {
        self.inner.probe()
    }
    fn read(&mut self) -> Result<Reading, DeviceError> {
        let mut vals = Vec::with_capacity(self.samples);
        let mut unit = String::new();
        let mut last_err = None;
        for i in 0..self.samples {
            if i > 0 && !self.gap.is_zero() {
                std::thread::sleep(self.gap);
            }
            match self.inner.read() {
                Ok(r) => {
                    unit = r.unit;
                    vals.push(r.value);
                }
                Err(e) => last_err = Some(e),
            }
        }
        let n = vals.len();
        let Some(m) = median(&mut vals) else {
            *self.last.lock().unwrap_or_else(|e| e.into_inner()) = None;
            return Err(last_err.unwrap_or(DeviceError::Timeout));
        };
        let mut r = Reading::new(m, &unit);
        // Fewer than half the samples answered: flag it rather than hide it.
        if n * 2 < self.samples {
            r.quality = Quality::Suspect;
        }
        *self.last.lock().unwrap_or_else(|e| e.into_inner()) = Some((m, r.quality));
        Ok(r)
    }
}

/// Tank geometry: distance from the sensor to the water surface when full and
/// when empty (cm). `full_cm < empty_cm`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TankGeometry {
    pub full_cm: f64,
    pub empty_cm: f64,
}

impl Default for TankGeometry {
    fn default() -> Self {
        Self {
            full_cm: 5.0,
            empty_cm: 20.0,
        }
    }
}

impl TankGeometry {
    /// 0–100 % from a surface distance, clamped.
    pub fn level_pct(&self, distance_cm: f64) -> f64 {
        let span = self.empty_cm - self.full_cm;
        if span <= 0.0 {
            return 0.0;
        }
        ((self.empty_cm - distance_cm) / span * 100.0).clamp(0.0, 100.0)
    }
}

pub struct LevelPctSensor {
    source: SharedDistance,
    geometry: TankGeometry,
}

impl LevelPctSensor {
    pub fn new(source: SharedDistance, geometry: TankGeometry) -> Self {
        Self { source, geometry }
    }
}

impl Sensor for LevelPctSensor {
    fn id(&self) -> SensorId {
        SensorId::WaterLevelPct
    }
    fn probe(&mut self) -> Result<(), DeviceError> {
        Ok(())
    }
    fn read(&mut self) -> Result<Reading, DeviceError> {
        let (d, quality) =
            (*self.source.lock().unwrap_or_else(|e| e.into_inner())).ok_or(DeviceError::NotPresent)?;
        let mut r = Reading::new(self.geometry.level_pct(d), "%");
        r.quality = quality;
        Ok(r)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Noisy {
        seq: Vec<Result<f64, ()>>,
    }
    impl Sensor for Noisy {
        fn id(&self) -> SensorId {
            SensorId::WaterDistance
        }
        fn probe(&mut self) -> Result<(), DeviceError> {
            Ok(())
        }
        fn read(&mut self) -> Result<Reading, DeviceError> {
            match self.seq.remove(0) {
                Ok(v) => Ok(Reading::new(v, "cm")),
                Err(()) => Err(DeviceError::Timeout),
            }
        }
    }

    #[test]
    fn median_sensor_returns_median_and_shares_it() {
        let inner = Noisy {
            seq: vec![Ok(40.0), Ok(7.0), Ok(7.2), Ok(6.9), Ok(1.0)],
        };
        let mut m = MedianSensor::new(Box::new(inner), 5);
        let shared = m.shared();
        let r = m.read().unwrap();
        assert_eq!((r.value, r.unit.as_str(), r.quality), (7.0, "cm", Quality::Good));
        assert_eq!(*shared.lock().unwrap(), Some((7.0, Quality::Good)));
        assert_eq!(m.id(), SensorId::WaterDistance);
        assert!(m.probe().is_ok());
    }

    #[test]
    fn median_sensor_flags_mostly_failed_sample_sets_and_errors_when_all_fail() {
        let inner = Noisy {
            seq: vec![Err(()), Err(()), Ok(8.0), Err(()), Err(())],
        };
        let mut m = MedianSensor::new(Box::new(inner), 5);
        assert_eq!(m.read().unwrap().quality, Quality::Suspect);

        let inner = Noisy {
            seq: vec![Err(()), Err(()), Err(())],
        };
        let mut m = MedianSensor::new(Box::new(inner), 3);
        let shared = m.shared();
        assert!(matches!(m.read(), Err(DeviceError::Timeout)));
        assert_eq!(*shared.lock().unwrap(), None);
    }

    #[test]
    fn level_pct_maps_geometry_and_clamps() {
        let g = TankGeometry::default();
        assert_eq!(g.level_pct(5.0), 100.0);
        assert_eq!(g.level_pct(20.0), 0.0);
        assert_eq!(g.level_pct(12.5), 50.0);
        assert_eq!(g.level_pct(2.0), 100.0);
        assert_eq!(g.level_pct(30.0), 0.0);
        let bad = TankGeometry {
            full_cm: 10.0,
            empty_cm: 10.0,
        };
        assert_eq!(bad.level_pct(5.0), 0.0);
    }

    #[test]
    fn level_sensor_reads_from_shared_distance() {
        let shared: SharedDistance = Arc::new(Mutex::new(None));
        let mut s = LevelPctSensor::new(shared.clone(), TankGeometry::default());
        assert_eq!(s.id(), SensorId::WaterLevelPct);
        assert!(s.probe().is_ok());
        assert!(matches!(s.read(), Err(DeviceError::NotPresent)));
        *shared.lock().unwrap() = Some((12.5, Quality::Good));
        let r = s.read().unwrap();
        assert_eq!((r.value, r.unit.as_str(), r.quality), (50.0, "%", Quality::Good));
        // A level from a distance too few pings agreed on is no better than it.
        *shared.lock().unwrap() = Some((12.5, Quality::Suspect));
        assert_eq!(s.read().unwrap().quality, Quality::Suspect);
    }

    #[test]
    fn two_answers_take_the_nearer_rather_than_their_mean() {
        // The unit's 53 cm "readings": a 12.7 cm surface and a stray 94 cm echo
        // averaged into a level of 0 %.
        let inner = Noisy {
            seq: vec![Err(()), Ok(12.7), Err(()), Ok(94.0), Err(())],
        };
        let mut m = MedianSensor::new(Box::new(inner), 5);
        let shared = m.shared();
        let r = m.read().unwrap();
        assert_eq!((r.value, r.quality), (12.7, Quality::Suspect));
        assert_eq!(*shared.lock().unwrap(), Some((12.7, Quality::Suspect)));
    }

    #[test]
    fn pings_are_spaced_by_the_gap() {
        let inner = Noisy {
            seq: vec![Ok(7.0), Ok(7.1), Ok(6.9)],
        };
        let mut m = MedianSensor::new(Box::new(inner), 3).with_gap(Duration::from_millis(20));
        let t = std::time::Instant::now();
        assert_eq!(m.read().unwrap().value, 7.0);
        // Two gaps between three pings, none before the first.
        assert!(t.elapsed() >= Duration::from_millis(40));
    }
}
