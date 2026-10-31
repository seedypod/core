//! Config-driven device registry. `hal.toml` lists which drivers exist and at
//! what address/pin; `hald` builds the registry from it so adding a pH probe
//! is a config line plus a driver crate, not a code path through the daemon.

use std::collections::BTreeMap;

use crate::contract::{ActuatorId, SensorId};
use crate::device::{Actuator, Sensor};

#[derive(Default)]
pub struct Registry {
    sensors: BTreeMap<String, Box<dyn Sensor>>,
    actuators: BTreeMap<String, Box<dyn Actuator>>,
}

fn key<T: serde::Serialize>(id: &T) -> String {
    serde_json::to_value(id)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

impl Registry {
    pub fn add_sensor(&mut self, s: Box<dyn Sensor>) {
        self.sensors.insert(key(&s.id()), s);
    }
    pub fn add_actuator(&mut self, a: Box<dyn Actuator>) {
        self.actuators.insert(key(&a.id()), a);
    }
    pub fn sensor_ids(&self) -> Vec<SensorId> {
        self.sensors.values().map(|s| s.id()).collect()
    }
    pub fn actuator_ids(&self) -> Vec<ActuatorId> {
        self.actuators.values().map(|a| a.id()).collect()
    }
    pub fn sensor_mut(&mut self, id: SensorId) -> Option<&mut Box<dyn Sensor>> {
        self.sensors.get_mut(&key(&id))
    }
    pub fn actuator_mut(&mut self, id: ActuatorId) -> Option<&mut Box<dyn Actuator>> {
        self.actuators.get_mut(&key(&id))
    }
    pub fn remove_sensor(&mut self, id: SensorId) -> Option<Box<dyn Sensor>> {
        self.sensors.remove(&key(&id))
    }
    pub fn sensors_mut(&mut self) -> impl Iterator<Item = &mut Box<dyn Sensor>> {
        self.sensors.values_mut()
    }
}
