//! ASAIR AM2320 temperature/humidity sensor, I²C 0x5C — the air sensor on
//! Gardyn 1.0/2.0.
//!
//! The part sleeps between reads and NACKs the first address it sees, so it
//! never shows up in `i2cdetect` (upstream garden-of-eden #142). Sequence:
//! wake write (NACK ignored), wait ≥ 0.8 ms, function 0x03 read of registers
//! 0x00–0x03, wait ≥ 1.5 ms, read 8 bytes, CRC-16/MODBUS over the first six.

use std::time::Duration;

use hal_core::{DeviceError, Measurement, MultiSensor, SensorId};

use crate::bus::{Delay, I2cBus};

pub const CMD_READ_REGS: [u8; 3] = [0x03, 0x00, 0x04];
pub const WAKE_WAIT: Duration = Duration::from_millis(1);
pub const READ_WAIT: Duration = Duration::from_millis(2);

/// CRC-16/MODBUS: poly 0x8005 reflected (0xA001), init 0xFFFF.
pub fn crc16(data: &[u8]) -> u16 {
    let mut crc: u16 = 0xFFFF;
    for &b in data {
        crc ^= b as u16;
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xA001
            } else {
                crc >> 1
            };
        }
    }
    crc
}

/// Decode the 8-byte reply `[func, len, h_hi, h_lo, t_hi, t_lo, crc_lo, crc_hi]`.
pub fn decode(frame: &[u8; 8]) -> Result<(f64, f64), DeviceError> {
    if frame[0] != 0x03 || frame[1] != 0x04 {
        return Err(DeviceError::Bus(format!(
            "AM2320 unexpected header {:02X} {:02X}",
            frame[0], frame[1]
        )));
    }
    let crc = u16::from_le_bytes([frame[6], frame[7]]);
    if crc16(&frame[..6]) != crc {
        return Err(DeviceError::Bus("AM2320 CRC mismatch".into()));
    }
    let h = u16::from_be_bytes([frame[2], frame[3]]) as f64 / 10.0;
    let t_mag = u16::from_be_bytes([frame[4] & 0x7F, frame[5]]) as f64 / 10.0;
    let t = if frame[4] & 0x80 != 0 { -t_mag } else { t_mag };
    Ok((h, t))
}

pub struct Am2320<B: I2cBus, D: Delay> {
    bus: B,
    delay: D,
    addr: u16,
}

impl<B: I2cBus, D: Delay> Am2320<B, D> {
    pub fn new(bus: B, delay: D, addr: u16) -> Self {
        Self { bus, delay, addr }
    }

    fn wake(&mut self) {
        // The sensor NACKs its wake-up; that is expected, not an error.
        let _ = self.bus.write(self.addr, &[0x00]);
        self.delay.sleep(WAKE_WAIT);
    }

    /// One full transaction; `probe` and `measure` share it so probing does
    /// not rely on an ACK the sleeping part will never give.
    fn transact(&mut self) -> Result<(f64, f64), DeviceError> {
        self.wake();
        self.bus.write(self.addr, &CMD_READ_REGS)?;
        self.delay.sleep(READ_WAIT);
        let mut frame = [0u8; 8];
        self.bus.read(self.addr, &mut frame)?;
        decode(&frame)
    }
}

impl<B: I2cBus, D: Delay> MultiSensor for Am2320<B, D> {
    fn ids(&self) -> Vec<SensorId> {
        vec![SensorId::Humidity, SensorId::AirTemp]
    }
    fn probe(&mut self) -> Result<(), DeviceError> {
        self.transact().map(|_| ())
    }
    fn measure(&mut self) -> Result<Vec<Measurement>, DeviceError> {
        let (h, t) = self.transact()?;
        Ok(vec![
            Measurement {
                id: SensorId::Humidity,
                value: h,
                unit: "%",
            },
            Measurement {
                id: SensorId::AirTemp,
                value: t,
                unit: "°C",
            },
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bus::fake::{FakeI2c, NoDelay};

    fn frame(h_x10: u16, t_x10: i16) -> [u8; 8] {
        let mut f = [0x03, 0x04, 0, 0, 0, 0, 0, 0];
        f[2..4].copy_from_slice(&h_x10.to_be_bytes());
        let mag = t_x10.unsigned_abs();
        f[4..6].copy_from_slice(&mag.to_be_bytes());
        if t_x10 < 0 {
            f[4] |= 0x80;
        }
        let crc = crc16(&f[..6]).to_le_bytes();
        f[6] = crc[0];
        f[7] = crc[1];
        f
    }

    #[test]
    fn crc16_modbus_check_value() {
        assert_eq!(crc16(b"123456789"), 0x4B37);
        assert_eq!(crc16(&[]), 0xFFFF);
    }

    #[test]
    fn decodes_positive_and_negative_temperatures() {
        assert_eq!(decode(&frame(485, 231)).unwrap(), (48.5, 23.1));
        assert_eq!(decode(&frame(100, -55)).unwrap(), (10.0, -5.5));
    }

    #[test]
    fn rejects_bad_header_and_bad_crc() {
        let mut f = frame(1, 1);
        f[0] = 0x04;
        assert!(matches!(decode(&f), Err(DeviceError::Bus(_))));
        let mut f = frame(1, 1);
        f[7] ^= 1;
        assert!(matches!(decode(&f), Err(DeviceError::Bus(_))));
    }

    #[test]
    fn measure_wakes_ignoring_the_nack_then_reads() {
        let bus = FakeI2c::with_reads(vec![frame(485, 231).to_vec()]);
        let mut d = Am2320::new(bus, NoDelay::default(), 0x5C);
        let m = d.measure().unwrap();
        assert_eq!((m[0].value, m[1].value), (48.5, 23.1));
        assert_eq!(
            d.bus.writes,
            vec![(0x5C, vec![0x00]), (0x5C, CMD_READ_REGS.to_vec())]
        );
        assert_eq!(d.delay.slept, vec![WAKE_WAIT, READ_WAIT]);
        assert_eq!(d.ids().len(), 2);
    }

    #[test]
    fn probe_is_a_real_transaction_not_an_address_ping() {
        let mut d = Am2320::new(
            FakeI2c::with_reads(vec![frame(500, 200).to_vec()]),
            NoDelay::default(),
            0x5C,
        );
        d.probe().unwrap();
        assert_eq!(d.bus.writes.len(), 2);
        // A dead bus fails the probe.
        let bus = FakeI2c {
            nack_writes_to: Some(0x5C),
            ..Default::default()
        };
        let mut d = Am2320::new(bus, NoDelay::default(), 0x5C);
        assert!(d.probe().is_err());
    }
}
