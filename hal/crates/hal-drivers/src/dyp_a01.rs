//! DYP-A01 waterproof ultrasonic ranger (trigger GPIO26, echo GPIO19) that
//! measures the distance from the lid to the water surface.
//!
//! This driver returns one raw ping. `hal_core::derived::MedianSensor` wraps
//! it so the guard and the alert path both see the median of N samples.

use std::time::Duration;

use hal_core::{DeviceError, Reading, Sensor, SensorId};

use crate::bus::{Clock, Delay, DigitalIn, DigitalOut};

/// Speed of sound at ~20 °C, cm/s.
pub const SOUND_CM_PER_S: f64 = 34_300.0;
pub const TRIGGER_PULSE: Duration = Duration::from_micros(10);

/// Echo high time → one-way distance in cm.
pub fn distance_cm(echo: Duration) -> f64 {
    echo.as_secs_f64() * SOUND_CM_PER_S / 2.0
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DypConfig {
    /// Give up waiting for the echo edge after this long.
    pub timeout: Duration,
    /// Readings beyond the sensor's rated range are rejected (DYP-A01: 450 cm).
    pub max_cm: f64,
    /// Below the blind zone the echo is garbage (DYP-A01: ~3 cm).
    pub min_cm: f64,
}

impl Default for DypConfig {
    fn default() -> Self {
        Self {
            timeout: Duration::from_millis(60),
            max_cm: 450.0,
            min_cm: 3.0,
        }
    }
}

pub struct DypA01<T: DigitalOut, E: DigitalIn, C: Clock, D: Delay> {
    trig: T,
    echo: E,
    clock: C,
    delay: D,
    cfg: DypConfig,
}

impl<T: DigitalOut, E: DigitalIn, C: Clock, D: Delay> DypA01<T, E, C, D> {
    pub fn new(trig: T, echo: E, clock: C, delay: D, cfg: DypConfig) -> Self {
        Self {
            trig,
            echo,
            clock,
            delay,
            cfg,
        }
    }

    /// One ping: the echo pulse width.
    pub fn ping(&mut self) -> Result<Duration, DeviceError> {
        self.trig.set(true)?;
        self.delay.sleep(TRIGGER_PULSE);
        self.trig.set(false)?;

        let t0 = self.clock.now();
        loop {
            if self.echo.is_high()? {
                break;
            }
            if self.clock.now().duration_since(t0) > self.cfg.timeout {
                return Err(DeviceError::Timeout);
            }
        }
        let start = self.clock.now();
        loop {
            if !self.echo.is_high()? {
                break;
            }
            if self.clock.now().duration_since(start) > self.cfg.timeout {
                return Err(DeviceError::Timeout);
            }
        }
        Ok(self.clock.now().duration_since(start))
    }
}

impl<T: DigitalOut, E: DigitalIn, C: Clock, D: Delay> Sensor for DypA01<T, E, C, D> {
    fn id(&self) -> SensorId {
        SensorId::WaterDistance
    }
    fn probe(&mut self) -> Result<(), DeviceError> {
        self.trig.set(false)
    }
    fn read(&mut self) -> Result<Reading, DeviceError> {
        let cm = distance_cm(self.ping()?);
        if cm < self.cfg.min_cm || cm > self.cfg.max_cm {
            return Err(DeviceError::Other(format!(
                "ultrasonic reading {cm:.1} cm out of range"
            )));
        }
        Ok(Reading::new(cm, "cm"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bus::fake::{FakeIn, FakeOut, NoDelay, StepClock};

    #[test]
    fn echo_width_to_distance() {
        assert!((distance_cm(Duration::from_micros(583)) - 10.0).abs() < 0.01);
        assert_eq!(distance_cm(Duration::ZERO), 0.0);
    }

    fn ranger(levels: &[bool], step_us: u64) -> DypA01<FakeOut, FakeIn, StepClock, NoDelay> {
        DypA01::new(
            FakeOut::default(),
            FakeIn::new(levels),
            StepClock::new(Duration::from_micros(step_us)),
            NoDelay::default(),
            DypConfig::default(),
        )
    }

    #[test]
    fn ping_times_the_high_pulse_after_a_trigger() {
        // Clock steps 100 µs per call: two polls low, rising edge, two polls
        // high, falling edge → 3 steps ≈ 300 µs ≈ 5.1 cm.
        let mut r = ranger(&[false, false, true, true, true, false], 100);
        let r0 = r.read().unwrap();
        assert!((r0.value - 5.15).abs() < 0.01, "{}", r0.value);
        assert_eq!(r0.unit, "cm");
        assert_eq!(r.trig.history, vec![true, false]);
        assert_eq!(r.delay.slept, vec![TRIGGER_PULSE]);
        assert_eq!(r.id(), SensorId::WaterDistance);
    }

    #[test]
    fn times_out_when_the_echo_never_rises_or_never_falls() {
        let mut never_rises = ranger(&[false], 20_000);
        assert!(matches!(never_rises.ping(), Err(DeviceError::Timeout)));
        let mut never_falls = ranger(&[true], 20_000);
        assert!(matches!(never_falls.ping(), Err(DeviceError::Timeout)));
    }

    #[test]
    fn out_of_range_pings_are_rejected() {
        // 1 µs steps → ~1.5 µs echo → 0.03 cm, below the blind zone.
        let mut r = ranger(&[true, false], 1);
        assert!(matches!(r.read(), Err(DeviceError::Other(_))));
        // 30 ms steps → 30 ms echo → 514 cm, beyond the rated range.
        let mut r = ranger(&[true, false], 30_000);
        assert!(matches!(r.read(), Err(DeviceError::Other(_))));
    }

    #[test]
    fn probe_parks_the_trigger_low() {
        let mut r = ranger(&[false], 1);
        r.probe().unwrap();
        assert_eq!(r.trig.history, vec![false]);
    }
}
