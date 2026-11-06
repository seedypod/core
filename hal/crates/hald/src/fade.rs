//! Every light change fades, whichever source sent it, on its own thread so
//! that a slow telemetry round can't make a fade stutter and a fade can't hold
//! up the engine: the pump guard and sensor reads never wait for it. The engine
//! only ever says where the light should end up. It publishes and persists that
//! target once, so nothing here reaches MQTT or the card.
//!
//! Levels are PWM duty, and the eye doesn't see duty evenly: a straight ramp
//! rushes through the dim end and crawls at the top. So a fade is a straight
//! line in perceived brightness, and both ends stay the exact levels asked for.

use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use hal_core::device::{Actuator, DeviceError};
use tracing::error;

/// Perceived brightness goes roughly as duty^(1/2.2).
const GAMMA: f64 = 2.2;
/// 50 steps a second, which the eye takes for continuous.
const FRAME: Duration = Duration::from_millis(20);
/// How soon to try again when the last write of a fade fails.
const RETRY: Duration = Duration::from_secs(1);

fn perceived(level: f64) -> f64 {
    (level / 100.0).clamp(0.0, 1.0).powf(1.0 / GAMMA)
}

fn level_of(perceived: f64) -> f64 {
    100.0 * perceived.powf(GAMMA)
}

struct Ramp {
    from: f64,
    to: f64,
    start: Instant,
    duration: Duration,
}

impl Ramp {
    /// Where the light belongs at `now`, and whether that's the end of the fade.
    fn at(&self, now: Instant) -> (f64, bool) {
        let t = now.saturating_duration_since(self.start).as_secs_f64() / self.duration.as_secs_f64();
        if t >= 1.0 || !t.is_finite() {
            return (self.to, true);
        }
        let (a, b) = (perceived(self.from), perceived(self.to));
        (level_of(a + (b - a) * t), false)
    }
}

type Clock = Box<dyn Fn() -> Instant + Send>;

struct State {
    driver: Box<dyn Actuator>,
    /// The last level the driver took.
    actual: f64,
    target: f64,
    ramp: Option<Ramp>,
    /// Without something stepping the ramp, a fade would never arrive, so changes land at once.
    stepping: bool,
    stopped: bool,
    /// One log line per run of failed writes, not fifty a second.
    write_failing: bool,
    clock: Clock,
}

impl State {
    fn write(&mut self, level: f64) -> Result<(), DeviceError> {
        let written = self.driver.set_level(level);
        match &written {
            Ok(()) => {
                self.actual = level;
                self.write_failing = false;
            }
            Err(e) if !self.write_failing => {
                error!(%e, "light driver write failed");
                self.write_failing = true;
            }
            Err(_) => {}
        }
        written
    }

    /// One frame. The delay until the next, or `None` with nothing left to do.
    fn step(&mut self) -> Option<Duration> {
        let (level, last) = self.ramp.as_ref()?.at((self.clock)());
        match (self.write(level), last) {
            (Ok(()), true) => {
                self.ramp = None;
                None
            }
            // The last write is the one that matters: off has to reach zero.
            (Err(_), true) => Some(RETRY),
            (_, false) => Some(FRAME),
        }
    }
}

struct Shared {
    state: Mutex<State>,
    wake: Condvar,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn run(&self) {
        let mut state = self.lock();
        while !state.stopped {
            state = match state.step() {
                Some(delay) => {
                    self.wake
                        .wait_timeout(state, delay)
                        .unwrap_or_else(|e| e.into_inner())
                        .0
                }
                None => self.wake.wait(state).unwrap_or_else(|e| e.into_inner()),
            };
        }
    }
}

/// Owns the light's driver. A full swing takes `fade`.
pub struct LightFader {
    shared: Arc<Shared>,
    fade: Duration,
}

impl LightFader {
    pub fn new(driver: Box<dyn Actuator>, fade: Duration) -> Self {
        let level = driver.level();
        let state = State {
            driver,
            actual: level,
            target: level,
            ramp: None,
            stepping: false,
            stopped: false,
            write_failing: false,
            clock: Box::new(Instant::now),
        };
        Self {
            shared: Arc::new(Shared {
                state: Mutex::new(state),
                wake: Condvar::new(),
            }),
            fade,
        }
    }

    /// Starts stepping fades. If the thread can't start, changes stay instant.
    pub fn spawn(&self) -> std::io::Result<()> {
        if self.fade.is_zero() {
            return Ok(());
        }
        let shared = self.shared.clone();
        std::thread::Builder::new()
            .name("light-fade".into())
            .spawn(move || shared.run())?;
        self.shared.lock().stepping = true;
        Ok(())
    }

    pub fn probe(&self) -> Result<(), DeviceError> {
        self.shared.lock().driver.probe()
    }

    /// Fades from wherever the light is right now, so a change mid-fade has no jump.
    /// The time scales with the square root of the perceived distance: a whole
    /// swing takes `fade`, while the small steps schedules and Autopilot send
    /// finish quickly and can't pile up.
    pub fn fade_to(&self, level: f64) {
        let mut state = self.shared.lock();
        if !state.stepping {
            drop(state);
            return self.jump(level);
        }
        if level == state.target {
            return;
        }
        let from = state.actual;
        let distance = (perceived(level) - perceived(from)).abs();
        let start = (state.clock)();
        state.target = level;
        state.ramp = Some(Ramp {
            from,
            to: level,
            start,
            duration: self.fade.mul_f64(distance.sqrt()),
        });
        self.shared.wake.notify_all();
    }

    /// Straight there: a boot restore, or fading turned off.
    pub fn jump(&self, level: f64) {
        let mut state = self.shared.lock();
        state.ramp = None;
        state.target = level;
        let _ = state.write(level);
    }

    /// Shutdown: the light lands on its target, which is what the state file says,
    /// so the next boot restores to where it already is.
    pub fn finish(&self) {
        let target = self.shared.lock().target;
        self.jump(target);
        self.shared.lock().stopped = true;
        self.shared.wake.notify_all();
    }

    #[cfg(test)]
    pub fn step_by_hand(&self, clock: impl Fn() -> Instant + Send + 'static) {
        let mut state = self.shared.lock();
        state.stepping = true;
        state.clock = Box::new(clock);
    }

    #[cfg(test)]
    pub fn step(&self) -> Option<Duration> {
        self.shared.lock().step()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hal_core::ActuatorId;

    /// A light that records its writes, and fails the next `failures` of them.
    #[derive(Clone, Default)]
    struct Fake(Arc<Mutex<(Vec<f64>, usize)>>);

    impl Fake {
        fn writes(&self) -> Vec<f64> {
            self.0.lock().unwrap().0.clone()
        }
        fn fail_next(&self, n: usize) {
            self.0.lock().unwrap().1 = n;
        }
    }

    impl Actuator for Fake {
        fn id(&self) -> ActuatorId {
            ActuatorId::Light
        }
        fn probe(&mut self) -> Result<(), DeviceError> {
            Ok(())
        }
        fn set_level(&mut self, level: f64) -> Result<(), DeviceError> {
            let mut s = self.0.lock().unwrap();
            if s.1 > 0 {
                s.1 -= 1;
                return Err(DeviceError::Timeout);
            }
            s.0.push(level);
            Ok(())
        }
        fn level(&self) -> f64 {
            0.0
        }
    }

    fn by_hand(fake: &Fake) -> (LightFader, Arc<Mutex<Instant>>) {
        let f = LightFader::new(Box::new(fake.clone()), Duration::from_millis(800));
        let t = Arc::new(Mutex::new(Instant::now()));
        let clock = t.clone();
        f.step_by_hand(move || *clock.lock().unwrap());
        (f, t)
    }

    fn frames(f: &LightFader, t: &Mutex<Instant>, n: usize) {
        for _ in 0..n {
            *t.lock().unwrap() += FRAME;
            f.step();
        }
    }

    #[test]
    fn brightness_and_level_are_inverse_and_keep_the_ends() {
        assert_eq!(perceived(0.0), 0.0);
        assert_eq!(perceived(100.0), 1.0);
        assert_eq!(level_of(1.0), 100.0);
        assert!((level_of(perceived(30.0)) - 30.0).abs() < 1e-9);
    }

    #[test]
    fn a_fade_is_even_to_the_eye_so_it_spends_its_time_at_the_dim_end() {
        let fake = Fake::default();
        let (f, t) = by_hand(&fake);
        f.fade_to(100.0);
        frames(&f, &t, 20);
        let half = *fake.writes().last().unwrap();
        assert!((15.0..30.0).contains(&half), "{half}");
        frames(&f, &t, 20);
        assert_eq!(*fake.writes().last().unwrap(), 100.0);
        assert_eq!(f.step(), None);
    }

    #[test]
    fn the_last_write_is_retried_so_off_always_reaches_zero() {
        let fake = Fake::default();
        let (f, t) = by_hand(&fake);
        f.jump(50.0);
        f.fade_to(0.0);
        frames(&f, &t, 10);
        assert_ne!(*fake.writes().last().unwrap(), 0.0, "still on its way");
        fake.fail_next(2);
        *t.lock().unwrap() += Duration::from_secs(1);
        assert_eq!(f.step(), Some(RETRY));
        assert_eq!(f.step(), Some(RETRY));
        assert_eq!(f.step(), None);
        assert_eq!(*fake.writes().last().unwrap(), 0.0);
    }

    #[test]
    fn a_failed_frame_mid_fade_doesnt_stop_it() {
        let fake = Fake::default();
        let (f, t) = by_hand(&fake);
        f.fade_to(100.0);
        fake.fail_next(3);
        frames(&f, &t, 3);
        assert!(fake.writes().is_empty());
        *t.lock().unwrap() += FRAME;
        assert_eq!(f.step(), Some(FRAME));
        assert_eq!(fake.writes().len(), 1);
    }

    #[test]
    fn a_fade_back_to_where_the_light_already_is_lands_at_once() {
        let fake = Fake::default();
        let (f, t) = by_hand(&fake);
        f.fade_to(100.0);
        frames(&f, &t, 10);
        let here = *fake.writes().last().unwrap();
        f.fade_to(here);
        assert_eq!(f.step(), None);
        assert_eq!(*fake.writes().last().unwrap(), here);
    }

    #[test]
    fn without_anything_stepping_a_change_lands_at_once() {
        let fake = Fake::default();
        let f = LightFader::new(Box::new(fake.clone()), Duration::from_millis(800));
        f.fade_to(40.0);
        assert_eq!(fake.writes(), [40.0]);
    }

    #[test]
    fn zero_means_no_thread_and_no_fade() {
        let fake = Fake::default();
        let f = LightFader::new(Box::new(fake.clone()), Duration::ZERO);
        f.spawn().unwrap();
        f.fade_to(40.0);
        assert_eq!(fake.writes(), [40.0]);
    }

    #[test]
    fn its_own_thread_finishes_a_fade_and_stops_with_it() {
        let fake = Fake::default();
        let f = LightFader::new(Box::new(fake.clone()), Duration::from_millis(60));
        f.spawn().unwrap();
        f.fade_to(100.0);
        let deadline = Instant::now() + Duration::from_secs(5);
        while fake.writes().last() != Some(&100.0) {
            assert!(Instant::now() < deadline, "{:?}", fake.writes());
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(fake.writes().len() > 1, "{:?}", fake.writes());
        f.finish();
        assert!(f.shared.lock().stopped);
    }
}
