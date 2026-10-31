//! ASAIR DHT20 (AHT20 core) temperature/humidity sensor, I²C 0x38 — the
//! air sensor on Gardyn 3.0 and Studio.
//!
//! Sequence: trigger `[0xAC, 0x33, 0x00]`, wait ≥ 80 ms, read 7 bytes
//! `[status, h, h, h|t, t, t, crc8]`, check the busy bit and the CRC.

use std::time::Duration;

use hal_core::{DeviceError, Measurement, MultiSensor, SensorId};

use crate::bus::{Delay, I2cBus};

pub const CMD_TRIGGER: [u8; 3] = [0xAC, 0x33, 0x00];
pub const CMD_STATUS: u8 = 0x71;
pub const STATUS_BUSY: u8 = 0x80;
pub const STATUS_CALIBRATED: u8 = 0x08;
pub const MEASURE_WAIT: Duration = Duration::from_millis(85);

/// CRC-8, polynomial 0x31, init 0xFF, no reflection (datasheet §7.4).
pub fn crc8(data: &[u8]) -> u8 {
    let mut crc: u8 = 0xFF;
    for &b in data {
        crc ^= b;
        for _ in 0..8 {
            crc = if crc & 0x80 != 0 {
                (crc << 1) ^ 0x31
            } else {
                crc << 1
            };
        }
    }
    crc
}

/// Decode a 7-byte frame to (humidity %, temperature °C).
pub fn decode(frame: &[u8; 7]) -> Result<(f64, f64), DeviceError> {
    if frame[0] & STATUS_BUSY != 0 {
        return Err(DeviceError::Other("DHT20 still measuring".into()));
    }
    if crc8(&frame[..6]) != frame[6] {
        return Err(DeviceError::Bus("DHT20 CRC mismatch".into()));
    }
    let raw_h = ((frame[1] as u32) << 12) | ((frame[2] as u32) << 4) | ((frame[3] as u32) >> 4);
    let raw_t = (((frame[3] & 0x0F) as u32) << 16) | ((frame[4] as u32) << 8) | frame[5] as u32;
    let h = raw_h as f64 / 1_048_576.0 * 100.0;
    let t = raw_t as f64 / 1_048_576.0 * 200.0 - 50.0;
    Ok((h, t))
}

pub struct Dht20<B: I2cBus, D: Delay> {
    bus: B,
    delay: D,
    addr: u16,
}

impl<B: I2cBus, D: Delay> Dht20<B, D> {
    pub fn new(bus: B, delay: D, addr: u16) -> Self {
        Self { bus, delay, addr }
    }
}

impl<B: I2cBus, D: Delay> MultiSensor for Dht20<B, D> {
    fn ids(&self) -> Vec<SensorId> {
        vec![SensorId::Humidity, SensorId::AirTemp]
    }
    fn probe(&mut self) -> Result<(), DeviceError> {
        let mut status = [0u8; 1];
        self.bus.write_read(self.addr, &[CMD_STATUS], &mut status)?;
        if status[0] & STATUS_CALIBRATED == 0 {
            // Datasheet: send the init command, then wait 10 ms.
            self.bus.write(self.addr, &[0xBE, 0x08, 0x00])?;
            self.delay.sleep(Duration::from_millis(10));
        }
        Ok(())
    }
    fn measure(&mut self) -> Result<Vec<Measurement>, DeviceError> {
        self.bus.write(self.addr, &CMD_TRIGGER)?;
        self.delay.sleep(MEASURE_WAIT);
        let mut frame = [0u8; 7];
        self.bus.read(self.addr, &mut frame)?;
        let (h, t) = decode(&frame)?;
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

    /// Build a valid frame for the given raw 20-bit values.
    fn frame(raw_h: u32, raw_t: u32, busy: bool) -> [u8; 7] {
        let mut f = [0u8; 7];
        f[0] = 0x1C | if busy { STATUS_BUSY } else { 0 };
        f[1] = (raw_h >> 12) as u8;
        f[2] = (raw_h >> 4) as u8;
        f[3] = (((raw_h & 0xF) << 4) as u8) | ((raw_t >> 16) as u8 & 0x0F);
        f[4] = (raw_t >> 8) as u8;
        f[5] = raw_t as u8;
        f[6] = crc8(&f[..6]);
        f
    }

    #[test]
    fn crc8_matches_known_vectors() {
        // Standard CRC-8/NRSC-5 check value for "123456789" is 0xF7.
        assert_eq!(crc8(b"123456789"), 0xF7);
        assert_eq!(crc8(&[]), 0xFF);
    }

    #[test]
    fn decodes_half_scale_humidity_and_room_temperature() {
        // raw_h = 2^19 → 50 %; raw_t = (25+50)/200 × 2^20 = 393216 → 25 °C.
        let (h, t) = decode(&frame(524_288, 393_216, false)).unwrap();
        assert!((h - 50.0).abs() < 1e-9);
        assert!((t - 25.0).abs() < 1e-9);
    }

    #[test]
    fn rejects_busy_and_bad_crc() {
        assert!(matches!(decode(&frame(0, 0, true)), Err(DeviceError::Other(_))));
        let mut f = frame(1, 1, false);
        f[6] ^= 0xFF;
        assert!(matches!(decode(&f), Err(DeviceError::Bus(_))));
    }

    #[test]
    fn measure_triggers_waits_and_reads_seven_bytes() {
        let bus = FakeI2c::with_reads(vec![frame(524_288, 393_216, false).to_vec()]);
        let mut d = Dht20::new(bus, NoDelay::default(), 0x38);
        let m = d.measure().unwrap();
        assert_eq!(m[0].id, SensorId::Humidity);
        assert_eq!(m[1].id, SensorId::AirTemp);
        assert_eq!(d.bus.writes, vec![(0x38, CMD_TRIGGER.to_vec())]);
        assert_eq!(d.delay.slept, vec![MEASURE_WAIT]);
        assert_eq!(d.ids(), vec![SensorId::Humidity, SensorId::AirTemp]);
    }

    #[test]
    fn probe_initialises_only_when_uncalibrated() {
        let mut d = Dht20::new(FakeI2c::with_reads(vec![vec![0x18]]), NoDelay::default(), 0x38);
        d.probe().unwrap();
        assert_eq!(d.bus.writes.len(), 1);
        let mut d = Dht20::new(FakeI2c::with_reads(vec![vec![0x10]]), NoDelay::default(), 0x38);
        d.probe().unwrap();
        assert_eq!(d.bus.writes[1], (0x38, vec![0xBE, 0x08, 0x00]));
        assert_eq!(d.delay.slept, vec![Duration::from_millis(10)]);
    }
}
