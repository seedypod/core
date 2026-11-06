//! The engine: one synchronous owner of the registry and the guards. Every
//! input — MQTT command, HA mirror topic, button, HTTP camera result — is an
//! [`Inbound`]; every effect on the outside world is an [`Outbound`] publish.
//! The engine is clock-injected ([`Now`]) so the whole daemon behaviour is
//! unit-tested against `hal-sim` with virtual time.
//!
//! Invariant (AGENTS.md, ADR-0009): the pump driver's `set_level` is called
//! only from [`Engine::apply_pump`], which only acts on a `PumpGuard`
//! decision. Dosing pumps likewise only through their `DoseGuard`.

use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use hal_core::device::{now_epoch_s, rfc3339_from_epoch};
use hal_core::registry::Registry;
use hal_core::safety::{Decision, DoseGuard, DoseLimits, Env, PumpGuard, PumpLimits};
use hal_core::{
    topics, ActuatorCommand, ActuatorId, ActuatorState, Alert, AlertKind, BinarySensor, ButtonEvent,
    ButtonPress, CalibrationCommand, CalibrationResult, DeviceCommand, DeviceEntry, DeviceInventory,
    DeviceOp, DeviceResult, DeviceSource, DeviceStatus, Quality, Reading, SensorId, SystemInfo,
};
use serde::Serialize;
use tracing::{error, info, warn};

use crate::config::{SensorEntry, I2C_ADDR_RANGE};
use crate::fade::LightFader;
use crate::kinds::SensorFactory;
use crate::overlay::Overlay;
use crate::state::{Persisted, StateFile};

/// One MQTT publish (or one JSON line in `--stdout` mode).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outbound {
    pub topic: String,
    pub payload: String,
    pub retain: bool,
}

impl Outbound {
    pub fn retained(topic: impl Into<String>, payload: impl Into<String>) -> Self {
        Self {
            topic: topic.into(),
            payload: payload.into(),
            retain: true,
        }
    }
    pub fn json<T: Serialize>(topic: impl Into<String>, v: &T, retain: bool) -> Self {
        Self {
            topic: topic.into(),
            payload: serde_json::to_string(v).unwrap_or_else(|_| "null".into()),
            retain,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Inbound {
    ActuatorSet(ActuatorId, ActuatorCommand),
    AlertAck(AlertKind),
    /// Store a calibration point on a probe (EZO); the result is published retained.
    Calibrate(SensorId, CalibrationCommand),
    /// Add or remove a sensor at runtime (`devices/set`).
    Devices(DeviceCommand),
    Button(ButtonPress),
    /// Outcome of a camera capture (from the HTTP server) → `camera_missing`.
    CameraResult {
        name: String,
        ok: bool,
        detail: String,
    },
    /// The broker (re)connected: republish every retained topic.
    Resync,
    Shutdown,
}

/// Injected clock: monotonic for deadlines, wall for timestamps and ledgers.
#[derive(Debug, Clone, Copy)]
pub struct Now {
    pub instant: Instant,
    pub epoch_s: u64,
}

impl Now {
    pub fn real() -> Self {
        Self {
            instant: Instant::now(),
            epoch_s: now_epoch_s(),
        }
    }
    pub fn advance(&mut self, d: Duration) {
        self.instant += d;
        self.epoch_s += d.as_secs();
    }
    pub fn ts(&self) -> String {
        rfc3339_from_epoch(self.epoch_s)
    }
}

/// What `GET /state` returns.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub unit_id: String,
    pub ts: String,
    pub sensors: BTreeMap<String, Reading>,
    pub actuators: BTreeMap<String, ActuatorState>,
    pub alerts: BTreeMap<String, Alert>,
    pub light_hours_total: f64,
    /// Current capabilities, for HTTP `/system` (they change when sensors are added).
    #[serde(skip)]
    pub system: Option<SystemInfo>,
}

pub type SharedSnapshot = Arc<RwLock<Snapshot>>;

#[derive(Debug, Clone)]
pub struct EngineConfig {
    pub telemetry_interval: Duration,
    /// How long a full swing of the light takes; zero for no fade.
    pub light_fade: Duration,
    pub pump: PumpLimits,
    pub dosing: DoseLimits,
    /// Bounded run requested by a double press.
    pub button_pump_run_s: u64,
    /// `Some(prefix)` publishes HA discovery.
    pub ha_prefix: Option<String>,
}

const HOURS_PERSIST_EVERY: Duration = Duration::from_secs(900);

fn key<T: Serialize>(v: &T) -> String {
    serde_json::to_value(v)
        .ok()
        .and_then(|j| j.as_str().map(str::to_owned))
        .unwrap_or_default()
}

pub struct Engine {
    unit: String,
    system: SystemInfo,
    cfg: EngineConfig,
    registry: Registry,
    over_temp_input: Option<Box<dyn BinarySensor>>,
    pump: PumpGuard,
    pump_since: String,
    pump_was_on: bool,
    doses: BTreeMap<ActuatorId, DoseGuard>,
    dose_since: BTreeMap<ActuatorId, String>,
    /// Where the light is going; a fade may still be on its way there.
    light_level: f64,
    light_since: String,
    /// Owns the light's driver, taken out of the registry.
    light: Option<LightFader>,
    persisted: Persisted,
    state_file: Option<StateFile>,
    env: Env,
    last_published: BTreeMap<SensorId, (f64, Instant)>,
    last_telemetry: Option<Instant>,
    last_tick: Option<Instant>,
    last_hours_persist: Option<Instant>,
    alerts: BTreeMap<AlertKind, Alert>,
    water: WaterAlert,
    snapshot: SharedSnapshot,
    devices: Devices,
}

/// Telemetry rounds the water alert looks back over: a minute at the default 10 s.
const WATER_WINDOW: usize = 6;
/// Rounds without a good reading in that window that raise it.
const WATER_RAISE_AT: usize = 3;

/// The `water_low` alert, debounced. A tank lifted out leaves the ranger on stray
/// echoes that alternate with no reading at all, and each raise is an alert row
/// in core. So a reading at the limit raises at once, a lost reading only when
/// lost ones pile up, and it clears after a whole window of good readings.
#[derive(Debug, Default)]
struct WaterAlert {
    /// Newest last; `true` for a round that read low or read nothing.
    rounds: VecDeque<bool>,
    active: bool,
    detail: String,
}

impl WaterAlert {
    fn observe(&mut self, distance: Option<f64>, low: f64) {
        let is_low = distance.is_some_and(|d| d >= low);
        let bad = is_low || distance.is_none();
        // With no history the first round decides: nothing says a silent ranger is a blip.
        if self.rounds.is_empty() {
            self.rounds.extend([bad; WATER_RAISE_AT]);
        }
        if self.rounds.len() == WATER_WINDOW {
            self.rounds.pop_front();
        }
        self.rounds.push_back(bad);
        let bad_rounds = self.rounds.iter().filter(|b| **b).count();
        if is_low || bad_rounds >= WATER_RAISE_AT {
            self.active = true;
        } else if bad_rounds == 0 {
            self.active = false;
            self.detail.clear();
        }
        if self.active && bad {
            self.detail = match distance {
                Some(d) => format!("water distance {d:.1} cm ≥ {low:.1} cm"),
                None => "water level sensor unavailable".to_owned(),
            };
        }
    }
}

/// Runtime sensor inventory: what is configured, what was added from the app,
/// and how to build more. Without a factory, `devices/set` is refused.
#[derive(Default)]
pub struct Devices {
    pub entries: Vec<DeviceEntry>,
    /// The app-added entries, as persisted in the overlay.
    pub user: Vec<SensorEntry>,
    pub factory: Option<Box<dyn SensorFactory>>,
    pub overlay: Option<Overlay>,
}

impl Devices {
    /// Inventory entries for every configured sensor, from the boot outcome.
    pub fn from_boot(status: &[(SensorEntry, Option<String>)], user: &[SensorEntry]) -> Vec<DeviceEntry> {
        status
            .iter()
            .map(|(s, err)| DeviceEntry {
                kind: s.kind.clone(),
                label: crate::kinds::label(&s.kind),
                addr: s.addr,
                ids: crate::kinds::ids_for(&s.kind),
                source: if user.contains(s) {
                    DeviceSource::User
                } else {
                    DeviceSource::Config
                },
                status: if err.is_some() {
                    DeviceStatus::Absent
                } else {
                    DeviceStatus::Ready
                },
                detail: err.clone().unwrap_or_default(),
            })
            .collect()
    }
}

impl Engine {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        system: SystemInfo,
        cfg: EngineConfig,
        registry: Registry,
        over_temp_input: Option<Box<dyn BinarySensor>>,
        state_file: Option<StateFile>,
        snapshot: SharedSnapshot,
    ) -> Self {
        let mut registry = registry;
        let light = registry
            .remove_actuator(ActuatorId::Light)
            .map(|driver| LightFader::new(driver, cfg.light_fade));
        let persisted = state_file.as_ref().map(StateFile::load).unwrap_or_default();
        let mut doses = BTreeMap::new();
        for id in &system.caps.actuators {
            if matches!(id, ActuatorId::Dose1 | ActuatorId::Dose2 | ActuatorId::Dose3) {
                let mut g = DoseGuard::new(cfg.dosing.clone());
                if let Some(l) = persisted.doses.get(&key(id)) {
                    g.restore(l.clone());
                }
                doses.insert(*id, g);
            }
        }
        Self {
            unit: system.unit_id.clone(),
            pump: PumpGuard::new(cfg.pump.clone()),
            pump_since: String::new(),
            pump_was_on: false,
            doses,
            dose_since: BTreeMap::new(),
            light_level: 0.0,
            light_since: persisted.light_since.clone().unwrap_or_default(),
            light,
            persisted,
            system,
            cfg,
            registry,
            over_temp_input,
            state_file,
            env: Env::default(),
            last_published: BTreeMap::new(),
            last_telemetry: None,
            last_tick: None,
            last_hours_persist: None,
            alerts: BTreeMap::new(),
            water: WaterAlert::default(),
            snapshot,
            devices: Devices::default(),
        }
    }

    /// Starts the thread that steps light fades. Without it, light changes are instant.
    pub fn start_light_fades(&self) {
        if let Some(Err(e)) = self.light.as_ref().map(LightFader::spawn) {
            warn!(%e, "light changes won't fade");
        }
    }

    pub fn with_devices(mut self, devices: Devices) -> Self {
        self.devices = devices;
        self
    }

    fn inventory(&self) -> DeviceInventory {
        DeviceInventory {
            sensors: self.devices.entries.clone(),
            addable: if self.devices.factory.is_some() {
                crate::kinds::addable().iter().map(|k| k.info()).collect()
            } else {
                Vec::new()
            },
        }
    }

    // ---- boot / resync -----------------------------------------------------

    /// Probe everything, restore the light, publish the retained picture.
    pub fn boot(&mut self, now: Now) -> Vec<Outbound> {
        for s in self.registry.sensors_mut() {
            if let Err(e) = s.probe() {
                warn!(sensor = ?s.id(), %e, "probe failed at boot; will retry on read");
            }
        }
        for id in self.system.caps.actuators.clone() {
            if let Some(a) = self.registry.actuator_mut(id) {
                if let Err(e) = a.probe() {
                    warn!(actuator = ?id, %e, "probe failed at boot");
                }
            }
        }
        if let Some(Err(e)) = self.light.as_ref().map(LightFader::probe) {
            warn!(actuator = ?ActuatorId::Light, %e, "probe failed at boot");
        }
        if let Some(b) = &mut self.over_temp_input {
            if let Err(e) = b.probe() {
                warn!(%e, "over-temperature input probe failed");
            }
        }
        // Restore the light exactly where it was (upstream #131: never glitch it).
        let restore = self.persisted.light_level.clamp(0.0, 100.0);
        if restore > 0.0 {
            info!(level = restore, "restoring light level from state file");
        }
        self.set_light(restore, now, false);
        self.pump_since = now.ts();
        for id in self.doses.keys().copied().collect::<Vec<_>>() {
            self.dose_since.insert(id, now.ts());
        }
        self.last_tick = Some(now.instant);
        // Read first so the retained alerts reflect the real tank, then publish
        // system → discovery → states → alerts → readings.
        let readings = self.telemetry(now, true);
        let mut out = self.resync(now);
        out.extend(readings);
        out
    }

    /// Everything retained: system, actuator states (+ HA mirrors), alerts, discovery.
    fn resync(&mut self, now: Now) -> Vec<Outbound> {
        let mut out = vec![Outbound::json(topics::system(&self.unit), &self.system, true)];
        if let Some(prefix) = &self.cfg.ha_prefix {
            out.extend(crate::ha::discovery(prefix, &self.system));
        }
        for id in self.system.caps.actuators.clone() {
            out.extend(self.publish_actuator(id, now));
        }
        self.refresh_alerts(now, true, &mut out);
        out.push(Outbound::json(
            topics::devices(&self.unit),
            &self.inventory(),
            true,
        ));
        out
    }

    // ---- inbound -----------------------------------------------------------

    pub fn handle(&mut self, msg: Inbound, now: Now) -> Vec<Outbound> {
        let mut out = Vec::new();
        match msg {
            Inbound::ActuatorSet(id, cmd) => out.extend(self.actuator_set(id, &cmd, now)),
            Inbound::AlertAck(kind) => {
                warn!(?kind, "alert acknowledged");
                match kind {
                    AlertKind::PumpFault => {
                        self.pump.acknowledge();
                        out.extend(self.publish_actuator(ActuatorId::Pump, now));
                        self.save_state(now);
                    }
                    AlertKind::DoseFault => {
                        for g in self.doses.values_mut() {
                            g.acknowledge();
                        }
                        for id in self.doses.keys().copied().collect::<Vec<_>>() {
                            out.extend(self.publish_actuator(id, now));
                        }
                        self.save_state(now);
                    }
                    _ => {}
                }
                self.refresh_alerts(now, false, &mut out);
            }
            Inbound::Button(press) => {
                out.push(Outbound::json(
                    topics::button(&self.unit),
                    &ButtonEvent { press },
                    false,
                ));
                match press {
                    ButtonPress::Single => {
                        let target = if self.light_level > 0.0 {
                            0.0
                        } else {
                            self.last_light_on()
                        };
                        out.extend(self.actuator_set(
                            ActuatorId::Light,
                            &ActuatorCommand {
                                on: Some(target > 0.0),
                                level: Some(target),
                                duration_s: None,
                            },
                            now,
                        ));
                    }
                    ButtonPress::Double => {
                        let want_on = !self.pump.is_running(now.instant);
                        out.extend(self.actuator_set(
                            ActuatorId::Pump,
                            &ActuatorCommand {
                                on: Some(want_on),
                                level: None,
                                duration_s: Some(self.cfg.button_pump_run_s),
                            },
                            now,
                        ));
                    }
                    // Someone is standing at the unit: clear every latched fault.
                    ButtonPress::Long => {
                        out.extend(self.handle(Inbound::AlertAck(AlertKind::PumpFault), now));
                        if !self.doses.is_empty() {
                            out.extend(self.handle(Inbound::AlertAck(AlertKind::DoseFault), now));
                        }
                    }
                    // Networking is core's job (ADR-0004); hald only reports the gesture.
                    ButtonPress::Setup => {}
                }
            }
            Inbound::CameraResult { name, ok, detail } => {
                let kind = AlertKind::CameraMissing;
                let prev = self.alerts.get(&kind).map(|a| a.active).unwrap_or(false);
                let active = !ok;
                let detail = if ok {
                    String::new()
                } else {
                    format!("{name}: {detail}")
                };
                if active != prev || (active && self.alerts.get(&kind).is_some_and(|a| a.detail != detail)) {
                    let a = Alert {
                        kind,
                        active,
                        ts: now.ts(),
                        detail,
                    };
                    out.push(Outbound::json(topics::alert(&self.unit, kind), &a, true));
                    self.alerts.insert(kind, a);
                    self.update_snapshot(now);
                }
            }
            Inbound::Calibrate(id, cmd) => {
                let res = match self.registry.sensor_mut(id) {
                    Some(s) => s.calibrate(&cmd).map_err(|e| e.to_string()),
                    None => Err(format!("no {} sensor configured", key(&id))),
                };
                match &res {
                    Ok(points) => info!(sensor = %key(&id), point = ?cmd.point, ?points, "calibrated"),
                    Err(e) => warn!(sensor = %key(&id), point = ?cmd.point, %e, "calibration refused"),
                }
                let result = CalibrationResult {
                    ts: now.ts(),
                    point: cmd.point,
                    ok: res.is_ok(),
                    points: res.as_ref().ok().copied().flatten(),
                    detail: res.err().unwrap_or_default(),
                };
                out.push(Outbound::json(
                    topics::sensor_calibration(&self.unit, id),
                    &result,
                    true,
                ));
            }
            Inbound::Devices(cmd) => out.extend(self.devices_cmd(cmd, now)),
            Inbound::Resync => out.extend(self.resync(now)),
            Inbound::Shutdown => out.extend(self.shutdown(now)),
        }
        out
    }

    fn last_light_on(&self) -> f64 {
        if self.persisted.light_level > 0.0 {
            self.persisted.light_level
        } else {
            100.0
        }
    }

    fn actuator_set(&mut self, id: ActuatorId, cmd: &ActuatorCommand, now: Now) -> Vec<Outbound> {
        if !self.system.caps.actuators.contains(&id) {
            warn!(?id, "command for an actuator this unit does not have");
            return Vec::new();
        }
        match id {
            ActuatorId::Light => {
                let level = match (cmd.on, cmd.level) {
                    (Some(false), _) => 0.0,
                    (_, Some(l)) => l,
                    (Some(true), None) => self.last_light_on(),
                    (None, None) => self.light_level,
                };
                self.set_light(level.clamp(0.0, 100.0), now, true);
                self.publish_actuator(id, now)
            }
            ActuatorId::Pump => {
                let mut out = Vec::new();
                self.refresh_env(now);
                match self.pump.request(cmd, self.start_env(), now.instant) {
                    Ok(Decision::Run { level, deadline_in }) => {
                        info!(level, secs = deadline_in.as_secs(), "pump run accepted");
                        self.apply_pump(level, now);
                        self.persisted.last_pump_run = Some(now.ts());
                    }
                    Ok(Decision::Stop) => self.apply_pump(0.0, now),
                    Err(e) => warn!(%e, "pump command refused"),
                }
                out.extend(self.publish_actuator(id, now));
                self.refresh_alerts(now, false, &mut out);
                out
            }
            ActuatorId::Dose1 | ActuatorId::Dose2 | ActuatorId::Dose3 => {
                let mut out = Vec::new();
                let decision = self.doses.get_mut(&id).map(|g| g.request(cmd, now.epoch_s));
                match decision {
                    Some(Ok(Decision::Run { deadline_in, .. })) => {
                        info!(?id, secs = deadline_in.as_secs(), "dose accepted");
                        self.apply_dose(id, true, now);
                        self.save_state(now);
                    }
                    Some(Ok(Decision::Stop)) => self.apply_dose(id, false, now),
                    Some(Err(e)) => warn!(?id, %e, "dose refused"),
                    None => {}
                }
                out.extend(self.publish_actuator(id, now));
                self.refresh_alerts(now, false, &mut out);
                out
            }
        }
    }

    // ---- periodic ----------------------------------------------------------

    pub fn tick(&mut self, now: Now) -> Vec<Outbound> {
        let mut out = Vec::new();
        self.account_light_hours(now);

        let due = self.last_telemetry.map_or(true, |t| {
            now.instant.duration_since(t) >= self.cfg.telemetry_interval
        });
        if due {
            out.extend(self.telemetry(now, false));
        } else if self.pump.is_running(now.instant) {
            self.refresh_env(now);
        }

        if let Some(Decision::Stop) = self.pump.tick(self.env, now.instant) {
            self.apply_pump(0.0, now);
            match self.pump.fault() {
                Some(f) => warn!(fault = f, "pump stopped by guard; latched until acknowledged"),
                None => info!("pump run complete"),
            }
            out.extend(self.publish_actuator(ActuatorId::Pump, now));
        }
        for id in self.doses.keys().copied().collect::<Vec<_>>() {
            let stop = self.doses.get_mut(&id).and_then(|g| g.tick(now.epoch_s));
            if let Some(Decision::Stop) = stop {
                self.apply_dose(id, false, now);
                info!(?id, "dose complete");
                out.extend(self.publish_actuator(id, now));
            }
        }
        if due {
            self.refresh_alerts(now, false, &mut out);
        }
        if self
            .last_hours_persist
            .map_or(true, |t| now.instant.duration_since(t) >= HOURS_PERSIST_EVERY)
        {
            self.save_state(now);
        }
        self.last_tick = Some(now.instant);
        out
    }

    /// Read every sensor; publish on change or when the interval elapsed.
    fn telemetry(&mut self, now: Now, force: bool) -> Vec<Outbound> {
        let mut out = Vec::new();
        let mut distance = None;
        let mut trusted_distance = None;
        let mut pcb = None;
        let mut readings = Vec::new();
        for s in self.registry.sensors_mut() {
            match s.read() {
                Ok(r) => {
                    match s.id() {
                        SensorId::WaterDistance => {
                            distance = Some(r.value);
                            // Too few pings answered: the guard keeps the number, but a
                            // run of stray echoes mustn't count as water being back.
                            trusted_distance = (r.quality != Quality::Suspect).then_some(r.value);
                        }
                        SensorId::PcbTemp => pcb = Some(r.value),
                        _ => {}
                    }
                    readings.push((s.id(), r));
                }
                Err(e) => {
                    warn!(sensor = ?s.id(), %e, "read failed; reprobing");
                    let _ = s.probe();
                }
            }
        }
        self.env.water_distance_cm = distance;
        self.env.pcb_temp_c = pcb;
        if let Some(low) = self.cfg.pump.water_low_cm {
            self.water.observe(trusted_distance, low);
        }
        self.env.over_temp_signal = self.read_over_temp_signal();
        for (id, r) in readings {
            let changed = self.last_published.get(&id).map_or(true, |(v, t)| {
                *v != r.value || now.instant.duration_since(*t) >= self.cfg.telemetry_interval
            });
            if changed || force {
                out.push(Outbound::json(topics::sensor(&self.unit, id), &r, false));
                self.last_published.insert(id, (r.value, now.instant));
            }
            if let Ok(mut snap) = self.snapshot.write() {
                snap.sensors.insert(key(&id), r);
            }
        }
        self.last_telemetry = Some(now.instant);
        self.update_snapshot(now);
        out
    }

    /// Just what the guard needs (before a pump decision and, while running,
    /// between telemetry rounds).
    fn refresh_env(&mut self, _now: Now) {
        if let Some(s) = self.registry.sensor_mut(SensorId::WaterDistance) {
            self.env.water_distance_cm = s.read().ok().map(|r| r.value);
        }
        if let Some(s) = self.registry.sensor_mut(SensorId::PcbTemp) {
            self.env.pcb_temp_c = s.read().ok().map(|r| r.value);
        }
        self.env.over_temp_signal = self.read_over_temp_signal();
    }

    /// What the guard judges a pump start on. A held water alert counts as no
    /// reading, so a stray good echo can't start the pump while the app says the
    /// water is low (upstream #111). It only holds that way round: the guard judges
    /// each live read, so one lost read can refuse a start or trip the pump while
    /// `water_low`, which counts telemetry rounds, stays inactive.
    fn start_env(&self) -> Env {
        Env {
            water_distance_cm: self.env.water_distance_cm.filter(|_| !self.water.active),
            ..self.env
        }
    }

    fn read_over_temp_signal(&mut self) -> bool {
        match &mut self.over_temp_input {
            Some(b) => b.is_active().unwrap_or(false),
            None => false,
        }
    }

    // ---- drivers (the only places that touch set_level) --------------------

    /// The pump driver is driven from here and nowhere else.
    fn apply_pump(&mut self, level: f64, now: Now) {
        if let Some(p) = self.registry.actuator_mut(ActuatorId::Pump) {
            if let Err(e) = p.set_level(level) {
                error!(%e, "pump driver write failed");
            }
        }
        let on = level > 0.0;
        if on != self.pump_was_on {
            self.pump_since = now.ts();
            self.pump_was_on = on;
        }
    }

    fn apply_dose(&mut self, id: ActuatorId, on: bool, now: Now) {
        if let Some(a) = self.registry.actuator_mut(id) {
            if let Err(e) = a.set_level(if on { 100.0 } else { 0.0 }) {
                error!(?id, %e, "dosing driver write failed");
            }
        }
        self.dose_since.insert(id, now.ts());
    }

    fn set_light(&mut self, level: f64, now: Now, persist: bool) {
        if let Some(l) = &self.light {
            // Only a boot restore doesn't persist, and that must land exactly, never fade.
            if persist {
                l.fade_to(level);
            } else {
                l.jump(level);
            }
        }
        if level != self.light_level || self.light_since.is_empty() {
            self.light_since = now.ts();
        }
        self.light_level = level;
        if persist {
            if level > 0.0 {
                self.persisted.light_level = level;
            } else {
                // Keep the last on-level for the button toggle; record off separately.
                self.persisted.light_level = 0.0;
            }
            self.persisted.light_since = Some(self.light_since.clone());
            self.save_state(now);
        }
    }

    fn account_light_hours(&mut self, now: Now) {
        if let Some(t) = self.last_tick {
            if self.light_level > 0.0 {
                self.persisted.light_hours_total += now.instant.duration_since(t).as_secs_f64() / 3600.0;
            }
        }
    }

    fn save_state(&mut self, now: Now) {
        for (id, g) in &self.doses {
            self.persisted.doses.insert(key(id), g.ledger());
        }
        if let Some(f) = &self.state_file {
            if let Err(e) = f.save(&self.persisted) {
                error!(path = %f.path().display(), %e, "could not persist state");
            }
        }
        self.last_hours_persist = Some(now.instant);
    }

    // ---- state publishing --------------------------------------------------

    pub fn actuator_state(&self, id: ActuatorId, now: Now) -> ActuatorState {
        match id {
            ActuatorId::Light => ActuatorState {
                on: self.light_level > 0.0,
                level: self.light_level,
                since: self.light_since.clone(),
                fault: None,
                remaining_s: None,
            },
            ActuatorId::Pump => ActuatorState {
                on: self.pump.is_running(now.instant),
                level: self.pump.level(),
                since: self.pump_since.clone(),
                fault: self.pump.fault().map(str::to_owned),
                remaining_s: self.pump.remaining(now.instant),
            },
            ActuatorId::Dose1 | ActuatorId::Dose2 | ActuatorId::Dose3 => {
                let g = self.doses.get(&id);
                ActuatorState {
                    on: g.is_some_and(|g| g.is_running(now.epoch_s)),
                    level: if g.is_some_and(|g| g.is_running(now.epoch_s)) {
                        100.0
                    } else {
                        0.0
                    },
                    since: self.dose_since.get(&id).cloned().unwrap_or_default(),
                    fault: g.and_then(|g| g.fault()).map(str::to_owned),
                    remaining_s: g.and_then(|g| g.remaining(now.epoch_s)),
                }
            }
        }
    }

    fn publish_actuator(&mut self, id: ActuatorId, now: Now) -> Vec<Outbound> {
        let st = self.actuator_state(id, now);
        let mut out = vec![Outbound::json(topics::actuator_state(&self.unit, id), &st, true)];
        if self.cfg.ha_prefix.is_some() {
            out.extend(crate::ha::state_mirror(&self.unit, id, &st));
        }
        if let Ok(mut snap) = self.snapshot.write() {
            snap.actuators.insert(key(&id), st);
        }
        out
    }

    fn compute_alerts(&self, now: Now) -> Vec<Alert> {
        let ts = now.ts();
        let mut v = Vec::new();
        let has_distance = self.system.caps.sensors.contains(&SensorId::WaterDistance);
        if has_distance && self.cfg.pump.water_low_cm.is_some() {
            v.push(Alert {
                kind: AlertKind::WaterLow,
                active: self.water.active,
                ts: ts.clone(),
                detail: self.water.detail.clone(),
            });
        }
        let pump_fault = self.pump.fault();
        v.push(Alert {
            kind: AlertKind::PumpFault,
            active: pump_fault.is_some(),
            ts: ts.clone(),
            detail: pump_fault.map(|f| format!("pump: {f}")).unwrap_or_default(),
        });
        if !self.doses.is_empty() {
            let dose_detail: Vec<String> = self
                .doses
                .iter()
                .filter_map(|(id, g)| g.fault().map(|f| format!("{}: {f}", key(id))))
                .collect();
            v.push(Alert {
                kind: AlertKind::DoseFault,
                active: !dose_detail.is_empty(),
                ts: ts.clone(),
                detail: dose_detail.join("; "),
            });
        }
        let hot_by_temp = matches!(
            (self.cfg.pump.over_temp_c, self.env.pcb_temp_c),
            (Some(max), Some(t)) if t >= max
        );
        v.push(Alert {
            kind: AlertKind::OverTemp,
            active: hot_by_temp || self.env.over_temp_signal,
            ts,
            detail: if self.env.over_temp_signal {
                "board alert line asserted".into()
            } else if hot_by_temp {
                format!("pcb {:.1} °C", self.env.pcb_temp_c.unwrap_or_default())
            } else {
                String::new()
            },
        });
        v
    }

    /// Publish alerts whose `active`/`detail` changed (or all of them on `force`).
    fn refresh_alerts(&mut self, now: Now, force: bool, out: &mut Vec<Outbound>) {
        for a in self.compute_alerts(now) {
            let prev = self.alerts.get(&a.kind);
            let changed = prev.map_or(true, |p| p.active != a.active || p.detail != a.detail);
            if changed || force {
                // A live detail (the water distance) changes every reading; log transitions only.
                let was_active = prev.is_some_and(|p| p.active);
                if a.active && !was_active {
                    warn!(kind = ?a.kind, detail = %a.detail, "alert raised");
                } else if !a.active && was_active {
                    info!(kind = ?a.kind, "alert cleared");
                }
                out.push(Outbound::json(topics::alert(&self.unit, a.kind), &a, true));
                self.alerts.insert(a.kind, a);
            }
        }
        if force && !self.alerts.contains_key(&AlertKind::CameraMissing) {
            let a = Alert {
                kind: AlertKind::CameraMissing,
                active: false,
                ts: now.ts(),
                detail: String::new(),
            };
            out.push(Outbound::json(topics::alert(&self.unit, a.kind), &a, true));
            self.alerts.insert(a.kind, a);
        } else if force {
            if let Some(a) = self.alerts.get(&AlertKind::CameraMissing) {
                out.push(Outbound::json(topics::alert(&self.unit, a.kind), a, true));
            }
        }
        self.update_snapshot(now);
    }

    // ---- runtime sensors ----------------------------------------------------

    /// `devices/set`: apply, then publish the result and the new inventory.
    fn devices_cmd(&mut self, cmd: DeviceCommand, now: Now) -> Vec<Outbound> {
        let res = match cmd.op {
            DeviceOp::Add => self.add_sensor(&cmd.kind, cmd.addr),
            DeviceOp::Remove => self.remove_sensor(&cmd.kind, cmd.addr),
        };
        let (mut out, ok, detail) = match res {
            Ok(out) => {
                info!(op = ?cmd.op, kind = %cmd.kind, addr = cmd.addr, "sensor inventory changed");
                (out, true, String::new())
            }
            Err(e) => {
                warn!(op = ?cmd.op, kind = %cmd.kind, addr = cmd.addr, %e, "sensor change refused");
                (Vec::new(), false, e)
            }
        };
        self.update_snapshot(now);
        out.push(Outbound::json(
            topics::devices(&self.unit),
            &self.inventory(),
            true,
        ));
        out.push(Outbound::json(
            topics::devices_result(&self.unit),
            &DeviceResult {
                request_id: cmd.request_id,
                ok,
                detail,
            },
            false,
        ));
        out
    }

    fn add_sensor(&mut self, kind: &str, addr: u16) -> Result<Vec<Outbound>, String> {
        let spec = crate::kinds::find(kind).ok_or_else(|| format!("{kind} can't be added from the app"))?;
        if self.devices.factory.is_none() {
            return Err("this daemon can't add sensors at runtime".into());
        }
        if !I2C_ADDR_RANGE.contains(&addr) {
            return Err(format!("address 0x{addr:02X} is outside 0x08–0x77"));
        }
        if let Some(d) = self.devices.entries.iter().find(|d| d.addr == Some(addr)) {
            return Err(format!("0x{addr:02X} is already used by {}", d.label));
        }
        let info = spec.info();
        if let Some(id) = info.ids.iter().find(|id| {
            self.system.caps.sensors.contains(id) || self.devices.entries.iter().any(|d| d.ids.contains(id))
        }) {
            return Err(format!("a {} sensor is already installed", key(id)));
        }
        let drivers = self
            .devices
            .factory
            .as_mut()
            .expect("checked above")
            .build(spec.as_ref(), addr)
            .map_err(|e| e.to_string())?;
        let entry = SensorEntry {
            kind: kind.into(),
            addr: Some(addr),
            pin: None,
            trigger: None,
            echo: None,
            optional: false,
            active_low: None,
        };
        let mut user = self.devices.user.clone();
        user.push(entry);
        if let Some(o) = &self.devices.overlay {
            o.save(&user)
                .map_err(|e| format!("could not save the sensor list: {e}"))?;
        }
        self.devices.user = user;
        for d in drivers {
            self.registry.add_sensor(d);
        }
        self.system.caps.sensors.extend(info.ids.iter().copied());
        self.devices.entries.push(DeviceEntry {
            kind: kind.into(),
            label: info.label,
            addr: Some(addr),
            ids: info.ids,
            source: DeviceSource::User,
            status: DeviceStatus::Ready,
            detail: String::new(),
        });
        Ok(self.publish_caps(&[]))
    }

    fn remove_sensor(&mut self, kind: &str, addr: u16) -> Result<Vec<Outbound>, String> {
        let idx = self
            .devices
            .entries
            .iter()
            .position(|d| d.kind == kind && d.addr == Some(addr))
            .ok_or_else(|| format!("no {kind} sensor at 0x{addr:02X}"))?;
        if self.devices.entries[idx].source == DeviceSource::Config {
            return Err("built-in sensors come from hal.toml and can't be removed from the app".into());
        }
        let user: Vec<SensorEntry> = self
            .devices
            .user
            .iter()
            .filter(|s| !(s.kind == kind && s.addr == Some(addr)))
            .cloned()
            .collect();
        if let Some(o) = &self.devices.overlay {
            o.save(&user)
                .map_err(|e| format!("could not save the sensor list: {e}"))?;
        }
        self.devices.user = user;
        let entry = self.devices.entries.remove(idx);
        for id in &entry.ids {
            self.registry.remove_sensor(*id);
            self.last_published.remove(id);
            if let Ok(mut snap) = self.snapshot.write() {
                snap.sensors.remove(&key(id));
            }
        }
        self.system.caps.sensors.retain(|id| !entry.ids.contains(id));
        Ok(self.publish_caps(&entry.ids))
    }

    /// Retained `system` + HA discovery after the capability set changed;
    /// `removed` sensors get their discovery entity deleted.
    fn publish_caps(&self, removed: &[SensorId]) -> Vec<Outbound> {
        let mut out = vec![Outbound::json(topics::system(&self.unit), &self.system, true)];
        if let Some(prefix) = &self.cfg.ha_prefix {
            out.extend(crate::ha::discovery(prefix, &self.system));
            out.extend(
                removed
                    .iter()
                    .map(|id| crate::ha::remove_sensor(prefix, &self.unit, *id)),
            );
        }
        out
    }

    fn update_snapshot(&self, now: Now) {
        if let Ok(mut snap) = self.snapshot.write() {
            snap.system = Some(self.system.clone());
            snap.unit_id = self.unit.clone();
            snap.ts = now.ts();
            snap.alerts = self.alerts.iter().map(|(k, a)| (key(k), a.clone())).collect();
            snap.light_hours_total = self.persisted.light_hours_total;
        }
    }

    // ---- shutdown ----------------------------------------------------------

    /// SIGTERM: pump and dosers off, light left as-is, state saved, offline.
    pub fn shutdown(&mut self, now: Now) -> Vec<Outbound> {
        info!("shutting down: pump off, light left as-is");
        let mut out = Vec::new();
        let stop = ActuatorCommand {
            on: Some(false),
            ..Default::default()
        };
        if self.system.caps.actuators.contains(&ActuatorId::Pump) {
            let _ = self.pump.request(&stop, self.env, now.instant);
            self.apply_pump(0.0, now);
            out.extend(self.publish_actuator(ActuatorId::Pump, now));
        }
        for id in self.doses.keys().copied().collect::<Vec<_>>() {
            if let Some(g) = self.doses.get_mut(&id) {
                let _ = g.request(&stop, now.epoch_s);
            }
            self.apply_dose(id, false, now);
            out.extend(self.publish_actuator(id, now));
        }
        if let Some(l) = &self.light {
            l.finish();
        }
        self.account_light_hours(now);
        self.save_state(now);
        out.push(Outbound::retained(topics::availability(&self.unit), "offline"));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hal_core::{Caps, Limits, CONTRACT_VERSION};

    fn system(actuators: Vec<ActuatorId>) -> SystemInfo {
        SystemInfo {
            contract: CONTRACT_VERSION,
            unit_id: "u1".into(),
            model: "sim".into(),
            board: None,
            hal_version: "0.1.0".into(),
            caps: Caps {
                sensors: vec![
                    SensorId::AirTemp,
                    SensorId::PcbTemp,
                    SensorId::WaterDistance,
                    SensorId::WaterLevelPct,
                ],
                actuators,
                cameras: vec![],
            },
            limits: Limits {
                pump_max_run_s: 900,
                pump_max_duty: 30.0,
                water_low_cm: Some(16.0),
            },
        }
    }

    fn cfg(ha: bool) -> EngineConfig {
        EngineConfig {
            telemetry_interval: Duration::from_secs(10),
            light_fade: Duration::from_millis(800),
            pump: PumpLimits::default(),
            dosing: DoseLimits {
                enabled: true,
                ..DoseLimits::default()
            },
            button_pump_run_s: 300,
            ha_prefix: ha.then(|| "homeassistant".to_owned()),
        }
    }

    struct Rig {
        engine: Engine,
        world: hal_sim::Shared,
        now: Now,
        snapshot: SharedSnapshot,
        dir: std::path::PathBuf,
    }

    fn rig(actuators: Vec<ActuatorId>, ha: bool, tag: &str) -> Rig {
        let world = hal_sim::world();
        let mut registry = Registry::default();
        for id in [
            SensorId::AirTemp,
            SensorId::PcbTemp,
            SensorId::WaterDistance,
            SensorId::WaterLevelPct,
        ] {
            registry.add_sensor(Box::new(hal_sim::SimSensor::new(id, world.clone())));
        }
        for a in &actuators {
            registry.add_actuator(Box::new(hal_sim::SimActuator::new(*a, world.clone())));
        }
        let dir = std::env::temp_dir().join(format!("hald-engine-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let snapshot: SharedSnapshot = Arc::default();
        let engine = Engine::new(
            system(actuators),
            cfg(ha),
            registry,
            None,
            Some(StateFile::new(&dir)),
            snapshot.clone(),
        );
        Rig {
            engine,
            world,
            now: Now {
                instant: Instant::now(),
                epoch_s: 1_793_419_043,
            },
            snapshot,
            dir,
        }
    }

    fn topics_of(out: &[Outbound]) -> Vec<&str> {
        out.iter().map(|o| o.topic.as_str()).collect()
    }
    fn payload(out: &[Outbound], topic: &str) -> serde_json::Value {
        let o = out
            .iter()
            .rev()
            .find(|o| o.topic == topic)
            .unwrap_or_else(|| panic!("no {topic}"));
        serde_json::from_str(&o.payload).unwrap()
    }
    fn on(level: Option<f64>, duration_s: Option<u64>) -> ActuatorCommand {
        ActuatorCommand {
            on: Some(true),
            level,
            duration_s,
        }
    }
    fn off() -> ActuatorCommand {
        ActuatorCommand {
            on: Some(false),
            ..Default::default()
        }
    }

    #[test]
    fn boot_publishes_system_states_alerts_discovery_and_telemetry() {
        let mut r = rig(vec![ActuatorId::Light, ActuatorId::Pump], true, "boot");
        let out = r.engine.boot(r.now);
        let t = topics_of(&out);
        assert_eq!(t[0], "seedypod/u1/system");
        assert!(t
            .iter()
            .any(|x| x.starts_with("homeassistant/light/u1_light/config")));
        assert!(t.contains(&"seedypod/u1/actuator/light/state"));
        assert!(t.contains(&"seedypod/u1/ha/light/state"));
        assert!(t.contains(&"seedypod/u1/actuator/pump/state"));
        for k in ["water_low", "pump_fault", "over_temp", "camera_missing"] {
            assert!(t.contains(&format!("seedypod/u1/alert/{k}").as_str()), "{k}");
        }
        assert!(t.contains(&"seedypod/u1/sensor/air_temp"));
        assert!(t.contains(&"seedypod/u1/sensor/water_level_pct"));
        assert_eq!(payload(&out, "seedypod/u1/alert/water_low")["active"], false);
        assert_eq!(payload(&out, "seedypod/u1/system")["unitId"], "u1");
        // Retained flags.
        assert!(out
            .iter()
            .filter(|o| o.topic.starts_with("seedypod/u1/alert/"))
            .all(|o| o.retain));
        assert!(out
            .iter()
            .filter(|o| o.topic.starts_with("seedypod/u1/sensor/"))
            .all(|o| !o.retain));
        let snap = r.snapshot.read().unwrap();
        assert_eq!(snap.sensors.len(), 4);
        assert_eq!(snap.actuators.len(), 2);
        assert_eq!(snap.alerts.len(), 4);
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    #[test]
    fn light_commands_apply_persist_and_mirror() {
        let mut r = rig(vec![ActuatorId::Light], true, "light");
        r.engine.boot(r.now);
        let out = r.engine.handle(
            Inbound::ActuatorSet(ActuatorId::Light, on(Some(60.0), None)),
            r.now,
        );
        assert_eq!(payload(&out, "seedypod/u1/actuator/light/state")["level"], 60.0);
        assert_eq!(
            out.iter()
                .find(|o| o.topic.ends_with("ha/light/brightness/state"))
                .unwrap()
                .payload,
            "60"
        );
        assert_eq!(r.world.lock().unwrap().light_level, 60.0);
        // Over-range clamps; `on` without level restores the last level.
        r.engine.handle(
            Inbound::ActuatorSet(ActuatorId::Light, on(Some(500.0), None)),
            r.now,
        );
        assert_eq!(r.engine.light_level, 100.0);
        r.engine
            .handle(Inbound::ActuatorSet(ActuatorId::Light, off()), r.now);
        assert_eq!(r.world.lock().unwrap().light_level, 0.0);
        let out = r
            .engine
            .handle(Inbound::ActuatorSet(ActuatorId::Light, on(None, None)), r.now);
        assert_eq!(payload(&out, "seedypod/u1/actuator/light/state")["level"], 100.0);
        // Empty command is a no-op state publish.
        let out = r.engine.handle(
            Inbound::ActuatorSet(ActuatorId::Light, ActuatorCommand::default()),
            r.now,
        );
        assert_eq!(payload(&out, "seedypod/u1/actuator/light/state")["on"], true);
        // Persisted and restored by a fresh engine on the same state dir.
        let saved = StateFile::new(&r.dir).load();
        assert_eq!(saved.light_level, 100.0);
        let mut registry = Registry::default();
        registry.add_actuator(Box::new(hal_sim::SimActuator::new(
            ActuatorId::Light,
            r.world.clone(),
        )));
        r.world.lock().unwrap().light_level = 0.0;
        let mut e2 = Engine::new(
            system(vec![ActuatorId::Light]),
            cfg(false),
            registry,
            None,
            Some(StateFile::new(&r.dir)),
            Arc::default(),
        );
        e2.boot(r.now);
        assert_eq!(r.world.lock().unwrap().light_level, 100.0);
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    #[test]
    fn pump_runs_only_through_the_guard_and_ends_on_deadline() {
        let mut r = rig(vec![ActuatorId::Pump], false, "pump");
        r.engine.boot(r.now);
        let out = r.engine.handle(
            Inbound::ActuatorSet(ActuatorId::Pump, on(Some(100.0), Some(20))),
            r.now,
        );
        let st = payload(&out, "seedypod/u1/actuator/pump/state");
        assert_eq!(st["on"], true);
        assert_eq!(st["level"], 30.0, "clamped to max duty");
        assert_eq!(st["remainingS"], 20);
        assert_eq!(r.world.lock().unwrap().pump_level, 30.0);
        assert!(
            topics_of(&out).iter().all(|t| !t.starts_with("seedypod/u1/ha/")),
            "no HA mirror without prefix"
        );
        r.now.advance(Duration::from_secs(21));
        let out = r.engine.tick(r.now);
        let st = payload(&out, "seedypod/u1/actuator/pump/state");
        assert_eq!(st["on"], false);
        assert!(st["fault"].is_null());
        assert_eq!(r.world.lock().unwrap().pump_level, 0.0);
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    #[test]
    fn dry_tank_refuses_trips_latches_and_acknowledge_clears() {
        let mut r = rig(vec![ActuatorId::Pump], false, "dry");
        r.engine.boot(r.now);
        r.engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, None)), r.now);
        assert_eq!(r.world.lock().unwrap().pump_level, 30.0);
        // Drain the tank past the threshold; the next tick trips the guard.
        r.world.lock().unwrap().water_distance_cm = 17.0;
        r.now.advance(Duration::from_secs(10));
        let out = r.engine.tick(r.now);
        assert_eq!(r.world.lock().unwrap().pump_level, 0.0);
        let st = payload(&out, "seedypod/u1/actuator/pump/state");
        assert_eq!(st["fault"], "dry-run");
        assert_eq!(payload(&out, "seedypod/u1/alert/pump_fault")["active"], true);
        assert_eq!(payload(&out, "seedypod/u1/alert/water_low")["active"], true);
        // Refill: still latched, start refused, and the refusal is visible in state.
        r.world.lock().unwrap().water_distance_cm = 7.0;
        let out = r
            .engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, None)), r.now);
        assert_eq!(payload(&out, "seedypod/u1/actuator/pump/state")["on"], false);
        assert_eq!(
            payload(&out, "seedypod/u1/actuator/pump/state")["fault"],
            "dry-run"
        );
        assert_eq!(r.world.lock().unwrap().pump_level, 0.0);
        let out = r.engine.handle(Inbound::AlertAck(AlertKind::PumpFault), r.now);
        assert!(payload(&out, "seedypod/u1/actuator/pump/state")["fault"].is_null());
        assert_eq!(payload(&out, "seedypod/u1/alert/pump_fault")["active"], false);
        // A window of good readings clears the water alert, and only then may it start.
        let out = r
            .engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, Some(5))), r.now);
        assert_eq!(payload(&out, "seedypod/u1/actuator/pump/state")["on"], false);
        let mut cleared = None;
        for _ in 0..WATER_WINDOW {
            r.now.advance(Duration::from_secs(10));
            cleared = r
                .engine
                .tick(r.now)
                .into_iter()
                .find(|o| o.topic == "seedypod/u1/alert/water_low");
        }
        assert!(cleared.unwrap().payload.contains(r#""active":false"#));
        let out = r
            .engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, Some(5))), r.now);
        assert_eq!(payload(&out, "seedypod/u1/actuator/pump/state")["on"], true);
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    fn water_rounds(a: &mut WaterAlert, rounds: &[Option<f64>]) -> Vec<bool> {
        rounds
            .iter()
            .map(|d| {
                a.observe(*d, 16.0);
                a.active
            })
            .collect()
    }

    #[test]
    fn a_low_reading_raises_the_water_alert_at_once_and_it_needs_a_clean_window_to_clear() {
        let mut a = WaterAlert::default();
        water_rounds(&mut a, &[Some(7.0)]);
        assert!(!a.active);
        water_rounds(&mut a, &[Some(150.0)]);
        assert!(a.active);
        assert_eq!(a.detail, "water distance 150.0 cm ≥ 16.0 cm");
        let held = water_rounds(&mut a, &[Some(7.0); WATER_WINDOW]);
        assert_eq!(held, [true, true, true, true, true, false]);
        assert_eq!(a.detail, "");
    }

    #[test]
    fn a_lost_reading_raises_the_water_alert_only_when_they_pile_up() {
        let mut a = WaterAlert::default();
        water_rounds(&mut a, &[Some(7.0); WATER_WINDOW]);
        // A dropout now and then on a full tank is not low water.
        let blips = [
            None,
            Some(7.0),
            Some(7.0),
            None,
            Some(7.0),
            Some(7.0),
            None,
            Some(7.0),
        ];
        assert!(!water_rounds(&mut a, &blips).contains(&true));
        water_rounds(&mut a, &[None, None]);
        assert!(a.active);
        assert_eq!(a.detail, "water level sensor unavailable");
    }

    #[test]
    fn a_ranger_with_the_tank_out_holds_the_water_alert_instead_of_flapping() {
        let mut a = WaterAlert::default();
        let flapping = [
            None,
            Some(9.0),
            None,
            Some(150.0),
            None,
            Some(4.0),
            None,
            None,
            Some(9.0),
        ]
        .repeat(5);
        assert!(!water_rounds(&mut a, &flapping).contains(&false));
        // Held across a stray good reading, the detail stays the last bad one.
        assert_eq!(a.detail, "water level sensor unavailable");
    }

    /// A ranger on stray echoes: under the limit, but too few pings answered.
    struct StrayEchoes;

    impl hal_core::device::Sensor for StrayEchoes {
        fn id(&self) -> SensorId {
            SensorId::WaterDistance
        }
        fn probe(&mut self) -> Result<(), hal_core::device::DeviceError> {
            Ok(())
        }
        fn read(&mut self) -> Result<Reading, hal_core::device::DeviceError> {
            let mut r = Reading::new(9.0, "cm");
            r.quality = Quality::Suspect;
            Ok(r)
        }
    }

    #[test]
    fn suspect_readings_never_clear_the_water_alert_but_the_guard_still_sees_them() {
        let mut registry = Registry::default();
        registry.add_sensor(Box::new(StrayEchoes));
        let mut e = Engine::new(system(vec![]), cfg(false), registry, None, None, Arc::default());
        let mut now = Now {
            instant: Instant::now(),
            epoch_s: 1_793_419_043,
        };
        e.boot(now);
        for _ in 0..WATER_WINDOW * 3 {
            now.advance(Duration::from_secs(10));
            e.tick(now);
        }
        assert!(e.water.active);
        assert_eq!(e.water.detail, "water level sensor unavailable");
        assert_eq!(e.env.water_distance_cm, Some(9.0));
    }

    #[test]
    fn a_silent_ranger_at_boot_raises_the_water_alert_straight_away() {
        let mut a = WaterAlert::default();
        assert_eq!(water_rounds(&mut a, &[None]), [true]);
    }

    #[test]
    fn a_held_water_alert_refuses_a_start_on_a_stray_good_reading() {
        let mut r = rig(vec![ActuatorId::Pump], false, "held");
        r.engine.boot(r.now);
        r.world.lock().unwrap().water_distance_cm = 150.0;
        r.now.advance(Duration::from_secs(10));
        let out = r.engine.tick(r.now);
        assert_eq!(payload(&out, "seedypod/u1/alert/water_low")["active"], true);
        r.world.lock().unwrap().water_distance_cm = 7.0;
        r.now.advance(Duration::from_secs(10));
        let out = r.engine.tick(r.now);
        assert!(!topics_of(&out).contains(&"seedypod/u1/alert/water_low"));
        let out = r
            .engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, Some(5))), r.now);
        assert_eq!(payload(&out, "seedypod/u1/actuator/pump/state")["on"], false);
        assert_eq!(r.world.lock().unwrap().pump_level, 0.0);
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    #[test]
    fn a_unit_with_the_water_interlock_off_has_no_water_alert_to_hold() {
        let mut r = rig(vec![ActuatorId::Pump], false, "nolimit");
        r.engine.cfg.pump.water_low_cm = None;
        r.engine.pump = PumpGuard::new(r.engine.cfg.pump.clone());
        r.world.lock().unwrap().water_distance_cm = 150.0;
        let out = r.engine.boot(r.now);
        assert!(!topics_of(&out).contains(&"seedypod/u1/alert/water_low"));
        let out = r
            .engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, Some(5))), r.now);
        assert_eq!(payload(&out, "seedypod/u1/actuator/pump/state")["on"], true);
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    /// The fmt layer and policy filter as main.rs builds them, into a buffer.
    fn quiet_log(run: impl FnOnce()) -> String {
        use std::io::Write;
        use std::sync::Mutex;
        use tracing_subscriber::layer::{Layer, SubscriberExt};

        #[derive(Clone, Default)]
        struct Buf(Arc<Mutex<Vec<u8>>>);
        impl Write for Buf {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(b);
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let buf = Buf::default();
        let sink = buf.clone();
        let policy = Some(crate::recording::RecordingPolicy::new(
            "/nonexistent/recording-policy.json",
        ));
        let layer = tracing_subscriber::fmt::layer()
            .with_writer(move || sink.clone())
            .with_filter(crate::recording::log_filter(policy));
        tracing::subscriber::with_default(tracing_subscriber::registry().with(layer), run);
        let out = buf.0.lock().unwrap();
        String::from_utf8_lossy(&out).into_owned()
    }

    /// tracing caches per log line, process-wide, whether anyone wants it, and tests running
    /// beside this one can leave a line switched off. So the scenario gets a process to itself.
    #[test]
    fn quiet_logging_keeps_pump_faults_refusals_and_alerts_and_drops_the_routine() {
        let out = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "engine::tests::quiet_log_scenario", "--ignored"])
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(out.status.success() && stdout.contains("1 passed"), "{stdout}");
    }

    #[test]
    #[ignore = "run in its own process by the test above"]
    fn quiet_log_scenario() {
        let mut r = rig(vec![ActuatorId::Pump], false, "quiet");
        r.engine.boot(r.now);
        let log = quiet_log(|| {
            r.engine
                .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, None)), r.now);
            r.world.lock().unwrap().water_distance_cm = 17.0;
            r.now.advance(Duration::from_secs(10));
            r.engine.tick(r.now);
            r.engine
                .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, None)), r.now);
        });
        assert!(log.contains("pump stopped by guard"), "{log}");
        assert!(log.contains("alert raised"), "{log}");
        assert!(log.contains("pump command refused"), "{log}");
        assert!(!log.contains("pump run accepted"), "{log}");
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    /// A rig with fades on, stepped by hand: `frames` moves its clock 20 ms at a time.
    struct Fading {
        r: Rig,
        clock: Arc<std::sync::Mutex<Instant>>,
    }

    impl Fading {
        fn new(tag: &str) -> Self {
            let r = rig(vec![ActuatorId::Light, ActuatorId::Pump], false, tag);
            let clock = Arc::new(std::sync::Mutex::new(Instant::now()));
            let reads = clock.clone();
            r.engine
                .light
                .as_ref()
                .unwrap()
                .step_by_hand(move || *reads.lock().unwrap());
            Self { r, clock }
        }
        fn set(&mut self, level: f64) -> Vec<Outbound> {
            self.r.engine.handle(
                Inbound::ActuatorSet(ActuatorId::Light, on(Some(level), None)),
                self.r.now,
            )
        }
        fn level(&self) -> f64 {
            self.r.world.lock().unwrap().light_level
        }
        /// The level after each of `n` frames.
        fn frames(&mut self, n: usize) -> Vec<f64> {
            (0..n)
                .map(|_| {
                    *self.clock.lock().unwrap() += Duration::from_millis(20);
                    self.r.engine.light.as_ref().unwrap().step();
                    self.level()
                })
                .collect()
        }
    }

    impl Drop for Fading {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.r.dir);
        }
    }

    #[test]
    fn a_light_change_fades_while_state_reports_the_target_once() {
        let mut f = Fading::new("fade");
        f.r.engine.boot(f.r.now);
        let out = f.set(60.0);
        assert_eq!(payload(&out, "seedypod/u1/actuator/light/state")["level"], 60.0);
        assert_eq!(f.level(), 0.0, "nothing lands before the first frame");
        assert_eq!(
            StateFile::new(&f.r.dir).load().light_level,
            60.0,
            "the target, once"
        );
        let saved = std::fs::metadata(f.r.dir.join("state.json"))
            .unwrap()
            .modified()
            .unwrap();
        let levels = f.frames(40);
        assert!(levels.windows(2).all(|w| w[1] >= w[0]), "{levels:?}");
        assert!(
            levels.iter().filter(|l| **l > 0.0 && **l < 60.0).count() > 10,
            "{levels:?}"
        );
        assert_eq!(f.level(), 60.0);
        assert_eq!(
            std::fs::metadata(f.r.dir.join("state.json"))
                .unwrap()
                .modified()
                .unwrap(),
            saved,
            "no write per step"
        );
    }

    #[test]
    fn a_new_command_mid_fade_goes_on_from_where_the_light_is() {
        let mut f = Fading::new("fade-retarget");
        f.r.engine.boot(f.r.now);
        f.set(100.0);
        let here = *f.frames(20).last().unwrap();
        f.set(10.0);
        let after = f.frames(1)[0];
        assert!((after - here).abs() < 2.0, "{here} then {after}");
        f.frames(40);
        assert_eq!(f.level(), 10.0);
    }

    #[test]
    fn off_mid_fade_reaches_exactly_zero() {
        let mut f = Fading::new("fade-off");
        f.r.engine.boot(f.r.now);
        f.set(100.0);
        f.frames(10);
        f.r.engine
            .handle(Inbound::ActuatorSet(ActuatorId::Light, off()), f.r.now);
        f.frames(40);
        assert_eq!(f.level(), 0.0);
    }

    #[test]
    fn frequent_small_changes_track_smoothly_and_repeats_dont_restart_the_fade() {
        let mut f = Fading::new("fade-small");
        f.r.engine.boot(f.r.now);
        f.set(50.0);
        f.frames(40);
        let mut levels = Vec::new();
        for step in 1..=10 {
            f.set(50.0 + f64::from(step));
            levels.extend(f.frames(5));
        }
        assert!(
            levels.windows(2).all(|w| w[1] >= w[0] && w[1] - w[0] < 1.0),
            "{levels:?}"
        );
        assert_eq!(f.level(), 60.0);
        // Asking again for where it's already headed mustn't push the end back.
        f.set(100.0);
        f.frames(20);
        f.set(100.0);
        f.frames(20);
        assert_eq!(f.level(), 100.0);
    }

    #[test]
    fn boot_restores_the_light_exactly_without_a_fade() {
        let mut f = Fading::new("fade-boot");
        StateFile::new(&f.r.dir)
            .save(&Persisted {
                light_level: 70.0,
                ..Default::default()
            })
            .unwrap();
        let persisted = StateFile::new(&f.r.dir).load();
        f.r.engine.persisted = persisted;
        f.r.engine.boot(f.r.now);
        assert_eq!(f.level(), 70.0);
        assert_eq!(f.r.engine.light.as_ref().unwrap().step(), None);
    }

    #[test]
    fn with_fading_off_a_change_lands_at_once() {
        let mut c = cfg(false);
        c.light_fade = Duration::ZERO;
        let world = hal_sim::world();
        let mut registry = Registry::default();
        registry.add_actuator(Box::new(hal_sim::SimActuator::new(
            ActuatorId::Light,
            world.clone(),
        )));
        let mut e = Engine::new(
            system(vec![ActuatorId::Light]),
            c,
            registry,
            None,
            None,
            Arc::default(),
        );
        e.start_light_fades();
        let now = Now::real();
        e.boot(now);
        e.handle(Inbound::ActuatorSet(ActuatorId::Light, on(Some(35.0), None)), now);
        assert_eq!(world.lock().unwrap().light_level, 35.0);
    }

    #[test]
    fn a_shutdown_mid_fade_lands_the_light_on_its_saved_target() {
        let mut f = Fading::new("fade-shutdown");
        f.r.engine.boot(f.r.now);
        f.set(80.0);
        f.frames(5);
        f.r.engine.handle(Inbound::Shutdown, f.r.now);
        assert_eq!(f.level(), 80.0);
        assert_eq!(StateFile::new(&f.r.dir).load().light_level, 80.0);
    }

    #[test]
    fn a_fade_leaves_the_pump_guard_alone() {
        let mut f = Fading::new("fade-pump");
        f.r.engine.boot(f.r.now);
        f.set(100.0);
        f.r.engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, None)), f.r.now);
        assert_eq!(f.r.world.lock().unwrap().pump_level, 30.0);
        f.r.world.lock().unwrap().water_distance_cm = 17.0;
        f.r.now.advance(Duration::from_secs(10));
        f.r.engine.tick(f.r.now);
        assert_eq!(f.r.world.lock().unwrap().pump_level, 0.0, "tripped mid-fade");
        assert_eq!(f.r.engine.pump.fault(), Some("dry-run"));
        f.frames(40);
        assert_eq!(f.level(), 100.0);
    }

    #[test]
    fn over_temperature_raises_the_alert_and_refuses_the_pump() {
        let mut r = rig(vec![ActuatorId::Pump], false, "hot");
        r.engine.boot(r.now);
        r.world.lock().unwrap().pcb_temp_c = 40.0;
        r.now.advance(Duration::from_secs(10));
        let out = r.engine.tick(r.now);
        let a = payload(&out, "seedypod/u1/alert/over_temp");
        assert_eq!(a["active"], true);
        assert!(a["detail"].as_str().unwrap().contains("40.0"));
        let out = r
            .engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, None)), r.now);
        assert_eq!(payload(&out, "seedypod/u1/actuator/pump/state")["on"], false);
        // Cooling clears it on the next telemetry round only (no spam in between).
        r.world.lock().unwrap().pcb_temp_c = 30.0;
        r.now.advance(Duration::from_secs(1));
        assert!(!topics_of(&r.engine.tick(r.now)).contains(&"seedypod/u1/alert/over_temp"));
        r.now.advance(Duration::from_secs(10));
        let out = r.engine.tick(r.now);
        assert_eq!(payload(&out, "seedypod/u1/alert/over_temp")["active"], false);
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    struct Hot(bool);
    impl BinarySensor for Hot {
        fn name(&self) -> &str {
            "over_temp"
        }
        fn probe(&mut self) -> Result<(), hal_core::DeviceError> {
            Ok(())
        }
        fn is_active(&mut self) -> Result<bool, hal_core::DeviceError> {
            Ok(self.0)
        }
    }

    #[test]
    fn board_alert_line_counts_as_over_temperature() {
        let world = hal_sim::world();
        let mut registry = Registry::default();
        registry.add_sensor(Box::new(hal_sim::SimSensor::new(
            SensorId::WaterDistance,
            world.clone(),
        )));
        registry.add_sensor(Box::new(hal_sim::SimSensor::new(
            SensorId::PcbTemp,
            world.clone(),
        )));
        registry.add_actuator(Box::new(hal_sim::SimActuator::new(
            ActuatorId::Pump,
            world.clone(),
        )));
        let mut e = Engine::new(
            system(vec![ActuatorId::Pump]),
            cfg(false),
            registry,
            Some(Box::new(Hot(true))),
            None,
            Arc::default(),
        );
        let now = Now::real();
        let out = e.boot(now);
        let a = payload(&out, "seedypod/u1/alert/over_temp");
        assert_eq!(a["active"], true);
        assert_eq!(a["detail"], "board alert line asserted");
        e.handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, None)), now);
        assert_eq!(world.lock().unwrap().pump_level, 0.0);
    }

    #[test]
    fn telemetry_publishes_on_change_or_interval_and_on_boot() {
        let mut r = rig(vec![], false, "telemetry");
        r.engine.boot(r.now);
        // Nothing changed, interval not elapsed → quiet tick.
        r.now.advance(Duration::from_secs(1));
        assert!(topics_of(&r.engine.tick(r.now))
            .iter()
            .all(|t| !t.starts_with("seedypod/u1/sensor/")));
        // Interval elapsed with identical values → republished anyway.
        r.now.advance(Duration::from_secs(10));
        let out = r.engine.tick(r.now);
        assert!(topics_of(&out).contains(&"seedypod/u1/sensor/air_temp"));
        // Forced interval, but a changed value must publish even before the interval.
        r.now.advance(Duration::from_secs(10));
        r.world.lock().unwrap().air_temp_c = 30.0;
        let out = r.engine.tick(r.now);
        assert_eq!(payload(&out, "seedypod/u1/sensor/air_temp")["value"], 30.0);
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    #[test]
    fn button_toggles_light_runs_pump_and_acknowledges() {
        let mut r = rig(vec![ActuatorId::Light, ActuatorId::Pump], false, "button");
        r.engine.boot(r.now);
        let out = r.engine.handle(Inbound::Button(ButtonPress::Single), r.now);
        assert_eq!(payload(&out, "seedypod/u1/event/button")["press"], "single");
        assert!(!out[0].retain);
        assert_eq!(r.world.lock().unwrap().light_level, 100.0);
        r.engine.handle(Inbound::Button(ButtonPress::Single), r.now);
        assert_eq!(r.world.lock().unwrap().light_level, 0.0);
        let out = r.engine.handle(Inbound::Button(ButtonPress::Double), r.now);
        let st = payload(&out, "seedypod/u1/actuator/pump/state");
        assert_eq!(st["on"], true);
        assert_eq!(st["remainingS"], 300);
        // Second double press stops it.
        r.engine.handle(Inbound::Button(ButtonPress::Double), r.now);
        assert_eq!(r.world.lock().unwrap().pump_level, 0.0);
        // Long press acknowledges a latched fault.
        r.engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, None)), r.now);
        r.world.lock().unwrap().water_distance_cm = 18.0;
        r.now.advance(Duration::from_secs(10));
        r.engine.tick(r.now);
        assert_eq!(r.engine.pump.fault(), Some("dry-run"));
        r.engine.handle(Inbound::Button(ButtonPress::Long), r.now);
        assert_eq!(r.engine.pump.fault(), None);
        // The setup hold is only reported; core opens the Wi-Fi hotspot.
        let out = r.engine.handle(Inbound::Button(ButtonPress::Setup), r.now);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].payload, r#"{"press":"setup"}"#);
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    #[test]
    fn dosing_goes_through_the_dose_guard_and_persists_its_ledger() {
        let mut r = rig(vec![ActuatorId::Dose1], false, "dose");
        r.engine.boot(r.now);
        let out = r
            .engine
            .handle(Inbound::ActuatorSet(ActuatorId::Dose1, on(None, Some(3))), r.now);
        let st = payload(&out, "seedypod/u1/actuator/dose_1/state");
        assert_eq!(st["on"], true);
        assert_eq!(st["remainingS"], 3);
        assert_eq!(r.world.lock().unwrap().dose_level[0], 100.0);
        r.now.advance(Duration::from_secs(4));
        let out = r.engine.tick(r.now);
        assert_eq!(payload(&out, "seedypod/u1/actuator/dose_1/state")["on"], false);
        assert_eq!(r.world.lock().unwrap().dose_level[0], 0.0);
        let saved = StateFile::new(&r.dir).load();
        assert_eq!(saved.doses["dose_1"].doses, 1);
        // Exhaust the lockout (default 4 doses) → dose_fault alert names the doser.
        for _ in 0..3 {
            r.engine
                .handle(Inbound::ActuatorSet(ActuatorId::Dose1, on(None, Some(1))), r.now);
            r.now.advance(Duration::from_secs(2));
            r.engine.tick(r.now);
        }
        let out = r
            .engine
            .handle(Inbound::ActuatorSet(ActuatorId::Dose1, on(None, Some(1))), r.now);
        let st = payload(&out, "seedypod/u1/actuator/dose_1/state");
        assert_eq!(st["on"], false);
        assert_eq!(st["fault"], "lockout");
        let df = &r.engine.alerts[&AlertKind::DoseFault];
        assert!(df.active && df.detail.contains("dose_1: lockout"), "{df:?}");
        assert!(r.snapshot.read().unwrap().alerts["dose_fault"].active);
        assert!(!r.engine.alerts[&AlertKind::PumpFault].active);
        // Acknowledging the pump fault leaves the dosing lockout latched.
        let out = r.engine.handle(Inbound::AlertAck(AlertKind::PumpFault), r.now);
        assert!(!out.iter().any(|o| o.topic == "seedypod/u1/actuator/dose_1/state"));
        assert!(r.engine.alerts[&AlertKind::DoseFault].active);
        let out = r.engine.handle(Inbound::AlertAck(AlertKind::DoseFault), r.now);
        assert!(payload(&out, "seedypod/u1/actuator/dose_1/state")["fault"].is_null());
        assert_eq!(payload(&out, "seedypod/u1/alert/dose_fault")["active"], false);
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    fn devices_rig(tag: &str) -> Rig {
        let r = rig(vec![], true, tag);
        let world = r.world.clone();
        let stock = SensorEntry {
            kind: "ina219".into(),
            addr: Some(0x40),
            pin: None,
            trigger: None,
            echo: None,
            optional: false,
            active_low: None,
        };
        let Rig {
            engine,
            world: w,
            now,
            snapshot,
            dir,
        } = r;
        let engine = engine.with_devices(Devices {
            entries: Devices::from_boot(&[(stock, None)], &[]),
            user: Vec::new(),
            factory: Some(Box::new(crate::kinds::SimFactory(world))),
            overlay: Some(Overlay::new(&dir)),
        });
        Rig {
            engine,
            world: w,
            now,
            snapshot,
            dir,
        }
    }

    fn dev(op: DeviceOp, kind: &str, addr: u16) -> Inbound {
        Inbound::Devices(DeviceCommand {
            request_id: format!("{op:?}-{kind}-{addr}"),
            op,
            kind: kind.into(),
            addr,
        })
    }

    #[test]
    fn a_probe_added_from_the_app_goes_live_and_persists() {
        let mut r = devices_rig("dev-add");
        r.engine.boot(r.now);
        let out = r.engine.handle(dev(DeviceOp::Add, "ezo_ph", 0x63), r.now);
        let res = payload(&out, "seedypod/u1/devices/result");
        assert_eq!(
            (res["ok"].as_bool(), res["requestId"].as_str()),
            (Some(true), Some("Add-ezo_ph-99"))
        );
        assert!(payload(&out, "seedypod/u1/system")["caps"]["sensors"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("ph")));
        assert!(topics_of(&out).contains(&"homeassistant/sensor/u1_ph/config"));
        let inv = payload(&out, "seedypod/u1/devices");
        let added = inv["sensors"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["kind"] == "ezo_ph")
            .unwrap();
        assert_eq!(
            (
                added["source"].as_str(),
                added["status"].as_str(),
                added["addr"].as_u64()
            ),
            (Some("user"), Some("ready"), Some(0x63))
        );
        assert_eq!(inv["addable"].as_array().unwrap().len(), 3);
        // Persisted for the next boot, and readings flow on the next tick.
        assert_eq!(Overlay::new(&r.dir).load().len(), 1);
        r.now.advance(Duration::from_secs(11));
        assert!(topics_of(&r.engine.tick(r.now)).contains(&"seedypod/u1/sensor/ph"));
        assert!(r
            .snapshot
            .read()
            .unwrap()
            .system
            .as_ref()
            .is_some_and(|s| s.caps.sensors.contains(&SensorId::Ph)));
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    #[test]
    fn unsafe_or_conflicting_changes_are_refused_and_change_nothing() {
        let mut r = devices_rig("dev-refuse");
        r.engine.boot(r.now);
        r.engine.handle(dev(DeviceOp::Add, "ezo_ph", 0x63), r.now);
        for (cmd, why) in [
            (
                dev(DeviceOp::Add, "ezo_ph", 0x65),
                "a ph sensor is already installed",
            ),
            (
                dev(DeviceOp::Add, "ezo_ec", 0x63),
                "0x63 is already used by pH probe",
            ),
            (
                dev(DeviceOp::Add, "ezo_ec", 0x40),
                "already used by Pump power monitor",
            ),
            (dev(DeviceOp::Add, "ezo_ec", 0x05), "outside 0x08–0x77"),
            (dev(DeviceOp::Add, "pct2075", 0x48), "can't be added from the app"),
            (
                dev(DeviceOp::Remove, "ina219", 0x40),
                "built-in sensors come from hal.toml",
            ),
            (dev(DeviceOp::Remove, "ezo_ec", 0x64), "no ezo_ec sensor at 0x64"),
        ] {
            let out = r.engine.handle(cmd, r.now);
            let res = payload(&out, "seedypod/u1/devices/result");
            assert_eq!(res["ok"], false);
            assert!(res["detail"].as_str().unwrap().contains(why), "{why}: {res}");
            assert!(!topics_of(&out).contains(&"seedypod/u1/system"), "{why}");
        }
        assert_eq!(Overlay::new(&r.dir).load().len(), 1);
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    #[test]
    fn removing_a_probe_retires_its_entity_and_calibration() {
        let mut r = devices_rig("dev-remove");
        r.engine.boot(r.now);
        r.engine.handle(dev(DeviceOp::Add, "ezo_ec", 0x64), r.now);
        let out = r.engine.handle(dev(DeviceOp::Remove, "ezo_ec", 0x64), r.now);
        assert_eq!(payload(&out, "seedypod/u1/devices/result")["ok"], true);
        let ha = out
            .iter()
            .find(|o| o.topic == "homeassistant/sensor/u1_ec/config" && o.payload.is_empty())
            .expect("empty retained config deletes the HA entity");
        assert!(ha.retain);
        assert!(!payload(&out, "seedypod/u1/system")["caps"]["sensors"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("ec")));
        assert!(Overlay::new(&r.dir).load().is_empty());
        let out = r.engine.handle(
            Inbound::Calibrate(
                SensorId::Ec,
                CalibrationCommand {
                    point: hal_core::CalibrationPoint::Dry,
                    value: None,
                },
            ),
            r.now,
        );
        assert_eq!(payload(&out, "seedypod/u1/sensor/ec/calibration")["ok"], false);
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    #[test]
    fn without_a_factory_runtime_changes_are_refused_and_nothing_is_addable() {
        let mut r = rig(vec![], false, "dev-nofactory");
        let boot = r.engine.boot(r.now);
        assert!(payload(&boot, "seedypod/u1/devices")["addable"]
            .as_array()
            .unwrap()
            .is_empty());
        let out = r.engine.handle(dev(DeviceOp::Add, "ezo_ph", 0x63), r.now);
        assert!(payload(&out, "seedypod/u1/devices/result")["detail"]
            .as_str()
            .unwrap()
            .contains("can't add sensors at runtime"));
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    #[test]
    fn calibration_reaches_the_probe_and_publishes_a_retained_result() {
        use hal_core::CalibrationPoint;
        let mut r = rig(vec![], false, "cal");
        r.engine
            .registry
            .add_sensor(Box::new(hal_sim::SimSensor::new(SensorId::Ph, r.world.clone())));
        r.engine.boot(r.now);
        let cmd = |point, value| CalibrationCommand { point, value };
        let out = r.engine.handle(
            Inbound::Calibrate(SensorId::Ph, cmd(CalibrationPoint::Mid, Some(7.0))),
            r.now,
        );
        let o = out
            .iter()
            .find(|o| o.topic == "seedypod/u1/sensor/ph/calibration")
            .unwrap();
        assert!(o.retain);
        let v: serde_json::Value = serde_json::from_str(&o.payload).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["points"], 1);
        assert_eq!(v["point"], "mid");
        // Missing value → refused by the probe, reported, nothing stored.
        let out = r.engine.handle(
            Inbound::Calibrate(SensorId::Ph, cmd(CalibrationPoint::Low, None)),
            r.now,
        );
        let v = payload(&out, "seedypod/u1/sensor/ph/calibration");
        assert_eq!(v["ok"], false);
        assert!(v["points"].is_null());
        assert!(v["detail"].as_str().unwrap().contains("reference value"));
        assert_eq!(r.world.lock().unwrap().cal_points[0], 1);
        // No such probe configured.
        let out = r.engine.handle(
            Inbound::Calibrate(SensorId::Ec, cmd(CalibrationPoint::Dry, None)),
            r.now,
        );
        let v = payload(&out, "seedypod/u1/sensor/ec/calibration");
        assert_eq!(v["ok"], false);
        assert_eq!(v["detail"], "no ec sensor configured");
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    #[test]
    fn disabled_dosing_refuses_silently_in_state() {
        let world = hal_sim::world();
        let mut registry = Registry::default();
        registry.add_actuator(Box::new(hal_sim::SimActuator::new(
            ActuatorId::Dose2,
            world.clone(),
        )));
        let mut c = cfg(false);
        c.dosing.enabled = false;
        let mut e = Engine::new(
            system(vec![ActuatorId::Dose2]),
            c,
            registry,
            None,
            None,
            Arc::default(),
        );
        let now = Now::real();
        e.boot(now);
        let out = e.handle(Inbound::ActuatorSet(ActuatorId::Dose2, on(None, None)), now);
        assert_eq!(payload(&out, "seedypod/u1/actuator/dose_2/state")["on"], false);
        assert_eq!(world.lock().unwrap().dose_level[1], 0.0);
    }

    #[test]
    fn unknown_actuator_commands_are_ignored() {
        let mut r = rig(vec![ActuatorId::Light], false, "unknown");
        r.engine.boot(r.now);
        assert!(r
            .engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, None)), r.now)
            .is_empty());
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    #[test]
    fn camera_results_drive_the_camera_missing_alert() {
        let mut r = rig(vec![], false, "camera");
        r.engine.boot(r.now);
        let out = r.engine.handle(
            Inbound::CameraResult {
                name: "upper".into(),
                ok: false,
                detail: "device not present".into(),
            },
            r.now,
        );
        let a = payload(&out, "seedypod/u1/alert/camera_missing");
        assert_eq!(a["active"], true);
        assert_eq!(a["detail"], "upper: device not present");
        // Same failure again → no republish.
        assert!(r
            .engine
            .handle(
                Inbound::CameraResult {
                    name: "upper".into(),
                    ok: false,
                    detail: "device not present".into(),
                },
                r.now,
            )
            .is_empty());
        let out = r.engine.handle(
            Inbound::CameraResult {
                name: "upper".into(),
                ok: true,
                detail: String::new(),
            },
            r.now,
        );
        assert_eq!(payload(&out, "seedypod/u1/alert/camera_missing")["active"], false);
        // Resync republishes it along with everything else.
        let out = r.engine.handle(Inbound::Resync, r.now);
        assert!(topics_of(&out).contains(&"seedypod/u1/alert/camera_missing"));
        assert!(topics_of(&out).contains(&"seedypod/u1/system"));
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    #[test]
    fn shutdown_stops_the_pump_keeps_the_light_and_goes_offline() {
        let mut r = rig(
            vec![ActuatorId::Light, ActuatorId::Pump, ActuatorId::Dose1],
            false,
            "shutdown",
        );
        r.engine.boot(r.now);
        r.engine.handle(
            Inbound::ActuatorSet(ActuatorId::Light, on(Some(50.0), None)),
            r.now,
        );
        r.engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, None)), r.now);
        r.engine
            .handle(Inbound::ActuatorSet(ActuatorId::Dose1, on(None, Some(5))), r.now);
        r.now.advance(Duration::from_secs(3600));
        let out = r.engine.handle(Inbound::Shutdown, r.now);
        let w = r.world.lock().unwrap();
        assert_eq!(w.pump_level, 0.0);
        assert_eq!(w.dose_level[0], 0.0);
        assert_eq!(w.light_level, 50.0);
        drop(w);
        let last = out.last().unwrap();
        assert_eq!(
            (last.topic.as_str(), last.payload.as_str(), last.retain),
            ("seedypod/u1/availability", "offline", true)
        );
        assert_eq!(payload(&out, "seedypod/u1/actuator/pump/state")["on"], false);
        let saved = StateFile::new(&r.dir).load();
        assert!(
            (saved.light_hours_total - 1.0).abs() < 1e-6,
            "{}",
            saved.light_hours_total
        );
        assert_eq!(saved.light_level, 50.0);
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    #[test]
    fn now_advances_both_clocks_and_formats_ts() {
        let mut n = Now {
            instant: Instant::now(),
            epoch_s: 0,
        };
        n.advance(Duration::from_secs(90));
        assert_eq!(n.epoch_s, 90);
        assert_eq!(n.ts(), "1970-01-01T00:01:30Z");
        assert!(Now::real().epoch_s > 1_700_000_000);
        let o = Outbound::json("t", &serde_json::json!({"a": 1}), false);
        assert_eq!(o.payload, r#"{"a":1}"#);
    }
}
