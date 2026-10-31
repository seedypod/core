//! Fake drivers sharing one `SimWorld` so the tank drains while the pump runs
//! and the board warms with the light — the same model as `src/hardware/sim.ts`.

use std::sync::{Arc, Mutex};

use hal_core::device::now_rfc3339;
use hal_core::{Actuator, ActuatorId, DeviceError, Reading, Sensor, SensorId};

#[derive(Debug)]
pub struct SimWorld {
    pub water_distance_cm: f64,
    pub air_temp_c: f64,
    pub humidity_pct: f64,
    pub pcb_temp_c: f64,
    pub light_level: f64,
    pub pump_level: f64,
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
            _ => {}
        }
        Ok(())
    }
    fn level(&self) -> f64 {
        let w = self.world.lock().unwrap();
        match self.id {
            ActuatorId::Light => w.light_level,
            ActuatorId::Pump => w.pump_level,
            _ => 0.0,
        }
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
    fn sensors_report_units() {
        let w = world();
        let mut s = SimSensor::new(SensorId::WaterLevelPct, w);
        let r = s.read().unwrap();
        assert_eq!(r.unit, "%");
        assert!((0.0..=100.0).contains(&r.value));
    }
}
