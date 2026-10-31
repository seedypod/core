//! Dosing guard (Phase 6.3, ADR-0014 *Auto-dosing safety*).
//!
//! A peristaltic dosing pump is the one actuator that can poison a reservoir:
//! an unbounded pH-down dose kills the crop. The guard is the only path to a
//! dosing driver, and like [`super::PumpGuard`] it is pure and clock-injected:
//!
//! 1. **Off by default** — `enabled = false` refuses every start.
//! 2. **Bounded doses** — a dose is a volume (ml) converted to seconds by the
//!    pump's calibration, clamped to `max_single_ml`; there is no "on".
//! 3. **Hard daily cap** — the running total over a UTC day never exceeds
//!    `max_daily_ml`; a dose that would cross it is refused, not trimmed.
//! 4. **Lockout** — after `max_doses_per_day` doses the guard latches off
//!    until [`DoseGuard::acknowledge`]; day rollover does not clear it.
//! 5. **Stop always works**, latched or not.

use std::time::Duration;

use crate::contract::ActuatorCommand;
use crate::safety::Decision;

#[derive(Debug, Clone, PartialEq)]
pub struct DoseLimits {
    /// Dosing is refused entirely unless this is true.
    pub enabled: bool,
    /// Pump calibration: millilitres delivered per second at full drive.
    pub ml_per_s: f64,
    /// Dose volume used when a command carries no `durationS`.
    pub default_dose_ml: f64,
    /// Largest single dose; larger requests are clamped to this.
    pub max_single_ml: f64,
    /// Hard cap on the total volume per UTC day.
    pub max_daily_ml: f64,
    /// Lockout after this many doses in one UTC day (0 = no lockout).
    pub max_doses_per_day: u32,
}

impl Default for DoseLimits {
    fn default() -> Self {
        Self {
            enabled: false,
            ml_per_s: 1.0,
            default_dose_ml: 5.0,
            max_single_ml: 10.0,
            max_daily_ml: 30.0,
            max_doses_per_day: 4,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DoseRefusal {
    #[error("refused: dosing is disabled (enable it in hal.toml)")]
    Disabled,
    #[error("dosing locked out: {0}; acknowledge before dosing again")]
    Latched(String),
    #[error("refused: daily cap reached ({dosed_ml} of {cap_ml} ml dosed today)")]
    DailyCap { dosed_ml: u32, cap_ml: u32 },
    #[error("refused: a dose is already running")]
    Busy,
}

/// Persistable counters so a restart does not reset the daily cap.
#[derive(Debug, Clone, PartialEq, Default, serde::Serialize, serde::Deserialize)]
pub struct DoseLedger {
    /// UTC day index (epoch seconds / 86 400) the counters belong to.
    pub day: u64,
    pub dosed_ml: f64,
    pub doses: u32,
    pub fault: Option<String>,
}

#[derive(Debug)]
pub struct DoseGuard {
    limits: DoseLimits,
    day: u64,
    dosed_ml: f64,
    doses: u32,
    running_until: Option<u64>,
    fault: Option<String>,
}

fn day_of(now_s: u64) -> u64 {
    now_s / 86_400
}

impl DoseGuard {
    pub fn new(limits: DoseLimits) -> Self {
        Self {
            limits,
            day: 0,
            dosed_ml: 0.0,
            doses: 0,
            running_until: None,
            fault: None,
        }
    }

    pub fn limits(&self) -> &DoseLimits {
        &self.limits
    }
    pub fn fault(&self) -> Option<&str> {
        self.fault.as_deref()
    }
    pub fn is_running(&self, now_s: u64) -> bool {
        self.running_until.is_some_and(|t| t > now_s)
    }
    pub fn remaining(&self, now_s: u64) -> Option<u64> {
        self.running_until.map(|t| t.saturating_sub(now_s))
    }
    pub fn dosed_today_ml(&self, now_s: u64) -> f64 {
        if day_of(now_s) == self.day {
            self.dosed_ml
        } else {
            0.0
        }
    }
    pub fn doses_today(&self, now_s: u64) -> u32 {
        if day_of(now_s) == self.day {
            self.doses
        } else {
            0
        }
    }

    /// Snapshot the counters for persistence.
    pub fn ledger(&self) -> DoseLedger {
        DoseLedger {
            day: self.day,
            dosed_ml: self.dosed_ml,
            doses: self.doses,
            fault: self.fault.clone(),
        }
    }

    /// Restore counters saved by [`DoseGuard::ledger`]. A persisted lockout
    /// stays latched: a reboot is not an acknowledgement.
    pub fn restore(&mut self, ledger: DoseLedger) {
        self.day = ledger.day;
        self.dosed_ml = ledger.dosed_ml;
        self.doses = ledger.doses;
        self.fault = ledger.fault;
    }

    fn roll_day(&mut self, now_s: u64) {
        let d = day_of(now_s);
        if d != self.day {
            self.day = d;
            self.dosed_ml = 0.0;
            self.doses = 0;
        }
    }

    /// Seconds to run for `ml` at this pump's calibration (ceil, ≥ 1 s).
    pub fn seconds_for_ml(&self, ml: f64) -> u64 {
        let s = (ml / self.limits.ml_per_s.max(1e-9)).ceil();
        (s.max(1.0)) as u64
    }

    /// Evaluate a dose request. `durationS` on the command is interpreted as
    /// seconds of pumping and converted back to ml through the calibration;
    /// `level` is ignored (a MOSFET is on or off).
    pub fn request(&mut self, cmd: &ActuatorCommand, now_s: u64) -> Result<Decision, DoseRefusal> {
        let want_on = match cmd.on {
            Some(on) => on,
            None => cmd.level.is_some_and(|l| l > 0.0) || cmd.duration_s.is_some(),
        };
        if !want_on {
            self.running_until = None;
            return Ok(Decision::Stop);
        }
        if !self.limits.enabled {
            return Err(DoseRefusal::Disabled);
        }
        if let Some(f) = &self.fault {
            return Err(DoseRefusal::Latched(f.clone()));
        }
        if self.is_running(now_s) {
            return Err(DoseRefusal::Busy);
        }
        self.roll_day(now_s);

        let requested_ml = cmd
            .duration_s
            .map(|s| s as f64 * self.limits.ml_per_s)
            .unwrap_or(self.limits.default_dose_ml);
        let ml = requested_ml.clamp(0.0, self.limits.max_single_ml);
        if ml <= 0.0 {
            return Ok(Decision::Stop);
        }
        if self.dosed_ml + ml > self.limits.max_daily_ml + 1e-9 {
            return Err(DoseRefusal::DailyCap {
                dosed_ml: self.dosed_ml.round() as u32,
                cap_ml: self.limits.max_daily_ml.round() as u32,
            });
        }
        let secs = self.seconds_for_ml(ml);
        self.dosed_ml += ml;
        self.doses += 1;
        self.running_until = Some(now_s + secs);
        if self.limits.max_doses_per_day > 0 && self.doses >= self.limits.max_doses_per_day {
            // The dose that reaches the count still runs; the *next* one is refused.
            self.fault = Some("lockout".into());
        }
        Ok(Decision::Run {
            level: 100.0,
            deadline_in: Duration::from_secs(secs),
        })
    }

    /// Periodic check; `Some(Stop)` once the dose deadline has passed.
    pub fn tick(&mut self, now_s: u64) -> Option<Decision> {
        if self.running_until.is_some() && !self.is_running(now_s) {
            self.running_until = None;
            return Some(Decision::Stop);
        }
        None
    }

    /// Clear a lockout. The caller is responsible for having checked the reservoir.
    pub fn acknowledge(&mut self) {
        self.fault = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn enabled() -> DoseLimits {
        DoseLimits {
            enabled: true,
            ml_per_s: 2.0,
            default_dose_ml: 4.0,
            max_single_ml: 10.0,
            max_daily_ml: 20.0,
            max_doses_per_day: 3,
        }
    }
    fn dose(duration_s: Option<u64>) -> ActuatorCommand {
        ActuatorCommand {
            on: Some(true),
            level: None,
            duration_s,
        }
    }
    const T0: u64 = 1_793_419_043; // 2026-10-31T03:57:23Z

    #[test]
    fn disabled_by_default_refuses_everything_but_stop() {
        let mut g = DoseGuard::new(DoseLimits::default());
        assert!(!g.limits().enabled);
        assert_eq!(g.request(&dose(None), T0), Err(DoseRefusal::Disabled));
        let off = ActuatorCommand {
            on: Some(false),
            ..Default::default()
        };
        assert_eq!(g.request(&off, T0), Ok(Decision::Stop));
    }

    #[test]
    fn default_dose_is_converted_through_calibration() {
        let mut g = DoseGuard::new(enabled());
        let d = g.request(&dose(None), T0).unwrap();
        // 4 ml at 2 ml/s = 2 s.
        assert_eq!(
            d,
            Decision::Run {
                level: 100.0,
                deadline_in: Duration::from_secs(2)
            }
        );
        assert!(g.is_running(T0 + 1));
        assert_eq!(g.remaining(T0 + 1), Some(1));
        assert_eq!(g.dosed_today_ml(T0), 4.0);
        assert_eq!(g.doses_today(T0), 1);
    }

    #[test]
    fn duration_is_interpreted_as_seconds_and_clamped_to_max_single() {
        let mut g = DoseGuard::new(enabled());
        // 30 s × 2 ml/s = 60 ml → clamped to 10 ml → 5 s.
        let d = g.request(&dose(Some(30)), T0).unwrap();
        assert!(matches!(d, Decision::Run { deadline_in, .. } if deadline_in == Duration::from_secs(5)));
        assert_eq!(g.dosed_today_ml(T0), 10.0);
    }

    #[test]
    fn seconds_for_ml_rounds_up_and_is_at_least_one() {
        let g = DoseGuard::new(enabled());
        assert_eq!(g.seconds_for_ml(0.1), 1);
        assert_eq!(g.seconds_for_ml(3.0), 2);
        assert_eq!(g.seconds_for_ml(4.0), 2);
    }

    #[test]
    fn daily_cap_refuses_rather_than_trims() {
        let mut g = DoseGuard::new(DoseLimits {
            max_doses_per_day: 0,
            ..enabled()
        });
        g.request(&dose(Some(5)), T0).unwrap(); // 10 ml
        g.tick(T0 + 10);
        g.request(&dose(Some(4)), T0 + 20).unwrap(); // 8 ml → 18
        g.tick(T0 + 30);
        assert_eq!(
            g.request(&dose(Some(2)), T0 + 40), // 4 ml would be 22 > 20
            Err(DoseRefusal::DailyCap {
                dosed_ml: 18,
                cap_ml: 20
            })
        );
        assert_eq!(g.dosed_today_ml(T0 + 40), 18.0);
        // A smaller dose that fits is fine.
        assert!(g.request(&dose(Some(1)), T0 + 50).is_ok());
    }

    #[test]
    fn counters_reset_on_utc_day_rollover() {
        let mut g = DoseGuard::new(DoseLimits {
            max_doses_per_day: 0,
            ..enabled()
        });
        g.request(&dose(Some(5)), T0).unwrap();
        g.tick(T0 + 10);
        let tomorrow = T0 + 86_400;
        assert_eq!(g.dosed_today_ml(tomorrow), 0.0);
        assert_eq!(g.doses_today(tomorrow), 0);
        g.request(&dose(Some(5)), tomorrow).unwrap();
        assert_eq!(g.dosed_today_ml(tomorrow), 10.0);
        assert_eq!(g.doses_today(tomorrow), 1);
    }

    #[test]
    fn lockout_after_n_doses_latches_across_days_until_acknowledged() {
        let mut g = DoseGuard::new(enabled());
        for i in 0..3u64 {
            let t = T0 + i * 100;
            g.request(&dose(Some(1)), t).unwrap();
            assert_eq!(g.tick(t + 5), Some(Decision::Stop));
        }
        assert_eq!(g.fault(), Some("lockout"));
        assert_eq!(
            g.request(&dose(None), T0 + 1000),
            Err(DoseRefusal::Latched("lockout".into()))
        );
        assert!(matches!(
            g.request(&dose(None), T0 + 86_400 * 2),
            Err(DoseRefusal::Latched(_))
        ));
        g.acknowledge();
        assert!(g.request(&dose(None), T0 + 86_400 * 2).is_ok());
    }

    #[test]
    fn busy_while_a_dose_runs_and_stop_always_works() {
        let mut g = DoseGuard::new(enabled());
        g.request(&dose(Some(5)), T0).unwrap();
        assert_eq!(g.request(&dose(Some(1)), T0 + 1), Err(DoseRefusal::Busy));
        let off = ActuatorCommand {
            on: Some(false),
            ..Default::default()
        };
        assert_eq!(g.request(&off, T0 + 1), Ok(Decision::Stop));
        assert!(!g.is_running(T0 + 1));
        assert_eq!(g.tick(T0 + 2), None);
        // Stop also works when latched.
        g.fault = Some("lockout".into());
        assert_eq!(g.request(&off, T0 + 3), Ok(Decision::Stop));
    }

    #[test]
    fn tick_stops_once_and_is_quiet_afterwards() {
        let mut g = DoseGuard::new(enabled());
        g.request(&dose(Some(1)), T0).unwrap();
        assert_eq!(g.tick(T0), None);
        assert_eq!(g.tick(T0 + 1), Some(Decision::Stop));
        assert_eq!(g.tick(T0 + 2), None);
        assert_eq!(g.remaining(T0 + 2), None);
    }

    #[test]
    fn implicit_on_from_level_or_duration_and_zero_volume_is_a_stop() {
        let mut g = DoseGuard::new(enabled());
        let by_level = ActuatorCommand {
            on: None,
            level: Some(100.0),
            duration_s: None,
        };
        assert!(matches!(g.request(&by_level, T0), Ok(Decision::Run { .. })));
        g.tick(T0 + 10);
        let nothing = ActuatorCommand::default();
        assert_eq!(g.request(&nothing, T0 + 10), Ok(Decision::Stop));
        let zero = ActuatorCommand {
            on: Some(true),
            level: None,
            duration_s: Some(0),
        };
        assert_eq!(g.request(&zero, T0 + 10), Ok(Decision::Stop));
    }

    #[test]
    fn ledger_round_trips_including_lockout() {
        let mut g = DoseGuard::new(DoseLimits {
            max_doses_per_day: 1,
            ..enabled()
        });
        g.request(&dose(Some(1)), T0).unwrap();
        let l = g.ledger();
        assert_eq!(l.doses, 1);
        assert_eq!(l.dosed_ml, 2.0);
        assert_eq!(l.fault.as_deref(), Some("lockout"));
        let mut h = DoseGuard::new(enabled());
        h.restore(l.clone());
        assert_eq!(h.dosed_today_ml(T0), 2.0);
        assert_eq!(h.fault(), Some("lockout"));
        let json = serde_json::to_string(&l).unwrap();
        let back: DoseLedger = serde_json::from_str(&json).unwrap();
        assert_eq!(back, l);
        // Lockout cleared → ledger carries no fault.
        h.acknowledge();
        assert_eq!(h.ledger().fault, None);
    }
}
