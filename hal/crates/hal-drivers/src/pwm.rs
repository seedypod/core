//! PWM actuators: the grow light (hardware PWM, 8 kHz on GPIO18) and the pump
//! (software PWM, 50 Hz on GPIO24). Both are the same dumb mapping — level %
//! → duty — over a [`PwmOut`]; the pump's duty cap lives in `PumpGuard`, not
//! here (ADR-0009).

use hal_core::{Actuator, ActuatorId, DeviceError};

use crate::bus::PwmOut;

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bus::fake::FakePwm;

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
}
