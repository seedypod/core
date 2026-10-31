//! Pump safety guard (ADR-0009, modelled on sleepypod ADR-0022).
//!
//! Every pump command — from MQTT, HTTP, the button, or a schedule — passes
//! through [`PumpGuard::request`]. The guard is pure and clock-injected so the
//! whole policy is unit-testable without hardware:
//!
//! 1. **Duty clamp** — `level` is clamped to `max_duty` (Gardyn's board browns
//!    out above ~30 %).
//! 2. **Bounded runs** — every start carries a deadline ≤ `max_run_s`; there is
//!    no unbounded "on".
//! 3. **Dry-run interlock** — a start is refused when the water distance (median
//!    of N samples, supplied by the caller) exceeds `water_low_cm`.
//! 4. **Over-temperature cutoff** — a start is refused, and a running pump is
//!    stopped, when the PCB temperature is above `over_temp_c`.
//! 5. **Latched faults** — a stop caused by (3) or (4) while running latches
//!    the pump off until [`PumpGuard::acknowledge`] is called. Auto-recovery is
//!    deliberately not offered: a pump that tripped is a hardware signal, not
//!    something to retry at 3 a.m. (sleepypod ADR-0022).

mod dosing;

use std::time::{Duration, Instant};

use crate::contract::ActuatorCommand;
pub use dosing::{DoseGuard, DoseLedger, DoseLimits, DoseRefusal};

#[derive(Debug, Clone, PartialEq)]
pub struct PumpLimits {
    pub max_run_s: u64,
    pub max_duty: f64,
    pub water_low_cm: Option<f64>,
    pub over_temp_c: Option<f64>,
}

impl Default for PumpLimits {
    fn default() -> Self {
        Self {
            max_run_s: 900,
            max_duty: 30.0,
            water_low_cm: Some(16.0),
            over_temp_c: Some(36.0),
        }
    }
}

/// Why a command was refused. Serialised into `ActuatorState.fault` / error replies.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Refusal {
    #[error("pump fault latched: {0}; acknowledge before restarting")]
    Latched(String),
    #[error("refused: water level low (dry-run interlock)")]
    WaterLow,
    #[error("refused: board over temperature")]
    OverTemp,
}

/// Live environment the guard needs at decision time.
#[derive(Debug, Clone, Copy, Default)]
pub struct Env {
    /// Median water distance (cm), `None` if the sensor is unavailable.
    pub water_distance_cm: Option<f64>,
    /// PCB temperature (°C), `None` if unavailable.
    pub pcb_temp_c: Option<f64>,
    /// The board's own over-temperature alert line (GPIO25) is asserted.
    pub over_temp_signal: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Decision {
    /// Drive the pump at `level` until `deadline`.
    Run { level: f64, deadline_in: Duration },
    /// Turn the pump off.
    Stop,
}

#[derive(Debug)]
pub struct PumpGuard {
    limits: PumpLimits,
    level: f64,
    running_until: Option<Instant>,
    fault: Option<String>,
}

impl PumpGuard {
    pub fn new(limits: PumpLimits) -> Self {
        Self {
            limits,
            level: 0.0,
            running_until: None,
            fault: None,
        }
    }

    pub fn limits(&self) -> &PumpLimits {
        &self.limits
    }

    pub fn fault(&self) -> Option<&str> {
        self.fault.as_deref()
    }

    pub fn level(&self) -> f64 {
        self.level
    }

    pub fn is_running(&self, now: Instant) -> bool {
        self.running_until.is_some_and(|t| t > now)
    }

    pub fn remaining(&self, now: Instant) -> Option<u64> {
        self.running_until
            .map(|t| t.saturating_duration_since(now).as_secs())
    }

    /// Evaluate a command. Returns what the driver should do, or why not.
    pub fn request(&mut self, cmd: &ActuatorCommand, env: Env, now: Instant) -> Result<Decision, Refusal> {
        let want_on = match (cmd.on, cmd.level) {
            (Some(on), _) => on,
            (None, Some(l)) => l > 0.0,
            (None, None) => self.is_running(now),
        };

        if !want_on {
            self.running_until = None;
            self.level = 0.0;
            return Ok(Decision::Stop);
        }

        if let Some(f) = &self.fault {
            return Err(Refusal::Latched(f.clone()));
        }
        if self.is_dry(env) {
            return Err(Refusal::WaterLow);
        }
        if self.is_hot(env) {
            return Err(Refusal::OverTemp);
        }

        let level = cmd.level.unwrap_or(if self.level > 0.0 {
            self.level
        } else {
            self.limits.max_duty
        });
        let level = level.clamp(0.0, self.limits.max_duty);
        let secs = cmd
            .duration_s
            .unwrap_or(self.limits.max_run_s)
            .min(self.limits.max_run_s);
        let deadline_in = Duration::from_secs(secs);
        self.level = level;
        self.running_until = Some(now + deadline_in);
        Ok(Decision::Run { level, deadline_in })
    }

    /// Periodic check while running. Returns `Some(Stop)` when the pump must be
    /// turned off: deadline reached (clean) or a fault condition (latched).
    pub fn tick(&mut self, env: Env, now: Instant) -> Option<Decision> {
        if !self.is_running(now) {
            if self.running_until.is_some() {
                // Deadline passed: clean end of a bounded run.
                self.running_until = None;
                self.level = 0.0;
                return Some(Decision::Stop);
            }
            return None;
        }
        if self.is_dry(env) {
            return Some(self.trip("dry-run"));
        }
        if self.is_hot(env) {
            return Some(self.trip("over-temp"));
        }
        None
    }

    /// Clear a latched fault. The caller is responsible for having fixed the cause.
    pub fn acknowledge(&mut self) {
        self.fault = None;
    }

    fn trip(&mut self, reason: &str) -> Decision {
        self.fault = Some(reason.to_owned());
        self.running_until = None;
        self.level = 0.0;
        Decision::Stop
    }

    fn is_dry(&self, env: Env) -> bool {
        match (self.limits.water_low_cm, env.water_distance_cm) {
            (Some(low), Some(d)) => d >= low,
            // Fail safe: if the interlock is configured but the sensor is gone, refuse.
            (Some(_), None) => true,
            (None, _) => false,
        }
    }

    fn is_hot(&self, env: Env) -> bool {
        env.over_temp_signal
            || matches!((self.limits.over_temp_c, env.pcb_temp_c), (Some(max), Some(t)) if t >= max)
    }
}

/// Median of a small sample set; the guard is fed this, never a single ping
/// (upstream bug #111: guard and alert disagreed because one used a raw read).
pub fn median(samples: &mut [f64]) -> Option<f64> {
    if samples.is_empty() {
        return None;
    }
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = samples.len();
    Some(if n % 2 == 1 {
        samples[n / 2]
    } else {
        (samples[n / 2 - 1] + samples[n / 2]) / 2.0
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn guard() -> PumpGuard {
        PumpGuard::new(PumpLimits {
            max_run_s: 900,
            max_duty: 30.0,
            water_low_cm: Some(16.0),
            over_temp_c: Some(36.0),
        })
    }
    fn wet() -> Env {
        Env {
            water_distance_cm: Some(7.0),
            pcb_temp_c: Some(30.0),
            over_temp_signal: false,
        }
    }
    fn on(level: Option<f64>, duration_s: Option<u64>) -> ActuatorCommand {
        ActuatorCommand {
            on: Some(true),
            level,
            duration_s,
        }
    }

    #[test]
    fn clamps_duty_to_max() {
        let mut g = guard();
        let d = g.request(&on(Some(100.0), None), wet(), Instant::now()).unwrap();
        assert_eq!(
            d,
            Decision::Run {
                level: 30.0,
                deadline_in: Duration::from_secs(900)
            }
        );
    }

    #[test]
    fn every_run_is_bounded_by_max_run() {
        let mut g = guard();
        let d = g.request(&on(None, Some(36_000)), wet(), Instant::now()).unwrap();
        assert!(matches!(d, Decision::Run { deadline_in, .. } if deadline_in == Duration::from_secs(900)));
    }

    #[test]
    fn bounded_run_ends_cleanly_without_a_fault() {
        let mut g = guard();
        let t0 = Instant::now();
        g.request(&on(None, Some(10)), wet(), t0).unwrap();
        assert!(g.tick(wet(), t0 + Duration::from_secs(5)).is_none());
        assert_eq!(g.tick(wet(), t0 + Duration::from_secs(11)), Some(Decision::Stop));
        assert_eq!(g.fault(), None);
        assert!(!g.is_running(t0 + Duration::from_secs(12)));
    }

    #[test]
    fn refuses_start_when_dry_or_sensor_missing() {
        let mut g = guard();
        let dry = Env {
            water_distance_cm: Some(17.0),
            pcb_temp_c: Some(30.0),
            over_temp_signal: false,
        };
        assert_eq!(
            g.request(&on(None, None), dry, Instant::now()),
            Err(Refusal::WaterLow)
        );
        let missing = Env {
            water_distance_cm: None,
            pcb_temp_c: Some(30.0),
            over_temp_signal: false,
        };
        assert_eq!(
            g.request(&on(None, None), missing, Instant::now()),
            Err(Refusal::WaterLow)
        );
    }

    #[test]
    fn refuses_start_when_hot() {
        let mut g = guard();
        let hot = Env {
            water_distance_cm: Some(7.0),
            pcb_temp_c: Some(36.5),
            over_temp_signal: false,
        };
        assert_eq!(
            g.request(&on(None, None), hot, Instant::now()),
            Err(Refusal::OverTemp)
        );
    }

    #[test]
    fn over_temp_signal_refuses_and_trips_even_without_a_temperature_limit() {
        let mut g = PumpGuard::new(PumpLimits {
            over_temp_c: None,
            ..PumpLimits::default()
        });
        let t0 = Instant::now();
        g.request(&on(None, None), wet(), t0).unwrap();
        let signalled = Env {
            over_temp_signal: true,
            ..wet()
        };
        assert_eq!(
            g.tick(signalled, t0 + Duration::from_secs(1)),
            Some(Decision::Stop)
        );
        assert_eq!(g.fault(), Some("over-temp"));
        g.acknowledge();
        assert_eq!(
            g.request(&on(None, None), signalled, t0 + Duration::from_secs(2)),
            Err(Refusal::OverTemp)
        );
    }

    #[test]
    fn running_dry_trips_and_latches_until_acknowledged() {
        let mut g = guard();
        let t0 = Instant::now();
        g.request(&on(None, None), wet(), t0).unwrap();
        let dry = Env {
            water_distance_cm: Some(16.0),
            pcb_temp_c: Some(30.0),
            over_temp_signal: false,
        };
        assert_eq!(g.tick(dry, t0 + Duration::from_secs(60)), Some(Decision::Stop));
        assert_eq!(g.fault(), Some("dry-run"));
        // Even with water back, the latch holds.
        assert!(matches!(
            g.request(&on(None, None), wet(), t0 + Duration::from_secs(61)),
            Err(Refusal::Latched(_))
        ));
        g.acknowledge();
        assert!(g
            .request(&on(None, None), wet(), t0 + Duration::from_secs(62))
            .is_ok());
    }

    #[test]
    fn stop_always_works_even_when_latched() {
        let mut g = guard();
        let t0 = Instant::now();
        g.request(&on(None, None), wet(), t0).unwrap();
        g.tick(
            Env {
                water_distance_cm: Some(40.0),
                pcb_temp_c: None,
                over_temp_signal: false,
            },
            t0 + Duration::from_secs(1),
        );
        let off = ActuatorCommand {
            on: Some(false),
            level: None,
            duration_s: None,
        };
        assert_eq!(
            g.request(&off, wet(), t0 + Duration::from_secs(2)),
            Ok(Decision::Stop)
        );
    }

    #[test]
    fn interlock_disabled_when_unconfigured() {
        let mut g = PumpGuard::new(PumpLimits {
            water_low_cm: None,
            over_temp_c: None,
            ..PumpLimits::default()
        });
        let env = Env {
            water_distance_cm: None,
            pcb_temp_c: None,
            over_temp_signal: false,
        };
        assert!(g.request(&on(None, None), env, Instant::now()).is_ok());
    }

    #[test]
    fn median_handles_odd_even_and_empty() {
        assert_eq!(median(&mut [3.0, 1.0, 2.0]), Some(2.0));
        assert_eq!(median(&mut [4.0, 1.0, 3.0, 2.0]), Some(2.5));
        assert_eq!(median(&mut []), None);
    }
}
