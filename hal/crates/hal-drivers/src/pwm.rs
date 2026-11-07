//! PWM actuators: the grow light (hardware PWM, 8 kHz on GPIO18) and the pump
//! (software PWM, 50 Hz on GPIO24). Both are the same dumb mapping — level %
//! → duty — over a [`PwmOut`]; the pump's duty cap lives in `PumpGuard`, not
//! here (ADR-0009).

use std::path::Path;
use std::time::Duration;

use hal_core::{Actuator, ActuatorId, DeviceError};

use crate::bus::PwmOut;

/// The duty a PWM channel was left running at, 0–1, or 0 if it isn't running. `root` is
/// `/sys/class/pwm`; the chip differs by Pi, and only one has this channel exported.
pub fn found_duty(root: &Path, channel: u8) -> f64 {
    let read = |dir: &Path, name: &str| {
        std::fs::read_to_string(dir.join(name))
            .ok()?
            .trim()
            .parse::<f64>()
            .ok()
    };
    std::fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .map(|chip| chip.path().join(format!("pwm{channel}")))
        .find_map(|dir| {
            let (enabled, period, width) = (
                read(&dir, "enable")?,
                read(&dir, "period")?,
                read(&dir, "duty_cycle")?,
            );
            (enabled == 1.0 && period > 0.0).then(|| (width / period).clamp(0.0, 1.0))
        })
        .unwrap_or(0.0)
}

/// Level 0–100 → duty 0.0–1.0, clamped (a driver never trusts its input twice).
pub fn level_to_duty(level: f64) -> f64 {
    if level.is_nan() {
        return 0.0;
    }
    (level / 100.0).clamp(0.0, 1.0)
}

pub struct PwmActuator<P: PwmOut> {
    id: ActuatorId,
    out: P,
    level: f64,
}

impl<P: PwmOut> PwmActuator<P> {
    pub fn new(id: ActuatorId, out: P) -> Self {
        Self { id, out, level: 0.0 }
    }

    /// For an output already running at `level`, so a probe re-asserts that and not zero.
    pub fn with_level(mut self, level: f64) -> Self {
        self.level = level.clamp(0.0, 100.0);
        self
    }
}

/// The grow light.
pub type PwmLight<P> = PwmActuator<P>;
/// The circulation pump.
pub type PwmPump<P> = PwmActuator<P>;

impl<P: PwmOut> Actuator for PwmActuator<P> {
    fn id(&self) -> ActuatorId {
        self.id
    }
    fn probe(&mut self) -> Result<(), DeviceError> {
        // Re-assert the current level so a re-probe never glitches the output
        // (upstream #131: the light flickered on every process start).
        self.out.set_duty(level_to_duty(self.level))
    }
    fn set_level(&mut self, level: f64) -> Result<(), DeviceError> {
        self.out.set_duty(level_to_duty(level))?;
        self.level = level.clamp(0.0, 100.0);
        Ok(())
    }
    fn level(&self) -> f64 {
        self.level
    }
}

/// Run `op` up to `tries` times, `wait` apart, for as long as `transient` calls its error passing.
pub fn retry_while<T, E>(
    tries: u32,
    wait: Duration,
    transient: impl Fn(&E) -> bool,
    mut op: impl FnMut() -> Result<T, E>,
) -> Result<T, E> {
    let mut left = tries.max(1);
    loop {
        left -= 1;
        match op() {
            Err(e) if left > 0 && transient(&e) => std::thread::sleep(wait),
            done => return done,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bus::fake::FakePwm;

    fn sysfs(
        tag: &str,
        chip: u8,
        channel: u8,
        enable: &str,
        period: &str,
        width: &str,
    ) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("pwm-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join(format!("pwmchip{chip}/pwm{channel}"));
        std::fs::create_dir_all(&dir).unwrap();
        for (name, value) in [("enable", enable), ("period", period), ("duty_cycle", width)] {
            std::fs::write(dir.join(name), format!("{value}\n")).unwrap();
        }
        root
    }

    #[test]
    fn a_running_channel_is_found_at_its_duty_on_whichever_chip_has_it() {
        let root = sysfs("running", 0, 0, "1", "50000", "15000");
        assert_eq!(found_duty(&root, 0), 0.3);
        assert_eq!(found_duty(&root, 1), 0.0);
        let _ = std::fs::remove_dir_all(&root);
        let root = sysfs("pi5", 2, 2, "1", "125000", "125000");
        assert_eq!(found_duty(&root, 2), 1.0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_channel_that_isnt_running_is_found_at_zero() {
        for (tag, enable, period, width) in [
            ("off", "0", "50000", "15000"),
            ("no-period", "1", "0", "0"),
            ("damaged", "1", "x", "15000"),
        ] {
            let root = sysfs(tag, 0, 0, enable, period, width);
            assert_eq!(found_duty(&root, 0), 0.0, "{tag}");
            let _ = std::fs::remove_dir_all(&root);
        }
        assert_eq!(found_duty(Path::new("/nonexistent"), 0), 0.0);
    }

    #[test]
    fn a_probe_keeps_the_level_an_output_was_found_at() {
        let mut d = PwmLight::new(ActuatorId::Light, FakePwm::default()).with_level(40.0);
        d.probe().unwrap();
        assert_eq!(d.level(), 40.0);
        assert_eq!(d.out.duties, [0.4]);
    }

    #[test]
    fn level_maps_to_duty_and_clamps() {
        assert_eq!(level_to_duty(0.0), 0.0);
        assert_eq!(level_to_duty(30.0), 0.3);
        assert_eq!(level_to_duty(100.0), 1.0);
        assert_eq!(level_to_duty(150.0), 1.0);
        assert_eq!(level_to_duty(-5.0), 0.0);
        assert_eq!(level_to_duty(f64::NAN), 0.0);
    }

    #[test]
    fn actuator_drives_duty_and_reports_level() {
        let mut a = PwmLight::new(ActuatorId::Light, FakePwm::default());
        assert_eq!(a.id(), ActuatorId::Light);
        a.set_level(75.0).unwrap();
        assert_eq!(a.level(), 75.0);
        a.probe().unwrap();
        a.set_level(0.0).unwrap();
        assert_eq!(a.out.duties, vec![0.75, 0.75, 0.0]);
    }

    #[test]
    fn retries_a_passing_error_until_it_clears() {
        let mut calls = 0;
        let got = retry_while(
            5,
            Duration::ZERO,
            |e: &&str| *e == "busy",
            || {
                calls += 1;
                if calls < 3 {
                    Err("busy")
                } else {
                    Ok(calls)
                }
            },
        );
        assert_eq!(got, Ok(3));
    }

    #[test]
    fn stops_at_the_limit_and_on_any_other_error() {
        let mut calls = 0;
        let got: Result<(), &str> = retry_while(
            4,
            Duration::ZERO,
            |e: &&str| *e == "busy",
            || {
                calls += 1;
                Err("busy")
            },
        );
        assert_eq!((got, calls), (Err("busy"), 4));

        let mut calls = 0;
        let got: Result<(), &str> = retry_while(
            4,
            Duration::ZERO,
            |e: &&str| *e == "busy",
            || {
                calls += 1;
                Err("gone")
            },
        );
        assert_eq!((got, calls), (Err("gone"), 1));
    }
}
