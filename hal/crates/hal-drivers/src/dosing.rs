//! Peristaltic dosing pump on a GPIO through a MOSFET: on or off. Volume →
//! time is the guard's business (`hal_core::safety::DoseGuard` owns the
//! calibration and the caps); this driver only switches the pin, and offers
//! the same conversion for anyone who wants to display it.

use hal_core::{Actuator, ActuatorId, DeviceError};

use crate::bus::DigitalOut;

/// Seconds to deliver `ml` at `ml_per_s` (ceil, ≥ 1 s for any positive volume).
pub fn ml_to_seconds(ml: f64, ml_per_s: f64) -> u64 {
    if ml <= 0.0 || ml_per_s <= 0.0 {
        return 0;
    }
    (ml / ml_per_s).ceil().max(1.0) as u64
}

pub struct DosingPump<P: DigitalOut> {
    id: ActuatorId,
    pin: P,
    active_low: bool,
    level: f64,
}

impl<P: DigitalOut> DosingPump<P> {
    pub fn new(id: ActuatorId, pin: P, active_low: bool) -> Self {
        Self {
            id,
            pin,
            active_low,
            level: 0.0,
        }
    }

    fn drive(&mut self, on: bool) -> Result<(), DeviceError> {
        self.pin.set(on != self.active_low)
    }
}

impl<P: DigitalOut> Actuator for DosingPump<P> {
    fn id(&self) -> ActuatorId {
        self.id
    }
    fn probe(&mut self) -> Result<(), DeviceError> {
        // Always start de-energised.
        self.level = 0.0;
        self.drive(false)
    }
    fn set_level(&mut self, level: f64) -> Result<(), DeviceError> {
        let on = level > 0.0;
        self.drive(on)?;
        self.level = if on { 100.0 } else { 0.0 };
        Ok(())
    }
    fn level(&self) -> f64 {
        self.level
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bus::fake::FakeOut;

    #[test]
    fn ml_to_seconds_rounds_up_and_guards_zero() {
        assert_eq!(ml_to_seconds(5.0, 1.0), 5);
        assert_eq!(ml_to_seconds(5.0, 2.0), 3);
        assert_eq!(ml_to_seconds(0.1, 2.0), 1);
        assert_eq!(ml_to_seconds(0.0, 2.0), 0);
        assert_eq!(ml_to_seconds(5.0, 0.0), 0);
    }

    #[test]
    fn pump_is_binary_and_respects_polarity() {
        let mut p = DosingPump::new(ActuatorId::Dose1, FakeOut::default(), false);
        assert_eq!(p.id(), ActuatorId::Dose1);
        p.probe().unwrap();
        p.set_level(37.0).unwrap();
        assert_eq!(p.level(), 100.0);
        p.set_level(0.0).unwrap();
        assert_eq!(p.level(), 0.0);
        assert_eq!(p.pin.history, vec![false, true, false]);

        let mut inv = DosingPump::new(ActuatorId::Dose2, FakeOut::default(), true);
        inv.set_level(100.0).unwrap();
        inv.probe().unwrap();
        assert_eq!(inv.pin.history, vec![false, true]);
        assert_eq!(inv.level(), 0.0);
    }
}
