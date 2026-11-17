//! `hald` — the one process that owns the Gardyn's hardware (ADR-0004).
//!
//! * `engine` runs on its own thread with the registry and the guards;
//!   everything else talks to it over channels.
//! * `mqtt` (rumqttc) and `http` (axum) are tokio tasks; `--stdout` replaces
//!   MQTT with JSON lines for smoke tests and CI.
//! * `--sim` swaps every driver for `hal-sim` and runs on virtual time.

mod board;
mod boot_log;
mod cameras;
mod config;
mod devices;
mod engine;
mod fade;
mod ha;
mod http;
mod identity;
mod kinds;
mod mdns;
mod mqtt;
mod notify;
mod overlay;
mod pi_power;
mod pump_pin;
mod pump_trace;
mod recording;
mod state;
mod usb;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use clap::Parser;
use engine::{Engine, EngineConfig, Inbound, Now, Outbound, SharedSnapshot};
use hal_core::{Caps, Limits, SystemInfo, CONTRACT_VERSION};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use tracing::{info, warn};
use tracing_subscriber::layer::{Layer, SubscriberExt};
use tracing_subscriber::util::SubscriberInitExt;

#[derive(Parser, Debug)]
#[command(name = "hald", version, about = "seedypod hardware daemon")]
struct Cli {
    /// Path to hal.toml (defaults are the documented Gardyn pin map).
    #[arg(short, long, env = "HAL_CONFIG")]
    config: Option<PathBuf>,
    /// Run against simulated hardware (no GPIO/I²C needed).
    #[arg(long, env = "HAL_SIM")]
    sim: bool,
    /// Validate the config and exit (non-zero on errors).
    #[arg(long)]
    check: bool,
    /// Print the commented default hal.toml and exit.
    #[arg(long)]
    print_default_config: bool,
    /// MQTT broker URL (overrides hal.toml).
    #[arg(long, env = "HAL_MQTT_URL")]
    mqtt_url: Option<String>,
    /// Print would-be MQTT publishes as JSON lines instead of connecting.
    #[arg(long)]
    stdout: bool,
    /// Simulated seconds per real second (sim only).
    #[arg(long, default_value_t = 1.0)]
    time_scale: f64,
    /// Exit after this many telemetry ticks (for smoke tests).
    #[arg(long)]
    ticks: Option<u64>,
    /// Temporary (#220): append the pump monitor's V, A and W at 4 Hz to this CSV
    /// while the pump runs, to record wet and dry traces for the current guard.
    #[arg(long, env = "HAL_PUMP_TRACE", value_name = "FILE")]
    pump_trace: Option<PathBuf>,
    /// If the USB bus is empty after boot, try to enumerate it again and exit.
    /// Needs root. Runs once per boot.
    #[arg(long)]
    usb_recover: bool,
    /// List the USB cameras (capture nodes) with their ports as JSON and exit.
    #[arg(long)]
    list_cameras: bool,
    /// Print udev rules giving cameras stable names and exit. With no NAME=PORT
    /// pairs, the first two cameras by port become upper and lower.
    #[arg(long, num_args = 0.., value_name = "NAME=PORT")]
    camera_rules: Option<Vec<String>>,
    /// Pin both cameras in the udev rules once they're on the bus, keeping any
    /// pins already made, and exit. Needs root. Runs when a camera appears.
    #[arg(long)]
    sync_camera_rules: bool,
    /// Print the pump's GPIO and exit; nothing if low doesn't turn it off. The
    /// pump-off script hald.service runs after every stop drives it low.
    #[arg(long)]
    pump_pin: bool,
}

const DEFAULT_MQTT_URL: &str = "mqtt://127.0.0.1:1883";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let policy = recording::RecordingPolicy::from_env();
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::from_default_env().add_directive("info".parse()?))
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(std::io::stderr)
                .with_filter(recording::log_filter(policy)),
        )
        .init();
    let cli = Cli::parse();
    if cli.print_default_config {
        print!("{}", config::DEFAULT_CONFIG_TOML);
        return Ok(());
    }
    if cli.list_cameras {
        let found = cameras::discover(Path::new("/sys"), Path::new("/dev"));
        let assigned = cameras::default_assignment(&found);
        let rows: Vec<_> = found
            .iter()
            .map(|d| {
                let name = assigned.iter().find(|(_, p)| *p == d.port).map(|(n, _)| n.clone());
                serde_json::json!({ "device": d.device, "port": d.port, "name": d.name, "default_assignment": name,
                                    "stable": name.as_deref().map(cameras::stable_path) })
            })
            .collect();
        println!("{}", serde_json::to_string_pretty(&rows)?);
        return Ok(());
    }
    if let Some(pairs) = &cli.camera_rules {
        let assign = if pairs.is_empty() {
            cameras::default_assignment(&cameras::discover(Path::new("/sys"), Path::new("/dev")))
        } else {
            cameras::parse_assignment(pairs).map_err(anyhow::Error::msg)?
        };
        if assign.is_empty() {
            anyhow::bail!("no USB cameras found; plug them in or pass NAME=PORT pairs (see --list-cameras)");
        }
        print!("{}", cameras::rules(&assign));
        return Ok(());
    }
    if cli.sync_camera_rules {
        let said = cameras::sync(
            Path::new("/sys"),
            Path::new("/dev"),
            Path::new(cameras::RULES_PATH),
            cameras::reload_udev,
        )
        .map_err(anyhow::Error::msg)?;
        println!("{said}");
        return Ok(());
    }

    let mut cfg = config::Config::load(cli.config.as_deref())?;
    if cli.pump_pin {
        if let Some(pin) = pump_pin::pump_off_pin(&cfg) {
            println!("{pin}");
        }
        return Ok(());
    }
    if cli.usb_recover {
        let boot = usb::Boot {
            sysfs: Path::new("/sys"),
            state_dir: &cfg.state_dir,
            root: Path::new("/"),
            uptime: usb::uptime().unwrap_or_default(),
            has_cameras: !cfg.camera.is_empty(),
        };
        let recovery = usb::recover(&boot, &cfg.usb_recovery, &mut std::thread::sleep, &mut || {
            usb::in_use(&cfg.http_bind)
        });
        if let Some(came_up) = recovery.hub_came_up() {
            if let Err(e) = usb::record_boot(&cfg.state_dir, came_up) {
                warn!(%e, "couldn't record this boot's USB hub");
            }
        }
        // Before any reboot, which would take the journal with it. It must never stop one.
        let facts = boot_log::gather(
            &recovery,
            Path::new("/"),
            Path::new("/sys"),
            &cfg.state_dir,
            Now::real().ts(),
            usb::uptime().unwrap_or_default(),
        );
        if let Err(e) = boot_log::append(&cfg.state_dir, &facts.line()) {
            warn!(%e, "couldn't add to the boot log");
        }
        match recovery {
            usb::Recovery::AlreadyUp => info!("USB bus came up by itself"),
            usb::Recovery::NoAction(why) => info!(%why, "no USB recovery needed"),
            usb::Recovery::Recovered { attempts } => info!(attempts, "USB bus recovered"),
            usb::Recovery::Reboot { attempt, limit } => {
                warn!(attempt, limit, "USB hub missing; rebooting to try again");
                usb::reboot()?;
            }
            usb::Recovery::NotRebooting(why) => warn!(%why, "USB hub missing; not rebooting this boot"),
            usb::Recovery::GaveUp { reboots } => {
                let limit = cfg.usb_recovery.reboot_attempts;
                anyhow::bail!("USB hub missing after {reboots} reboots (reboot_attempts = {limit}); waiting for it to be seen")
            }
        }
        return Ok(());
    }
    if let Some(u) = &cli.mqtt_url {
        cfg.mqtt_url = Some(u.clone());
    }
    let state_dir = if cli.sim && cfg.state_dir == config::Config::default().state_dir {
        std::env::temp_dir().join("seedypod-sim")
    } else {
        cfg.state_dir.clone()
    };
    // Sensors added from the app. A bad overlay must never keep hald from starting.
    let overlay = overlay::Overlay::new(&state_dir);
    cfg.extra_sensors = overlay.load();
    if !cfg.extra_sensors.is_empty() && !cfg.validate().is_empty() {
        let bad = cfg.validate();
        cfg.extra_sensors.clear();
        if cfg.validate().is_empty() {
            warn!(errors = ?bad, "ignoring the app-added sensor list; it no longer validates");
        }
    }
    let errors = cfg.validate();
    let unit_id = identity::unit_id(cfg.unit_id.as_deref());

    if cli.check {
        let (sensors, actuators) = devices::planned_capabilities(&cfg);
        // The guard the engine will run on this config, and why (before probing: an
        // ina219 that doesn't answer at boot falls back further, and says so in the log).
        // hal.toml's alone: settings the app made, kept in state.json, aren't read here.
        let guard = hal_core::safety::resolve_dry_guard(
            cfg.limits.pump_dry_guard,
            cfg.limits.pump_dry_current_a,
            sensors.contains(&hal_core::SensorId::PumpA),
            cfg.limits.water_low_cm.is_some(),
        );
        let pump_v = sensors.contains(&hal_core::SensorId::PumpV);
        let pi_flag = cfg.limits.pump_brownout_pi
            && pi_power::under_voltage(std::path::Path::new(config::PI_THROTTLED)).is_some();
        let brownout_v = (cfg.limits.pump_brownout_v > 0.0).then_some(cfg.limits.pump_brownout_v);
        let brownout =
            hal_core::safety::describe_brownout(brownout_v, cfg.limits.pump_brownout_ms, pump_v, pi_flag);
        let warnings: Vec<&str> = guard
            .warn
            .then_some(guard.why.as_str())
            .into_iter()
            .chain((brownout_v.is_none() || !pump_v).then_some(brownout.as_str()))
            .collect();
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "ok": errors.is_empty(),
                "errors": errors,
                "warnings": warnings,
                "unit_id": unit_id,
                "config": cli.config,
                "mqtt_url": cfg.mqtt_url.clone().unwrap_or_else(|| DEFAULT_MQTT_URL.into()),
                "http_bind": cfg.http_bind,
                "sensors": sensors,
                "actuators": actuators,
                "cameras": cfg.camera.iter().map(|c| c.name.clone()).collect::<Vec<_>>(),
                "limits": { "pump_max_run_s": cfg.limits.pump_max_run_s, "pump_max_duty": cfg.limits.pump_max_duty,
                            "water_low_cm": cfg.limits.water_low_cm, "over_temp_c": cfg.limits.over_temp_c,
                            "water_low_min_cm": cfg.limits.water_low_min_cm, "water_low_max_cm": cfg.limits.water_low_max_cm,
                            "water_low_hold_ms": cfg.limits.water_low_hold_ms,
                            "water_low_hold_min_ms": cfg.limits.water_low_hold_min_ms,
                            "water_low_hold_max_ms": cfg.limits.water_low_hold_max_ms,
                            "pump_dry_current_a": cfg.limits.pump_dry_current_a, "pump_dry_after_ms": cfg.limits.dry_after_ms(),
                            "pump_dry_current_min_a": cfg.limits.pump_dry_current_min_a,
                            "pump_dry_current_max_a": cfg.limits.pump_dry_current_max_a,
                            "pump_dry_grace_ms": cfg.limits.dry_grace_ms(),
                            "pump_dry_grace_min_ms": cfg.limits.pump_dry_grace_min_ms,
                            "pump_dry_grace_max_ms": cfg.limits.pump_dry_grace_max_ms,
                            "pump_dry_guard": guard.mode, "pump_dry_guard_asked": cfg.limits.pump_dry_guard,
                            "pump_dry_guard_why": guard.why, "pump_dry_guard_app": cfg.limits.pump_dry_guard_app,
                            "pump_brownout_v": brownout_v, "pump_brownout_ms": cfg.limits.pump_brownout_ms,
                            "pump_brownout_pi": cfg.limits.pump_brownout_pi, "pump_brownout_pi_readable": pi_flag,
                            "pump_brownout_guard": brownout },
                "dosing_enabled": cfg.dosing.enabled,
            }))?
        );
        if !errors.is_empty() {
            std::process::exit(1);
        }
        return Ok(());
    }
    if !errors.is_empty() {
        anyhow::bail!("invalid config:\n  {}", errors.join("\n  "));
    }

    let trace = match &cli.pump_trace {
        Some(path) => {
            let file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .map_err(|e| anyhow::anyhow!("pump trace {}: {e}", path.display()))?;
            info!(path = %path.display(), "tracing the pump monitor while the pump runs");
            Some(pump_trace::PumpTrace::new(file))
        }
        None => None,
    };

    let built = if cli.sim {
        devices::build_sim(&cfg)
    } else {
        devices::build_hardware(&cfg)?
    };
    let model = cfg
        .model
        .clone()
        .or_else(|| built.detected_model.clone())
        .unwrap_or_else(|| "gardyn".into());
    let system = SystemInfo {
        contract: CONTRACT_VERSION,
        unit_id: unit_id.clone(),
        model,
        board: if cli.sim { None } else { board::read() },
        hal_version: env!("CARGO_PKG_VERSION").into(),
        caps: Caps {
            sensors: built.registry.sensor_ids(),
            actuators: built.registry.actuator_ids(),
            cameras: built.cameras.keys().cloned().collect(),
        },
        limits: Limits {
            pump_max_run_s: cfg.limits.pump_max_run_s,
            pump_max_duty: cfg.limits.pump_max_duty,
            water_low_cm: cfg.limits.water_low_cm,
            // The engine fills in the dry-run guard it runs and its settings.
            ..Limits::default()
        },
    };
    info!(unit = %unit_id, model = %system.model, sensors = ?system.caps.sensors, actuators = ?system.caps.actuators, "hald starting");

    let snapshot: SharedSnapshot = Arc::default();
    let engine = Engine::new(
        system.clone(),
        EngineConfig {
            telemetry_interval: Duration::from_secs(cfg.telemetry_interval_s.max(1)),
            light_fade: Duration::from_millis(cfg.light_fade_ms),
            pump: (&cfg.limits).into(),
            dosing: (&cfg.dosing).into(),
            button_pump_run_s: cfg.button.pump_run_s,
            ha_prefix: cfg.ha.discovery.then(|| cfg.ha.prefix.clone()),
            dry_grace_bounds: (cfg.limits.pump_dry_grace_min_ms, cfg.limits.pump_dry_grace_max_ms),
            dry_current_bounds: (
                cfg.limits.pump_dry_current_min_a,
                cfg.limits.pump_dry_current_max_a,
            ),
            water_low_bounds: (cfg.limits.water_low_min_cm, cfg.limits.water_low_max_cm),
            water_low_hold_bounds: (cfg.limits.water_low_hold_min_ms, cfg.limits.water_low_hold_max_ms),
            dry_guard_app: cfg.limits.pump_dry_guard_app,
            pi_throttled: (cfg.limits.pump_brownout_pi && !cli.sim)
                .then(|| std::path::PathBuf::from(config::PI_THROTTLED)),
        },
        built.registry,
        built.over_temp,
        Some(state::StateFile::new(&state_dir)),
        snapshot.clone(),
    )
    .with_devices(engine::Devices {
        entries: engine::Devices::from_boot(&built.status, &cfg.extra_sensors),
        user: cfg.extra_sensors.clone(),
        factory: Some(built.factory),
        overlay: Some(overlay),
    });

    let (inbound_tx, inbound_rx) = std::sync::mpsc::channel::<Inbound>();
    let (out_tx, out_rx) = tokio::sync::mpsc::unbounded_channel::<Outbound>();
    let mqtt_connected = Arc::new(AtomicBool::new(false));

    // Button presses → engine.
    if let Some(rx) = built.button {
        let tx = inbound_tx.clone();
        std::thread::Builder::new()
            .name("button-fwd".into())
            .spawn(move || {
                while let Ok(p) = rx.recv() {
                    if tx.send(Inbound::Button(p)).is_err() {
                        break;
                    }
                }
            })?;
    }

    // Transport: MQTT or JSON lines.
    let sink = if cli.stdout {
        tokio::spawn(stdout_sink(out_rx))
    } else {
        let settings = mqtt::MqttSettings {
            url: cfg.mqtt_url.clone().unwrap_or_else(|| DEFAULT_MQTT_URL.into()),
            username: cfg.mqtt_username.clone(),
            password: cfg.mqtt_password.clone(),
        };
        tokio::spawn(mqtt::run(
            settings,
            unit_id.clone(),
            inbound_tx.clone(),
            out_rx,
            mqtt_connected.clone(),
        ))
    };

    // HTTP.
    let http_state = http::AppState {
        system: system.clone(),
        snapshot,
        cameras: Arc::new(built.cameras),
        camera_health: http::CameraHealth::default(),
        state_dir: state_dir.clone(),
        started: Instant::now(),
        mqtt_connected: mqtt_connected.clone(),
        inbound: inbound_tx.clone(),
        sim: built.world.clone(),
    };
    let http_port = match tokio::net::TcpListener::bind(&cfg.http_bind).await {
        Ok(listener) => {
            let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
            info!(bind = %cfg.http_bind, "HTTP listening");
            tokio::spawn(async move {
                if let Err(e) = axum::serve(listener, http::router(http_state)).await {
                    warn!(%e, "HTTP server stopped");
                }
            });
            Some(port)
        }
        Err(e) => {
            warn!(bind = %cfg.http_bind, %e, "HTTP disabled: bind failed");
            None
        }
    };

    // mDNS.
    let _advert = match (cfg.mdns, http_port) {
        (true, Some(port)) => match mdns::Advert::start(&unit_id, &system.model, &system.hal_version, port) {
            Ok(a) => {
                info!(service = mdns::SERVICE_TYPE, port, "mDNS advertised");
                Some(a)
            }
            Err(e) => {
                warn!(%e, "mDNS unavailable");
                None
            }
        },
        _ => None,
    };

    // An empty USB bus → camera_missing, once recovery has had its chance.
    if !cli.sim && cfg.usb_recovery.enabled && !cfg.camera.is_empty() {
        let tx = inbound_tx.clone();
        let mut watch = usb::Watch::new(&cfg.usb_recovery, state_dir.clone());
        let reboots_dir = state_dir.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;
                let uptime = usb::uptime().unwrap_or_default();
                let reboots = usb::reboots_so_far(&reboots_dir).unwrap_or(0);
                if let Some(alert) = watch.tick(&usb::bus_state(Path::new("/sys")), uptime, reboots) {
                    let _ = tx.send(alert);
                }
            }
        });
    }

    // Signals → Shutdown.
    {
        let tx = inbound_tx.clone();
        tokio::spawn(async move {
            wait_for_signal().await;
            info!("signal received");
            let _ = tx.send(Inbound::Shutdown);
        });
    }

    // Engine thread.
    let loop_cfg = LoopConfig {
        sim: cli.sim,
        time_scale: cli.time_scale,
        ticks: cli.ticks,
        interval: Duration::from_secs(cfg.telemetry_interval_s.max(1)),
        world: built.world,
        stop: built.stop,
        trace,
        notify: notify::Notifier::from_env(),
    };
    let engine_task = tokio::task::spawn_blocking(move || run_engine(engine, loop_cfg, inbound_rx, out_tx));
    engine_task.await?;
    // The engine dropped `out_tx`; the sink drains and finishes.
    let _ = sink.await;
    info!("hald stopped");
    Ok(())
}

struct LoopConfig {
    sim: bool,
    time_scale: f64,
    ticks: Option<u64>,
    interval: Duration,
    world: Option<hal_sim::Shared>,
    stop: Arc<AtomicBool>,
    trace: Option<pump_trace::PumpTrace<std::fs::File>>,
    notify: notify::Notifier,
}

/// `--pump-trace`: reads the pump monitor when a read is due.
fn trace_pump(trace: &mut Option<pump_trace::PumpTrace<std::fs::File>>, engine: &mut Engine, now: Now) {
    if let Some(t) = trace {
        t.poll(engine.pump_on(now), Instant::now(), &now.ts(), || {
            engine.pump_sample()
        });
    }
}

/// The engine loop: drain commands until the next tick, tick, repeat. While the
/// pump runs it also wakes for the pump guard's fast reads (`Engine::pump_watch`).
/// In `--sim`, virtual time advances one telemetry interval per tick, in the
/// guard's 100 ms steps while the pump runs.
fn run_engine(mut engine: Engine, mut cfg: LoopConfig, rx: Receiver<Inbound>, tx: UnboundedSender<Outbound>) {
    let send = |tx: &UnboundedSender<Outbound>, outs: Vec<Outbound>| {
        for o in outs {
            let _ = tx.send(o);
        }
    };
    let real_tick = if cfg.sim {
        Duration::from_millis(200)
    } else {
        Duration::from_secs(1)
    };
    let mut now = Now::real();
    send(&tx, engine.boot(now));
    // After boot, which restores the light on this thread; from here on only the fader writes.
    engine.start_light_fades();
    cfg.notify.ready();
    let mut ticks = 0u64;
    loop {
        let deadline = Instant::now() + real_tick;
        loop {
            // A pump trace, and the pump guard while the pump runs, wake the loop between ticks.
            let watch = (!cfg.sim).then(|| engine.pump_watch_due(now)).flatten();
            let wake = [cfg.trace.as_ref().and_then(pump_trace::PumpTrace::due), watch]
                .into_iter()
                .flatten()
                .fold(deadline, Instant::min);
            match rx.recv_timeout(wake.saturating_duration_since(Instant::now())) {
                Ok(Inbound::Shutdown) | Err(RecvTimeoutError::Disconnected) => {
                    send(&tx, engine.handle(Inbound::Shutdown, now));
                    cfg.stop.store(true, Ordering::Relaxed);
                    return;
                }
                Ok(msg) => {
                    // A pump start's spin-up grace counts from now, not the last tick.
                    if !cfg.sim {
                        now = Now::real();
                    }
                    send(&tx, engine.handle(msg, now));
                }
                Err(RecvTimeoutError::Timeout) if Instant::now() < deadline => {}
                Err(RecvTimeoutError::Timeout) => break,
            }
            if watch.is_some_and(|t| Instant::now() >= t) {
                now = Now::real();
                send(&tx, engine.pump_watch(now));
            }
            trace_pump(&mut cfg.trace, &mut engine, now);
        }
        if cfg.sim {
            let dt = cfg.interval.mul_f64(cfg.time_scale.max(0.0));
            // While the guard watches the pump, virtual time goes in its steps.
            let steps = match engine.pump_watch_due(now) {
                Some(_) => (dt.as_millis() / engine::PUMP_SAMPLE_EVERY.as_millis()).clamp(1, 200) as u32,
                None => 1,
            };
            for i in 0..steps {
                if let Some(w) = &cfg.world {
                    w.lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .step((dt / steps).as_secs_f64());
                }
                now.advance(dt / steps);
                if i + 1 < steps {
                    send(&tx, engine.pump_watch(now));
                }
            }
        } else {
            now = Now::real();
        }
        send(&tx, engine.tick(now));
        cfg.notify.watchdog();
        trace_pump(&mut cfg.trace, &mut engine, now);
        ticks += 1;
        if cfg.ticks.is_some_and(|n| ticks >= n) {
            send(&tx, engine.handle(Inbound::Shutdown, now));
            cfg.stop.store(true, Ordering::Relaxed);
            return;
        }
    }
}

/// `--stdout`: one JSON object per publish, payload parsed when it is JSON.
async fn stdout_sink(mut rx: UnboundedReceiver<Outbound>) {
    use std::io::Write;
    let stdout = std::io::stdout();
    while let Some(o) = rx.recv().await {
        let payload = serde_json::from_str::<serde_json::Value>(&o.payload)
            .unwrap_or_else(|_| serde_json::Value::String(o.payload.clone()));
        let line = serde_json::json!({ "topic": o.topic, "payload": payload, "retain": o.retain });
        let mut lock = stdout.lock();
        let _ = writeln!(lock, "{line}");
    }
}

async fn wait_for_signal() {
    #[cfg(unix)]
    {
        let mut term = match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(s) => s,
            Err(e) => {
                warn!(%e, "SIGTERM handler unavailable");
                let _ = tokio::signal::ctrl_c().await;
                return;
            }
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notify::tests::FakeSystemd;
    use hal_core::registry::Registry;
    use hal_core::{DoseLimits, PumpLimits};

    fn engine() -> Engine {
        let system = SystemInfo {
            contract: CONTRACT_VERSION,
            unit_id: "u1".into(),
            model: "sim".into(),
            board: None,
            hal_version: "0.1.0".into(),
            caps: Caps {
                sensors: vec![],
                actuators: vec![],
                cameras: vec![],
            },
            limits: Limits {
                pump_max_run_s: 900,
                pump_max_duty: 100.0,
                water_low_cm: None,
                ..Limits::default()
            },
        };
        let cfg = EngineConfig {
            telemetry_interval: Duration::from_secs(10),
            light_fade: Duration::ZERO,
            pump: PumpLimits::default(),
            dosing: DoseLimits::default(),
            button_pump_run_s: 300,
            ha_prefix: None,
            dry_grace_bounds: (300, 5000),
            dry_current_bounds: (0.1, 3.0),
            water_low_bounds: (8.0, 19.0),
            water_low_hold_bounds: (0, 60_000),
            dry_guard_app: true,
            pi_throttled: None,
        };
        Engine::new(system, cfg, Registry::default(), None, None, Arc::default())
    }

    fn run(systemd: &FakeSystemd, ticks: u64, rx: Receiver<Inbound>) {
        let (tx, _out) = tokio::sync::mpsc::unbounded_channel();
        let cfg = LoopConfig {
            sim: true,
            time_scale: 1.0,
            ticks: Some(ticks),
            interval: Duration::from_secs(10),
            world: None,
            stop: Arc::default(),
            trace: None,
            notify: systemd.notifier(),
        };
        run_engine(engine(), cfg, rx, tx);
    }

    /// The watchdog's pings come from the loop's own tick, one each, after READY=1:
    /// a loop that stops ticking stops pinging.
    #[test]
    fn the_engine_loop_pings_systemd_once_a_tick() {
        let systemd = FakeSystemd::new();
        let (_keep, rx) = std::sync::mpsc::channel();
        run(&systemd, 3, rx);
        assert_eq!(
            systemd.received(),
            ["READY=1", "WATCHDOG=1", "WATCHDOG=1", "WATCHDOG=1"]
        );
    }

    #[test]
    fn a_loop_that_never_ticks_never_pings() {
        let systemd = FakeSystemd::new();
        let (tx, rx) = std::sync::mpsc::channel();
        tx.send(Inbound::Shutdown).unwrap();
        run(&systemd, 3, rx);
        assert_eq!(systemd.received(), ["READY=1"]);
    }
}
