//! `hald` — the one process that owns the Gardyn's hardware (ADR-0004).
//!
//! * `engine` runs on its own thread with the registry and the guards;
//!   everything else talks to it over channels.
//! * `mqtt` (rumqttc) and `http` (axum) are tokio tasks; `--stdout` replaces
//!   MQTT with JSON lines for smoke tests and CI.
//! * `--sim` swaps every driver for `hal-sim` and runs on virtual time.

mod config;
mod devices;
mod engine;
mod ha;
mod http;
mod identity;
mod mdns;
mod mqtt;
mod state;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use clap::Parser;
use engine::{Engine, EngineConfig, Inbound, Now, Outbound, SharedSnapshot};
use hal_core::{Caps, Limits, SystemInfo, CONTRACT_VERSION};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use tracing::{info, warn};

#[derive(Parser, Debug)]
#[command(name = "hald", version, about = "leafypod hardware daemon")]
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
}

const DEFAULT_MQTT_URL: &str = "mqtt://127.0.0.1:1883";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env().add_directive("info".parse()?))
        .with_writer(std::io::stderr)
        .init();
    let cli = Cli::parse();
    if cli.print_default_config {
        print!("{}", config::DEFAULT_CONFIG_TOML);
        return Ok(());
    }

    let mut cfg = config::Config::load(cli.config.as_deref())?;
    if let Some(u) = &cli.mqtt_url {
        cfg.mqtt_url = Some(u.clone());
    }
    let errors = cfg.validate();
    let unit_id = identity::unit_id(cfg.unit_id.as_deref());

    if cli.check {
        let (sensors, actuators) = devices::planned_capabilities(&cfg);
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "ok": errors.is_empty(),
                "errors": errors,
                "unit_id": unit_id,
                "config": cli.config,
                "mqtt_url": cfg.mqtt_url.clone().unwrap_or_else(|| DEFAULT_MQTT_URL.into()),
                "http_bind": cfg.http_bind,
                "sensors": sensors,
                "actuators": actuators,
                "cameras": cfg.camera.iter().map(|c| c.name.clone()).collect::<Vec<_>>(),
                "limits": { "pump_max_run_s": cfg.limits.pump_max_run_s, "pump_max_duty": cfg.limits.pump_max_duty,
                            "water_low_cm": cfg.limits.water_low_cm, "over_temp_c": cfg.limits.over_temp_c },
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
        },
    };
    info!(unit = %unit_id, model = %system.model, sensors = ?system.caps.sensors, actuators = ?system.caps.actuators, "hald starting");

    let state_dir = if cli.sim && cfg.state_dir == config::Config::default().state_dir {
        std::env::temp_dir().join("leafypod-sim")
    } else {
        cfg.state_dir.clone()
    };
    let snapshot: SharedSnapshot = Arc::default();
    let engine = Engine::new(
        system.clone(),
        EngineConfig {
            telemetry_interval: Duration::from_secs(cfg.telemetry_interval_s.max(1)),
            pump: (&cfg.limits).into(),
            dosing: (&cfg.dosing).into(),
            button_pump_run_s: cfg.button.pump_run_s,
            ha_prefix: cfg.ha.discovery.then(|| cfg.ha.prefix.clone()),
        },
        built.registry,
        built.over_temp,
        Some(state::StateFile::new(&state_dir)),
        snapshot.clone(),
    );

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
        started: Instant::now(),
        mqtt_connected: mqtt_connected.clone(),
        inbound: inbound_tx.clone(),
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
}

/// The engine loop: drain commands until the next tick, tick, repeat.
/// In `--sim`, virtual time advances one telemetry interval per tick.
fn run_engine(mut engine: Engine, cfg: LoopConfig, rx: Receiver<Inbound>, tx: UnboundedSender<Outbound>) {
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
    let mut ticks = 0u64;
    loop {
        let deadline = Instant::now() + real_tick;
        loop {
            match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(Inbound::Shutdown) | Err(RecvTimeoutError::Disconnected) => {
                    send(&tx, engine.handle(Inbound::Shutdown, now));
                    cfg.stop.store(true, Ordering::Relaxed);
                    return;
                }
                Ok(msg) => send(&tx, engine.handle(msg, now)),
                Err(RecvTimeoutError::Timeout) => break,
            }
        }
        if cfg.sim {
            let dt = cfg.interval.mul_f64(cfg.time_scale.max(0.0));
            if let Some(w) = &cfg.world {
                w.lock().unwrap_or_else(|e| e.into_inner()).step(dt.as_secs_f64());
            }
            now.advance(dt);
        } else {
            now = Now::real();
        }
        send(&tx, engine.tick(now));
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
