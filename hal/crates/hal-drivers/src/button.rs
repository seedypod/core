//! The front-panel button (GPIO13): debounce and classify presses into
//! single / double / long. The classifier is a pure state machine fed
//! `(pressed, now)` so every window is unit-tested; [`ButtonPoller`] drives it
//! from a pin on a thread.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::time::{Duration, Instant};

use hal_core::ButtonPress;

use crate::bus::{Clock, Delay, DigitalIn};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ButtonConfig {
    pub debounce: Duration,
    /// A second press starting within this window after a release is a double.
    pub double_window: Duration,
    /// Held at least this long → long press (fires while still held).
    pub long_press: Duration,
    /// Kept holding this long → setup (fires while still held, after the long press).
    pub setup_hold: Duration,
    /// Pressed reads low (pull-up wiring).
    pub active_low: bool,
}

impl Default for ButtonConfig {
    fn default() -> Self {
        Self {
            debounce: Duration::from_millis(30),
            double_window: Duration::from_millis(400),
            long_press: Duration::from_millis(1000),
            setup_hold: Duration::from_millis(10_000),
            active_low: true,
        }
    }
}

#[derive(Debug)]
pub struct Classifier {
    cfg: ButtonConfig,
    raw: bool,
    stable: bool,
    last_change: Option<Instant>,
    pressed_at: Option<Instant>,
    long_fired: bool,
    setup_fired: bool,
    pending_single_at: Option<Instant>,
}

impl Classifier {
    pub fn new(cfg: ButtonConfig) -> Self {
        Self {
            cfg,
            raw: false,
            stable: false,
            last_change: None,
            pressed_at: None,
            long_fired: false,
            setup_fired: false,
            pending_single_at: None,
        }
    }

    /// Feed one sample. `pressed` is already polarity-corrected.
    pub fn update(&mut self, pressed: bool, now: Instant) -> Option<ButtonPress> {
        if pressed != self.raw {
            self.raw = pressed;
            self.last_change = Some(now);
        }
        let settled = self
            .last_change
            .is_some_and(|t| now.duration_since(t) >= self.cfg.debounce);
        let mut event = None;
        if settled && self.stable != self.raw {
            self.stable = self.raw;
            if self.stable {
                self.pressed_at = Some(now);
                self.long_fired = false;
                self.setup_fired = false;
            } else if !self.long_fired {
                if self.pending_single_at.take().is_some() {
                    event = Some(ButtonPress::Double);
                } else {
                    self.pending_single_at = Some(now);
                }
            }
        }
        if self.stable && !self.long_fired {
            if let Some(t) = self.pressed_at {
                if now.duration_since(t) >= self.cfg.long_press {
                    self.long_fired = true;
                    self.pending_single_at = None;
                    event = Some(ButtonPress::Long);
                }
            }
        }
        if self.stable && self.long_fired && !self.setup_fired {
            if let Some(t) = self.pressed_at {
                if now.duration_since(t) >= self.cfg.setup_hold {
                    self.setup_fired = true;
                    event = Some(ButtonPress::Setup);
                }
            }
        }
        if !self.stable {
            if let Some(t) = self.pending_single_at {
                if now.duration_since(t) >= self.cfg.double_window {
                    self.pending_single_at = None;
                    event = Some(ButtonPress::Single);
                }
            }
        }
        event
    }
}

/// Polls a pin and sends classified presses down a channel.
pub struct ButtonPoller<I: DigitalIn, C: Clock, D: Delay> {
    pin: I,
    clock: C,
    delay: D,
    classifier: Classifier,
    active_low: bool,
    poll: Duration,
}

impl<I: DigitalIn, C: Clock, D: Delay> ButtonPoller<I, C, D> {
    pub fn new(pin: I, clock: C, delay: D, cfg: ButtonConfig, poll: Duration) -> Self {
        Self {
            pin,
            clock,
            delay,
            classifier: Classifier::new(cfg),
            active_low: cfg.active_low,
            poll,
        }
    }

    /// One poll: read, classify, sleep. Read errors are treated as "not pressed".
    pub fn step(&mut self) -> Option<ButtonPress> {
        let high = self.pin.is_high().unwrap_or(self.active_low);
        let pressed = high != self.active_low;
        let now = self.clock.now();
        let ev = self.classifier.update(pressed, now);
        self.delay.sleep(self.poll);
        ev
    }

    /// Run until `stop` is set or the receiver goes away.
    pub fn run(mut self, tx: Sender<ButtonPress>, stop: Arc<AtomicBool>) {
        while !stop.load(Ordering::Relaxed) {
            if let Some(ev) = self.step() {
                if tx.send(ev).is_err() {
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bus::fake::{FakeIn, NoDelay, StepClock};

    fn cfg() -> ButtonConfig {
        ButtonConfig {
            debounce: Duration::from_millis(30),
            double_window: Duration::from_millis(400),
            long_press: Duration::from_millis(1000),
            setup_hold: Duration::from_millis(10_000),
            active_low: true,
        }
    }

    /// Replay a script of (pressed, at_ms) samples; collect events.
    fn replay(script: &[(bool, u64)]) -> Vec<ButtonPress> {
        let t0 = Instant::now();
        let mut c = Classifier::new(cfg());
        script
            .iter()
            .filter_map(|&(p, ms)| c.update(p, t0 + Duration::from_millis(ms)))
            .collect()
    }

    #[test]
    fn single_press_fires_after_the_double_window() {
        let ev = replay(&[
            (true, 0),
            (true, 40),   // debounced press
            (false, 100), // release
            (false, 140), // debounced release → pending single
            (false, 300), // still waiting
            (false, 600), // window over → single
        ]);
        assert_eq!(ev, vec![ButtonPress::Single]);
    }

    #[test]
    fn two_presses_inside_the_window_are_a_double() {
        let ev = replay(&[
            (true, 0),
            (true, 40),
            (false, 100),
            (false, 140),
            (true, 250),
            (true, 290),
            (false, 350),
            (false, 390), // second release → double
            (false, 1000),
        ]);
        assert_eq!(ev, vec![ButtonPress::Double]);
    }

    #[test]
    fn two_presses_outside_the_window_are_two_singles() {
        let ev = replay(&[
            (true, 0),
            (true, 40),
            (false, 100),
            (false, 140),
            (false, 600), // single
            (true, 700),
            (true, 740),
            (false, 800),
            (false, 840),
            (false, 1300), // single
        ]);
        assert_eq!(ev, vec![ButtonPress::Single, ButtonPress::Single]);
    }

    #[test]
    fn holding_on_past_the_setup_time_adds_one_setup_event() {
        let ev = replay(&[
            (true, 0),
            (true, 40),
            (true, 1040), // long
            (true, 5000),
            (true, 10_040), // ≥ 10 s since the debounced press → setup
            (true, 12_000),
            (false, 12_100),
            (false, 12_200),
            (false, 13_000),
        ]);
        assert_eq!(ev, vec![ButtonPress::Long, ButtonPress::Setup]);
        // Letting go before 10 s is only a long press.
        let ev = replay(&[
            (true, 0),
            (true, 40),
            (true, 1040),
            (true, 9000),
            (false, 9100),
            (false, 9200),
            (false, 10_500),
        ]);
        assert_eq!(ev, vec![ButtonPress::Long]);
    }

    #[test]
    fn long_press_fires_while_held_and_release_is_silent() {
        let ev = replay(&[
            (true, 0),
            (true, 40),
            (true, 500),
            (true, 1040), // ≥ 1000 ms since debounced press at 40 → long
            (true, 1500),
            (false, 1600),
            (false, 1640),
            (false, 3000),
        ]);
        assert_eq!(ev, vec![ButtonPress::Long]);
    }

    #[test]
    fn bounce_shorter_than_debounce_is_ignored() {
        let ev = replay(&[
            (true, 0),
            (false, 10),
            (true, 15),
            (false, 20),
            (false, 100),
            (false, 1000),
        ]);
        assert!(ev.is_empty());
    }

    #[test]
    fn poller_applies_polarity_and_emits_events() {
        // Active-low pin: low = pressed. Clock steps 50 ms per poll.
        let levels = [
            false, false, true, true, true, true, true, true, true, true, true, true, true, true,
        ];
        let mut p = ButtonPoller::new(
            FakeIn::new(&levels),
            StepClock::new(Duration::from_millis(50)),
            NoDelay::default(),
            cfg(),
            Duration::from_millis(5),
        );
        let mut events = Vec::new();
        for _ in 0..levels.len() {
            events.extend(p.step());
        }
        assert_eq!(events, vec![ButtonPress::Single]);
        assert_eq!(p.delay.slept.len(), levels.len());
    }

    #[test]
    fn run_stops_when_the_flag_is_set() {
        let stop = Arc::new(AtomicBool::new(true));
        let (tx, rx) = std::sync::mpsc::channel();
        let p = ButtonPoller::new(
            FakeIn::new(&[true]),
            StepClock::new(Duration::from_millis(1)),
            NoDelay::default(),
            cfg(),
            Duration::from_millis(1),
        );
        p.run(tx, stop);
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn run_exits_when_the_receiver_is_dropped() {
        // Script a full single press so an event is produced and send() fails.
        let mut levels = vec![true, true, false, false, false];
        levels.extend(std::iter::repeat(true).take(40));
        let (tx, rx) = std::sync::mpsc::channel::<ButtonPress>();
        drop(rx);
        let p = ButtonPoller::new(
            FakeIn::new(&levels),
            StepClock::new(Duration::from_millis(50)),
            NoDelay::default(),
            cfg(),
            Duration::from_millis(1),
        );
        p.run(tx, Arc::new(AtomicBool::new(false)));
    }
}
