//! The thin seams between a driver and the silicon. Drivers are generic over
//! these traits so their register decoding, CRCs and timing math run on a
//! laptop against scripted bytes; `crate::hw` implements them with rppal.

use std::time::{Duration, Instant};

use hal_core::DeviceError;

/// 7-bit-addressed I²C master. Every call names the slave address so one bus
/// object can be shared by several drivers.
pub trait I2cBus: Send {
    fn write(&mut self, addr: u16, bytes: &[u8]) -> Result<(), DeviceError>;
    fn read(&mut self, addr: u16, buf: &mut [u8]) -> Result<(), DeviceError>;
    fn write_read(&mut self, addr: u16, w: &[u8], r: &mut [u8]) -> Result<(), DeviceError> {
        self.write(addr, w)?;
        self.read(addr, r)
    }
}

/// Blocking sleep; tests substitute a no-op.
pub trait Delay: Send {
    fn sleep(&mut self, d: Duration);
}

/// `std::thread::sleep`.
#[derive(Debug, Default, Clone, Copy)]
pub struct StdDelay;
impl Delay for StdDelay {
    fn sleep(&mut self, d: Duration) {
        std::thread::sleep(d);
    }
}

/// Monotonic clock; tests substitute a scripted one.
pub trait Clock: Send {
    fn now(&mut self) -> Instant;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct StdClock;
impl Clock for StdClock {
    fn now(&mut self) -> Instant {
        Instant::now()
    }
}

pub trait DigitalOut: Send {
    fn set(&mut self, high: bool) -> Result<(), DeviceError>;
}

pub trait DigitalIn: Send {
    fn is_high(&mut self) -> Result<bool, DeviceError>;
}

/// A PWM output. `duty` is 0.0–1.0.
pub trait PwmOut: Send {
    fn set_duty(&mut self, duty: f64) -> Result<(), DeviceError>;
}

/// Shared scripted fakes for driver unit tests.
#[cfg(test)]
pub(crate) mod fake {
    use super::*;
    use std::collections::VecDeque;

    /// Records writes; serves reads from a queue of scripted buffers.
    #[derive(Default)]
    pub struct FakeI2c {
        pub writes: Vec<(u16, Vec<u8>)>,
        pub reads: VecDeque<Result<Vec<u8>, DeviceError>>,
        /// Fail every write to this address (an AM2320 asleep NACKs).
        pub nack_writes_to: Option<u16>,
    }

    impl FakeI2c {
        pub fn with_reads(reads: Vec<Vec<u8>>) -> Self {
            Self {
                reads: reads.into_iter().map(Ok).collect(),
                ..Default::default()
            }
        }
    }

    impl I2cBus for FakeI2c {
        fn write(&mut self, addr: u16, bytes: &[u8]) -> Result<(), DeviceError> {
            self.writes.push((addr, bytes.to_vec()));
            if self.nack_writes_to == Some(addr) {
                return Err(DeviceError::Bus("NACK".into()));
            }
            Ok(())
        }
        fn read(&mut self, _addr: u16, buf: &mut [u8]) -> Result<(), DeviceError> {
            let next = self.reads.pop_front().unwrap_or(Err(DeviceError::Timeout))?;
            if next.len() != buf.len() {
                return Err(DeviceError::Bus(format!(
                    "scripted {} bytes, driver asked for {}",
                    next.len(),
                    buf.len()
                )));
            }
            buf.copy_from_slice(&next);
            Ok(())
        }
    }

    #[derive(Default)]
    pub struct NoDelay {
        pub slept: Vec<Duration>,
    }
    impl Delay for NoDelay {
        fn sleep(&mut self, d: Duration) {
            self.slept.push(d);
        }
    }

    /// A clock that advances by a fixed step on every `now()`.
    pub struct StepClock {
        pub t: Instant,
        pub step: Duration,
    }
    impl StepClock {
        pub fn new(step: Duration) -> Self {
            Self {
                t: Instant::now(),
                step,
            }
        }
    }
    impl Clock for StepClock {
        fn now(&mut self) -> Instant {
            let t = self.t;
            self.t += self.step;
            t
        }
    }

    #[derive(Default)]
    pub struct FakeOut {
        pub history: Vec<bool>,
    }
    impl DigitalOut for FakeOut {
        fn set(&mut self, high: bool) -> Result<(), DeviceError> {
            self.history.push(high);
            Ok(())
        }
    }

    /// Returns scripted levels in order; repeats the last one when exhausted.
    pub struct FakeIn {
        pub levels: VecDeque<bool>,
        last: bool,
    }
    impl FakeIn {
        pub fn new(levels: &[bool]) -> Self {
            Self {
                levels: levels.iter().copied().collect(),
                last: false,
            }
        }
    }
    impl DigitalIn for FakeIn {
        fn is_high(&mut self) -> Result<bool, DeviceError> {
            if let Some(l) = self.levels.pop_front() {
                self.last = l;
            }
            Ok(self.last)
        }
    }

    #[derive(Default)]
    pub struct FakePwm {
        pub duties: Vec<f64>,
    }
    impl PwmOut for FakePwm {
        fn set_duty(&mut self, duty: f64) -> Result<(), DeviceError> {
            self.duties.push(duty);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::*;
    use super::*;

    #[test]
    fn default_write_read_is_write_then_read() {
        let mut bus = FakeI2c::with_reads(vec![vec![1, 2]]);
        let mut out = [0u8; 2];
        bus.write_read(0x48, &[0x00], &mut out).unwrap();
        assert_eq!(bus.writes, vec![(0x48, vec![0x00])]);
        assert_eq!(out, [1, 2]);
    }

    #[test]
    fn fake_i2c_reports_script_exhaustion_and_length_mismatch() {
        let mut bus = FakeI2c::with_reads(vec![vec![1]]);
        let mut two = [0u8; 2];
        assert!(matches!(bus.read(0x48, &mut two), Err(DeviceError::Bus(_))));
        assert!(matches!(bus.read(0x48, &mut two), Err(DeviceError::Timeout)));
    }

    #[test]
    fn std_clock_and_delay_are_usable() {
        let mut c = StdClock;
        let a = c.now();
        StdDelay.sleep(Duration::from_millis(1));
        assert!(c.now() >= a);
    }
}
