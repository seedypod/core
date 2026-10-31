//! A GPIO input exposed as a [`BinarySensor`] — the PCB over-temperature
//! alert line on GPIO25.

use hal_core::{BinarySensor, DeviceError};

use crate::bus::DigitalIn;

pub struct GpioBinary<I: DigitalIn> {
    name: String,
    pin: I,
    /// Asserted when the pin reads low.
    active_low: bool,
}

impl<I: DigitalIn> GpioBinary<I> {
    pub fn new(name: &str, pin: I, active_low: bool) -> Self {
        Self {
            name: name.to_owned(),
            pin,
            active_low,
        }
    }
}

/// Over-temperature alert input.
pub type OverTempAlert<I> = GpioBinary<I>;

impl<I: DigitalIn> BinarySensor for GpioBinary<I> {
    fn name(&self) -> &str {
        &self.name
    }
    fn probe(&mut self) -> Result<(), DeviceError> {
        self.pin.is_high().map(|_| ())
    }
    fn is_active(&mut self) -> Result<bool, DeviceError> {
        Ok(self.pin.is_high()? != self.active_low)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bus::fake::FakeIn;

    #[test]
    fn polarity_is_applied() {
        let mut hi_active = GpioBinary::new("over_temp", FakeIn::new(&[true, false]), false);
        assert_eq!(hi_active.name(), "over_temp");
        assert!(hi_active.probe().is_ok());
        assert!(!hi_active.is_active().unwrap());
        let mut lo_active = OverTempAlert::new("over_temp", FakeIn::new(&[false, true]), true);
        assert!(lo_active.is_active().unwrap());
        assert!(!lo_active.is_active().unwrap());
    }
}
