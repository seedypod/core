//! Home Assistant MQTT discovery, published by `hald` itself so HA works
//! with zero core (ADR-0007). Sensors, alerts, the button event and the
//! acknowledge button bind straight to contract topics. The light and the
//! pump need plain-text ON/OFF and number topics that HA's `light` / `fan`
//! platforms can speak, so `hald` mirrors them under `seedypod/<unit>/ha/…`
//! and translates commands back into `ActuatorCommand`s — which then go
//! through the guard like any other command.

use hal_core::topics;
use hal_core::{ActuatorCommand, ActuatorId, ActuatorState, AlertKind, SensorId, SystemInfo};
use serde_json::{json, Value};

use crate::engine::Outbound;

/// `seedypod/<unit>/ha/<rest>`.
pub fn ha_topic(unit: &str, rest: &str) -> String {
    format!("{}/ha/{rest}", topics::prefix(unit))
}

fn id_str<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_value(v)
        .ok()
        .and_then(|j| j.as_str().map(str::to_owned))
        .unwrap_or_default()
}

fn device(system: &SystemInfo) -> Value {
    json!({
        "identifiers": [system.unit_id],
        "name": format!("Gardyn {}", system.unit_id),
        "manufacturer": "seedypod",
        "model": system.model,
        "sw_version": system.hal_version,
    })
}

fn sensor_meta(
    id: SensorId,
) -> (
    &'static str,
    Option<&'static str>,
    Option<&'static str>,
    Option<&'static str>,
) {
    // (name, device_class, unit_of_measurement, icon)
    match id {
        SensorId::AirTemp => ("Air temperature", Some("temperature"), Some("°C"), None),
        SensorId::Humidity => ("Humidity", Some("humidity"), Some("%"), None),
        SensorId::PcbTemp => ("Board temperature", Some("temperature"), Some("°C"), None),
        SensorId::WaterDistance => ("Water distance", Some("distance"), Some("cm"), None),
        SensorId::WaterLevelPct => ("Water level", None, Some("%"), Some("mdi:water-percent")),
        SensorId::PumpV => ("Pump voltage", Some("voltage"), Some("V"), None),
        SensorId::PumpA => ("Pump current", Some("current"), Some("A"), None),
        SensorId::PumpW => ("Pump power", Some("power"), Some("W"), None),
        SensorId::Ph => ("pH", Some("ph"), None, None),
        SensorId::Ec => ("Conductivity", Some("conductivity"), Some("mS/cm"), None),
        SensorId::WaterTemp => ("Water temperature", Some("temperature"), Some("°C"), None),
    }
}

/// One discovery message: (`homeassistant/<component>/<unit>_<object>/config`, payload).
fn entity(prefix: &str, component: &str, system: &SystemInfo, object: &str, mut body: Value) -> Outbound {
    let unit = &system.unit_id;
    let obj = body.as_object_mut().expect("entity body is an object");
    obj.insert("unique_id".into(), json!(format!("{unit}_{object}")));
    obj.insert("availability_topic".into(), json!(topics::availability(unit)));
    obj.insert("device".into(), device(system));
    Outbound {
        topic: format!("{prefix}/{component}/{unit}_{object}/config"),
        payload: body.to_string(),
        retain: true,
    }
}

/// Empty retained config: tells Home Assistant to delete a sensor entity.
pub fn remove_sensor(prefix: &str, unit: &str, id: SensorId) -> Outbound {
    Outbound {
        topic: format!("{prefix}/sensor/{unit}_{}/config", id_str(&id)),
        payload: String::new(),
        retain: true,
    }
}

/// Every discovery message for this unit's capabilities.
pub fn discovery(prefix: &str, system: &SystemInfo) -> Vec<Outbound> {
    let unit = &system.unit_id;
    let mut out = Vec::new();

    for id in &system.caps.sensors {
        let (name, class, unit_m, icon) = sensor_meta(*id);
        let mut body = json!({
            "name": name,
            "state_topic": topics::sensor(unit, *id),
            "value_template": "{{ value_json.value }}",
            "json_attributes_topic": topics::sensor(unit, *id),
            "state_class": "measurement",
        });
        if let Some(c) = class {
            body["device_class"] = json!(c);
        }
        if let Some(u) = unit_m {
            body["unit_of_measurement"] = json!(u);
        }
        if let Some(i) = icon {
            body["icon"] = json!(i);
        }
        out.push(entity(prefix, "sensor", system, &id_str(id), body));
    }

    for a in &system.caps.actuators {
        match a {
            ActuatorId::Light => out.push(entity(
                prefix,
                "light",
                system,
                "light",
                json!({
                    "name": "Grow light",
                    "state_topic": ha_topic(unit, "light/state"),
                    "command_topic": ha_topic(unit, "light/set"),
                    "brightness_state_topic": ha_topic(unit, "light/brightness/state"),
                    "brightness_command_topic": ha_topic(unit, "light/brightness/set"),
                    "brightness_scale": 100,
                    "payload_on": "ON",
                    "payload_off": "OFF",
                    "json_attributes_topic": topics::actuator_state(unit, ActuatorId::Light),
                }),
            )),
            ActuatorId::Pump => out.push(entity(
                prefix,
                "fan",
                system,
                "pump",
                json!({
                    "name": "Pump",
                    "icon": "mdi:water-pump",
                    "state_topic": ha_topic(unit, "pump/state"),
                    "command_topic": ha_topic(unit, "pump/set"),
                    "percentage_state_topic": ha_topic(unit, "pump/percentage/state"),
                    "percentage_command_topic": ha_topic(unit, "pump/percentage/set"),
                    // HA's 100 % is the guard's duty cap, so the slider cannot ask for more.
                    "speed_range_min": 1,
                    "speed_range_max": system.limits.pump_max_duty.round().max(1.0) as u64,
                    "payload_on": "ON",
                    "payload_off": "OFF",
                    "json_attributes_topic": topics::actuator_state(unit, ActuatorId::Pump),
                }),
            )),
            ActuatorId::Dose1 | ActuatorId::Dose2 | ActuatorId::Dose3 => {
                // A dose is a bounded action, not a switch: expose it as a
                // button that fires the default dose; the guard caps it.
                let s = id_str(a);
                out.push(entity(
                    prefix,
                    "button",
                    system,
                    &s,
                    json!({
                        "name": format!("Dose {}", s.trim_start_matches("dose_")),
                        "icon": "mdi:eyedropper",
                        "command_topic": topics::actuator_set(unit, *a),
                        "payload_press": "{\"on\":true}",
                        "json_attributes_topic": topics::actuator_state(unit, *a),
                    }),
                ));
            }
        }
    }

    let dosing = system
        .caps
        .actuators
        .iter()
        .any(|a| matches!(a, ActuatorId::Dose1 | ActuatorId::Dose2 | ActuatorId::Dose3));
    let mut alerts = vec![
        (AlertKind::WaterLow, "Water low", "problem"),
        (AlertKind::PumpFault, "Pump fault", "problem"),
        (AlertKind::OverTemp, "Board over temperature", "heat"),
    ];
    if dosing {
        alerts.push((AlertKind::DoseFault, "Dosing lockout", "problem"));
    }
    for (kind, name, class) in alerts {
        out.push(entity(
            prefix,
            "binary_sensor",
            system,
            &id_str(&kind),
            json!({
                "name": name,
                "device_class": class,
                "state_topic": topics::alert(unit, kind),
                "value_template": "{{ 'ON' if value_json.active else 'OFF' }}",
                "json_attributes_topic": topics::alert(unit, kind),
            }),
        ));
    }

    out.push(entity(
        prefix,
        "button",
        system,
        "ack_pump_fault",
        json!({
            "name": "Acknowledge pump fault",
            "icon": "mdi:restart-alert",
            "command_topic": topics::alert_ack(unit, AlertKind::PumpFault),
            "payload_press": "{}",
        }),
    ));
    if dosing {
        out.push(entity(
            prefix,
            "button",
            system,
            "ack_dose_fault",
            json!({
                "name": "Acknowledge dosing lockout",
                "icon": "mdi:restart-alert",
                "command_topic": topics::alert_ack(unit, AlertKind::DoseFault),
                "payload_press": "{}",
            }),
        ));
    }

    out.push(entity(
        prefix,
        "event",
        system,
        "button",
        json!({
            "name": "Button",
            "device_class": "button",
            "state_topic": topics::button(unit),
            "event_types": ["single", "double", "long"],
            "value_template": "{{ {\"event_type\": value_json.press} | to_json }}",
        }),
    ));

    out
}

/// Mirror an actuator state onto the plain-text topics HA's platforms read.
pub fn state_mirror(unit: &str, id: ActuatorId, st: &ActuatorState) -> Vec<Outbound> {
    let onoff = if st.on { "ON" } else { "OFF" };
    let level = st.level.round() as u64;
    match id {
        ActuatorId::Light => vec![
            Outbound::retained(ha_topic(unit, "light/state"), onoff),
            Outbound::retained(ha_topic(unit, "light/brightness/state"), level.to_string()),
        ],
        ActuatorId::Pump => vec![
            Outbound::retained(ha_topic(unit, "pump/state"), onoff),
            Outbound::retained(ha_topic(unit, "pump/percentage/state"), level.to_string()),
        ],
        _ => Vec::new(),
    }
}

/// Translate a `seedypod/<unit>/ha/...` command into an actuator command.
/// Returns `None` for topics that are not HA commands.
pub fn translate_command(unit: &str, topic: &str, payload: &str) -> Option<(ActuatorId, ActuatorCommand)> {
    let rest = topic.strip_prefix(&ha_topic(unit, ""))?;
    let p = payload.trim();
    let onoff = |s: &str| match s.to_ascii_uppercase().as_str() {
        "ON" => Some(true),
        "OFF" => Some(false),
        _ => None,
    };
    match rest {
        "light/set" => Some((
            ActuatorId::Light,
            ActuatorCommand {
                on: Some(onoff(p)?),
                ..Default::default()
            },
        )),
        "light/brightness/set" => {
            let level: f64 = p.parse().ok()?;
            Some((
                ActuatorId::Light,
                ActuatorCommand {
                    on: Some(level > 0.0),
                    level: Some(level),
                    duration_s: None,
                },
            ))
        }
        "pump/set" => Some((
            ActuatorId::Pump,
            ActuatorCommand {
                on: Some(onoff(p)?),
                ..Default::default()
            },
        )),
        "pump/percentage/set" => {
            let level: f64 = p.parse().ok()?;
            Some((
                ActuatorId::Pump,
                ActuatorCommand {
                    on: Some(level > 0.0),
                    level: Some(level),
                    duration_s: None,
                },
            ))
        }
        _ => None,
    }
}

/// The `ha/…/set` topics to subscribe to.
pub fn command_topics(unit: &str) -> Vec<String> {
    [
        "light/set",
        "light/brightness/set",
        "pump/set",
        "pump/percentage/set",
    ]
    .iter()
    .map(|r| ha_topic(unit, r))
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use hal_core::{Caps, Limits, CONTRACT_VERSION};

    fn system() -> SystemInfo {
        SystemInfo {
            contract: CONTRACT_VERSION,
            unit_id: "u1".into(),
            model: "gardyn 3.0".into(),
            hal_version: "0.1.0".into(),
            caps: Caps {
                sensors: vec![SensorId::AirTemp, SensorId::Ph, SensorId::WaterLevelPct],
                actuators: vec![ActuatorId::Light, ActuatorId::Pump, ActuatorId::Dose1],
                cameras: vec!["upper".into()],
            },
            limits: Limits {
                pump_max_run_s: 900,
                pump_max_duty: 30.0,
                water_low_cm: Some(16.0),
            },
        }
    }

    fn find(out: &[Outbound], topic: &str) -> Value {
        let o = out
            .iter()
            .find(|o| o.topic == topic)
            .unwrap_or_else(|| panic!("no {topic}"));
        assert!(o.retain);
        serde_json::from_str(&o.payload).unwrap()
    }

    #[test]
    fn every_entity_shares_the_device_and_availability() {
        let out = discovery("homeassistant", &system());
        // sensors + actuators + alert binary_sensors (incl. dose_fault) + ack buttons + event
        assert_eq!(out.len(), 3 + 3 + 4 + 2 + 1);
        for o in &out {
            let v: Value = serde_json::from_str(&o.payload).unwrap();
            assert_eq!(v["availability_topic"], "seedypod/u1/availability");
            assert_eq!(v["device"]["identifiers"][0], "u1");
            assert_eq!(v["device"]["name"], "Gardyn u1");
            assert_eq!(v["device"]["manufacturer"], "seedypod");
            assert_eq!(v["device"]["model"], "gardyn 3.0");
            assert_eq!(v["device"]["sw_version"], "0.1.0");
            assert!(v["unique_id"].as_str().unwrap().starts_with("u1_"));
            assert!(o.topic.starts_with("homeassistant/") && o.topic.ends_with("/config"));
        }
    }

    #[test]
    fn sensors_carry_device_class_unit_and_state_class() {
        let out = discovery("homeassistant", &system());
        let t = find(&out, "homeassistant/sensor/u1_air_temp/config");
        assert_eq!(t["device_class"], "temperature");
        assert_eq!(t["unit_of_measurement"], "°C");
        assert_eq!(t["state_class"], "measurement");
        assert_eq!(t["state_topic"], "seedypod/u1/sensor/air_temp");
        let ph = find(&out, "homeassistant/sensor/u1_ph/config");
        assert_eq!(ph["device_class"], "ph");
        assert!(ph.get("unit_of_measurement").is_none());
        let lvl = find(&out, "homeassistant/sensor/u1_water_level_pct/config");
        assert!(lvl.get("device_class").is_none());
        assert_eq!(lvl["icon"], "mdi:water-percent");
        // Every id has metadata.
        for id in [
            SensorId::Humidity,
            SensorId::PcbTemp,
            SensorId::WaterDistance,
            SensorId::PumpV,
            SensorId::PumpA,
            SensorId::PumpW,
            SensorId::Ec,
            SensorId::WaterTemp,
        ] {
            assert!(!sensor_meta(id).0.is_empty());
        }
    }

    #[test]
    fn light_and_pump_use_the_ha_mirror_topics() {
        let out = discovery("homeassistant", &system());
        let l = find(&out, "homeassistant/light/u1_light/config");
        assert_eq!(l["command_topic"], "seedypod/u1/ha/light/set");
        assert_eq!(
            l["brightness_command_topic"],
            "seedypod/u1/ha/light/brightness/set"
        );
        assert_eq!(l["brightness_scale"], 100);
        let f = find(&out, "homeassistant/fan/u1_pump/config");
        assert_eq!(
            f["percentage_command_topic"],
            "seedypod/u1/ha/pump/percentage/set"
        );
        assert_eq!(f["speed_range_max"], 30);
        let d = find(&out, "homeassistant/button/u1_dose_1/config");
        assert_eq!(d["command_topic"], "seedypod/u1/actuator/dose_1/set");
    }

    #[test]
    fn alerts_button_and_event_bind_to_contract_topics() {
        let out = discovery("homeassistant", &system());
        let w = find(&out, "homeassistant/binary_sensor/u1_water_low/config");
        assert_eq!(w["state_topic"], "seedypod/u1/alert/water_low");
        assert_eq!(w["device_class"], "problem");
        let pf = find(&out, "homeassistant/binary_sensor/u1_pump_fault/config");
        assert_eq!(pf["device_class"], "problem");
        let ot = find(&out, "homeassistant/binary_sensor/u1_over_temp/config");
        assert_eq!(ot["device_class"], "heat");
        let ack = find(&out, "homeassistant/button/u1_ack_pump_fault/config");
        assert_eq!(ack["command_topic"], "seedypod/u1/alert/pump_fault/ack");
        assert_eq!(ack["payload_press"], "{}");
        let df = find(&out, "homeassistant/binary_sensor/u1_dose_fault/config");
        assert_eq!(df["state_topic"], "seedypod/u1/alert/dose_fault");
        let dack = find(&out, "homeassistant/button/u1_ack_dose_fault/config");
        assert_eq!(dack["command_topic"], "seedypod/u1/alert/dose_fault/ack");
        let ev = find(&out, "homeassistant/event/u1_button/config");
        assert_eq!(ev["state_topic"], "seedypod/u1/event/button");
        assert_eq!(ev["event_types"], json!(["single", "double", "long"]));
    }

    #[test]
    fn dose_fault_entities_only_exist_with_dosers() {
        let mut sys = system();
        sys.caps.actuators.retain(|a| !matches!(a, ActuatorId::Dose1));
        let out = discovery("homeassistant", &sys);
        assert!(!out.iter().any(|o| o.topic.contains("dose_fault")));
    }

    #[test]
    fn custom_prefix_is_honoured() {
        let out = discovery("ha-test", &system());
        assert!(out.iter().all(|o| o.topic.starts_with("ha-test/")));
    }

    #[test]
    fn state_mirror_emits_onoff_and_level() {
        let st = ActuatorState {
            on: true,
            level: 72.6,
            since: "t".into(),
            fault: None,
            remaining_s: None,
        };
        let m = state_mirror("u1", ActuatorId::Light, &st);
        assert_eq!(
            m.iter()
                .map(|o| (o.topic.as_str(), o.payload.as_str(), o.retain))
                .collect::<Vec<_>>(),
            vec![
                ("seedypod/u1/ha/light/state", "ON", true),
                ("seedypod/u1/ha/light/brightness/state", "73", true)
            ]
        );
        let off = ActuatorState {
            on: false,
            level: 0.0,
            ..st
        };
        let m = state_mirror("u1", ActuatorId::Pump, &off);
        assert_eq!(m[0].payload, "OFF");
        assert_eq!(m[1].topic, "seedypod/u1/ha/pump/percentage/state");
        assert!(state_mirror("u1", ActuatorId::Dose1, &off).is_empty());
    }

    #[test]
    fn commands_translate_to_actuator_commands() {
        let (id, c) = translate_command("u1", "seedypod/u1/ha/light/set", "ON").unwrap();
        assert_eq!((id, c.on), (ActuatorId::Light, Some(true)));
        let (_, c) = translate_command("u1", "seedypod/u1/ha/light/set", "off").unwrap();
        assert_eq!(c.on, Some(false));
        let (_, c) = translate_command("u1", "seedypod/u1/ha/light/brightness/set", "40").unwrap();
        assert_eq!((c.on, c.level), (Some(true), Some(40.0)));
        let (_, c) = translate_command("u1", "seedypod/u1/ha/light/brightness/set", "0").unwrap();
        assert_eq!(c.on, Some(false));
        let (id, c) = translate_command("u1", "seedypod/u1/ha/pump/set", "ON").unwrap();
        assert_eq!((id, c.on, c.duration_s), (ActuatorId::Pump, Some(true), None));
        let (_, c) = translate_command("u1", "seedypod/u1/ha/pump/percentage/set", "20").unwrap();
        assert_eq!(c.level, Some(20.0));
        assert!(translate_command("u1", "seedypod/u1/ha/light/set", "maybe").is_none());
        assert!(translate_command("u1", "seedypod/u1/ha/light/brightness/set", "bright").is_none());
        assert!(translate_command("u1", "seedypod/u1/ha/nothing", "ON").is_none());
        assert!(translate_command("u1", "seedypod/u2/ha/light/set", "ON").is_none());
        assert_eq!(command_topics("u1").len(), 4);
    }
}
