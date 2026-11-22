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
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use hal_core::device::{now_epoch_s, rfc3339_from_epoch};
use hal_core::registry::Registry;
use hal_core::safety::{
    describe_brownout, is_dry_run, is_level_dry_run, median, resolve_dry_guard, Decision, DoseGuard,
    DoseLimits, Env, PumpGuard, PumpLimits, ResolvedGuard,
};
use hal_core::{
    topics, ActuatorCommand, ActuatorId, ActuatorState, Alert, AlertKind, BinarySensor, ButtonEvent,
    ButtonPress, CalibrationCommand, CalibrationResult, DeviceCommand, DeviceEntry, DeviceInventory,
    DeviceOp, DeviceResult, DeviceSource, DeviceStatus, DryGuard, PumpGuardCommand, PumpRun, PumpRunEnd,
    Quality, Reading, SensorId, SystemInfo, PUMP_RUN_MAX_SAMPLES, PUMP_RUN_SAMPLES_S,
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
    /// The app asks for dry-run guard settings (`pump/guard/set`).
    PumpGuard(PumpGuardCommand),
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
    /// What `advance` added short of a whole second, so steps of 100 ms still add up.
    pub frac: Duration,
}

impl Now {
    pub fn real() -> Self {
        Self {
            instant: Instant::now(),
            epoch_s: now_epoch_s(),
            frac: Duration::ZERO,
        }
    }
    pub fn advance(&mut self, d: Duration) {
        self.instant += d;
        let total = self.frac + d;
        self.epoch_s += total.as_secs();
        self.frac = Duration::from_nanos(u64::from(total.subsec_nanos()));
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
    /// The bounds (ms) a grace from the app is clamped into: hal.toml's
    /// `pump_dry_grace_min_ms` and `pump_dry_grace_max_ms`.
    pub dry_grace_bounds: (u64, u64),
    /// The bounds of the other guard settings from the app, likewise:
    /// `pump_dry_current_{min,max}_a`, `water_low_{min,max}_cm` and
    /// `water_low_hold_{min,max}_ms`.
    pub dry_current_bounds: (f64, f64),
    pub water_low_bounds: (f64, f64),
    pub water_low_hold_bounds: (u64, u64),
    /// Whether the app may change the dry-run guard's mode (`pump_dry_guard_app`).
    pub dry_guard_app: bool,
    /// Where the Pi's under-voltage flag is read for the brown-out guard
    /// (`config::PI_THROTTLED`); `None` doesn't read it (`--sim`, or
    /// `pump_brownout_pi = false`).
    pub pi_throttled: Option<std::path::PathBuf>,
}

/// A grace (or a hold) from the app, held to hal.toml's bounds.
fn clamp_grace(ms: u64, (min, max): (u64, u64)) -> u64 {
    ms.clamp(min, max.max(min))
}

/// A cutoff from the app, held to hal.toml's bounds.
fn clamp_cutoff(v: f64, (min, max): (f64, f64)) -> f64 {
    v.clamp(min, max.max(min))
}

/// To `places` decimals, for the pump run's samples.
fn round_to(v: f64, places: i32) -> f64 {
    let k = 10f64.powi(places);
    (v * k).round() / k
}

/// The pump run under way, for its `pump/run` message.
#[derive(Debug)]
struct RunTrace {
    started: Instant,
    started_at: String,
    /// `(ms since the start, A, V)` over the first [`PUMP_RUN_SAMPLES_S`].
    samples: Vec<(u64, Option<f64>, Option<f64>)>,
    /// Every current read this run, for the median past the grace.
    currents: Vec<(u64, f64)>,
}

impl RunTrace {
    fn new(now: Now) -> Self {
        Self {
            started: now.instant,
            started_at: now.ts(),
            samples: Vec::new(),
            currents: Vec::new(),
        }
    }

    fn record(&mut self, at: Instant, amps: Option<f64>, volts: Option<f64>) {
        let t = at.duration_since(self.started).as_millis() as u64;
        if t < PUMP_RUN_SAMPLES_S * 1000 && self.samples.len() < PUMP_RUN_MAX_SAMPLES {
            self.samples
                .push((t, amps.map(|a| round_to(a, 3)), volts.map(|v| round_to(v, 2))));
        }
        if let Some(a) = amps {
            self.currents.push((t, a));
        }
    }

    /// The median current read at or past `grace_ms`; `None` if there was none.
    fn wet_a(&self, grace_ms: u64) -> Option<f64> {
        let mut wet: Vec<f64> = self
            .currents
            .iter()
            .filter(|(t, _)| *t >= grace_ms)
            .map(|(_, a)| *a)
            .collect();
        median(&mut wet).map(|a| round_to(a, 3))
    }
}

const HOURS_PERSIST_EVERY: Duration = Duration::from_secs(900);

/// The fault latched when the pump driver refuses a stop. It waits for a person.
pub const STOP_FAILED: &str = "stop-failed";

/// How often the pump guard reads the pump current while the pump runs, and for
/// [`PUMP_WATCH_TAIL`] after it stops. The reads feed the guard in memory only:
/// telemetry keeps its own interval.
pub const PUMP_SAMPLE_EVERY: Duration = Duration::from_millis(100);
/// How long the fast reads go on after the pump stops.
pub const PUMP_WATCH_TAIL: Duration = Duration::from_secs(2);
/// How often the ranger is read for the guard while the pump runs. Its median of
/// pings holds the engine for ~0.3 s, so it can't keep up with the current.
const LEVEL_READ_EVERY: Duration = Duration::from_secs(1);
/// How often the Pi's under-voltage flag is read while the pump runs.
const PI_FLAG_READ_EVERY: Duration = Duration::from_secs(1);

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
    /// The dry-run guard's mode hal.toml asks for, and the one asked for now
    /// (hal.toml's, or the app's); what runs is resolved from it.
    dry_guard_toml: DryGuard,
    dry_guard_asked: DryGuard,
    /// The current guard's cutoff, hal.toml's or the app's, whatever the mode:
    /// the guard is only handed it when the mode in effect judges the current.
    dry_current_a: Option<f64>,
    /// The pump run under way, and the last one's message, republished on a resync.
    run: Option<RunTrace>,
    last_run: Option<PumpRun>,
    pump_since: String,
    pump_was_on: bool,
    /// Until when a current-guard trip holds before it may clear like a dry-run.
    dry_hold_until: Option<Instant>,
    /// Until when the pump guard's fast reads go on after the pump stopped.
    watch_until: Option<Instant>,
    /// When the guard's next fast read of the pump current is due.
    next_pump_sample: Option<Instant>,
    /// When the guard's next read of the ranger is due, while the pump runs.
    next_level_read: Option<Instant>,
    /// When the guard's next read of the Pi's under-voltage flag is due, while the pump runs.
    next_pi_flag_read: Option<Instant>,
    /// A stop the pump driver refused, retried until it takes.
    stop_pending: bool,
    doses: BTreeMap<ActuatorId, DoseGuard>,
    dose_since: BTreeMap<ActuatorId, String>,
    /// Where the light is going; a fade may still be on its way there.
    light_level: f64,
    light_since: String,
    /// Owns the light's driver, taken out of the registry.
    light: Option<LightFader>,
    /// The last light fault published; a failed fade step has no command to report it.
    light_fault: Option<&'static str>,
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
    captures: Captures,
}

/// Camera stills in flight and started, shared with the HTTP server. On the Pi
/// Zero's one core a capture starves the ranger's busy-wait on the echo, so a
/// reading lost while one ran says nothing about the water.
#[derive(Clone, Debug, Default)]
pub struct Captures(Arc<(AtomicUsize, AtomicU64)>);

/// Held for the length of one capture.
pub struct Capturing(Captures);

impl Captures {
    pub fn begin(&self) -> Capturing {
        self.0 .1.fetch_add(1, Ordering::SeqCst);
        self.0 .0.fetch_add(1, Ordering::SeqCst);
        Capturing(self.clone())
    }

    /// How many are running, and how many have started.
    pub(crate) fn mark(&self) -> (usize, u64) {
        (self.0 .0.load(Ordering::SeqCst), self.0 .1.load(Ordering::SeqCst))
    }

    /// Whether a capture ran at any point since `before`.
    fn since(&self, before: (usize, u64)) -> bool {
        let after = self.mark();
        before.0 > 0 || after.0 > 0 || after.1 != before.1
    }
}

impl Drop for Capturing {
    fn drop(&mut self) {
        self.0 .0 .0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Telemetry rounds the water alert looks back over: a minute at the default 10 s.
const WATER_WINDOW: usize = 6;
/// Rounds without a good reading in that window that raise it.
const WATER_RAISE_AT: usize = 3;

/// The `water_low` alert, debounced. A tank lifted out leaves the ranger on stray
/// echoes that alternate with no reading at all, and each raise is an alert row
/// in core. So a reading at the limit raises at once, a lost reading only when
/// lost ones pile up, and it clears after a whole window of good readings. A
/// reading lost during a camera capture is skipped rather than counted.
#[derive(Debug, Default)]
struct WaterAlert {
    /// Newest last; `true` for a round that read low or read nothing.
    rounds: VecDeque<bool>,
    active: bool,
    detail: String,
}

impl WaterAlert {
    /// A whole window of rounds that each read the water above the limit.
    fn all_good(&self) -> bool {
        self.rounds.len() == WATER_WINDOW && self.rounds.iter().all(|b| !*b)
    }

    fn observe(&mut self, distance: Option<f64>, low: f64, capturing: bool) {
        if distance.is_none() && capturing && !self.rounds.is_empty() {
            return;
        }
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
        let mut cfg = cfg;
        let mut system = system;
        let mut registry = registry;
        let light = registry
            .remove_actuator(ActuatorId::Light)
            .map(|driver| LightFader::new(driver, cfg.light_fade));
        let mut persisted = state_file.as_ref().map(StateFile::load).unwrap_or_default();
        // What the app set and hald kept, without waiting on core: each held to
        // hal.toml's bounds as they are now. hal.toml's values stand for the rest.
        if let Some(ms) = persisted.pump_dry_grace_ms {
            cfg.pump.dry_grace_ms = clamp_grace(ms, cfg.dry_grace_bounds);
        }
        let mut dry_current_a = cfg.pump.dry_current_a;
        if let Some(a) = persisted.pump_dry_current_a {
            dry_current_a = Some(clamp_cutoff(a, cfg.dry_current_bounds));
        }
        // A level interlock hal.toml turned off stays off.
        if let (Some(_), Some(cm)) = (cfg.pump.water_low_cm, persisted.water_low_cm) {
            cfg.pump.water_low_cm = Some(clamp_cutoff(cm, cfg.water_low_bounds));
        }
        if let Some(ms) = persisted.water_low_hold_ms {
            cfg.pump.water_low_hold_ms = clamp_grace(ms, cfg.water_low_hold_bounds);
        }
        let dry_guard_toml = cfg.pump.dry_guard;
        let current_monitor = system.caps.sensors.contains(&SensorId::PumpA);
        let water_low = cfg.pump.water_low_cm.is_some();
        let dry_guard_asked = match persisted.pump_dry_guard {
            Some(m) if m != dry_guard_toml && !cfg.dry_guard_app => {
                warn!(kept = %key(&m), "the app's dry-run guard mode is dropped: hal.toml locks it (pump_dry_guard_app = false)");
                persisted.pump_dry_guard = None;
                dry_guard_toml
            }
            Some(m)
                if m != dry_guard_toml
                    && resolve_dry_guard(m, dry_current_a, current_monitor, water_low).off =>
            {
                warn!(kept = %key(&m), "the app's dry-run guard mode is dropped: it would leave the pump with no dry-run guard");
                persisted.pump_dry_guard = None;
                dry_guard_toml
            }
            Some(m) => m,
            None => dry_guard_toml,
        };
        // The brown-out guard: the supply needs a pump monitor, the Pi's flag a readable file.
        let monitor = system.caps.sensors.contains(&SensorId::PumpV);
        let pi_flag = match cfg.pi_throttled.as_deref() {
            Some(p) if crate::pi_power::under_voltage(p).is_some() => true,
            Some(p) => {
                warn!(path = %p.display(), "the Pi's under-voltage flag can't be read; the brown-out guard goes without it");
                false
            }
            None => false,
        };
        let brownout = describe_brownout(cfg.pump.brownout_v, cfg.pump.brownout_ms, monitor, pi_flag);
        if cfg.pump.brownout_v.is_none() || !monitor {
            cfg.pump.brownout_v = None;
            warn!(why = %brownout, "pump brown-out guard");
        } else {
            info!(why = %brownout, "pump brown-out guard");
        }
        if !pi_flag {
            cfg.pi_throttled = None;
        }
        system.limits.pump_brownout_v = cfg.pump.brownout_v;
        system.limits.pump_brownout_ms = Some(cfg.pump.brownout_ms);
        system.limits.pump_brownout_pi = Some(pi_flag);
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
        let mut engine = Self {
            unit: system.unit_id.clone(),
            pump: PumpGuard::new(cfg.pump.clone()),
            dry_guard_toml,
            dry_guard_asked,
            dry_current_a,
            run: None,
            last_run: None,
            pump_since: String::new(),
            pump_was_on: false,
            dry_hold_until: None,
            watch_until: None,
            next_pump_sample: None,
            next_level_read: None,
            next_pi_flag_read: None,
            stop_pending: false,
            doses,
            dose_since: BTreeMap::new(),
            light_level: 0.0,
            light_since: persisted.light_since.clone().unwrap_or_default(),
            light,
            light_fault: None,
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
            captures: Captures::default(),
        };
        let guard = engine.apply_guard();
        if guard.warn {
            warn!(mode = %key(&guard.mode), why = %guard.why, "pump dry-run guard");
        } else {
            info!(mode = %key(&guard.mode), why = %guard.why, "pump dry-run guard");
        }
        engine
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

    /// The camera captures the HTTP server runs, so the water alert can tell a
    /// starved ranger from a silent one.
    pub fn with_captures(mut self, captures: Captures) -> Self {
        self.captures = captures;
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
        if let Some(run) = &self.last_run {
            out.push(Outbound::json(topics::pump_run(&self.unit), run, true));
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
                        self.dry_hold_until = None;
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
            Inbound::PumpGuard(cmd) => out.extend(self.set_guard(cmd, now)),
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
                let was_running = self.pump.is_running(now.instant);
                match self.pump.request(cmd, self.start_env(), now.instant) {
                    Ok(Decision::Run { level, deadline_in }) => {
                        info!(level, secs = deadline_in.as_secs(), "pump run accepted");
                        // A new run, not a longer one: a last run whose deadline passed
                        // unseen ends here.
                        if !was_running {
                            out.extend(self.end_run(PumpRunEnd::Deadline, now));
                            self.run = Some(RunTrace::new(now));
                        }
                        self.apply_pump(level, now);
                        self.persisted.last_pump_run = Some(now.ts());
                    }
                    Ok(Decision::Stop) => {
                        self.apply_pump(0.0, now);
                        out.extend(self.end_run(PumpRunEnd::Stop, now));
                    }
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
            // A dry-run clears itself once the water has read good for a whole window, as
            // `water_low` does: a trip on a lost read clears a round later, a real one once
            // the tank is filled. Over-temp and other latches still wait for a person.
            let held = self.dry_hold_until.is_some_and(|t| now.instant < t);
            if self.pump.fault().is_some_and(is_dry_run)
                && !held
                && !self.water.active
                && self.water.all_good()
            {
                self.pump.acknowledge();
                self.dry_hold_until = None;
                info!("pump dry-run cleared: the water has read good for a minute");
                out.extend(self.publish_actuator(ActuatorId::Pump, now));
            }
        }
        if self.watching(now.instant) {
            self.sample_for_guard(now);
        }

        let tripped = self.guard_tick(now, &mut out);
        for id in self.doses.keys().copied().collect::<Vec<_>>() {
            let stop = self.doses.get_mut(&id).and_then(|g| g.tick(now.epoch_s));
            if let Some(Decision::Stop) = stop {
                self.apply_dose(id, false, now);
                info!(?id, "dose complete");
                out.extend(self.publish_actuator(id, now));
            }
        }
        let light_fault = self.light.as_ref().and_then(LightFader::fault);
        if light_fault != self.light_fault {
            self.light_fault = light_fault;
            out.extend(self.publish_actuator(ActuatorId::Light, now));
        }
        // A trip between telemetry rounds raises its alert now, not a round later.
        if due || tripped {
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
        let mut has_ranger = false;
        let mut pcb = None;
        let mut pump_a = None;
        let mut pump_v = None;
        let mut readings = Vec::new();
        let before = self.captures.mark();
        for s in self.registry.sensors_mut() {
            has_ranger |= s.id() == SensorId::WaterDistance;
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
                        SensorId::PumpA => pump_a = Some(r.value),
                        SensorId::PumpV => pump_v = Some(r.value),
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
        self.env.water_suspect = distance.is_some() && trusted_distance.is_none();
        if has_ranger {
            self.env.water_fresh = true;
            self.next_level_read = Some(now.instant + LEVEL_READ_EVERY);
        }
        self.env.pcb_temp_c = pcb;
        self.env.pump_current_a = pump_a;
        self.env.supply_v = pump_v;
        if let Some(low) = self.cfg.pump.water_low_cm {
            let capturing = self.captures.since(before);
            self.water.observe(trusted_distance, low, capturing);
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

    /// Everything the guard needs, before a pump decision.
    fn refresh_env(&mut self, now: Now) {
        // One more try before calling it no reading: a start shouldn't be refused on one bad read.
        self.read_level(now, true);
        self.read_pcb_temp();
        self.read_pump_current();
        self.env.over_temp_signal = self.read_over_temp_signal();
    }

    /// The ranger, for the guard: the reading, whether it's suspect, and that it's new.
    fn read_level(&mut self, now: Now, retry: bool) {
        if let Some(s) = self.registry.sensor_mut(SensorId::WaterDistance) {
            let r = if retry {
                s.read().or_else(|_| s.read())
            } else {
                s.read()
            };
            let r = r.ok();
            self.env.water_distance_cm = r.as_ref().map(|r| r.value);
            self.env.water_suspect = r.is_some_and(|r| r.quality == Quality::Suspect);
            self.env.water_fresh = true;
        }
        self.next_level_read = Some(now.instant + LEVEL_READ_EVERY);
    }

    fn read_pcb_temp(&mut self) {
        if let Some(s) = self.registry.sensor_mut(SensorId::PcbTemp) {
            self.env.pcb_temp_c = s.read().ok().map(|r| r.value);
        }
    }

    /// A fresh read of the pump monitor: the facets' cache would hand the guard
    /// one number for 500 ms. The supply voltage comes from the same
    /// transaction, which the current's fresh read just cached. A failed read is
    /// `None`, which neither the current guard nor the brown-out guard trips on.
    fn read_pump_current(&mut self) {
        self.env.pump_current_a = self
            .registry
            .sensor_mut(SensorId::PumpA)
            .and_then(|s| s.read_fresh().ok())
            .map(|r| r.value);
        self.env.supply_v = self
            .registry
            .sensor_mut(SensorId::PumpV)
            .and_then(|s| s.read().ok())
            .map(|r| r.value);
    }

    /// The Pi's under-voltage flag, at most once a second while the pump runs.
    fn read_pi_flag(&mut self, now: Now) {
        let Some(path) = &self.cfg.pi_throttled else {
            return;
        };
        if self.next_pi_flag_read.is_some_and(|t| now.instant < t) {
            return;
        }
        self.env.under_voltage = crate::pi_power::under_voltage(path);
        self.next_pi_flag_read = Some(now.instant + PI_FLAG_READ_EVERY);
    }

    /// The pump is (or may still be) driven, or stopped less than [`PUMP_WATCH_TAIL`] ago.
    fn watching(&self, now: Instant) -> bool {
        self.pump_was_on || self.stop_pending || self.watch_until.is_some_and(|t| now < t)
    }

    /// When the guard's next fast read is due, while the pump runs and for a
    /// moment after it stops; `None` otherwise. The engine loop wakes for it.
    pub fn pump_watch_due(&self, now: Now) -> Option<Instant> {
        self.watching(now.instant)
            .then(|| self.next_pump_sample.unwrap_or(now.instant))
    }

    /// The guard's fast path, between ticks: read the pump current (and the ranger
    /// when its read is due) and let the guard judge them. It publishes nothing
    /// but a stop: readings go out with telemetry, on its own interval.
    pub fn pump_watch(&mut self, now: Now) -> Vec<Outbound> {
        let mut out = Vec::new();
        let due = self.next_pump_sample.map_or(true, |t| now.instant >= t);
        if !self.watching(now.instant) || !due {
            return out;
        }
        self.sample_for_guard(now);
        if self.guard_tick(now, &mut out) {
            self.refresh_alerts(now, false, &mut out);
        }
        out
    }

    fn sample_for_guard(&mut self, now: Now) {
        self.read_pump_current();
        if self.pump_was_on {
            if let Some(run) = &mut self.run {
                run.record(now.instant, self.env.pump_current_a, self.env.supply_v);
            }
        }
        let level_due = self.next_level_read.map_or(true, |t| now.instant >= t);
        if self.pump.is_running(now.instant) && level_due {
            self.read_level(now, false);
            self.read_pcb_temp();
        }
        if self.pump.is_running(now.instant) {
            self.read_pi_flag(now);
        }
        self.env.over_temp_signal = self.read_over_temp_signal();
        // Late reads don't bunch up: the next is a whole step from this one.
        self.next_pump_sample = Some(now.instant + PUMP_SAMPLE_EVERY);
    }

    /// One guard decision on the readings in hand; true when it latched a fault.
    fn guard_tick(&mut self, now: Now, out: &mut Vec<Outbound>) -> bool {
        if self.stop_pending {
            self.apply_pump(0.0, now);
            if !self.stop_pending {
                info!("pump stopped: the driver took the stop on a retry");
                out.extend(self.publish_actuator(ActuatorId::Pump, now));
            }
        }
        let env = self.env;
        self.env.water_fresh = false;
        // One read of the Pi's flag counts once, like a ranger reading.
        self.env.under_voltage = None;
        let Some(Decision::Stop) = self.pump.tick(env, now.instant) else {
            return false;
        };
        self.apply_pump(0.0, now);
        let tripped = match self.pump.fault() {
            Some(f) => {
                warn!(fault = f, "pump stopped by guard; latched until acknowledged");
                // A full tank says nothing about a pump pulling air: the window it
                // clears on starts at the trip, not before it.
                if is_dry_run(f) && !is_level_dry_run(f) {
                    self.dry_hold_until =
                        Some(now.instant + self.cfg.telemetry_interval * WATER_WINDOW as u32);
                }
                true
            }
            None => {
                info!("pump run complete");
                false
            }
        };
        let by = if tripped {
            PumpRunEnd::Fault
        } else {
            PumpRunEnd::Deadline
        };
        out.extend(self.end_run(by, now));
        out.extend(self.publish_actuator(ActuatorId::Pump, now));
        tripped
    }

    /// Whether the pump is commanded on (for `--pump-trace`).
    pub fn pump_on(&self, now: Now) -> bool {
        self.pump.is_running(now.instant)
    }

    /// One read of the pump monitor for `--pump-trace`: duty, then V, A and W, `None` where a read failed.
    pub fn pump_sample(&mut self) -> crate::pump_trace::Sample {
        let mut read = |id| {
            self.registry
                .sensor_mut(id)
                .and_then(|s| s.read().ok())
                .map(|r| r.value)
        };
        let (v, a, w) = (
            read(SensorId::PumpV),
            read(SensorId::PumpA),
            read(SensorId::PumpW),
        );
        crate::pump_trace::Sample {
            duty: self.pump.level(),
            v,
            a,
            w,
        }
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

    /// The pump driver is driven from here and nowhere else. A stop the driver
    /// refuses latches a fault and is retried on every guard decision until it
    /// takes: the pump may still be running, with nothing else to stop it.
    fn apply_pump(&mut self, level: f64, now: Now) {
        let res = self
            .registry
            .actuator_mut(ActuatorId::Pump)
            .map(|p| p.set_level(level));
        if let Some(Err(e)) = res {
            if level > 0.0 {
                error!(%e, "pump driver write failed");
            } else {
                if !self.stop_pending {
                    error!(%e, "pump driver refused a stop; retrying until it takes");
                }
                self.stop_pending = true;
                // It outranks a dry-run, which would clear itself with the pump still on.
                if !self.pump.fault().is_some_and(|f| f.starts_with(STOP_FAILED)) {
                    self.pump
                        .latch(&format!("{STOP_FAILED}: the pump driver refused a stop: {e}"));
                }
                return;
            }
        }
        if level == 0.0 {
            self.stop_pending = false;
        }
        let on = level > 0.0;
        if on != self.pump_was_on {
            self.pump_since = now.ts();
            self.pump_was_on = on;
            if !on {
                self.watch_until = Some(now.instant + PUMP_WATCH_TAIL);
            }
        }
        if on {
            self.next_pump_sample = Some(now.instant + PUMP_SAMPLE_EVERY);
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
                fault: self.light.as_ref().and_then(LightFader::fault).map(str::to_owned),
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

    // ---- the dry-run guard settings from the app ----------------------------

    /// `pump/guard/set`: whichever of the dry-run guard's settings the app sent.
    /// Numbers are held to hal.toml's bounds (logged when they had to be, never
    /// refused) and a mode is refused (logged) when hal.toml locks it or it would
    /// leave the pump unguarded. What's taken is kept in the state file and goes
    /// to the guard at once; `system` is republished whatever was taken.
    fn set_guard(&mut self, cmd: PumpGuardCommand, now: Now) -> Vec<Outbound> {
        if let Some(ms) = cmd.dry_grace_ms {
            self.set_dry_grace(ms);
        }
        if let Some(asked) = cmd.dry_current_a {
            let a = clamp_cutoff(asked, self.cfg.dry_current_bounds);
            let (min, max) = self.cfg.dry_current_bounds;
            if a != asked {
                warn!(
                    asked,
                    a, min, max, "pump dry-run cutoff held to hal.toml's bounds"
                );
            } else {
                info!(a, "pump dry-run cutoff set");
            }
            self.dry_current_a = Some(a);
            self.persisted.pump_dry_current_a = Some(a);
        }
        if let Some(asked) = cmd.water_low_cm {
            if self.cfg.pump.water_low_cm.is_none() {
                warn!(
                    asked,
                    "water_low_cm refused: hal.toml turns the level interlock off"
                );
            } else {
                let cm = clamp_cutoff(asked, self.cfg.water_low_bounds);
                let (min, max) = self.cfg.water_low_bounds;
                if cm != asked {
                    warn!(asked, cm, min, max, "water_low_cm held to hal.toml's bounds");
                } else {
                    info!(cm, "water_low_cm set");
                }
                self.cfg.pump.water_low_cm = Some(cm);
                self.pump.set_water_low_cm(cm);
                self.persisted.water_low_cm = Some(cm);
            }
        }
        if let Some(asked) = cmd.water_low_hold_ms {
            let ms = clamp_grace(asked, self.cfg.water_low_hold_bounds);
            let (min, max) = self.cfg.water_low_hold_bounds;
            if ms != asked {
                warn!(asked, ms, min, max, "water_low_hold_ms held to hal.toml's bounds");
            } else {
                info!(ms, "water_low_hold_ms set");
            }
            self.cfg.pump.water_low_hold_ms = ms;
            self.pump.set_water_low_hold_ms(ms);
            self.persisted.water_low_hold_ms = Some(ms);
        }
        if let Some(mode) = cmd.dry_guard {
            let toml = self.dry_guard_toml;
            if !self.cfg.dry_guard_app {
                if mode == toml {
                    self.dry_guard_asked = toml;
                    self.persisted.pump_dry_guard = None;
                } else {
                    warn!(asked = %key(&mode), hal_toml = %key(&toml), "pump dry-run guard mode refused: hal.toml locks it (pump_dry_guard_app = false)");
                }
            } else if mode != toml && self.resolve_guard(mode).off {
                warn!(asked = %key(&mode), "pump dry-run guard mode refused: it would leave the pump with no dry-run guard");
            } else {
                info!(asked = %key(&mode), "pump dry-run guard mode set");
                self.dry_guard_asked = mode;
                self.persisted.pump_dry_guard = Some(mode);
            }
        }
        let guard = self.apply_guard();
        if guard.warn {
            warn!(mode = %key(&guard.mode), why = %guard.why, "pump dry-run guard");
        } else {
            info!(mode = %key(&guard.mode), why = %guard.why, "pump dry-run guard");
        }
        self.save_state(now);
        self.update_snapshot(now);
        vec![Outbound::json(topics::system(&self.unit), &self.system, true)]
    }

    /// The current guard's spin-up grace, held to hal.toml's bounds.
    fn set_dry_grace(&mut self, asked: u64) {
        let ms = clamp_grace(asked, self.cfg.dry_grace_bounds);
        let (min, max) = self.cfg.dry_grace_bounds;
        if ms != asked {
            warn!(
                asked,
                ms, min, max, "pump dry-run grace held to hal.toml's bounds"
            );
        } else {
            info!(ms, "pump dry-run grace set");
        }
        self.cfg.pump.dry_grace_ms = ms;
        self.pump.set_dry_grace_ms(ms);
        self.persisted.pump_dry_grace_ms = Some(ms);
    }

    /// The guard `asked` would run as on this unit, with the cutoff and tank limit kept now.
    fn resolve_guard(&self, asked: DryGuard) -> ResolvedGuard {
        resolve_dry_guard(
            asked,
            self.dry_current_a,
            self.system.caps.sensors.contains(&SensorId::PumpA),
            self.cfg.pump.water_low_cm.is_some(),
        )
    }

    /// Resolve the mode asked for, hand the guard what it runs on, and report
    /// every setting in `system.limits`.
    fn apply_guard(&mut self) -> ResolvedGuard {
        let guard = self.resolve_guard(self.dry_guard_asked);
        let cutoff = self.dry_current_a.filter(|_| guard.mode != DryGuard::Level);
        self.cfg.pump.dry_guard = guard.mode;
        self.cfg.pump.dry_current_a = cutoff;
        self.pump.set_dry_guard(guard.mode, cutoff);
        let (cfg, l) = (&self.cfg, &mut self.system.limits);
        l.water_low_cm = cfg.pump.water_low_cm;
        l.pump_dry_guard = Some(guard.mode);
        l.pump_dry_guard_asked = Some(self.dry_guard_asked);
        l.pump_dry_guard_why = (guard.mode != self.dry_guard_asked).then(|| guard.why.clone());
        l.pump_dry_guard_app = Some(cfg.dry_guard_app);
        l.pump_dry_current_a = self.dry_current_a;
        l.pump_dry_current_min_a = Some(cfg.dry_current_bounds.0);
        l.pump_dry_current_max_a = Some(cfg.dry_current_bounds.1);
        l.pump_dry_grace_ms = Some(cfg.pump.dry_grace_ms);
        l.pump_dry_grace_min_ms = Some(cfg.dry_grace_bounds.0);
        l.pump_dry_grace_max_ms = Some(cfg.dry_grace_bounds.1);
        l.water_low_min_cm = Some(cfg.water_low_bounds.0);
        l.water_low_max_cm = Some(cfg.water_low_bounds.1);
        l.water_low_hold_ms = Some(cfg.pump.water_low_hold_ms);
        l.water_low_hold_min_ms = Some(cfg.water_low_hold_bounds.0);
        l.water_low_hold_max_ms = Some(cfg.water_low_hold_bounds.1);
        guard
    }

    // ---- the pump run's trace -------------------------------------------------

    /// Ends the run under way, if there is one: its `pump/run` message.
    fn end_run(&mut self, by: PumpRunEnd, now: Now) -> Option<Outbound> {
        let run = self.run.take()?;
        let level_pct = self
            .registry
            .sensor_mut(SensorId::WaterLevelPct)
            .and_then(|s| s.read().ok())
            .map(|r| r.value);
        let msg = PumpRun {
            started_at: run.started_at.clone(),
            ended_at: now.ts(),
            every_ms: PUMP_SAMPLE_EVERY.as_millis() as u64,
            wet_a: run.wet_a(self.cfg.pump.dry_grace_ms),
            samples: run.samples,
            ended_by: by,
            fault: self.pump.fault().map(str::to_owned),
            level_pct,
            level_cm: self.env.water_distance_cm,
        };
        let out = Outbound::json(topics::pump_run(&self.unit), &msg, true);
        self.last_run = Some(msg);
        Some(out)
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
            out.extend(self.end_run(PumpRunEnd::Stop, now));
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
                pump_max_duty: 100.0,
                water_low_cm: Some(16.0),
                ..Limits::default()
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
            dry_grace_bounds: (300, 5000),
            dry_current_bounds: (0.1, 3.0),
            water_low_bounds: (8.0, 19.0),
            water_low_hold_bounds: (0, 60_000),
            dry_guard_app: true,
            pi_throttled: None,
        }
    }

    struct Rig {
        engine: Engine,
        world: hal_sim::Shared,
        now: Now,
        snapshot: SharedSnapshot,
        dir: std::path::PathBuf,
        /// 100 ms steps taken by [`step`].
        steps: u64,
    }

    /// 100 ms as main.rs runs it: the guard's fast read, and a tick every second.
    fn step(r: &mut Rig) -> Vec<Outbound> {
        r.now.advance(PUMP_SAMPLE_EVERY);
        r.steps += 1;
        if r.steps % 10 == 0 {
            r.engine.tick(r.now)
        } else {
            r.engine.pump_watch(r.now)
        }
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
                frac: Duration::ZERO,
            },
            snapshot,
            dir,
            steps: 0,
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
            Inbound::ActuatorSet(ActuatorId::Pump, on(Some(150.0), Some(20))),
            r.now,
        );
        let st = payload(&out, "seedypod/u1/actuator/pump/state");
        assert_eq!(st["on"], true);
        assert_eq!(st["level"], 100.0, "clamped to max duty");
        assert_eq!(st["remainingS"], 20);
        assert_eq!(r.world.lock().unwrap().pump_level, 100.0);
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
        assert_eq!(r.world.lock().unwrap().pump_level, 100.0);
        // Drain the tank past the threshold; once it has stayed low for DRY_CONFIRM, the guard trips.
        r.world.lock().unwrap().water_distance_cm = 17.0;
        r.now.advance(Duration::from_secs(10));
        let first = r.engine.tick(r.now);
        assert_eq!(
            r.world.lock().unwrap().pump_level,
            100.0,
            "one low read is not enough"
        );
        assert_eq!(payload(&first, "seedypod/u1/alert/water_low")["active"], true);
        r.now.advance(hal_core::safety::DRY_CONFIRM);
        let out = r.engine.tick(r.now);
        assert_eq!(r.world.lock().unwrap().pump_level, 0.0);
        let st = payload(&out, "seedypod/u1/actuator/pump/state");
        assert_eq!(st["fault"], "dry-run: tank level read 17 cm, past 16 cm for 3 s");
        // The trip raises its alert at once, between telemetry rounds.
        assert_eq!(payload(&out, "seedypod/u1/alert/pump_fault")["active"], true);
        // Refill: still latched, start refused, and the refusal is visible in state.
        r.world.lock().unwrap().water_distance_cm = 7.0;
        let out = r
            .engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, None)), r.now);
        assert_eq!(payload(&out, "seedypod/u1/actuator/pump/state")["on"], false);
        assert_eq!(
            payload(&out, "seedypod/u1/actuator/pump/state")["fault"],
            "dry-run: tank level read 17 cm, past 16 cm for 3 s"
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

    #[test]
    fn a_dry_run_clears_itself_once_the_water_reads_good_for_a_window() {
        let mut r = rig(vec![ActuatorId::Pump], false, "dry-clears");
        r.engine.boot(r.now);
        r.engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, None)), r.now);
        r.world.lock().unwrap().water_distance_cm = 17.0;
        r.now.advance(Duration::from_secs(10));
        r.engine.tick(r.now);
        r.now.advance(hal_core::safety::DRY_CONFIRM);
        r.engine.tick(r.now);
        assert_eq!(
            r.engine.pump.fault(),
            Some("dry-run: tank level read 17 cm, past 16 cm for 3 s")
        );
        // Topped off: still latched until a whole window has read good, then clear without an ack.
        r.world.lock().unwrap().water_distance_cm = 7.0;
        let mut last = Vec::new();
        for i in 0..WATER_WINDOW {
            assert_eq!(
                r.engine.pump.fault(),
                Some("dry-run: tank level read 17 cm, past 16 cm for 3 s"),
                "round {i}"
            );
            r.now.advance(Duration::from_secs(10));
            last = r.engine.tick(r.now);
        }
        assert_eq!(r.engine.pump.fault(), None);
        assert!(payload(&last, "seedypod/u1/actuator/pump/state")["fault"].is_null());
        assert_eq!(payload(&last, "seedypod/u1/alert/pump_fault")["active"], false);
        let out = r
            .engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, Some(5))), r.now);
        assert_eq!(payload(&out, "seedypod/u1/actuator/pump/state")["on"], true);
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    /// A pump with the current guard on, and the INA219's three quantities unless `monitor` is false.
    fn current_rig(tag: &str, monitor: bool) -> Rig {
        let mut r = rig(vec![ActuatorId::Pump], false, tag);
        r.engine = current_engine(&r, current_cfg(), monitor);
        r
    }

    fn current_cfg() -> EngineConfig {
        let mut c = cfg(false);
        // The sim draws 0.5 A wet at 100 % and a quarter of that pulling air.
        c.pump.dry_current_a = Some(0.15);
        c
    }

    /// An engine over the rig's world and state dir, as after a restart.
    fn current_engine(r: &Rig, c: EngineConfig, monitor: bool) -> Engine {
        let mut sys = system(vec![ActuatorId::Pump]);
        let mut registry = Registry::default();
        let mut ids = sys.caps.sensors.clone();
        if monitor {
            ids.extend([SensorId::PumpV, SensorId::PumpA, SensorId::PumpW]);
        }
        for id in &ids {
            registry.add_sensor(Box::new(hal_sim::SimSensor::new(*id, r.world.clone())));
        }
        registry.add_actuator(Box::new(hal_sim::SimActuator::new(
            ActuatorId::Pump,
            r.world.clone(),
        )));
        sys.caps.sensors = ids;
        Engine::new(
            sys,
            c,
            registry,
            None,
            Some(StateFile::new(&r.dir)),
            r.snapshot.clone(),
        )
    }

    fn grace(ms: u64) -> Inbound {
        Inbound::PumpGuard(PumpGuardCommand {
            dry_grace_ms: Some(ms),
            ..Default::default()
        })
    }

    #[test]
    fn the_app_sets_the_grace_within_hal_toml_bounds_and_it_survives_a_restart() {
        let mut r = current_rig("grace", true);
        let out = r.engine.boot(r.now);
        let limits = &payload(&out, "seedypod/u1/system")["limits"];
        assert_eq!(limits["pumpDryGuard"], "both");
        assert_eq!(
            (
                &limits["pumpDryGraceMs"],
                &limits["pumpDryGraceMinMs"],
                &limits["pumpDryGraceMaxMs"]
            ),
            (
                &serde_json::json!(3000),
                &serde_json::json!(300),
                &serde_json::json!(5000)
            )
        );
        // In bounds it's taken as asked; out of them, held to the nearer bound, never refused.
        for (asked, got) in [(1200, 1200), (10, 300), (60_000, 5000), (2500, 2500)] {
            let out = r.engine.handle(grace(asked), r.now);
            let sys = payload(&out, "seedypod/u1/system");
            assert_eq!(sys["limits"]["pumpDryGraceMs"], got, "asked {asked}");
            assert!(out.iter().all(|o| o.topic != "seedypod/u1/system" || o.retain));
            assert_eq!(r.engine.pump.limits().dry_grace_ms, got);
        }
        let snap = r.snapshot.read().unwrap().system.clone().unwrap();
        assert_eq!(snap.limits.pump_dry_grace_ms, Some(2500));
        // The guard goes by it: a dry intake trips 0.3 s past a 2.5 s grace.
        r.world.lock().unwrap().intake_dry = true;
        r.engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, Some(60))), r.now);
        let mut tripped = None;
        for n in 1..=40 {
            step(&mut r);
            if r.world.lock().unwrap().pump_level == 0.0 {
                tripped = Some(n * 100);
                break;
            }
        }
        assert_eq!(tripped, Some(2800));
        // Restarted, hald uses the grace it kept, without waiting on core.
        let again = current_engine(&r, current_cfg(), true);
        assert_eq!(again.pump.limits().dry_grace_ms, 2500);
        assert_eq!(again.system.limits.pump_dry_grace_ms, Some(2500));
        // hal.toml's bounds outrank what was kept: narrowed, the kept grace is held to them.
        let mut narrow = current_cfg();
        narrow.dry_grace_bounds = (300, 2000);
        let held = current_engine(&r, narrow, true);
        assert_eq!(held.pump.limits().dry_grace_ms, 2000);
        assert_eq!(held.system.limits.pump_dry_grace_max_ms, Some(2000));
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    /// A `pump/guard/set` as it comes off the wire.
    fn guard_cmd(json: &str) -> Inbound {
        Inbound::PumpGuard(serde_json::from_str(json).unwrap_or_else(|e| panic!("{json}: {e}")))
    }

    /// The retained `system` limits a guard command republished.
    fn limits_after(r: &mut Rig, json: &str) -> serde_json::Value {
        let out = r.engine.handle(guard_cmd(json), r.now);
        let sys: Vec<&Outbound> = out.iter().filter(|o| o.topic == "seedypod/u1/system").collect();
        assert_eq!(sys.len(), 1, "{json}: one system publish");
        assert!(sys[0].retain, "{json}: retained");
        payload(&out, "seedypod/u1/system")["limits"].clone()
    }

    #[test]
    fn the_app_sets_the_cutoff_tank_limit_and_hold_within_hal_toml_bounds_and_they_survive_a_restart() {
        let mut r = current_rig("guard-set", true);
        let out = r.engine.boot(r.now);
        let l = &payload(&out, "seedypod/u1/system")["limits"];
        // Nothing kept: hal.toml's, and the bounds the app is held to.
        for (k, v) in [
            ("pumpDryCurrentA", 0.15),
            ("pumpDryCurrentMinA", 0.1),
            ("pumpDryCurrentMaxA", 3.0),
            ("waterLowCm", 16.0),
            ("waterLowMinCm", 8.0),
            ("waterLowMaxCm", 19.0),
            ("waterLowHoldMs", 0.0),
            ("waterLowHoldMinMs", 0.0),
            ("waterLowHoldMaxMs", 60_000.0),
        ] {
            assert_eq!(l[k].as_f64(), Some(v), "{k}");
        }
        // In bounds, taken as asked; out of them, held to the nearer bound, never refused.
        for (json, k, got) in [
            (r#"{"dryCurrentA":0.8}"#, "pumpDryCurrentA", 0.8),
            (r#"{"dryCurrentA":0.01}"#, "pumpDryCurrentA", 0.1),
            (r#"{"dryCurrentA":9}"#, "pumpDryCurrentA", 3.0),
            (r#"{"waterLowCm":12.5}"#, "waterLowCm", 12.5),
            (r#"{"waterLowCm":2}"#, "waterLowCm", 8.0),
            (r#"{"waterLowCm":40}"#, "waterLowCm", 19.0),
            (r#"{"waterLowHoldMs":4000}"#, "waterLowHoldMs", 4000.0),
            (r#"{"waterLowHoldMs":600000}"#, "waterLowHoldMs", 60_000.0),
        ] {
            assert_eq!(limits_after(&mut r, json)[k].as_f64(), Some(got), "{json}");
        }
        // Several at once, and the guard goes by them straight away.
        let l = limits_after(
            &mut r,
            r#"{"dryCurrentA":0.4,"waterLowCm":15,"waterLowHoldMs":2500,"dryGraceMs":2000}"#,
        );
        assert_eq!(
            (
                l["pumpDryCurrentA"].as_f64(),
                l["waterLowCm"].as_f64(),
                l["waterLowHoldMs"].as_u64(),
                l["pumpDryGraceMs"].as_u64()
            ),
            (Some(0.4), Some(15.0), Some(2500), Some(2000))
        );
        let g = r.engine.pump.limits().clone();
        assert_eq!(
            (
                g.dry_current_a,
                g.water_low_cm,
                g.water_low_hold_ms,
                g.dry_grace_ms
            ),
            (Some(0.4), Some(15.0), 2500, 2000)
        );
        let snap = r.snapshot.read().unwrap().system.clone().unwrap();
        assert_eq!(snap.limits.pump_dry_current_a, Some(0.4));
        let kept = StateFile::new(&r.dir).load();
        assert_eq!(
            (
                kept.pump_dry_current_a,
                kept.water_low_cm,
                kept.water_low_hold_ms,
                kept.pump_dry_grace_ms
            ),
            (Some(0.4), Some(15.0), Some(2500), Some(2000))
        );
        // Restarted, hald uses what it kept, without waiting on core.
        let again = current_engine(&r, current_cfg(), true);
        let g = again.pump.limits();
        assert_eq!(
            (g.dry_current_a, g.water_low_cm, g.water_low_hold_ms),
            (Some(0.4), Some(15.0), 2500)
        );
        assert_eq!(again.system.limits.pump_dry_current_a, Some(0.4));
        assert_eq!(again.system.limits.water_low_cm, Some(15.0));
        assert_eq!(again.system.limits.water_low_hold_ms, Some(2500));
        // hal.toml's bounds outrank what was kept: narrowed, each is held to them.
        let mut narrow = current_cfg();
        narrow.dry_current_bounds = (0.5, 1.0);
        narrow.water_low_bounds = (16.0, 18.0);
        narrow.water_low_hold_bounds = (0, 1000);
        let held = current_engine(&r, narrow, true);
        let g = held.pump.limits();
        assert_eq!(
            (g.dry_current_a, g.water_low_cm, g.water_low_hold_ms),
            (Some(0.5), Some(16.0), 1000)
        );
        let l = &held.system.limits;
        assert_eq!(
            (
                l.pump_dry_current_min_a,
                l.water_low_max_cm,
                l.water_low_hold_max_ms
            ),
            (Some(0.5), Some(18.0), Some(1000))
        );
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    #[test]
    fn the_app_picks_the_mode_and_system_says_what_was_asked_and_why_it_differs() {
        let mut r = current_rig("guard-mode", true);
        r.engine.boot(r.now);
        let l = limits_after(&mut r, r#"{"dryGuard":"current"}"#);
        assert_eq!(
            (&l["pumpDryGuard"], &l["pumpDryGuardAsked"]),
            (&"current".into(), &"current".into())
        );
        assert!(!l.as_object().unwrap().contains_key("pumpDryGuardWhy"));
        assert_eq!(l["pumpDryGuardApp"], true);
        assert_eq!(r.engine.pump.limits().dry_guard, DryGuard::Current);
        assert_eq!(r.engine.pump.limits().dry_current_a, Some(0.15));
        // Current ignores the tank: a low one neither refuses a start nor stops the
        // run, and waterLowCm is still reported, for core's warning.
        r.world.lock().unwrap().water_distance_cm = 17.0;
        let out = r
            .engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, Some(30))), r.now);
        assert_eq!(payload(&out, "seedypod/u1/actuator/pump/state")["on"], true);
        // Past a telemetry round, which judges the water alert.
        for _ in 0..120 {
            step(&mut r);
        }
        assert_eq!(r.world.lock().unwrap().pump_level, 100.0);
        assert_eq!(r.engine.system.limits.water_low_cm, Some(16.0));
        assert!(r.engine.water.active, "the water alert still warns");
        r.engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, off()), r.now);
        // Level ignores the current: the guard is handed no cutoff, though it's still reported.
        let l = limits_after(&mut r, r#"{"dryGuard":"level"}"#);
        assert_eq!(l["pumpDryGuard"], "level");
        assert_eq!(l["pumpDryCurrentA"].as_f64(), Some(0.15));
        assert_eq!(r.engine.pump.limits().dry_current_a, None);
        // Kept for the next boot.
        let again = current_engine(&r, current_cfg(), true);
        assert_eq!(again.system.limits.pump_dry_guard, Some(DryGuard::Level));
        assert_eq!(again.system.limits.pump_dry_guard_asked, Some(DryGuard::Level));
        // Asked for current on a unit without a monitor: the tank level, and why.
        let mut bare = current_engine(&r, current_cfg(), false);
        let out = bare.handle(guard_cmd(r#"{"dryGuard":"current"}"#), r.now);
        let l = &payload(&out, "seedypod/u1/system")["limits"];
        assert_eq!(
            (&l["pumpDryGuard"], &l["pumpDryGuardAsked"]),
            (&"level".into(), &"current".into())
        );
        assert_eq!(
            l["pumpDryGuardWhy"],
            "pump_dry_guard = \"current\" needs a pump monitor (ina219): falling back to the tank level"
        );
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    #[test]
    fn with_the_mode_locked_the_app_keeps_hal_tomls_and_a_kept_one_is_dropped() {
        let mut r = current_rig("guard-lock", true);
        r.engine.boot(r.now);
        // Unlocked, the app's mode is kept...
        limits_after(&mut r, r#"{"dryGuard":"current"}"#);
        assert_eq!(
            StateFile::new(&r.dir).load().pump_dry_guard,
            Some(DryGuard::Current)
        );
        // ...until hal.toml locks it: then hal.toml's runs, and the kept one goes.
        let mut c = current_cfg();
        c.dry_guard_app = false;
        r.engine = current_engine(&r, c, true);
        assert_eq!(r.engine.system.limits.pump_dry_guard, Some(DryGuard::Both));
        assert_eq!(r.engine.system.limits.pump_dry_guard_app, Some(false));
        assert_eq!(r.engine.persisted.pump_dry_guard, None);
        // A mode other than hal.toml's is refused; the rest of the payload is still taken.
        let l = limits_after(&mut r, r#"{"dryGuard":"current","dryCurrentA":0.5}"#);
        assert_eq!(
            (&l["pumpDryGuard"], &l["pumpDryGuardAsked"]),
            (&"both".into(), &"both".into())
        );
        assert_eq!(l["pumpDryGuardApp"], false);
        assert_eq!(l["pumpDryCurrentA"].as_f64(), Some(0.5));
        assert_eq!(r.engine.pump.limits().dry_guard, DryGuard::Both);
        assert_eq!(StateFile::new(&r.dir).load().pump_dry_guard, None);
        // hal.toml's own is no change.
        let l = limits_after(&mut r, r#"{"dryGuard":"both"}"#);
        assert_eq!(l["pumpDryGuard"], "both");
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    #[test]
    fn nothing_from_the_app_leaves_the_pump_without_a_dry_run_guard() {
        // hal.toml turned the level interlock off: the current guard is all there is.
        let mut r = current_rig("guard-never-off", true);
        let mut c = current_cfg();
        c.pump.water_low_cm = None;
        r.engine = current_engine(&r, c.clone(), true);
        r.engine.boot(r.now);
        assert_eq!(r.engine.system.limits.pump_dry_guard, Some(DryGuard::Both));
        // Level would guard nothing: refused.
        let l = limits_after(&mut r, r#"{"dryGuard":"level"}"#);
        assert_eq!(
            (&l["pumpDryGuard"], &l["pumpDryGuardAsked"]),
            (&"both".into(), &"both".into())
        );
        assert_eq!(r.engine.pump.limits().dry_current_a, Some(0.15));
        // And the app can't turn the interlock hal.toml turned off back on.
        let l = limits_after(&mut r, r#"{"waterLowCm":12}"#);
        assert!(l["waterLowCm"].is_null());
        assert_eq!(r.engine.pump.limits().water_low_cm, None);
        assert_eq!(StateFile::new(&r.dir).load().water_low_cm, None);
        // Current still guards: taken.
        assert_eq!(
            limits_after(&mut r, r#"{"dryGuard":"current"}"#)["pumpDryGuard"],
            "current"
        );
        // A kept mode that would guard nothing on this hal.toml is dropped at boot.
        StateFile::new(&r.dir)
            .save(&Persisted {
                pump_dry_guard: Some(DryGuard::Level),
                ..Persisted::default()
            })
            .unwrap();
        let e = current_engine(&r, c, true);
        assert_eq!(e.system.limits.pump_dry_guard, Some(DryGuard::Both));
        assert_eq!(e.persisted.pump_dry_guard, None);
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    #[test]
    fn a_hold_from_the_app_lets_a_noisy_ranger_read_low_without_stopping_the_pump() {
        let mut r = rig(vec![ActuatorId::Pump], false, "level-hold");
        r.engine.boot(r.now);
        limits_after(&mut r, r#"{"waterLowHoldMs":5000}"#);
        r.engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, None)), r.now);
        for _ in 0..25 {
            step(&mut r);
        }
        // A low reading every other second, a good one between: it runs on.
        for n in 0..200 {
            r.world.lock().unwrap().water_distance_cm = if (n / 10) % 2 == 0 { 17.0 } else { 7.0 };
            step(&mut r);
        }
        assert_eq!(r.world.lock().unwrap().pump_level, 100.0);
        assert_eq!(r.engine.pump.fault(), None);
        // Low for the whole hold: it stops, five readings on from the first low one.
        r.world.lock().unwrap().water_distance_cm = 7.0;
        for _ in 0..20 {
            step(&mut r);
        }
        r.world.lock().unwrap().water_distance_cm = 17.0;
        let (n, out) = (1..=100)
            .find_map(|n| {
                let out = step(&mut r);
                (r.world.lock().unwrap().pump_level == 0.0).then_some((n, out))
            })
            .expect("never tripped");
        assert!(
            (50..=60).contains(&n),
            "tripped {n} steps after the tank went low"
        );
        let fault = payload(&out, "seedypod/u1/actuator/pump/state")["fault"].clone();
        let held: f64 = fault
            .as_str()
            .and_then(|f| f.strip_prefix("dry-run: tank level read 17 cm, past 16 cm for "))
            .and_then(|f| f.strip_suffix(" s"))
            .and_then(|s| s.parse().ok())
            .unwrap_or_else(|| panic!("{fault}"));
        assert!((5.0..6.0).contains(&held), "{fault}");
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    // ---- the pump run's trace (pump/run) -------------------------------------

    /// The `pump/run` publish among `out`, checked retained.
    fn run_msg(out: &[Outbound]) -> serde_json::Value {
        let runs: Vec<&Outbound> = out.iter().filter(|o| o.topic == "seedypod/u1/pump/run").collect();
        assert_eq!(runs.len(), 1, "one pump/run in {:?}", topics_of(out));
        assert!(runs[0].retain);
        serde_json::from_str(&runs[0].payload).unwrap()
    }

    fn no_run_msg(out: &[Outbound]) -> bool {
        out.iter().all(|o| o.topic != "seedypod/u1/pump/run")
    }

    #[test]
    fn a_run_that_ends_on_its_deadline_publishes_its_first_twelve_seconds_and_wet_current() {
        let mut r = current_rig("run-deadline", true);
        r.engine.boot(r.now);
        let start = r.now.ts();
        let out = r
            .engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, Some(15))), r.now);
        assert!(no_run_msg(&out));
        let mut stopped = None;
        for n in 1..=300 {
            let out = step(&mut r);
            if n == 30 {
                // A longer run asked for mid-run is the same run.
                let more = r
                    .engine
                    .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, Some(15))), r.now);
                assert!(no_run_msg(&more));
            }
            if r.world.lock().unwrap().pump_level == 0.0 {
                stopped = Some((n, out));
                break;
            }
            assert!(no_run_msg(&out), "{n}");
        }
        let (n, out) = stopped.expect("the run ends");
        assert_eq!(n, 180, "3 s, then 15 s more");
        let run = run_msg(&out);
        assert_eq!(run["startedAt"], start.as_str());
        assert_eq!(run["endedAt"], r.now.ts().as_str());
        assert_ne!(run["startedAt"], run["endedAt"]);
        assert_eq!(run["everyMs"], 100);
        assert_eq!(run["endedBy"], "deadline");
        assert!(run["fault"].is_null());
        let samples = run["samples"].as_array().unwrap();
        // Every 100 ms from the first read, short of 12 s.
        assert_eq!(samples.len(), 119);
        assert!(samples.len() <= hal_core::PUMP_RUN_MAX_SAMPLES);
        assert_eq!(samples[0], serde_json::json!([100, 0.5, 12.1]));
        assert_eq!(samples[118][0], 11_900);
        assert!(samples.iter().all(|s| s[1] == 0.5 && s[2] == 12.1));
        assert_eq!(run["wetA"], 0.5);
        assert_eq!(run["levelCm"], 7.0);
        assert!(run["levelPct"].as_f64().is_some_and(|p| p > 80.0));
        // Republished on a resync, as every retained topic is.
        let again = r.engine.handle(Inbound::Resync, r.now);
        assert_eq!(run_msg(&again), run);
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    #[test]
    fn a_run_stopped_by_hand_or_a_fault_or_a_shutdown_says_how_it_ended() {
        let mut r = current_rig("run-ends", true);
        r.engine.boot(r.now);
        // Stopped inside the grace: no wet current to speak of.
        r.engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, Some(60))), r.now);
        for _ in 0..20 {
            step(&mut r);
        }
        let out = r
            .engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, off()), r.now);
        let run = run_msg(&out);
        assert_eq!(run["endedBy"], "stop");
        assert!(run["fault"].is_null() && run["wetA"].is_null());
        assert_eq!(run["samples"].as_array().unwrap().len(), 20);
        // A stop with nothing running publishes nothing.
        assert!(no_run_msg(
            &r.engine
                .handle(Inbound::ActuatorSet(ActuatorId::Pump, off()), r.now)
        ));
        // Wet for 5 s, then pulling air: the current guard ends it.
        r.engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, Some(60))), r.now);
        for _ in 0..50 {
            assert!(no_run_msg(&step(&mut r)));
        }
        r.world.lock().unwrap().intake_dry = true;
        let (_, out) = run_until_stopped(&mut r, 20).expect("the current guard trips");
        let run = run_msg(&out);
        assert_eq!(run["endedBy"], "fault");
        assert!(run["fault"].as_str().unwrap().contains("pulling air"));
        // The median past the grace: 21 wet reads and 4 dry ones, not their mean.
        let samples = run["samples"].as_array().unwrap();
        assert_eq!(samples.len(), 54);
        assert_eq!(samples[53][1], 0.12);
        assert_eq!(run["wetA"], 0.5);
        // A refused start traces nothing.
        assert!(no_run_msg(&r.engine.handle(
            Inbound::ActuatorSet(ActuatorId::Pump, on(None, Some(60))),
            r.now
        )));
        r.engine.handle(Inbound::AlertAck(AlertKind::PumpFault), r.now);
        r.world.lock().unwrap().intake_dry = false;
        r.engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, Some(60))), r.now);
        step(&mut r);
        let out = r.engine.shutdown(r.now);
        assert_eq!(run_msg(&out)["endedBy"], "stop");
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    #[test]
    fn without_a_pump_monitor_a_run_traces_gaps_and_no_wet_current() {
        let mut r = current_rig("run-bare", false);
        r.engine.boot(r.now);
        r.engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, Some(5))), r.now);
        let (_, out) = run_until_stopped(&mut r, 60).expect("the run ends");
        let run = run_msg(&out);
        assert_eq!(run["endedBy"], "deadline");
        assert!(run["wetA"].is_null());
        let samples = run["samples"].as_array().unwrap();
        assert!(!samples.is_empty());
        assert!(samples.iter().all(|s| s[1].is_null() && s[2].is_null()));
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    #[test]
    fn current_mode_runs_on_a_low_tank_and_reports_itself() {
        let mut r = rig(vec![ActuatorId::Pump], false, "mode-current");
        let mut c = current_cfg();
        c.pump.dry_guard = DryGuard::Current;
        r.engine = current_engine(&r, c, true);
        r.world.lock().unwrap().water_distance_cm = 17.0;
        let out = r.engine.boot(r.now);
        assert_eq!(
            payload(&out, "seedypod/u1/system")["limits"]["pumpDryGuard"],
            "current"
        );
        let out = r
            .engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, Some(30))), r.now);
        assert_eq!(payload(&out, "seedypod/u1/actuator/pump/state")["on"], true);
        for _ in 0..50 {
            step(&mut r);
        }
        assert_eq!(
            r.world.lock().unwrap().pump_level,
            100.0,
            "the tank doesn't stop it"
        );
        // Asked for current with no monitor, it runs on the tank level instead.
        let mut c = current_cfg();
        c.pump.dry_guard = DryGuard::Current;
        let fallback = current_engine(&r, c, false);
        assert_eq!(fallback.system.limits.pump_dry_guard, Some(DryGuard::Level));
        assert_eq!(fallback.pump.limits().dry_current_a, None);
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    #[test]
    fn a_pump_pulling_air_stops_on_its_current_names_it_and_clears_like_a_dry_run() {
        let mut r = current_rig("air", true);
        r.engine.boot(r.now);
        r.engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, None)), r.now);
        // Wet, it runs on.
        for _ in 0..120 {
            assert!(!topics_of(&step(&mut r)).contains(&"seedypod/u1/actuator/pump/state"));
        }
        assert_eq!(r.world.lock().unwrap().pump_level, 100.0);
        // The intake comes out of the water: the tank still reads full, the current falls.
        r.world.lock().unwrap().intake_dry = true;
        let mut tripped = None;
        for n in 1..=50 {
            let out = step(&mut r);
            if r.world.lock().unwrap().pump_level == 0.0 {
                tripped = Some((n * 100, out));
                break;
            }
        }
        let (after, out) = tripped.expect("the current guard never tripped");
        // The first low read comes 100 ms in, then 0.3 s of them.
        assert_eq!(after, 400, "tripped {after} ms after the intake went dry");
        let why = "dry-run: pump drew 0.12 A, below 0.15 A for 0.3 s: it's pulling air";
        assert_eq!(payload(&out, "seedypod/u1/actuator/pump/state")["fault"], why);
        let alert = payload(&out, "seedypod/u1/alert/pump_fault");
        assert_eq!(alert["active"], true);
        assert_eq!(alert["detail"], format!("pump: {why}"));
        assert!(!r.engine.water.active, "the tank reads full throughout");
        // Same latch as a level dry-run: refused until the water has read good for a
        // window, though here the window starts at the trip, as the tank was full all along.
        let out = r
            .engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, None)), r.now);
        assert_eq!(payload(&out, "seedypod/u1/actuator/pump/state")["on"], false);
        let mut cleared = None;
        for s in 1..=(2 * WATER_WINDOW as u64 * 10) {
            r.now.advance(Duration::from_secs(1));
            r.engine.tick(r.now);
            if r.engine.pump.fault().is_none() {
                cleared = Some(s);
                break;
            }
        }
        let cleared = cleared.expect("the dry-run never cleared");
        assert!((60..=70).contains(&cleared), "cleared {cleared} s after the trip");
        assert_eq!(r.engine.dry_hold_until, None);
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    /// Runs the rig in 100 ms steps until the pump stops: how long after the start, and the last publishes.
    fn run_until_stopped(r: &mut Rig, steps: u64) -> Option<(u64, Vec<Outbound>)> {
        (1..=steps).find_map(|n| {
            let out = step(r);
            (r.world.lock().unwrap().pump_level == 0.0).then(|| (n * 100, out))
        })
    }

    #[test]
    fn a_sagging_supply_stops_the_pump_past_the_grace_and_waits_for_a_person() {
        let mut r = current_rig("brownout", true);
        let out = r.engine.boot(r.now);
        let limits = &payload(&out, "seedypod/u1/system")["limits"];
        assert_eq!(limits["pumpBrownoutV"], 10.8);
        assert_eq!(limits["pumpBrownoutMs"], 300);
        assert_eq!(limits["pumpBrownoutPi"], false);
        // A healthy run sees 12.1 V and runs on.
        r.engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, Some(5))), r.now);
        assert_eq!(r.engine.env.supply_v, Some(12.3), "read idle, before the start");
        step(&mut r);
        assert_eq!(
            r.engine.env.supply_v,
            Some(12.1),
            "read with the current, every 100 ms"
        );
        let (ended, _) = run_until_stopped(&mut r, 60).expect("the run ends");
        assert_eq!(ended + 100, 5000, "on its deadline");
        assert_eq!(r.engine.pump.fault(), None);
        // The supply sags under the pump: past the 3 s grace, 0.3 s of it stops the pump.
        r.world.lock().unwrap().supply_sag_v = Some(10.2);
        r.engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, Some(60))), r.now);
        let (after, out) = run_until_stopped(&mut r, 50).expect("the brown-out guard never tripped");
        assert_eq!(after, 3300);
        let why = "brown-out: supply fell to 10.2 V for 0.3 s";
        assert_eq!(payload(&out, "seedypod/u1/actuator/pump/state")["fault"], why);
        assert_eq!(
            payload(&out, "seedypod/u1/alert/pump_fault")["detail"],
            format!("pump: {why}")
        );
        // Unlike a dry-run it doesn't clear itself on a full tank: it waits for an acknowledge.
        r.world.lock().unwrap().supply_sag_v = None;
        for _ in 0..(2 * WATER_WINDOW as u64 * 10) {
            r.now.advance(Duration::from_secs(1));
            r.engine.tick(r.now);
        }
        assert_eq!(r.engine.pump.fault(), Some(why));
        r.engine.handle(Inbound::AlertAck(AlertKind::PumpFault), r.now);
        let out = r
            .engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, Some(30))), r.now);
        assert_eq!(payload(&out, "seedypod/u1/actuator/pump/state")["on"], true);
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    #[test]
    fn without_a_pump_monitor_the_supply_isnt_judged_and_isnt_reported() {
        let r = current_rig("brownout-bare", false);
        assert_eq!(r.engine.pump.limits().brownout_v, None);
        assert_eq!(r.engine.system.limits.pump_brownout_v, None);
        assert_eq!(r.engine.system.limits.pump_brownout_ms, Some(300));
        let mut c = current_cfg();
        c.pump.brownout_v = None;
        let off = current_engine(&r, c, true);
        assert_eq!(off.system.limits.pump_brownout_v, None);
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    #[test]
    fn the_pis_under_voltage_flag_stops_the_pump_when_it_can_be_read() {
        let r0 = current_rig("pi-flag", true);
        let flag = r0.dir.join("get_throttled");
        std::fs::create_dir_all(&r0.dir).unwrap();
        std::fs::write(&flag, "0\n").unwrap();
        let mut c = current_cfg();
        c.pi_throttled = Some(flag.clone());
        let mut r = Rig {
            engine: current_engine(&r0, c.clone(), true),
            ..r0
        };
        assert_eq!(r.engine.system.limits.pump_brownout_pi, Some(true));
        r.engine.boot(r.now);
        r.engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, Some(60))), r.now);
        // Clear, it runs on.
        for _ in 0..30 {
            step(&mut r);
        }
        assert_eq!(r.world.lock().unwrap().pump_level, 100.0);
        std::fs::write(&flag, "50005\n").unwrap();
        let (after, out) = run_until_stopped(&mut r, 50).expect("the Pi's flag never tripped it");
        // Read once a second: the second read in a row that says so trips it.
        assert!(
            (1000..=2100).contains(&after),
            "tripped {after} ms after the flag went up"
        );
        let fault = payload(&out, "seedypod/u1/actuator/pump/state")["fault"].clone();
        assert_eq!(fault, "brown-out: the Pi reported under-voltage for 1 s");
        // A flag that can't be read leaves the guard without it, and says so.
        c.pi_throttled = Some(r.dir.join("missing"));
        let without = current_engine(&r, c, true);
        assert_eq!(without.system.limits.pump_brownout_pi, Some(false));
        assert_eq!(without.cfg.pi_throttled, None);
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    #[test]
    fn acknowledging_a_current_trip_lets_the_pump_run_at_once() {
        let mut r = current_rig("air-ack", true);
        r.engine.boot(r.now);
        r.world.lock().unwrap().intake_dry = true;
        r.engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, None)), r.now);
        for _ in 0..10 {
            r.now.advance(Duration::from_secs(1));
            r.engine.tick(r.now);
        }
        assert!(r.engine.pump.fault().is_some_and(|f| f.contains("pulling air")));
        assert!(r.engine.dry_hold_until.is_some());
        r.world.lock().unwrap().intake_dry = false;
        let out = r.engine.handle(Inbound::AlertAck(AlertKind::PumpFault), r.now);
        assert_eq!(payload(&out, "seedypod/u1/alert/pump_fault")["active"], false);
        assert_eq!(r.engine.dry_hold_until, None);
        let out = r
            .engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, Some(30))), r.now);
        assert_eq!(payload(&out, "seedypod/u1/actuator/pump/state")["on"], true);
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    #[test]
    fn without_a_pump_monitor_the_current_guard_is_off() {
        let mut r = current_rig("no-monitor", false);
        assert_eq!(r.engine.pump.limits().dry_current_a, None);
        r.engine.boot(r.now);
        r.engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, Some(60))), r.now);
        r.world.lock().unwrap().intake_dry = true;
        for _ in 0..30 {
            r.now.advance(Duration::from_secs(1));
            r.engine.tick(r.now);
        }
        assert_eq!(r.world.lock().unwrap().pump_level, 100.0);
        assert_eq!(r.engine.pump.fault(), None);
        assert!(current_rig("with-monitor", true)
            .engine
            .pump
            .limits()
            .dry_current_a
            .is_some());
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    #[test]
    fn a_pump_sample_reads_the_monitor_and_leaves_gaps_for_what_is_missing() {
        let mut r = current_rig("sample", true);
        r.engine.boot(r.now);
        assert!(!r.engine.pump_on(r.now));
        r.engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, Some(60))), r.now);
        assert!(r.engine.pump_on(r.now));
        let s = r.engine.pump_sample();
        assert_eq!((s.duty, s.v, s.a), (100.0, Some(12.1), Some(0.5)));
        assert!(s.w.is_some());
        let mut bare = current_rig("sample-bare", false);
        let s = bare.engine.pump_sample();
        assert_eq!((s.v, s.a, s.w), (None, None, None));
        let _ = std::fs::remove_dir_all(&r.dir);
        let _ = std::fs::remove_dir_all(&bare.dir);
    }

    #[test]
    fn fast_reads_open_on_a_start_and_close_two_seconds_after_the_stop() {
        let mut r = current_rig("watch", true);
        r.engine.boot(r.now);
        assert_eq!(r.engine.pump_watch_due(r.now), None);
        assert!(r.engine.pump_watch(r.now).is_empty());
        r.engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, Some(3))), r.now);
        assert_eq!(
            r.engine.pump_watch_due(r.now),
            Some(r.now.instant + PUMP_SAMPLE_EVERY)
        );
        // Not due yet: nothing happens.
        assert!(r.engine.pump_watch(r.now).is_empty());
        let mut stopped = None;
        for _ in 0..40 {
            let out = step(&mut r);
            if out
                .iter()
                .any(|o| o.topic == "seedypod/u1/actuator/pump/state" && o.payload.contains(r#""on":false"#))
            {
                stopped = Some(r.steps);
                break;
            }
            assert_eq!(r.engine.env.pump_current_a, Some(0.5));
        }
        // The 3 s run ends on its deadline, not up to a tick late.
        assert_eq!(stopped, Some(30));
        // The current goes on being read for 2 s, then the reads stop.
        for _ in 31..50 {
            step(&mut r);
            assert!(r.engine.pump_watch_due(r.now).is_some(), "{} steps", r.steps);
        }
        assert_eq!(r.engine.env.pump_current_a, Some(0.0));
        step(&mut r);
        assert_eq!(r.engine.pump_watch_due(r.now), None);
        r.world.lock().unwrap().pump_level = 30.0;
        step(&mut r);
        assert_eq!(r.engine.env.pump_current_a, Some(0.0), "no reads past the tail");
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    #[test]
    fn telemetry_goes_out_on_its_interval_whether_or_not_the_pump_runs() {
        let mut r = current_rig("cadence", true);
        r.engine.boot(r.now);
        // (telemetry rounds, readings the fast reads published) over 30 s.
        let rounds = |r: &mut Rig| {
            let (mut rounds, mut fast) = (0, 0);
            for _ in 0..300 {
                let out = step(r);
                let readings = out
                    .iter()
                    .filter(|o| o.topic.starts_with("seedypod/u1/sensor/"))
                    .count();
                if r.steps % 10 != 0 {
                    fast += readings;
                } else if readings > 0 {
                    rounds += 1;
                }
            }
            (rounds, fast)
        };
        assert_eq!(rounds(&mut r), (3, 0));
        r.engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, Some(60))), r.now);
        assert_eq!(rounds(&mut r), (3, 0));
        assert_eq!(r.world.lock().unwrap().pump_level, 100.0);
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    #[test]
    fn a_tank_running_low_stops_the_pump_on_its_second_trusted_reading() {
        let mut r = rig(vec![ActuatorId::Pump], false, "level-fast");
        r.engine.boot(r.now);
        r.engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, None)), r.now);
        for _ in 0..25 {
            step(&mut r);
        }
        r.world.lock().unwrap().water_distance_cm = 17.0;
        let mut tripped = None;
        for n in 1..=40 {
            let out = step(&mut r);
            if r.world.lock().unwrap().pump_level == 0.0 {
                tripped = Some((n, out));
                break;
            }
        }
        let (n, out) = tripped.expect("never tripped");
        // The ranger is read once a second: the first low reading at 0.5 s, the second a second on.
        assert_eq!(n, 15, "tripped {n} steps after the tank went low");
        assert_eq!(
            payload(&out, "seedypod/u1/actuator/pump/state")["fault"],
            "dry-run: tank level read 17 cm, past 16 cm for 1 s"
        );
        assert_eq!(payload(&out, "seedypod/u1/alert/pump_fault")["active"], true);
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    /// The sim pump, but a stop can be made to fail.
    struct StuckPump {
        inner: hal_sim::SimActuator,
        stuck: Arc<std::sync::atomic::AtomicBool>,
    }

    impl hal_core::device::Actuator for StuckPump {
        fn id(&self) -> ActuatorId {
            ActuatorId::Pump
        }
        fn probe(&mut self) -> Result<(), hal_core::device::DeviceError> {
            self.inner.probe()
        }
        fn set_level(&mut self, level: f64) -> Result<(), hal_core::device::DeviceError> {
            if level == 0.0 && self.stuck.load(std::sync::atomic::Ordering::Relaxed) {
                return Err(hal_core::device::DeviceError::Bus("stuck".into()));
            }
            self.inner.set_level(level)
        }
        fn level(&self) -> f64 {
            self.inner.level()
        }
    }

    #[test]
    fn a_stop_the_driver_refuses_latches_a_fault_and_is_retried_until_it_takes() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let mut r = rig(vec![ActuatorId::Pump], false, "stuck");
        let stuck = Arc::new(AtomicBool::new(false));
        let mut registry = Registry::default();
        for id in [
            SensorId::AirTemp,
            SensorId::PcbTemp,
            SensorId::WaterDistance,
            SensorId::WaterLevelPct,
        ] {
            registry.add_sensor(Box::new(hal_sim::SimSensor::new(id, r.world.clone())));
        }
        registry.add_actuator(Box::new(StuckPump {
            inner: hal_sim::SimActuator::new(ActuatorId::Pump, r.world.clone()),
            stuck: stuck.clone(),
        }));
        r.engine = Engine::new(
            system(vec![ActuatorId::Pump]),
            cfg(false),
            registry,
            None,
            Some(StateFile::new(&r.dir)),
            r.snapshot.clone(),
        );
        r.engine.boot(r.now);
        r.engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, Some(60))), r.now);
        assert_eq!(r.world.lock().unwrap().pump_level, 100.0);
        stuck.store(true, Ordering::Relaxed);
        let out = r
            .engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, off()), r.now);
        let why = "stop-failed: the pump driver refused a stop: bus error: stuck";
        assert_eq!(payload(&out, "seedypod/u1/actuator/pump/state")["fault"], why);
        let alert = payload(&out, "seedypod/u1/alert/pump_fault");
        assert_eq!(alert["active"], true);
        // Retried on every read while it won't take; the pump is still on.
        for _ in 0..15 {
            step(&mut r);
            assert!(r.engine.pump_watch_due(r.now).is_some());
        }
        assert_eq!(r.world.lock().unwrap().pump_level, 100.0);
        // Acknowledged too soon: the next refused stop latches it again.
        r.engine.handle(Inbound::AlertAck(AlertKind::PumpFault), r.now);
        step(&mut r);
        assert_eq!(r.engine.pump.fault(), Some(why));
        stuck.store(false, Ordering::Relaxed);
        let out = step(&mut r);
        assert_eq!(r.world.lock().unwrap().pump_level, 0.0);
        assert_eq!(payload(&out, "seedypod/u1/actuator/pump/state")["fault"], why);
        // Stopped, but still latched for a person: no restart until acknowledged.
        let out = r
            .engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, Some(5))), r.now);
        assert_eq!(payload(&out, "seedypod/u1/actuator/pump/state")["on"], false);
        r.engine.handle(Inbound::AlertAck(AlertKind::PumpFault), r.now);
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
                a.observe(*d, 16.0, false);
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
            frac: Duration::ZERO,
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
    fn a_reading_lost_during_a_camera_capture_is_skipped_but_a_low_one_still_counts() {
        let mut a = WaterAlert::default();
        water_rounds(&mut a, &[Some(7.0); WATER_WINDOW]);
        for _ in 0..WATER_WINDOW * 2 {
            a.observe(None, 16.0, true);
        }
        assert!(!a.active, "a starved ranger is not low water");
        assert!(a.all_good(), "skipped rounds leave the window as it was");
        a.observe(Some(150.0), 16.0, true);
        assert!(a.active);
        assert_eq!(a.detail, "water distance 150.0 cm ≥ 16.0 cm");
        // At boot there is nothing to hold: the first round still decides.
        let mut fresh = WaterAlert::default();
        fresh.observe(None, 16.0, true);
        assert!(fresh.active);
    }

    #[test]
    fn captures_tell_whether_one_ran_since_a_mark() {
        let c = Captures::default();
        let before = c.mark();
        assert!(!c.since(before));
        drop(c.begin());
        assert!(c.since(before), "one that started and ended in between");
        let idle = c.mark();
        assert!(!c.since(idle));
        let busy = c.begin();
        assert!(c.since(idle), "one that started since");
        assert!(c.since(c.mark()), "one still running");
        drop(busy);
        assert_eq!(c.mark(), (0, 2));
    }

    /// A ranger that answers, or times out while `None`.
    struct Ranger(Arc<std::sync::Mutex<Option<f64>>>);

    impl hal_core::device::Sensor for Ranger {
        fn id(&self) -> SensorId {
            SensorId::WaterDistance
        }
        fn probe(&mut self) -> Result<(), hal_core::device::DeviceError> {
            Ok(())
        }
        fn read(&mut self) -> Result<Reading, hal_core::device::DeviceError> {
            match *self.0.lock().unwrap() {
                Some(cm) => Ok(Reading::new(cm, "cm")),
                None => Err(hal_core::device::DeviceError::Timeout),
            }
        }
    }

    #[test]
    fn a_ranger_silent_only_while_a_camera_captures_leaves_the_water_alert_down() {
        let cm = Arc::new(std::sync::Mutex::new(Some(7.0)));
        let mut registry = Registry::default();
        registry.add_sensor(Box::new(Ranger(cm.clone())));
        let captures = Captures::default();
        let mut e = Engine::new(system(vec![]), cfg(false), registry, None, None, Arc::default())
            .with_captures(captures.clone());
        let mut now = Now {
            instant: Instant::now(),
            epoch_s: 1_793_419_043,
            frac: Duration::ZERO,
        };
        e.boot(now);
        let mut rounds = |e: &mut Engine, n: usize| {
            for _ in 0..n {
                now.advance(Duration::from_secs(10));
                e.tick(now);
            }
        };
        rounds(&mut e, WATER_WINDOW);
        *cm.lock().unwrap() = None;
        let busy = captures.begin();
        rounds(&mut e, WATER_WINDOW * 2);
        assert!(!e.water.active);
        drop(busy);
        rounds(&mut e, WATER_RAISE_AT);
        assert!(e.water.active, "silent with no capture running is a lost sensor");
        assert_eq!(e.water.detail, "water level sensor unavailable");
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
            r.now.advance(hal_core::safety::DRY_CONFIRM);
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

    /// A light that refuses writes while `broken` is set.
    struct Flaky(Arc<std::sync::atomic::AtomicBool>);

    impl hal_core::device::Actuator for Flaky {
        fn id(&self) -> ActuatorId {
            ActuatorId::Light
        }
        fn probe(&mut self) -> Result<(), hal_core::device::DeviceError> {
            Ok(())
        }
        fn set_level(&mut self, _: f64) -> Result<(), hal_core::device::DeviceError> {
            if self.0.load(std::sync::atomic::Ordering::Relaxed) {
                return Err(hal_core::device::DeviceError::Timeout);
            }
            Ok(())
        }
        fn level(&self) -> f64 {
            0.0
        }
    }

    #[test]
    fn a_light_that_wont_write_reports_a_fault_once_and_clears_it() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let broken = Arc::new(AtomicBool::new(false));
        let mut registry = Registry::default();
        registry.add_actuator(Box::new(Flaky(broken.clone())));
        let mut e = Engine::new(
            system(vec![ActuatorId::Light]),
            cfg(false),
            registry,
            None,
            None,
            Arc::default(),
        );
        let mut now = Now {
            instant: Instant::now(),
            epoch_s: 1_793_419_043,
            frac: Duration::ZERO,
        };
        e.boot(now);
        broken.store(true, Ordering::Relaxed);
        let out = e.handle(Inbound::ActuatorSet(ActuatorId::Light, on(Some(50.0), None)), now);
        assert_eq!(
            payload(&out, "seedypod/u1/actuator/light/state")["fault"],
            "light driver write failed"
        );
        now.advance(Duration::from_secs(1));
        let out = e.tick(now);
        assert_eq!(
            payload(&out, "seedypod/u1/actuator/light/state")["fault"],
            "light driver write failed"
        );
        now.advance(Duration::from_secs(1));
        assert!(!topics_of(&e.tick(now)).contains(&"seedypod/u1/actuator/light/state"));
        broken.store(false, Ordering::Relaxed);
        e.handle(Inbound::ActuatorSet(ActuatorId::Light, on(Some(60.0), None)), now);
        now.advance(Duration::from_secs(1));
        let out = e.tick(now);
        assert!(payload(&out, "seedypod/u1/actuator/light/state")["fault"].is_null());
    }

    #[test]
    fn a_fade_leaves_the_pump_guard_alone() {
        let mut f = Fading::new("fade-pump");
        f.r.engine.boot(f.r.now);
        f.set(100.0);
        f.r.engine
            .handle(Inbound::ActuatorSet(ActuatorId::Pump, on(None, None)), f.r.now);
        assert_eq!(f.r.world.lock().unwrap().pump_level, 100.0);
        f.r.world.lock().unwrap().water_distance_cm = 17.0;
        f.r.now.advance(Duration::from_secs(10));
        f.r.engine.tick(f.r.now);
        f.r.now.advance(hal_core::safety::DRY_CONFIRM);
        f.r.engine.tick(f.r.now);
        assert_eq!(f.r.world.lock().unwrap().pump_level, 0.0, "tripped mid-fade");
        assert_eq!(
            f.r.engine.pump.fault(),
            Some("dry-run: tank level read 17 cm, past 16 cm for 3 s")
        );
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
        r.now.advance(hal_core::safety::DRY_CONFIRM);
        r.engine.tick(r.now);
        assert_eq!(
            r.engine.pump.fault(),
            Some("dry-run: tank level read 18 cm, past 16 cm for 3 s")
        );
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
            ..
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
            steps: 0,
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
            frac: Duration::ZERO,
        };
        n.advance(Duration::from_secs(90));
        assert_eq!(n.epoch_s, 90);
        assert_eq!(n.ts(), "1970-01-01T00:01:30Z");
        assert!(Now::real().epoch_s > 1_700_000_000);
        let o = Outbound::json("t", &serde_json::json!({"a": 1}), false);
        assert_eq!(o.payload, r#"{"a":1}"#);
    }
}
