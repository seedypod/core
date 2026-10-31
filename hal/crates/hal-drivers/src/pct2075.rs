//! NXP PCT2075 board-temperature sensor (I²C 0x48). 11-bit, 0.125 °C/LSB.

use hal_core::{DeviceError, Reading, Sensor, SensorId};

use crate::bus::I2cBus;

pub const REG_TEMP: u8 = 0x00;
pub const REG_CONF: u8 = 0x01;

/// Temperature register → °C. Two's complement in the top 11 bits.
pub fn decode_temp_c(raw: [u8; 2]) -> f64 {
    (i16::from_be_bytes(raw) >> 5) as f64 * 0.125
}

pub struct Pct2075<B: I2cBus> {
    bus: B,
    addr: u16,
}

impl<B: I2cBus> Pct2075<B> {
    pub fn new(bus: B, addr: u16) -> Self {
        Self { bus, addr }
    }
}

impl<B: I2cBus> Sensor for Pct2075<B> {
    fn id(&self) -> SensorId {
        SensorId::PcbTemp
    }
    fn probe(&mut self) -> Result<(), DeviceError> {
        // Normal operation, comparator mode: config = 0.
        self.bus.write(self.addr, &[REG_CONF, 0x00])
    }
    fn read(&mut self) -> Result<Reading, DeviceError> {
        let mut raw = [0u8; 2];
        self.bus.write_read(self.addr, &[REG_TEMP], &mut raw)?;
        Ok(Reading::new(decode_temp_c(raw), "°C"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bus::fake::FakeI2c;

    #[test]
    fn decodes_datasheet_values() {
        // Table 8 of the datasheet.
        assert_eq!(decode_temp_c([0x7F, 0xE0]), 127.875);
        assert_eq!(decode_temp_c([0x19, 0x00]), 25.0);
        assert_eq!(decode_temp_c([0x00, 0x20]), 0.125);
        assert_eq!(decode_temp_c([0x00, 0x00]), 0.0);
        assert_eq!(decode_temp_c([0xFF, 0xE0]), -0.125);
        assert_eq!(decode_temp_c([0xE7, 0x00]), -25.0);
        assert_eq!(decode_temp_c([0xC9, 0x00]), -55.0);
    }

    #[test]
    fn read_points_at_the_temperature_register() {
        let mut s = Pct2075::new(FakeI2c::with_reads(vec![vec![0x1F, 0x80]]), 0x48);
        assert_eq!(s.id(), SensorId::PcbTemp);
        s.probe().unwrap();
        let r = s.read().unwrap();
        assert_eq!((r.value, r.unit.as_str()), (31.5, "°C"));
        assert_eq!(s.bus.writes, vec![(0x48, vec![0x01, 0x00]), (0x48, vec![0x00])]);
    }
}
