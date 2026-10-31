//! Fake drivers sharing one `SimWorld` so the tank drains while the pump runs
//! and the board warms with the light — the same model as `src/hardware/sim.ts`.

use std::sync::{Arc, Mutex};

use hal_core::device::now_rfc3339;
use hal_core::{
    Actuator, ActuatorId, CalibrationCommand, CalibrationPoint, Camera, DeviceError, Reading, Sensor,
    SensorId,
};

#[derive(Debug)]
pub struct SimWorld {
    pub water_distance_cm: f64,
    pub air_temp_c: f64,
    pub humidity_pct: f64,
    pub pcb_temp_c: f64,
    pub light_level: f64,
    pub pump_level: f64,
    /// Dosing pumps 1–3 (on/off).
    pub dose_level: [f64; 3],
    /// Stored calibration points for the simulated pH, EC and RTD probes.
    pub cal_points: [u8; 3],
}

impl Default for SimWorld {
    fn default() -> Self {
        Self {
            water_distance_cm: 7.0,
            air_temp_c: 22.5,
            humidity_pct: 48.0,
            pcb_temp_c: 31.0,
            light_level: 0.0,
            pump_level: 0.0,
            dose_level: [0.0; 3],
            cal_points: [0; 3],
        }
    }
}

impl SimWorld {
    /// Advance physics by `dt` simulated seconds.
    pub fn step(&mut self, dt: f64) {
        if self.pump_level > 0.0 {
            self.water_distance_cm =
                (self.water_distance_cm + (self.pump_level / 100.0) * 0.0053 * dt).min(20.0);
        }
        let target = if self.light_level > 0.0 {
            24.5 + self.light_level * 0.02
        } else {
            21.5
        };
        self.air_temp_c += (target - self.air_temp_c) * (dt / 1800.0).min(1.0);
        let h = if self.light_level > 0.0 { 55.0 } else { 46.0 };
        self.humidity_pct += (h - self.humidity_pct) * (dt / 2400.0).min(1.0);
        let pt = if self.light_level > 0.0 {
            33.0 + self.light_level * 0.03
        } else {
            29.0
        };
        self.pcb_temp_c += (pt - self.pcb_temp_c) * (dt / 900.0).min(1.0);
    }
}

pub type Shared = Arc<Mutex<SimWorld>>;

pub fn world() -> Shared {
    Arc::new(Mutex::new(SimWorld::default()))
}

pub struct SimSensor {
    id: SensorId,
    world: Shared,
}

impl SimSensor {
    pub fn new(id: SensorId, world: Shared) -> Self {
        Self { id, world }
    }
}

impl Sensor for SimSensor {
    fn id(&self) -> SensorId {
        self.id
    }
    fn probe(&mut self) -> Result<(), DeviceError> {
        Ok(())
    }
    fn read(&mut self) -> Result<Reading, DeviceError> {
        let w = self.world.lock().map_err(|e| DeviceError::Other(e.to_string()))?;
        let pump_w = if w.pump_level > 0.0 {
            1.2 + (w.pump_level / 100.0) * 4.8
        } else {
            0.0
        };
        let (value, unit) = match self.id {
            SensorId::AirTemp => (w.air_temp_c, "°C"),
            SensorId::Humidity => (w.humidity_pct, "%"),
            SensorId::PcbTemp => (w.pcb_temp_c, "°C"),
            SensorId::WaterDistance => (w.water_distance_cm, "cm"),
            SensorId::WaterLevelPct => (
                ((20.0 - w.water_distance_cm) / 15.0 * 100.0).clamp(0.0, 100.0),
                "%",
            ),
            SensorId::PumpV => (if w.pump_level > 0.0 { 12.1 } else { 12.3 }, "V"),
            SensorId::PumpA => (pump_w / 12.1, "A"),
            SensorId::PumpW => (pump_w, "W"),
            SensorId::Ph => (6.1, "pH"),
            SensorId::Ec => (1.4, "mS/cm"),
            SensorId::WaterTemp => (w.air_temp_c - 1.0, "°C"),
        };
        Ok(Reading {
            ts: now_rfc3339(),
            value: (value * 100.0).round() / 100.0,
            unit: unit.into(),
            quality: Default::default(),
        })
    }
    /// Accepts any point with a finite value (or none for `dry`/`clear`) on the
    /// probes an EZO would back; the real range checks live in the driver.
    fn calibrate(&mut self, cmd: &CalibrationCommand) -> Result<Option<u8>, DeviceError> {
        let slot = match self.id {
            SensorId::Ph => 0,
            SensorId::Ec => 1,
            SensorId::WaterTemp => 2,
            _ => return Err(DeviceError::Other("sensor does not support calibration".into())),
        };
        let needs_value = !matches!(cmd.point, CalibrationPoint::Dry | CalibrationPoint::Clear);
        if needs_value && !cmd.value.is_some_and(f64::is_finite) {
            return Err(DeviceError::Other(format!(
                "{:?} calibration needs a reference value",
                cmd.point
            )));
        }
        let mut w = self.world.lock().map_err(|e| DeviceError::Other(e.to_string()))?;
        w.cal_points[slot] = if cmd.point == CalibrationPoint::Clear {
            0
        } else {
            (w.cal_points[slot] + 1).min(3)
        };
        Ok(Some(w.cal_points[slot]))
    }
}

pub struct SimActuator {
    id: ActuatorId,
    world: Shared,
}

impl SimActuator {
    pub fn new(id: ActuatorId, world: Shared) -> Self {
        Self { id, world }
    }
}

impl Actuator for SimActuator {
    fn id(&self) -> ActuatorId {
        self.id
    }
    fn probe(&mut self) -> Result<(), DeviceError> {
        Ok(())
    }
    fn set_level(&mut self, level: f64) -> Result<(), DeviceError> {
        let mut w = self.world.lock().map_err(|e| DeviceError::Other(e.to_string()))?;
        match self.id {
            ActuatorId::Light => w.light_level = level,
            ActuatorId::Pump => w.pump_level = level,
            ActuatorId::Dose1 => w.dose_level[0] = level,
            ActuatorId::Dose2 => w.dose_level[1] = level,
            ActuatorId::Dose3 => w.dose_level[2] = level,
        }
        Ok(())
    }
    fn level(&self) -> f64 {
        let w = self.world.lock().unwrap_or_else(|e| e.into_inner());
        match self.id {
            ActuatorId::Light => w.light_level,
            ActuatorId::Pump => w.pump_level,
            ActuatorId::Dose1 => w.dose_level[0],
            ActuatorId::Dose2 => w.dose_level[1],
            ActuatorId::Dose3 => w.dose_level[2],
        }
    }
}

/// Serves a fixture JPEG so `/camera/<name>.jpg` works without a USB camera.
pub struct SimCamera {
    name: String,
}

impl SimCamera {
    pub fn new(name: &str) -> Self {
        Self {
            name: name.to_owned(),
        }
    }
}

impl Camera for SimCamera {
    fn name(&self) -> &str {
        &self.name
    }
    fn capture(&mut self) -> Result<Vec<u8>, DeviceError> {
        let bytes: &[u8] = if self.name == "lower" {
            include_bytes!("../fixtures/lower.jpg")
        } else {
            include_bytes!("../fixtures/upper.jpg")
        };
        Ok(bytes.to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tank_drains_only_while_pump_runs() {
        let w = world();
        let mut pump = SimActuator::new(ActuatorId::Pump, w.clone());
        let before = w.lock().unwrap().water_distance_cm;
        w.lock().unwrap().step(600.0);
        assert_eq!(w.lock().unwrap().water_distance_cm, before);
        pump.set_level(30.0).unwrap();
        w.lock().unwrap().step(600.0);
        assert!(w.lock().unwrap().water_distance_cm > before);
    }

    #[test]
    fn dosing_actuators_have_their_own_levels() {
        let w = world();
        let mut d2 = SimActuator::new(ActuatorId::Dose2, w.clone());
        d2.set_level(100.0).unwrap();
        assert_eq!(d2.level(), 100.0);
        assert_eq!(SimActuator::new(ActuatorId::Dose1, w.clone()).level(), 0.0);
        assert_eq!(d2.id(), ActuatorId::Dose2);
        assert!(d2.probe().is_ok());
    }

    #[test]
    fn sim_cameras_serve_distinct_jpegs() {
        let mut up = SimCamera::new("upper");
        let mut lo = SimCamera::new("lower");
        let a = up.capture().unwrap();
        let b = lo.capture().unwrap();
        assert_eq!(&a[..2], &[0xFF, 0xD8]);
        assert_eq!(&b[..2], &[0xFF, 0xD8]);
        assert_ne!(a, b);
        assert_eq!(up.name(), "upper");
    }

    #[test]
    fn sensors_report_units() {
        let w = world();
        let mut s = SimSensor::new(SensorId::WaterLevelPct, w);
        let r = s.read().unwrap();
        assert_eq!(r.unit, "%");
        assert!((0.0..=100.0).contains(&r.value));
    }
}
