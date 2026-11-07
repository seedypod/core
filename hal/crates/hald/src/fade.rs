//! Every light change fades, whichever source sent it, on its own thread so
//! that a slow telemetry round can't make a fade stutter. The engine only ever
//! says where the light should end up. It publishes and persists that target
//! once, so nothing here reaches MQTT or the card.
//!
//! Once that thread runs, the engine never touches the driver: it writes a small
//! plan under its own lock, and only the thread holds the driver's. So a light
//! write that hangs can't hold up a command, the pump guard or a sensor read. With
//! fading off there's no thread, and writes happen on the engine as they always did.
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
/// How long a shutdown waits for the light to land. The pump is already off by then.
const FINISH_WAIT: Duration = Duration::from_millis(250);
/// A ramp this far past its end means a write has hung, which has no error to report.
const STALLED: Duration = Duration::from_secs(3);
/// What the light's state reports, which core raises as `light_fault`.
const WRITE_FAULT: &str = "light driver write failed";

fn perceived(level: f64) -> f64 {
    (level / 100.0).clamp(0.0, 1.0).powf(1.0 / GAMMA)
}

fn level_of(perceived: f64) -> f64 {
    100.0 * perceived.powf(GAMMA)
}

struct Ramp {
    /// Tells a ramp from the one that replaced it during a write.
    id: u64,
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

/// Never held across a driver write, so the engine can always take it.
struct Plan {
    /// The last level the driver took.
    actual: f64,
    target: f64,
    ramp: Option<Ramp>,
    ramps: u64,
    /// Without something stepping the ramp, a fade would never arrive, so changes land at once.
    stepping: bool,
    /// A thread is doing the stepping, rather than a test.
    threaded: bool,
    stopping: bool,
    stopped: bool,
    /// Also what stops a run of failed writes logging fifty times a second.
    write_failing: bool,
    clock: Clock,
}

struct Shared {
    output: Mutex<Box<dyn Actuator>>,
    plan: Mutex<Plan>,
    wake: Condvar,
}

impl Shared {
    fn plan(&self) -> MutexGuard<'_, Plan> {
        self.plan.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn write(&self, level: f64) -> bool {
        let written = self
            .output
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .set_level(level);
        let mut plan = self.plan();
        match &written {
            Ok(()) => {
                plan.actual = level;
                plan.write_failing = false;
            }
            Err(e) if !plan.write_failing => {
                error!(%e, "{WRITE_FAULT}");
                plan.write_failing = true;
            }
            Err(_) => {}
        }
        written.is_ok()
    }

    /// One frame. The delay until the next, or `None` with nothing left to do.
    fn step(&self) -> Option<Duration> {
        let (level, last, id) = {
            let plan = self.plan();
            let ramp = plan.ramp.as_ref()?;
            let (level, last) = ramp.at((plan.clock)());
            (level, last, ramp.id)
        };
        let written = self.write(level);
        let mut plan = self.plan();
        if written && last && plan.ramp.as_ref().is_some_and(|r| r.id == id) {
            plan.ramp = None;
            return None;
        }
        // The last write is the one that matters: off has to reach zero.
        Some(if last && !written { RETRY } else { FRAME })
    }

    /// Straight to the target, and done.
    fn land(&self) {
        let target = {
            let mut plan = self.plan();
            plan.ramp = None;
            plan.target
        };
        self.write(target);
        self.plan().stopped = true;
        self.wake.notify_all();
    }

    fn run(&self) {
        loop {
            let delay = self.step();
            let plan = self.plan();
            if plan.stopping {
                drop(plan);
                return self.land();
            }
            match delay {
                Some(delay) => drop(
                    self.wake
                        .wait_timeout(plan, delay)
                        .unwrap_or_else(|e| e.into_inner()),
                ),
                None if plan.ramp.is_none() => drop(self.wake.wait(plan).unwrap_or_else(|e| e.into_inner())),
                None => {}
            }
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
        let plan = Plan {
            actual: level,
            target: level,
            ramp: None,
            ramps: 0,
            stepping: false,
            threaded: false,
            stopping: false,
            stopped: false,
            write_failing: false,
            clock: Box::new(Instant::now),
        };
        Self {
            shared: Arc::new(Shared {
                output: Mutex::new(driver),
                plan: Mutex::new(plan),
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
        let mut plan = self.shared.plan();
        plan.stepping = true;
        plan.threaded = true;
        Ok(())
    }

    pub fn probe(&self) -> Result<(), DeviceError> {
        self.shared
            .output
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .probe()
    }

    /// What `actuator/light/state` reports as its fault: a write that failed or never
    /// came back. Clears on the next good write.
    pub fn fault(&self) -> Option<&'static str> {
        let plan = self.shared.plan();
        let now = (plan.clock)();
        let stalled = plan
            .ramp
            .as_ref()
            .is_some_and(|r| now > r.start + r.duration + STALLED);
        (plan.write_failing || stalled).then_some(WRITE_FAULT)
    }

    /// Fades from wherever the light is right now, so a change mid-fade has no jump.
    /// The time scales with the square root of the perceived distance: a whole
    /// swing takes `fade`, while the small steps schedules and Autopilot send
    /// finish quickly and can't pile up.
    pub fn fade_to(&self, level: f64) {
        let mut plan = self.shared.plan();
        if !plan.stepping {
            drop(plan);
            return self.jump(level);
        }
        // On its way or already there. A target it never reached gets a new ramp.
        if level == plan.target && (plan.ramp.is_some() || plan.actual == level) {
            return;
        }
        let from = plan.actual;
        let distance = (perceived(level) - perceived(from)).abs();
        let start = (plan.clock)();
        plan.ramps += 1;
        let id = plan.ramps;
        plan.target = level;
        plan.ramp = Some(Ramp {
            id,
            from,
            to: level,
            start,
            duration: self.fade.mul_f64(distance.sqrt()),
        });
        self.shared.wake.notify_all();
    }

    /// Straight there, on the caller's thread: a boot restore, before `spawn`, or fading off.
    pub fn jump(&self, level: f64) {
        {
            let mut plan = self.shared.plan();
            plan.ramp = None;
            plan.target = level;
        }
        self.shared.write(level);
    }

    /// Shutdown: the light lands on its target, which is what the state file says,
    /// so the next boot restores to where it already is. Waits a moment for that,
    /// but not for a driver that has hung.
    pub fn finish(&self) {
        let mut plan = self.shared.plan();
        if !plan.threaded {
            drop(plan);
            return self.shared.land();
        }
        plan.stopping = true;
        self.shared.wake.notify_all();
        let _ = self
            .shared
            .wake
            .wait_timeout_while(plan, FINISH_WAIT, |p| !p.stopped)
            .unwrap_or_else(|e| e.into_inner());
    }

    #[cfg(test)]
    pub fn step_by_hand(&self, clock: impl Fn() -> Instant + Send + 'static) {
        let mut plan = self.shared.plan();
        plan.stepping = true;
        plan.clock = Box::new(clock);
    }

    #[cfg(test)]
    pub fn step(&self) -> Option<Duration> {
        self.shared.step()
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
        assert!(f.shared.plan().stopped);
    }

    #[test]
    fn a_failed_restore_is_recovered_by_asking_for_the_same_level_again() {
        let fake = Fake::default();
        let (f, t) = by_hand(&fake);
        fake.fail_next(1);
        f.jump(70.0);
        assert!(fake.writes().is_empty());
        f.fade_to(70.0);
        frames(&f, &t, 40);
        assert_eq!(*fake.writes().last().unwrap(), 70.0);
    }

    #[test]
    fn a_failed_write_is_a_fault_until_a_write_succeeds() {
        let fake = Fake::default();
        let (f, t) = by_hand(&fake);
        assert_eq!(f.fault(), None);
        fake.fail_next(1);
        f.fade_to(100.0);
        frames(&f, &t, 1);
        assert_eq!(f.fault(), Some(WRITE_FAULT));
        frames(&f, &t, 1);
        assert_eq!(f.fault(), None);
    }

    #[test]
    fn a_ramp_long_past_its_end_is_a_fault_because_a_hung_write_reports_nothing() {
        let fake = Fake::default();
        let (f, t) = by_hand(&fake);
        f.fade_to(100.0);
        *t.lock().unwrap() += Duration::from_millis(800) + STALLED;
        assert_eq!(f.fault(), None, "right at the limit");
        *t.lock().unwrap() += Duration::from_millis(1);
        assert_eq!(f.fault(), Some(WRITE_FAULT));
        f.step();
        assert_eq!(f.fault(), None);
    }

    /// A light whose every write hangs until the test lets it go.
    struct Hung(std::sync::mpsc::Receiver<()>);

    impl Actuator for Hung {
        fn id(&self) -> ActuatorId {
            ActuatorId::Light
        }
        fn probe(&mut self) -> Result<(), DeviceError> {
            Ok(())
        }
        fn set_level(&mut self, _: f64) -> Result<(), DeviceError> {
            let _ = self.0.recv();
            Ok(())
        }
        fn level(&self) -> f64 {
            0.0
        }
    }

    #[test]
    fn a_hung_write_never_holds_up_the_engine() {
        let (release, hang) = std::sync::mpsc::channel();
        let (done, finished) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let f = LightFader::new(Box::new(Hung(hang)), Duration::from_millis(800));
            f.spawn().unwrap();
            f.fade_to(100.0);
            std::thread::sleep(FRAME * 3);
            f.fade_to(50.0);
            f.fault();
            f.finish();
            done.send(()).unwrap();
            drop(release);
        });
        finished
            .recv_timeout(Duration::from_secs(5))
            .expect("the engine's calls returned");
    }

    #[test]
    fn a_retarget_during_a_write_survives_the_end_of_the_old_ramp() {
        let fake = Fake::default();
        let (f, t) = by_hand(&fake);
        f.fade_to(100.0);
        *t.lock().unwrap() += Duration::from_secs(2);
        // The write of the old ramp's last frame is under way when the new command lands.
        let (level, last, id) = {
            let plan = f.shared.plan();
            let ramp = plan.ramp.as_ref().unwrap();
            let (l, last) = ramp.at(*t.lock().unwrap());
            (l, last, ramp.id)
        };
        assert!(last);
        f.fade_to(20.0);
        f.shared.write(level);
        assert_ne!(f.shared.plan().ramp.as_ref().map(|r| r.id), Some(id));
        frames(&f, &t, 60);
        assert_eq!(*fake.writes().last().unwrap(), 20.0);
    }
}
