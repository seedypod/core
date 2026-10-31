//! Atlas Scientific EZO circuits in I²C mode: pH (0x63), EC (0x64), RTD
//! (0x66). Protocol: write an ASCII command, wait (≈900 ms for `R`, 300 ms
//! for most others), read up to 32 bytes: `[code, ascii…, 0x00]` where code
//! 1 = ok, 2 = syntax error, 254 = still processing, 255 = no data.
//!
//! Calibration (`Cal,…`) is exposed as methods so core/UI can drive it over
//! MQTT later without the driver knowing about either.

use std::time::Duration;

use hal_core::{DeviceError, Reading, Sensor, SensorId};

use crate::bus::{Delay, I2cBus};

pub const READ_WAIT: Duration = Duration::from_millis(900);
pub const SHORT_WAIT: Duration = Duration::from_millis(300);
pub const RESPONSE_LEN: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EzoKind {
    Ph,
    Ec,
    Rtd,
}

impl EzoKind {
    pub fn default_addr(self) -> u16 {
        match self {
            EzoKind::Ph => 0x63,
            EzoKind::Ec => 0x64,
            EzoKind::Rtd => 0x66,
        }
    }
    pub fn sensor_id(self) -> SensorId {
        match self {
            EzoKind::Ph => SensorId::Ph,
            EzoKind::Ec => SensorId::Ec,
            EzoKind::Rtd => SensorId::WaterTemp,
        }
    }
    pub fn unit(self) -> &'static str {
        match self {
            EzoKind::Ph => "pH",
            EzoKind::Ec => "mS/cm",
            EzoKind::Rtd => "°C",
        }
    }
}

/// Split a raw response into (code, text).
pub fn parse_response(buf: &[u8]) -> Result<String, DeviceError> {
    let Some((&code, rest)) = buf.split_first() else {
        return Err(DeviceError::Bus("empty EZO response".into()));
    };
    match code {
        1 => {
            let end = rest.iter().position(|&b| b == 0).unwrap_or(rest.len());
            Ok(String::from_utf8_lossy(&rest[..end]).into_owned())
        }
        2 => Err(DeviceError::Other("EZO: syntax error".into())),
        254 => Err(DeviceError::Timeout),
        255 => Err(DeviceError::Other("EZO: no data".into())),
        other => Err(DeviceError::Bus(format!("EZO: unknown response code {other}"))),
    }
}

/// Turn the ASCII payload of an `R` into the contract value for this kind.
/// EC may answer `EC,TDS,SAL,SG` depending on output settings; the first
/// field is conductivity in µS/cm, published as mS/cm.
pub fn parse_value(kind: EzoKind, text: &str) -> Result<f64, DeviceError> {
    let first = text.split(',').next().unwrap_or("").trim();
    let v: f64 = first
        .parse()
        .map_err(|_| DeviceError::Other(format!("EZO: unparsable reading {text:?}")))?;
    Ok(match kind {
        EzoKind::Ec => v / 1000.0,
        _ => v,
    })
}

pub struct Ezo<B: I2cBus, D: Delay> {
    bus: B,
    delay: D,
    kind: EzoKind,
    addr: u16,
}

impl<B: I2cBus, D: Delay> Ezo<B, D> {
    pub fn new(bus: B, delay: D, kind: EzoKind, addr: u16) -> Self {
        Self {
            bus,
            delay,
            kind,
            addr,
        }
    }

    pub fn kind(&self) -> EzoKind {
        self.kind
    }

    /// Send a command, wait, and return the text reply.
    pub fn command(&mut self, cmd: &str, wait: Duration) -> Result<String, DeviceError> {
        self.bus.write(self.addr, cmd.as_bytes())?;
        self.delay.sleep(wait);
        let mut buf = [0u8; RESPONSE_LEN];
        self.bus.read(self.addr, &mut buf)?;
        match parse_response(&buf) {
            // Still processing: give it one more wait.
            Err(DeviceError::Timeout) => {
                self.delay.sleep(wait);
                self.bus.read(self.addr, &mut buf)?;
                parse_response(&buf)
            }
            other => other,
        }
    }

    /// `Cal,…` as the datasheet spells it, e.g. `Cal,mid,7.00`, `Cal,dry`,
    /// `Cal,low,12880`, `Cal,clear`. Returns the (usually empty) reply.
    pub fn calibrate(&mut self, args: &str) -> Result<String, DeviceError> {
        let cmd = if args.is_empty() {
            "Cal".to_owned()
        } else {
            format!("Cal,{args}")
        };
        self.command(&cmd, READ_WAIT)
    }

    /// `Cal,?` → number of calibration points stored.
    pub fn calibration_points(&mut self) -> Result<u8, DeviceError> {
        let r = self.command("Cal,?", SHORT_WAIT)?;
        r.rsplit(',')
            .next()
            .and_then(|n| n.trim().parse().ok())
            .ok_or_else(|| DeviceError::Other(format!("EZO: unexpected Cal,? reply {r:?}")))
    }

    /// Temperature compensation (`T,<°C>`) for pH and EC.
    pub fn set_temperature_compensation(&mut self, celsius: f64) -> Result<(), DeviceError> {
        self.command(&format!("T,{celsius:.1}"), SHORT_WAIT).map(|_| ())
    }
}

impl<B: I2cBus, D: Delay> Sensor for Ezo<B, D> {
    fn id(&self) -> SensorId {
        self.kind.sensor_id()
    }
    fn probe(&mut self) -> Result<(), DeviceError> {
        // `i` → "?i,pH,2.12": confirms the circuit type without taking a reading.
        let info = self.command("i", SHORT_WAIT)?;
        let want = match self.kind {
            EzoKind::Ph => "pH",
            EzoKind::Ec => "EC",
            EzoKind::Rtd => "RTD",
        };
        if info
            .split(',')
            .nth(1)
            .is_some_and(|t| t.eq_ignore_ascii_case(want))
        {
            Ok(())
        } else {
            Err(DeviceError::Other(format!(
                "EZO at 0x{:02X} answered {info:?}, expected {want}",
                self.addr
            )))
        }
    }
    fn read(&mut self) -> Result<Reading, DeviceError> {
        let text = self.command("R", READ_WAIT)?;
        Ok(Reading::new(parse_value(self.kind, &text)?, self.kind.unit()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bus::fake::{FakeI2c, NoDelay};

    fn reply(code: u8, text: &str) -> Vec<u8> {
        let mut v = vec![code];
        v.extend_from_slice(text.as_bytes());
        v.resize(RESPONSE_LEN, 0);
        v
    }

    #[test]
    fn response_codes_are_mapped() {
        assert_eq!(parse_response(&reply(1, "6.12")).unwrap(), "6.12");
        assert!(matches!(
            parse_response(&reply(2, "")),
            Err(DeviceError::Other(_))
        ));
        assert!(matches!(
            parse_response(&reply(254, "")),
            Err(DeviceError::Timeout)
        ));
        assert!(matches!(
            parse_response(&reply(255, "")),
            Err(DeviceError::Other(_))
        ));
        assert!(matches!(parse_response(&reply(9, "")), Err(DeviceError::Bus(_))));
        assert!(matches!(parse_response(&[]), Err(DeviceError::Bus(_))));
    }

    #[test]
    fn values_parse_per_kind() {
        assert_eq!(parse_value(EzoKind::Ph, "6.12").unwrap(), 6.12);
        assert_eq!(parse_value(EzoKind::Ec, "1413,706,0.70,1.00").unwrap(), 1.413);
        assert_eq!(parse_value(EzoKind::Rtd, "21.50").unwrap(), 21.5);
        assert!(parse_value(EzoKind::Ph, "").is_err());
        assert_eq!(EzoKind::Ec.default_addr(), 0x64);
        assert_eq!(EzoKind::Rtd.sensor_id(), SensorId::WaterTemp);
        assert_eq!(EzoKind::Ph.unit(), "pH");
    }

    #[test]
    fn read_sends_r_waits_and_parses() {
        let bus = FakeI2c::with_reads(vec![reply(1, "6.12")]);
        let mut s = Ezo::new(bus, NoDelay::default(), EzoKind::Ph, 0x63);
        assert_eq!(s.id(), SensorId::Ph);
        assert_eq!(s.kind(), EzoKind::Ph);
        let r = s.read().unwrap();
        assert_eq!((r.value, r.unit.as_str()), (6.12, "pH"));
        assert_eq!(s.bus.writes, vec![(0x63, b"R".to_vec())]);
        assert_eq!(s.delay.slept, vec![READ_WAIT]);
    }

    #[test]
    fn still_processing_is_retried_once() {
        let bus = FakeI2c::with_reads(vec![reply(254, ""), reply(1, "22.0")]);
        let mut s = Ezo::new(bus, NoDelay::default(), EzoKind::Rtd, 0x66);
        assert_eq!(s.read().unwrap().value, 22.0);
        assert_eq!(s.delay.slept.len(), 2);
        let bus = FakeI2c::with_reads(vec![reply(254, ""), reply(254, "")]);
        let mut s = Ezo::new(bus, NoDelay::default(), EzoKind::Rtd, 0x66);
        assert!(matches!(s.read(), Err(DeviceError::Timeout)));
    }

    #[test]
    fn probe_checks_the_circuit_type() {
        let bus = FakeI2c::with_reads(vec![reply(1, "?i,pH,2.12")]);
        let mut s = Ezo::new(bus, NoDelay::default(), EzoKind::Ph, 0x63);
        assert!(s.probe().is_ok());
        let bus = FakeI2c::with_reads(vec![reply(1, "?i,EC,2.10")]);
        let mut s = Ezo::new(bus, NoDelay::default(), EzoKind::Ph, 0x63);
        assert!(s.probe().is_err());
    }

    #[test]
    fn calibration_helpers_spell_the_commands() {
        let bus = FakeI2c::with_reads(vec![reply(1, ""), reply(1, ""), reply(1, "?Cal,2"), reply(1, "")]);
        let mut s = Ezo::new(bus, NoDelay::default(), EzoKind::Ph, 0x63);
        s.calibrate("mid,7.00").unwrap();
        s.calibrate("").unwrap();
        assert_eq!(s.calibration_points().unwrap(), 2);
        s.set_temperature_compensation(21.26).unwrap();
        let cmds: Vec<String> = s
            .bus
            .writes
            .iter()
            .map(|(_, w)| String::from_utf8(w.clone()).unwrap())
            .collect();
        assert_eq!(cmds, vec!["Cal,mid,7.00", "Cal", "Cal,?", "T,21.3"]);
        let bus = FakeI2c::with_reads(vec![reply(1, "garbage")]);
        let mut s = Ezo::new(bus, NoDelay::default(), EzoKind::Ph, 0x63);
        assert!(s.calibration_points().is_err());
    }
}
