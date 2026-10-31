//! Sensor kinds the app can add at runtime. Each kind is one `SensorKind`
//! implementation: its descriptor (label, quantities, bus, calibration steps)
//! is published in the `devices` inventory, so the UI and MCP render any kind
//! without per-kind code, and its builders make the simulated or real driver.
//! Supporting a new probe is a new impl here (plus a `SensorId` if it measures
//! a new quantity).

use hal_core::{CalibrationPoint, CalibrationStep, DeviceKindInfo, Sensor, SensorId};
use hal_drivers::ezo::EzoKind;

pub trait SensorKind: Send + Sync {
    fn info(&self) -> DeviceKindInfo;
    /// Simulated drivers, one per reported quantity.
    fn build_sim(&self, world: &hal_sim::Shared) -> Vec<Box<dyn Sensor>> {
        self.info()
            .ids
            .into_iter()
            .map(|id| Box::new(hal_sim::SimSensor::new(id, world.clone())) as Box<dyn Sensor>)
            .collect()
    }
    /// Real, already-probed drivers on the I²C bus at `addr`.
    #[cfg(feature = "hardware")]
    fn build_hw(&self, i2c: hal_drivers::hw::RppalI2c, addr: u16) -> anyhow::Result<Vec<Box<dyn Sensor>>>;
}

/// Every kind addable from the app, in display order.
pub fn addable() -> Vec<Box<dyn SensorKind>> {
    vec![
        Box::new(Ezo(EzoKind::Ph)),
        Box::new(Ezo(EzoKind::Ec)),
        Box::new(Ezo(EzoKind::Rtd)),
    ]
}

pub fn find(kind: &str) -> Option<Box<dyn SensorKind>> {
    addable().into_iter().find(|k| k.info().kind == kind)
}

/// Display name for any configured kind, addable or stock.
pub fn label(kind: &str) -> String {
    if let Some(k) = find(kind) {
        return k.info().label;
    }
    match kind {
        "pct2075" => "Board temperature (PCT2075)",
        "ina219" => "Pump power monitor (INA219)",
        "dht20" => "Air temperature & humidity (DHT20)",
        "am2320" => "Air temperature & humidity (AM2320)",
        "dyp_a01" => "Water level (ultrasonic)",
        "over_temp_alert" => "Board over-temperature line",
        other => other,
    }
    .to_owned()
}

/// Atlas Scientific EZO circuits (pH, EC, RTD).
pub struct Ezo(pub EzoKind);

fn step(
    point: CalibrationPoint,
    label: &str,
    instruction: &str,
    value: Option<f64>,
    optional: bool,
) -> CalibrationStep {
    CalibrationStep {
        point,
        label: label.into(),
        instruction: instruction.into(),
        default_value: value,
        optional,
    }
}

impl SensorKind for Ezo {
    fn info(&self) -> DeviceKindInfo {
        use CalibrationPoint::*;
        let (kind, label, description, calibration) = match self.0 {
            EzoKind::Ph => (
                "ezo_ph",
                "pH probe",
                "Atlas Scientific EZO-pH circuit with a pH probe, on the I²C bus.",
                vec![
                    step(Mid, "Midpoint (pH 7)", "Rinse the probe in distilled water, put it in pH 7.00 buffer and wait until the reading stops drifting (1–2 minutes). The midpoint clears any earlier calibration.", Some(7.0), false),
                    step(Low, "Low point (pH 4)", "Rinse, put the probe in pH 4.00 buffer and wait for the reading to settle.", Some(4.0), true),
                    step(High, "High point (pH 10)", "Rinse, put the probe in pH 10.00 buffer and wait for the reading to settle.", Some(10.0), true),
                ],
            ),
            EzoKind::Ec => (
                "ezo_ec",
                "Conductivity (EC) probe",
                "Atlas Scientific EZO-EC circuit with a conductivity probe, on the I²C bus.",
                vec![
                    step(Dry, "Dry", "Dry the probe completely and hold it in air.", None, false),
                    step(Single, "Reference solution", "Put the probe in the reference solution (1.413 mS/cm = 1413 µS/cm unless yours says otherwise), tap out bubbles and wait for the reading to settle.", Some(1.413), false),
                ],
            ),
            EzoKind::Rtd => (
                "ezo_rtd",
                "Water temperature probe",
                "Atlas Scientific EZO-RTD circuit with a PT-1000 probe, on the I²C bus.",
                vec![step(Single, "Reference temperature", "Put the probe in water of a known temperature (an ice-water bath is 0 °C) and wait for the reading to settle.", Some(0.0), false)],
            ),
        };
        DeviceKindInfo {
            kind: kind.into(),
            label: label.into(),
            description: description.into(),
            ids: vec![self.0.sensor_id()],
            bus: "i2c".into(),
            default_addr: Some(self.0.default_addr()),
            calibration,
        }
    }

    #[cfg(feature = "hardware")]
    fn build_hw(&self, i2c: hal_drivers::hw::RppalI2c, addr: u16) -> anyhow::Result<Vec<Box<dyn Sensor>>> {
        let mut d = hal_drivers::ezo::Ezo::new(i2c, hal_drivers::bus::StdDelay, self.0, addr);
        d.probe()
            .map_err(|e| anyhow::anyhow!("probe {} at 0x{addr:02X}: {e}", self.info().kind))?;
        Ok(vec![Box::new(d)])
    }
}

/// Builds drivers for kinds added at runtime.
pub trait SensorFactory: Send {
    fn build(&mut self, kind: &dyn SensorKind, addr: u16) -> anyhow::Result<Vec<Box<dyn Sensor>>>;
}

pub struct SimFactory(pub hal_sim::Shared);

impl SensorFactory for SimFactory {
    fn build(&mut self, kind: &dyn SensorKind, _addr: u16) -> anyhow::Result<Vec<Box<dyn Sensor>>> {
        Ok(kind.build_sim(&self.0))
    }
}

/// Opens the I²C bus on first use and shares it with every driver it builds.
#[cfg(feature = "hardware")]
pub struct HwFactory {
    pub bus: u8,
    pub i2c: Option<hal_drivers::hw::RppalI2c>,
}

#[cfg(feature = "hardware")]
impl SensorFactory for HwFactory {
    fn build(&mut self, kind: &dyn SensorKind, addr: u16) -> anyhow::Result<Vec<Box<dyn Sensor>>> {
        if self.i2c.is_none() {
            self.i2c = Some(
                hal_drivers::hw::RppalI2c::open(self.bus)
                    .map_err(|e| anyhow::anyhow!("open i2c-{}: {e}", self.bus))?,
            );
        }
        kind.build_hw(self.i2c.clone().expect("just opened"), addr)
    }
}

/// Quantities a configured kind reports (stock kinds included).
pub fn ids_for(kind: &str) -> Vec<SensorId> {
    find(kind)
        .map(|k| k.info().ids)
        .unwrap_or_else(|| crate::devices::sensor_ids_for(kind))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_addable_kind_describes_itself_completely() {
        for k in addable() {
            let i = k.info();
            assert!(i.kind.starts_with("ezo_") && !i.label.is_empty() && !i.description.is_empty());
            assert_eq!(i.ids.len(), 1);
            assert!(i.default_addr.is_some_and(|a| (0x08..=0x77).contains(&a)));
            assert!(!i.calibration.is_empty() && !i.calibration[0].optional);
            assert_eq!(crate::devices::sensor_ids_for(&i.kind), i.ids, "{}", i.kind);
        }
        assert!(find("ezo_ph").is_some() && find("pct2075").is_none());
        assert_eq!(label("dyp_a01"), "Water level (ultrasonic)");
        assert_eq!(label("ezo_ec"), "Conductivity (EC) probe");
    }

    /// `hal/contract/fixtures/device_kinds.json` is what core's simulator offers
    /// (it imports the fixture), so it must equal these descriptors.
    /// `SEEDYPOD_WRITE_FIXTURES=1 cargo test` regenerates it.
    #[test]
    fn addable_kinds_match_the_contract_fixture() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../contract/fixtures/device_kinds.json"
        );
        let ours: Vec<DeviceKindInfo> = addable().iter().map(|k| k.info()).collect();
        if std::env::var_os("SEEDYPOD_WRITE_FIXTURES").is_some() {
            std::fs::write(path, serde_json::to_string_pretty(&ours).unwrap() + "\n").unwrap();
        }
        let fixture: Vec<DeviceKindInfo> =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(
            fixture, ours,
            "run SEEDYPOD_WRITE_FIXTURES=1 cargo test to update the fixture"
        );
    }

    #[test]
    fn sim_factory_builds_one_driver_per_quantity() {
        let mut f = SimFactory(hal_sim::world());
        let s = f.build(find("ezo_ph").unwrap().as_ref(), 0x63).unwrap();
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].id(), SensorId::Ph);
    }
}
