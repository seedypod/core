//! TI INA219 bus-voltage / shunt-voltage / current / power monitor on the
//! pump supply (I²C 0x40 on the Gardyn board).

use hal_core::{DeviceError, Measurement, MultiSensor, SensorId};

use crate::bus::I2cBus;

pub const REG_CONFIG: u8 = 0x00;
pub const REG_SHUNT: u8 = 0x01;
pub const REG_BUS: u8 = 0x02;
pub const REG_POWER: u8 = 0x03;
pub const REG_CURRENT: u8 = 0x04;
pub const REG_CALIBRATION: u8 = 0x05;

/// 32 V range, ±320 mV shunt (PGA /8), 12-bit, continuous shunt+bus.
pub const CONFIG_DEFAULT: u16 = 0x399F;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Ina219Config {
    pub addr: u16,
    pub shunt_ohms: f64,
    /// Largest current the calibration should resolve (A).
    pub max_expected_amps: f64,
}

impl Default for Ina219Config {
    fn default() -> Self {
        Self {
            addr: 0x40,
            shunt_ohms: 0.1,
            max_expected_amps: 3.2,
        }
    }
}

/// Derived calibration: (`calibration register`, `current LSB` A/bit, `power LSB` W/bit).
pub fn calibration(cfg: &Ina219Config) -> (u16, f64, f64) {
    let current_lsb = cfg.max_expected_amps / 32_767.0;
    let cal = (0.04096 / (current_lsb * cfg.shunt_ohms)).trunc();
    let cal = cal.clamp(1.0, 65_535.0) as u16;
    (cal, current_lsb, current_lsb * 20.0)
}

/// Shunt register → volts (10 µV / bit, signed).
pub fn decode_shunt_v(raw: [u8; 2]) -> f64 {
    i16::from_be_bytes(raw) as f64 * 10e-6
}

/// Bus register → (volts, conversion ready, overflow). 4 mV / bit in bits 15..3.
pub fn decode_bus_v(raw: [u8; 2]) -> (f64, bool, bool) {
    let v = u16::from_be_bytes(raw);
    ((v >> 3) as f64 * 0.004, v & 0x2 != 0, v & 0x1 != 0)
}

pub fn decode_current_a(raw: [u8; 2], current_lsb: f64) -> f64 {
    i16::from_be_bytes(raw) as f64 * current_lsb
}

pub fn decode_power_w(raw: [u8; 2], power_lsb: f64) -> f64 {
    u16::from_be_bytes(raw) as f64 * power_lsb
}

pub struct Ina219<B: I2cBus> {
    bus: B,
    cfg: Ina219Config,
    current_lsb: f64,
    power_lsb: f64,
}

impl<B: I2cBus> Ina219<B> {
    pub fn new(bus: B, cfg: Ina219Config) -> Self {
        let (_, current_lsb, power_lsb) = calibration(&cfg);
        Self {
            bus,
            cfg,
            current_lsb,
            power_lsb,
        }
    }

    fn read_reg(&mut self, reg: u8) -> Result<[u8; 2], DeviceError> {
        let mut out = [0u8; 2];
        self.bus.write_read(self.cfg.addr, &[reg], &mut out)?;
        Ok(out)
    }

    fn write_reg(&mut self, reg: u8, v: u16) -> Result<(), DeviceError> {
        let [hi, lo] = v.to_be_bytes();
        self.bus.write(self.cfg.addr, &[reg, hi, lo])
    }
}

impl<B: I2cBus> MultiSensor for Ina219<B> {
    fn ids(&self) -> Vec<SensorId> {
        vec![SensorId::PumpV, SensorId::PumpA, SensorId::PumpW]
    }
    fn probe(&mut self) -> Result<(), DeviceError> {
        let (cal, _, _) = calibration(&self.cfg);
        self.write_reg(REG_CONFIG, CONFIG_DEFAULT)?;
        self.write_reg(REG_CALIBRATION, cal)
    }
    fn measure(&mut self) -> Result<Vec<Measurement>, DeviceError> {
        let (bus_v, _ready, overflow) = decode_bus_v(self.read_reg(REG_BUS)?);
        if overflow {
            return Err(DeviceError::Other("INA219 math overflow".into()));
        }
        let shunt_v = decode_shunt_v(self.read_reg(REG_SHUNT)?);
        let current = decode_current_a(self.read_reg(REG_CURRENT)?, self.current_lsb);
        let power = decode_power_w(self.read_reg(REG_POWER)?, self.power_lsb);
        // Cross-check: if the calibration register was reset (brown-out), the
        // current register reads 0 while the shunt still shows a drop.
        let current = if current == 0.0 && shunt_v.abs() > 1e-4 {
            shunt_v / self.cfg.shunt_ohms
        } else {
            current
        };
        let power = if power == 0.0 && current != 0.0 {
            bus_v * current
        } else {
            power
        };
        Ok(vec![
            Measurement {
                id: SensorId::PumpV,
                value: bus_v,
                unit: "V",
            },
            Measurement {
                id: SensorId::PumpA,
                value: current,
                unit: "A",
            },
            Measurement {
                id: SensorId::PumpW,
                value: power,
                unit: "W",
            },
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bus::fake::FakeI2c;

    #[test]
    fn calibration_matches_the_datasheet_example() {
        // Datasheet §8.5.1 worked example: 0.1 Ω, 3.2 A max → Current_LSB
        // = 3.2/32767 ≈ 97.66 µA (the datasheet rounds to 100 µA → 4096;
        // we keep the exact LSB → 4194).
        let (cal, lsb, plsb) = calibration(&Ina219Config::default());
        assert_eq!(cal, 4194);
        assert!((lsb - 9.766e-5).abs() < 1e-7);
        assert!((plsb - 1.953e-3).abs() < 1e-6);
        let tiny = Ina219Config {
            shunt_ohms: 1e-9,
            ..Default::default()
        };
        assert_eq!(calibration(&tiny).0, 65_535);
    }

    #[test]
    fn decoders_handle_sign_flags_and_scale() {
        assert_eq!(decode_shunt_v([0x00, 0x64]), 100.0 * 10e-6);
        assert!((decode_shunt_v([0xFF, 0x9C]) + 0.001).abs() < 1e-9);
        // 12.0 V = 3000 × 4 mV → 3000 << 3 = 0x5DC0, plus CNVR bit.
        let (v, ready, ovf) = decode_bus_v([0x5D, 0xC2]);
        assert!((v - 12.0).abs() < 1e-9);
        assert!(ready && !ovf);
        assert!(decode_bus_v([0x00, 0x01]).2);
        assert_eq!(decode_current_a([0x27, 0x10], 1e-4), 1.0);
        assert_eq!(decode_power_w([0x00, 0x0A], 0.002), 0.02);
    }

    #[test]
    fn probe_writes_config_then_calibration() {
        let mut d = Ina219::new(FakeI2c::default(), Ina219Config::default());
        d.probe().unwrap();
        assert_eq!(
            d.bus.writes,
            vec![(0x40, vec![0x00, 0x39, 0x9F]), (0x40, vec![0x05, 0x10, 0x62])]
        );
        assert_eq!(d.ids().len(), 3);
    }

    #[test]
    fn measure_reads_four_registers_and_reports_v_a_w() {
        let bus = FakeI2c::with_reads(vec![
            vec![0x5D, 0xC2], // bus 12.0 V
            vec![0x03, 0xE8], // shunt 1000 × 10 µV = 10 mV
            vec![0x04, 0x00], // current 1024 × 97.66 µA ≈ 0.1 A
            vec![0x00, 0x27], // power 39 × 1.953 mW ≈ 0.076 W
        ]);
        let mut d = Ina219::new(bus, Ina219Config::default());
        let m = d.measure().unwrap();
        assert_eq!(m[0].id, SensorId::PumpV);
        assert!((m[0].value - 12.0).abs() < 1e-9);
        assert!((m[1].value - 0.1).abs() < 1e-3);
        assert!((m[2].value - 0.076).abs() < 1e-3);
        assert_eq!(
            d.bus.writes.iter().map(|(_, w)| w[0]).collect::<Vec<_>>(),
            vec![REG_BUS, REG_SHUNT, REG_CURRENT, REG_POWER]
        );
    }

    #[test]
    fn falls_back_to_shunt_math_when_calibration_was_lost() {
        let bus = FakeI2c::with_reads(vec![
            vec![0x5D, 0xC0],
            vec![0x03, 0xE8], // 10 mV across 0.1 Ω = 0.1 A
            vec![0x00, 0x00],
            vec![0x00, 0x00],
        ]);
        let mut d = Ina219::new(bus, Ina219Config::default());
        let m = d.measure().unwrap();
        assert!((m[1].value - 0.1).abs() < 1e-9);
        assert!((m[2].value - 1.2).abs() < 1e-9);
    }

    #[test]
    fn overflow_is_an_error() {
        let bus = FakeI2c::with_reads(vec![vec![0x5D, 0xC1]]);
        let mut d = Ina219::new(bus, Ina219Config::default());
        assert!(matches!(d.measure(), Err(DeviceError::Other(_))));
    }
}
