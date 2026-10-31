//! rppal-backed implementations of the bus traits. Only compiled with the
//! `hardware` feature; constructors fail at runtime off a Raspberry Pi.

use std::sync::{Arc, Mutex};

use hal_core::DeviceError;
use rppal::gpio::{Gpio, InputPin, OutputPin};
use rppal::i2c::I2c;
use rppal::pwm::{Channel, Polarity, Pwm};

use crate::bus::{DigitalIn, DigitalOut, I2cBus, PwmOut};

fn bus_err<E: std::fmt::Display>(e: E) -> DeviceError {
    DeviceError::Bus(e.to_string())
}

/// One `/dev/i2c-N` handle, shareable between drivers.
#[derive(Clone)]
pub struct RppalI2c(Arc<Mutex<I2c>>);

impl RppalI2c {
    pub fn open(bus: u8) -> Result<Self, DeviceError> {
        let i2c = I2c::with_bus(bus).map_err(bus_err)?;
        Ok(Self(Arc::new(Mutex::new(i2c))))
    }
}

impl I2cBus for RppalI2c {
    fn write(&mut self, addr: u16, bytes: &[u8]) -> Result<(), DeviceError> {
        let mut i2c = self.0.lock().unwrap_or_else(|e| e.into_inner());
        i2c.set_slave_address(addr).map_err(bus_err)?;
        i2c.write(bytes).map_err(bus_err).map(|_| ())
    }
    fn read(&mut self, addr: u16, buf: &mut [u8]) -> Result<(), DeviceError> {
        let mut i2c = self.0.lock().unwrap_or_else(|e| e.into_inner());
        i2c.set_slave_address(addr).map_err(bus_err)?;
        i2c.read(buf).map_err(bus_err).map(|_| ())
    }
    fn write_read(&mut self, addr: u16, w: &[u8], r: &mut [u8]) -> Result<(), DeviceError> {
        let mut i2c = self.0.lock().unwrap_or_else(|e| e.into_inner());
        i2c.set_slave_address(addr).map_err(bus_err)?;
        i2c.write_read(w, r).map_err(bus_err)
    }
}

pub struct RppalOut(OutputPin);

impl RppalOut {
    pub fn open(bcm: u8) -> Result<Self, DeviceError> {
        let pin = Gpio::new()
            .map_err(bus_err)?
            .get(bcm)
            .map_err(bus_err)?
            .into_output_low();
        Ok(Self(pin))
    }
}

impl DigitalOut for RppalOut {
    fn set(&mut self, high: bool) -> Result<(), DeviceError> {
        if high {
            self.0.set_high();
        } else {
            self.0.set_low();
        }
        Ok(())
    }
}

pub struct RppalIn(InputPin);

impl RppalIn {
    /// `pull_up` wires the internal pull-up (buttons); otherwise floating.
    pub fn open(bcm: u8, pull_up: bool) -> Result<Self, DeviceError> {
        let pin = Gpio::new().map_err(bus_err)?.get(bcm).map_err(bus_err)?;
        Ok(Self(if pull_up {
            pin.into_input_pullup()
        } else {
            pin.into_input()
        }))
    }
}

impl DigitalIn for RppalIn {
    fn is_high(&mut self) -> Result<bool, DeviceError> {
        Ok(self.0.is_high())
    }
}

/// Hardware PWM (sysfs `pwmchip`). GPIO18 is channel 0 on Pi ≤ 4 and channel
/// 2 on the Pi 5; needs `dtoverlay=pwm` in `config.txt`.
pub struct HwPwm(Pwm);

impl HwPwm {
    pub fn open(channel: u8, hz: f64) -> Result<Self, DeviceError> {
        let ch = match channel {
            0 => Channel::Pwm0,
            1 => Channel::Pwm1,
            2 => Channel::Pwm2,
            3 => Channel::Pwm3,
            n => return Err(DeviceError::Other(format!("no PWM channel {n}"))),
        };
        let pwm = Pwm::with_frequency(ch, hz, 0.0, Polarity::Normal, true).map_err(bus_err)?;
        Ok(Self(pwm))
    }
}

impl PwmOut for HwPwm {
    fn set_duty(&mut self, duty: f64) -> Result<(), DeviceError> {
        self.0.set_duty_cycle(duty.clamp(0.0, 1.0)).map_err(bus_err)
    }
}

/// Software PWM on any GPIO: rppal times it on a dedicated thread.
pub struct SoftPwm {
    pin: OutputPin,
    hz: f64,
}

impl SoftPwm {
    pub fn open(bcm: u8, hz: f64) -> Result<Self, DeviceError> {
        let pin = Gpio::new()
            .map_err(bus_err)?
            .get(bcm)
            .map_err(bus_err)?
            .into_output_low();
        Ok(Self { pin, hz })
    }
}

impl PwmOut for SoftPwm {
    fn set_duty(&mut self, duty: f64) -> Result<(), DeviceError> {
        if duty <= 0.0 {
            self.pin.clear_pwm().map_err(bus_err)?;
            self.pin.set_low();
            Ok(())
        } else {
            self.pin
                .set_pwm_frequency(self.hz, duty.min(1.0))
                .map_err(bus_err)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_pwm_channel_is_an_error_without_touching_sysfs() {
        assert!(matches!(HwPwm::open(7, 8000.0), Err(DeviceError::Other(_))));
    }

    #[test]
    fn off_a_pi_the_constructors_fail_cleanly() {
        // On a real Pi these succeed; everywhere else they must return an
        // error rather than panic so `hald` can report and keep running.
        let on_pi = std::path::Path::new("/dev/gpiomem").exists();
        if !on_pi {
            assert!(RppalOut::open(24).is_err());
            assert!(RppalIn::open(13, true).is_err());
            assert!(SoftPwm::open(24, 50.0).is_err());
        }
    }
}
