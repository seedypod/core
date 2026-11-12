//! `--pump-trace <file>` (temporary, #220): the pump monitor read at 4 Hz while
//! the pump runs and for a moment after, appended as CSV. A wet and a dry run
//! recorded this way are the fixtures the current guard is tested against
//! (`hal-core/fixtures/pump_current/`), and what its defaults get set from.
//! The INA219 facets share a 500 ms cache, so 4 Hz reads give at least 2 Hz of
//! fresh readings. Remove once the guard's defaults rest on real traces.

use std::io::Write;
use std::time::{Duration, Instant};

/// How often the pump monitor is read while tracing.
pub const EVERY: Duration = Duration::from_millis(250);
/// How long to keep reading after the pump stops, to see the current fall away.
pub const TAIL: Duration = Duration::from_secs(2);
/// The columns, as the fixtures have them.
pub const HEADER: &str = "t_s,duty,pump_v,pump_a,pump_w";

/// One read of the pump monitor; `None` where it failed.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Sample {
    pub duty: f64,
    pub v: Option<f64>,
    pub a: Option<f64>,
    pub w: Option<f64>,
}

pub struct PumpTrace<W: Write> {
    out: W,
    /// When the run being traced started.
    run: Option<Instant>,
    /// When the pump was seen off, while the tail is read.
    stopped: Option<Instant>,
    next: Instant,
}

impl<W: Write> PumpTrace<W> {
    pub fn new(out: W) -> Self {
        Self {
            out,
            run: None,
            stopped: None,
            next: Instant::now(),
        }
    }

    /// When the next read is due, while a run is traced.
    pub fn due(&self) -> Option<Instant> {
        self.run.map(|_| self.next)
    }

    /// Call often: starts a run's trace when the pump comes on, reads the
    /// monitor when a read is due, and closes the trace after the tail.
    /// `ts` labels a new run.
    pub fn poll(&mut self, on: bool, at: Instant, ts: &str, sample: impl FnOnce() -> Sample) {
        match (self.run, on) {
            (None, false) => return,
            (None, true) => {
                self.run = Some(at);
                self.next = at;
                self.write(&format!("# run {ts}\n{HEADER}"));
            }
            (Some(_), true) => self.stopped = None,
            (Some(_), false) => {
                let stopped = *self.stopped.get_or_insert(at);
                if at.duration_since(stopped) > TAIL {
                    self.run = None;
                    self.stopped = None;
                    let _ = self.out.flush();
                    return;
                }
            }
        }
        let Some(start) = self.run else { return };
        if at < self.next {
            return;
        }
        let s = sample();
        let f = |v: Option<f64>| v.map(|v| format!("{v}")).unwrap_or_default();
        let t = at.duration_since(start).as_secs_f64();
        self.write(&format!("{t:.2},{},{},{},{}", s.duty, f(s.v), f(s.a), f(s.w)));
        // Late polls don't bunch up reads: the next is a whole step from this one.
        self.next = at + EVERY;
    }

    fn write(&mut self, line: &str) {
        if let Err(e) = writeln!(self.out, "{line}") {
            tracing::warn!(%e, "pump trace write failed");
        }
    }

    #[cfg(test)]
    fn into_inner(self) -> W {
        self.out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(a: Option<f64>) -> Sample {
        Sample {
            duty: 30.0,
            v: Some(12.05),
            a,
            w: a.map(|_| 22.53),
        }
    }

    #[test]
    fn traces_a_run_at_four_hertz_then_its_tail_then_stops() {
        let mut t = PumpTrace::new(Vec::new());
        let t0 = Instant::now();
        let ms = |n| t0 + Duration::from_millis(n);
        t.poll(false, t0, "x", || panic!("read with the pump off"));
        assert_eq!(t.due(), None);
        for n in (0..1000).step_by(50) {
            t.poll(true, ms(n), "2026-11-11T00:00:00Z", || sample(Some(1.87)));
        }
        assert_eq!(t.due(), Some(ms(1000)));
        // Off: reads go on for the tail, a failed one left blank, then nothing.
        t.poll(false, ms(1000), "x", || sample(None));
        t.poll(false, ms(3000), "x", || sample(Some(0.0)));
        t.poll(false, ms(3100), "x", || panic!("read past the tail"));
        assert_eq!(t.due(), None);
        let out = String::from_utf8(t.into_inner()).unwrap();
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines[0], "# run 2026-11-11T00:00:00Z");
        assert_eq!(lines[1], HEADER);
        assert_eq!(lines[2], "0.00,30,12.05,1.87,22.53");
        assert_eq!(lines.len(), 2 + 4 + 2, "{out}");
        assert_eq!(lines[5].split(',').next(), Some("0.75"));
        assert_eq!(lines[6], "1.00,30,12.05,,");
        assert_eq!(lines[7].split(',').next(), Some("3.00"));
    }

    #[test]
    fn a_run_restarted_in_the_tail_carries_on_in_the_same_trace() {
        let mut t = PumpTrace::new(Vec::new());
        let t0 = Instant::now();
        let ms = |n| t0 + Duration::from_millis(n);
        t.poll(true, t0, "a", || sample(Some(1.9)));
        t.poll(false, ms(500), "a", || sample(Some(0.0)));
        t.poll(true, ms(1000), "b", || sample(Some(1.9)));
        t.poll(false, ms(2000), "b", || sample(Some(0.0)));
        // The tail counts from the latest stop.
        t.poll(false, ms(3500), "b", || sample(Some(0.0)));
        assert!(t.due().is_some());
        let out = String::from_utf8(t.into_inner()).unwrap();
        assert_eq!(out.matches("# run").count(), 1, "{out}");
    }
}
