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
//!    A running pump also stops when its current says it is pulling air: past a
//!    spin-up grace, every read of the pump monitor stays below `dry_current_a`
//!    for `dry_current_s` (#220). It raises the same dry-run fault.
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
    /// Below this pump current (A), past the spin-up grace, the pump is pulling
    /// air. `None` turns the current guard off.
    pub dry_current_a: Option<f64>,
    /// How long every current read must stay below `dry_current_a` to trip.
    pub dry_current_s: u64,
    /// How long after a start the current isn't judged, while the pump spins up and primes.
    pub dry_grace_s: u64,
}

impl Default for PumpLimits {
    fn default() -> Self {
        Self {
            max_run_s: 900,
            max_duty: 30.0,
            water_low_cm: Some(16.0),
            over_temp_c: Some(36.0),
            dry_current_a: None,
            dry_current_s: 5,
            dry_grace_s: 3,
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
    /// Pump current (A) from the pump monitor, `None` if there is none or the read failed.
    pub pump_current_a: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Decision {
    /// Drive the pump at `level` until `deadline`.
    Run { level: f64, deadline_in: Duration },
    /// Turn the pump off.
    Stop,
}

/// How long the water must read low (or not at all) while the pump runs before
/// it trips. The ranger drops a read now and then, most often with the pump
/// stirring the tank; one lost read must not latch a dry-run on a full tank. A
/// tank that is really low stays low, and a pump takes a few dry seconds.
pub const DRY_CONFIRM: Duration = Duration::from_secs(3);

/// The fault a dry pump latches, from either guard. The current guard adds why.
pub const DRY_RUN: &str = "dry-run";

/// Whether a latched fault is a dry-run (from the level or the current), which
/// clears itself once the water reads good, unlike the others.
pub fn is_dry_run(fault: &str) -> bool {
    fault == DRY_RUN || fault.starts_with("dry-run:")
}

/// Amps for a fault message: `0.4`, `1.25`, `0`.
fn amps(a: f64) -> String {
    let s = format!("{a:.2}");
    s.trim_end_matches('0').trim_end_matches('.').to_owned()
}

#[derive(Debug)]
pub struct PumpGuard {
    limits: PumpLimits,
    level: f64,
    running_until: Option<Instant>,
    fault: Option<String>,
    /// When the running pump first saw the water low or missing, in this run of such checks.
    dry_since: Option<Instant>,
    /// When this run started, for the current guard's spin-up grace.
    started: Option<Instant>,
    /// When the pump current first read below `dry_current_a`, in this run of such reads.
    starved_since: Option<Instant>,
}

impl PumpGuard {
    pub fn new(limits: PumpLimits) -> Self {
        Self {
            limits,
            level: 0.0,
            running_until: None,
            fault: None,
            dry_since: None,
            started: None,
            starved_since: None,
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
            self.started = None;
            self.starved_since = None;
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
        // A longer run asked for mid-run keeps its spin-up and its count of low reads.
        if !self.is_running(now) {
            self.started = Some(now);
            self.starved_since = None;
        }
        self.level = level;
        self.running_until = Some(now + deadline_in);
        self.dry_since = None;
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
                self.started = None;
                self.starved_since = None;
                return Some(Decision::Stop);
            }
            return None;
        }
        if !self.is_dry(env) {
            self.dry_since = None;
        } else if now.duration_since(*self.dry_since.get_or_insert(now)) >= DRY_CONFIRM {
            return Some(self.trip(DRY_RUN));
        }
        if let Some(why) = self.pulling_air(env, now) {
            return Some(self.trip(&why));
        }
        if self.is_hot(env) {
            return Some(self.trip("over-temp"));
        }
        None
    }

    /// The current guard: past the spin-up grace, every read of the pump current
    /// for `dry_current_s` came back below `dry_current_a`. A lost read is no
    /// evidence of a dry pump, so it starts the count again and can't trip it.
    fn pulling_air(&mut self, env: Env, now: Instant) -> Option<String> {
        let (Some(min), Some(started)) = (self.limits.dry_current_a, self.started) else {
            return None;
        };
        if now.duration_since(started) < Duration::from_secs(self.limits.dry_grace_s) {
            return None;
        }
        match env.pump_current_a {
            Some(a) if a < min => {
                let since = *self.starved_since.get_or_insert(now);
                let secs = self.limits.dry_current_s;
                (now.duration_since(since) >= Duration::from_secs(secs)).then(|| {
                    format!(
                        "{DRY_RUN}: pump drew {} A, below {} A for {secs} s: it's pulling air",
                        amps(a),
                        amps(min)
                    )
                })
            }
            _ => {
                self.starved_since = None;
                None
            }
        }
    }

    /// Clear a latched fault. The caller is responsible for having fixed the cause.
    pub fn acknowledge(&mut self) {
        self.fault = None;
    }

    fn trip(&mut self, reason: &str) -> Decision {
        self.fault = Some(reason.to_owned());
        self.dry_since = None;
        self.started = None;
        self.starved_since = None;
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
/// With an even count it takes the lower middle value, not their mean: a
/// ranger's errors only lengthen (a stray echo, a timer preempted mid-pulse),
/// so one good ping and one bad must not average to a level nobody measured.
pub fn median(samples: &mut [f64]) -> Option<f64> {
    if samples.is_empty() {
        return None;
    }
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = samples.len();
    Some(samples[(n - 1) / 2])
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
            ..PumpLimits::default()
        })
    }
    fn wet() -> Env {
        Env {
            water_distance_cm: Some(7.0),
            pcb_temp_c: Some(30.0),
            over_temp_signal: false,
            pump_current_a: Some(1.87),
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
            pump_current_a: None,
        };
        assert_eq!(
            g.request(&on(None, None), dry, Instant::now()),
            Err(Refusal::WaterLow)
        );
        let missing = Env {
            water_distance_cm: None,
            pcb_temp_c: Some(30.0),
            over_temp_signal: false,
            pump_current_a: None,
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
            pump_current_a: None,
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
    fn a_lost_read_or_a_blip_while_running_does_not_trip() {
        let mut g = guard();
        let t0 = Instant::now();
        g.request(&on(None, None), wet(), t0).unwrap();
        let lost = Env {
            water_distance_cm: None,
            ..wet()
        };
        // The unit's dry-run on a 3-gallon tank: one read lost mid-run.
        assert_eq!(g.tick(lost, t0 + Duration::from_secs(5)), None);
        assert_eq!(g.tick(wet(), t0 + Duration::from_secs(6)), None);
        // Low again later starts the count afresh.
        assert_eq!(g.tick(lost, t0 + Duration::from_secs(10)), None);
        assert_eq!(g.tick(lost, t0 + Duration::from_secs(12)), None);
        assert_eq!(g.fault(), None);
        // Still missing past the confirm time: the sensor is gone, so fail safe.
        assert_eq!(g.tick(lost, t0 + Duration::from_secs(13)), Some(Decision::Stop));
        assert_eq!(g.fault(), Some("dry-run"));
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
            pump_current_a: None,
        };
        let t1 = t0 + Duration::from_secs(60);
        assert_eq!(g.tick(dry, t1), None);
        assert_eq!(g.tick(dry, t1 + DRY_CONFIRM), Some(Decision::Stop));
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
                pump_current_a: None,
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
            pump_current_a: None,
        };
        assert!(g.request(&on(None, None), env, Instant::now()).is_ok());
    }

    // ---- the current guard (#220) -------------------------------------------

    /// Pump-current traces as `hald --pump-trace` writes them. The synthetic ones
    /// stand in until the unit's wet and dry runs are recorded; add those here.
    const WET_TRACES: &[(&str, &str)] = &[
        (
            "wet.synthetic",
            include_str!("../fixtures/pump_current/wet.synthetic.csv"),
        ),
        (
            "lost_reads.synthetic",
            include_str!("../fixtures/pump_current/lost_reads.synthetic.csv"),
        ),
    ];
    const DRY_TRACES: &[(&str, &str)] = &[(
        "dry.synthetic",
        include_str!("../fixtures/pump_current/dry.synthetic.csv"),
    )];

    /// The cutoff the traces are judged against: well under the 1.87 A seen wet at 30 % duty.
    fn current_guard() -> PumpGuard {
        PumpGuard::new(PumpLimits {
            dry_current_a: Some(1.2),
            ..PumpLimits::default()
        })
    }

    /// `(seconds since the start, pump_a)` per sample; an empty `pump_a` is a failed read.
    fn trace(csv: &str) -> Vec<(f64, Option<f64>)> {
        let mut rows = csv
            .lines()
            .filter(|l| !l.trim().is_empty() && !l.starts_with('#'));
        let header: Vec<&str> = rows.next().expect("a header row").split(',').collect();
        let col = |name| header.iter().position(|h| *h == name).expect(name);
        let (t, a) = (col("t_s"), col("pump_a"));
        rows.map(|l| {
            let f: Vec<&str> = l.split(',').collect();
            (f[t].parse().expect("t_s"), f[a].trim().parse().ok())
        })
        .collect()
    }

    /// Plays a trace through a running pump with a full tank: when it tripped and why.
    fn replay(g: &mut PumpGuard, csv: &str) -> Option<(f64, String)> {
        let t0 = Instant::now();
        g.request(&on(None, None), wet(), t0).unwrap();
        trace(csv).into_iter().find_map(|(t, a)| {
            let env = Env {
                pump_current_a: a,
                ..wet()
            };
            let stop = g.tick(env, t0 + Duration::from_secs_f64(t));
            stop.map(|_| (t, g.fault().unwrap_or("no fault").to_owned()))
        })
    }

    #[test]
    fn wet_traces_never_trip_the_current_guard() {
        for (name, csv) in WET_TRACES {
            assert!(trace(csv).len() > 100, "{name} is too short to mean anything");
            let mut g = current_guard();
            assert_eq!(replay(&mut g, csv), None, "{name}");
        }
    }

    #[test]
    fn dry_traces_trip_within_the_grace_and_the_confirm_time() {
        for (name, csv) in DRY_TRACES {
            let mut g = current_guard();
            let (at, fault) = replay(&mut g, csv).unwrap_or_else(|| panic!("{name} never tripped"));
            let l = g.limits().clone();
            assert!(at >= l.dry_current_s as f64, "{name} tripped at {at} s");
            assert!(
                at <= (l.dry_grace_s + l.dry_current_s) as f64,
                "{name} tripped late, at {at} s"
            );
            assert!(is_dry_run(&fault), "{fault}");
            assert!(fault.contains("below 1.2 A for 5 s: it's pulling air"), "{fault}");
        }
    }

    #[test]
    fn the_fault_names_the_current_and_latches_like_a_dry_run() {
        let mut g = current_guard();
        let t0 = Instant::now();
        g.request(&on(None, None), wet(), t0).unwrap();
        let air = Env {
            pump_current_a: Some(0.4),
            ..wet()
        };
        // Spin-up: nothing is judged in the grace, however low.
        assert_eq!(g.tick(air, t0 + Duration::from_secs(2)), None);
        assert_eq!(g.tick(air, t0 + Duration::from_secs(3)), None);
        assert_eq!(g.tick(air, t0 + Duration::from_secs(7)), None);
        assert_eq!(g.tick(air, t0 + Duration::from_secs(8)), Some(Decision::Stop));
        assert_eq!(
            g.fault(),
            Some("dry-run: pump drew 0.4 A, below 1.2 A for 5 s: it's pulling air")
        );
        assert!(!g.is_running(t0 + Duration::from_secs(8)));
        assert!(matches!(
            g.request(&on(None, None), wet(), t0 + Duration::from_secs(9)),
            Err(Refusal::Latched(f)) if f.contains("pulling air")
        ));
        g.acknowledge();
        assert!(g
            .request(&on(None, None), wet(), t0 + Duration::from_secs(10))
            .is_ok());
    }

    #[test]
    fn a_lost_or_good_read_starts_the_current_count_again() {
        let mut g = current_guard();
        let t0 = Instant::now();
        g.request(&on(None, None), wet(), t0).unwrap();
        let at = |a| Env {
            pump_current_a: a,
            ..wet()
        };
        let s = |n| t0 + Duration::from_secs(n);
        assert_eq!(g.tick(at(Some(0.3)), s(4)), None);
        assert_eq!(g.tick(at(None), s(8)), None);
        assert_eq!(g.tick(at(Some(0.3)), s(9)), None);
        assert_eq!(g.tick(at(Some(1.5)), s(13)), None);
        assert_eq!(g.tick(at(Some(0.3)), s(14)), None);
        assert_eq!(g.tick(at(Some(0.3)), s(18)), None);
        assert_eq!(g.tick(at(Some(0.3)), s(19)), Some(Decision::Stop));
        assert_eq!(
            g.fault(),
            Some("dry-run: pump drew 0.3 A, below 1.2 A for 5 s: it's pulling air")
        );
    }

    #[test]
    fn a_longer_run_asked_for_mid_run_keeps_counting_and_a_new_run_gets_its_grace() {
        let mut g = current_guard();
        let t0 = Instant::now();
        let s = |n| t0 + Duration::from_secs(n);
        let air = Env {
            pump_current_a: Some(0.2),
            ..wet()
        };
        g.request(&on(None, Some(60)), wet(), t0).unwrap();
        assert_eq!(g.tick(air, s(4)), None);
        g.request(&on(None, Some(120)), wet(), s(6)).unwrap();
        assert_eq!(g.tick(air, s(9)), Some(Decision::Stop));
        g.acknowledge();
        // Stopped by hand mid-count, a new run spins up again before it's judged.
        g.request(&on(None, Some(60)), wet(), s(20)).unwrap();
        assert_eq!(g.tick(air, s(24)), None);
        let off = ActuatorCommand {
            on: Some(false),
            level: None,
            duration_s: None,
        };
        g.request(&off, wet(), s(25)).unwrap();
        g.request(&on(None, Some(60)), wet(), s(26)).unwrap();
        assert_eq!(g.tick(air, s(28)), None);
        assert_eq!(g.tick(air, s(29)), None);
        assert_eq!(g.tick(air, s(33)), None);
        assert_eq!(g.tick(air, s(34)), Some(Decision::Stop));
    }

    #[test]
    fn a_run_ending_mid_count_leaves_the_next_one_a_fresh_grace() {
        let mut g = current_guard();
        let t0 = Instant::now();
        let s = |n| t0 + Duration::from_secs(n);
        let air = Env {
            pump_current_a: Some(0.2),
            ..wet()
        };
        g.request(&on(None, Some(6)), wet(), t0).unwrap();
        assert_eq!(g.tick(air, s(4)), None);
        assert_eq!(g.tick(air, s(6)), Some(Decision::Stop));
        assert_eq!(g.fault(), None);
        g.request(&on(None, Some(60)), wet(), s(7)).unwrap();
        assert_eq!(g.tick(air, s(9)), None);
        assert_eq!(g.tick(air, s(10)), None);
        assert_eq!(g.tick(air, s(14)), None);
        assert_eq!(g.tick(air, s(15)), Some(Decision::Stop));
    }

    #[test]
    fn the_current_guard_is_off_unless_a_cutoff_is_set() {
        let mut g = guard();
        assert_eq!(g.limits().dry_current_a, None);
        let t0 = Instant::now();
        g.request(&on(None, None), wet(), t0).unwrap();
        let air = Env {
            pump_current_a: Some(0.0),
            ..wet()
        };
        for n in 1..60 {
            assert_eq!(g.tick(air, t0 + Duration::from_secs(n)), None);
        }
    }

    #[test]
    fn dry_run_faults_are_told_apart_from_the_others() {
        assert!(is_dry_run("dry-run"));
        assert!(is_dry_run(
            "dry-run: pump drew 0 A, below 1.2 A for 5 s: it's pulling air"
        ));
        assert!(!is_dry_run("over-temp"));
        assert!(!is_dry_run("dry-runner"));
        assert_eq!(amps(0.4), "0.4");
        assert_eq!(amps(1.25), "1.25");
        assert_eq!(amps(0.0), "0");
        assert_eq!(amps(2.0), "2");
    }

    #[test]
    fn median_handles_odd_even_and_empty() {
        assert_eq!(median(&mut [3.0, 1.0, 2.0]), Some(2.0));
        assert_eq!(median(&mut [4.0, 1.0, 3.0, 2.0]), Some(2.0));
        assert_eq!(median(&mut [53.0, 12.7]), Some(12.7));
        assert_eq!(median(&mut []), None);
    }
}
