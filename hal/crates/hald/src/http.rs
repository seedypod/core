//! HTTP (axum): health, system info, the state snapshot and camera stills
//! (and, in `--sim` only, a switch for the simulated pump's intake).
//! Stills go through one mutex per camera (upstream #117) and the capture
//! runs on a blocking thread; every result is reported to the engine so
//! `camera_missing` reflects reality. That alert covers all the cameras, so
//! [`CameraHealth`] keeps it up until none is failing: a good frame from one
//! camera must not clear another's failure.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use hal_core::{Camera, SystemInfo};
use serde::Deserialize;
use serde_json::json;
use tracing::info;

use crate::engine::{Inbound, SharedSnapshot};

pub type SharedCamera = Arc<Mutex<Box<dyn Camera>>>;

/// Why each failing camera's last capture failed.
#[derive(Clone, Default)]
pub struct CameraHealth(Arc<Mutex<BTreeMap<String, String>>>);

impl CameraHealth {
    /// Record one capture and tell the engine what it should now show. The send
    /// stays under the lock so the engine sees results in the order they were
    /// recorded: a stale success must not land after a newer failure.
    fn report(&self, name: &str, failure: Option<String>, engine: &Sender<Inbound>) {
        let mut failing = self.0.lock().unwrap_or_else(|e| e.into_inner());
        match failure {
            Some(detail) => failing.insert(name.to_owned(), detail),
            None => failing.remove(name),
        };
        let _ = engine.send(summary(&failing, name));
    }
}

/// Names read `upper camera`: core and the app go by that prefix.
fn summary(failing: &BTreeMap<String, String>, name: &str) -> Inbound {
    let mut all = failing.iter().map(|(n, d)| (format!("{n} camera"), d.clone()));
    match all.next() {
        Some((first, detail)) => Inbound::CameraResult {
            name: first,
            ok: false,
            detail: std::iter::once(detail)
                .chain(all.map(|(n, d)| format!("{n}: {d}")))
                .collect::<Vec<_>>()
                .join("; "),
        },
        None => Inbound::CameraResult {
            name: format!("{name} camera"),
            ok: true,
            detail: String::new(),
        },
    }
}

#[derive(Clone)]
pub struct AppState {
    pub system: SystemInfo,
    pub snapshot: SharedSnapshot,
    pub cameras: Arc<BTreeMap<String, SharedCamera>>,
    pub camera_health: CameraHealth,
    /// Where `usb::record_boot` keeps its record.
    pub state_dir: PathBuf,
    pub started: Instant,
    pub mqtt_connected: Arc<AtomicBool>,
    pub inbound: Sender<Inbound>,
    /// The simulated world in `--sim`; `None` on a unit, where `/sim/*` doesn't exist.
    pub sim: Option<hal_sim::Shared>,
}

pub fn router(state: AppState) -> Router {
    let r = Router::new()
        .route("/health", get(health))
        .route("/system", get(system))
        .route("/state", get(snapshot))
        .route("/camera/{file}", get(camera))
        .route("/camera/full/{file}", get(camera_full));
    let r = if state.sim.is_some() {
        r.route("/sim/intake", post(sim_intake))
    } else {
        r
    };
    r.with_state(state)
}

#[derive(Deserialize)]
struct Intake {
    dry: bool,
}

/// `--sim` only: `{"dry": true}` lifts the pump's intake out of the simulated
/// tank, so the next run pulls air and trips the current guard; `false` puts it back.
async fn sim_intake(State(s): State<AppState>, Json(body): Json<Intake>) -> Response {
    let Some(world) = &s.sim else {
        return StatusCode::NOT_FOUND.into_response();
    };
    world.lock().unwrap_or_else(|e| e.into_inner()).intake_dry = body.dry;
    info!(dry = body.dry, "sim: pump intake set");
    Json(json!({ "dry": body.dry })).into_response()
}

async fn health(State(s): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({
        "ok": true,
        "uptime_s": s.started.elapsed().as_secs(),
        "mqtt_connected": s.mqtt_connected.load(Ordering::Relaxed),
    }))
}

async fn system(State(s): State<AppState>) -> Json<SystemInfo> {
    // The engine's copy tracks sensors added at runtime; the boot copy is a fallback.
    let current = s.snapshot.read().ok().and_then(|snap| snap.system.clone());
    Json(current.unwrap_or_else(|| s.system.clone()))
}

async fn snapshot(State(s): State<AppState>) -> Response {
    match s.snapshot.read() {
        Ok(snap) => Json(snap.clone()).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// `/camera/upper.jpg` → the camera named `upper`.
pub fn camera_name(file: &str) -> Option<&str> {
    file.strip_suffix(".jpg").filter(|n| {
        !n.is_empty()
            && n.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    })
}

/// What core tracks a link's health from, on every still, good or not: frames this
/// capture refused as damaged, and `missing/total` boots the USB hub didn't come up.
fn link_headers(damaged: u32, boots: Option<(usize, usize)>) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        HeaderName::from_static("x-seedypod-damaged-frames"),
        HeaderValue::from(damaged),
    );
    if let Some((missing, total)) = boots {
        if let Ok(value) = HeaderValue::from_str(&format!("{missing}/{total}")) {
            headers.insert(HeaderName::from_static("x-seedypod-hub-boots"), value);
        }
    }
    headers
}

async fn camera(State(s): State<AppState>, Path(file): Path<String>) -> Response {
    let Some(name) = camera_name(&file) else {
        return (StatusCode::NOT_FOUND, "expected /camera/<name>.jpg").into_response();
    };
    let Some(cam) = s.cameras.get(name).cloned() else {
        return (StatusCode::NOT_FOUND, format!("no camera {name:?}")).into_response();
    };
    let name = name.to_owned();
    let (health, engine) = (s.camera_health.clone(), s.inbound.clone());
    let captured = tokio::task::spawn_blocking(move || {
        let mut c = cam.lock().unwrap_or_else(|e| e.into_inner());
        let result = c.capture();
        // Here, not after the await: a client that hangs up drops the handler, not this task.
        health.report(&name, result.as_ref().err().map(ToString::to_string), &engine);
        (result, c.damaged_frames())
    })
    .await;
    let boots = crate::usb::boot_record(&s.state_dir);
    match captured {
        Ok((Ok(bytes), damaged)) => (
            link_headers(damaged, boots),
            [
                (header::CONTENT_TYPE, "image/jpeg".to_owned()),
                (header::CACHE_CONTROL, "no-store".to_owned()),
            ],
            bytes,
        )
            .into_response(),
        Ok((Err(e), damaged)) => (
            StatusCode::SERVICE_UNAVAILABLE,
            link_headers(damaged, boots),
            e.to_string(),
        )
            .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/// `/camera/full/upper.jpg`: a pod-ID still at the sensor's full size (#224).
/// It waits its turn on the same mutex as the regular stills, but reports
/// nothing to `camera_missing` and sends no link headers: a full-size frame
/// that fails says nothing core's link watch should count.
async fn camera_full(State(s): State<AppState>, Path(file): Path<String>) -> Response {
    let Some(name) = camera_name(&file) else {
        return (StatusCode::NOT_FOUND, "expected /camera/full/<name>.jpg").into_response();
    };
    let Some(cam) = s.cameras.get(name).cloned() else {
        return (StatusCode::NOT_FOUND, format!("no camera {name:?}")).into_response();
    };
    let captured =
        tokio::task::spawn_blocking(move || cam.lock().unwrap_or_else(|e| e.into_inner()).capture_full())
            .await;
    match captured {
        Ok(Ok(bytes)) => (
            [
                (header::CONTENT_TYPE, "image/jpeg".to_owned()),
                (header::CACHE_CONTROL, "no-store".to_owned()),
            ],
            bytes,
        )
            .into_response(),
        Ok(Err(e)) => (StatusCode::SERVICE_UNAVAILABLE, e.to_string()).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use hal_core::{ActuatorId, Caps, DeviceError, Limits, SensorId, CONTRACT_VERSION};
    use std::time::Duration;
    use tower::ServiceExt;

    struct Broken;
    impl Camera for Broken {
        fn name(&self) -> &str {
            "lower"
        }
        fn capture(&mut self) -> Result<Vec<u8>, DeviceError> {
            Err(DeviceError::NotPresent)
        }
    }

    /// Holds its capture open, for a client that doesn't wait.
    struct Slow;
    impl Camera for Slow {
        fn name(&self) -> &str {
            "slow"
        }
        fn capture(&mut self) -> Result<Vec<u8>, DeviceError> {
            std::thread::sleep(Duration::from_millis(100));
            Err(DeviceError::NotPresent)
        }
    }

    /// A state with one camera, for calling the handler directly.
    fn state_with(name: &str, camera: Box<dyn Camera>) -> (AppState, std::sync::mpsc::Receiver<Inbound>) {
        let (state, rx, _) = app_state();
        let mut cameras: BTreeMap<String, SharedCamera> = BTreeMap::new();
        cameras.insert(name.into(), Arc::new(Mutex::new(camera)));
        (
            AppState {
                cameras: Arc::new(cameras),
                ..state
            },
            rx,
        )
    }

    fn app() -> (Router, std::sync::mpsc::Receiver<Inbound>, Arc<AtomicBool>) {
        let (state, rx, connected) = app_state();
        (router(state), rx, connected)
    }

    fn app_state() -> (AppState, std::sync::mpsc::Receiver<Inbound>, Arc<AtomicBool>) {
        let (tx, rx) = std::sync::mpsc::channel();
        let connected = Arc::new(AtomicBool::new(true));
        let mut cameras: BTreeMap<String, SharedCamera> = BTreeMap::new();
        cameras.insert(
            "upper".into(),
            Arc::new(Mutex::new(Box::new(hal_sim::SimCamera::new("upper")))),
        );
        cameras.insert("lower".into(), Arc::new(Mutex::new(Box::new(Broken))));
        cameras.insert("slow".into(), Arc::new(Mutex::new(Box::new(Slow))));
        let snapshot: SharedSnapshot = Arc::default();
        snapshot.write().unwrap().unit_id = "u1".into();
        let state = AppState {
            system: SystemInfo {
                contract: CONTRACT_VERSION,
                unit_id: "u1".into(),
                model: "sim".into(),
                board: None,
                hal_version: "0.1.0".into(),
                caps: Caps {
                    sensors: vec![SensorId::AirTemp],
                    actuators: vec![ActuatorId::Light],
                    cameras: vec!["upper".into(), "lower".into()],
                },
                limits: Limits {
                    pump_max_run_s: 900,
                    pump_max_duty: 30.0,
                    water_low_cm: Some(16.0),
                },
            },
            snapshot,
            cameras: Arc::new(cameras),
            camera_health: CameraHealth::default(),
            state_dir: std::env::temp_dir().join("hald-http-no-such-state"),
            started: Instant::now(),
            mqtt_connected: connected.clone(),
            inbound: tx,
            sim: None,
        };
        (state, rx, connected)
    }

    async fn get_path(app: &Router, path: &str) -> (StatusCode, Option<String>, Vec<u8>) {
        let res = app
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = res.status();
        let ct = res
            .headers()
            .get(header::CONTENT_TYPE)
            .map(|v| v.to_str().unwrap().to_owned());
        let body = axum::body::to_bytes(res.into_body(), 10 << 20)
            .await
            .unwrap()
            .to_vec();
        (status, ct, body)
    }

    async fn post_intake(app: &Router, dry: bool) -> StatusCode {
        let req = Request::post("/sim/intake")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(format!("{{\"dry\":{dry}}}")))
            .unwrap();
        app.clone().oneshot(req).await.unwrap().status()
    }

    #[tokio::test]
    async fn the_sim_intake_switch_exists_only_in_the_sim() {
        let (app, _rx, _) = app();
        assert_eq!(post_intake(&app, true).await, StatusCode::NOT_FOUND);
        let world = hal_sim::world();
        let (state, _rx, _) = app_state();
        let sim = router(AppState {
            sim: Some(world.clone()),
            ..state
        });
        assert_eq!(post_intake(&sim, true).await, StatusCode::OK);
        assert!(world.lock().unwrap().intake_dry);
        assert_eq!(post_intake(&sim, false).await, StatusCode::OK);
        assert!(!world.lock().unwrap().intake_dry);
    }

    #[tokio::test]
    async fn health_reports_uptime_and_mqtt() {
        let (app, _rx, connected) = app();
        let (st, _, body) = get_path(&app, "/health").await;
        assert_eq!(st, StatusCode::OK);
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["mqtt_connected"], true);
        assert!(v["uptime_s"].is_u64());
        connected.store(false, Ordering::Relaxed);
        let (_, _, body) = get_path(&app, "/health").await;
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["mqtt_connected"], false);
    }

    #[tokio::test]
    async fn system_and_state_are_json() {
        let (app, _rx, _) = app();
        let (st, ct, body) = get_path(&app, "/system").await;
        assert_eq!(st, StatusCode::OK);
        assert!(ct.unwrap().starts_with("application/json"));
        let s: SystemInfo = serde_json::from_slice(&body).unwrap();
        assert_eq!(s.unit_id, "u1");
        let (st, _, body) = get_path(&app, "/state").await;
        assert_eq!(st, StatusCode::OK);
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["unitId"], "u1");
        assert!(v["sensors"].is_object());
    }

    #[tokio::test]
    async fn camera_serves_jpeg_reports_failures_and_404s_unknowns() {
        let (app, rx, _) = app();
        let (st, ct, body) = get_path(&app, "/camera/upper.jpg").await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(ct.as_deref(), Some("image/jpeg"));
        assert_eq!(&body[..2], &[0xFF, 0xD8]);
        assert!(matches!(
            rx.try_recv(),
            Ok(Inbound::CameraResult { ok: true, .. })
        ));

        let (st, _, _) = get_path(&app, "/camera/lower.jpg").await;
        assert_eq!(st, StatusCode::SERVICE_UNAVAILABLE);
        match rx.try_recv() {
            Ok(Inbound::CameraResult { name, ok, detail }) => {
                assert_eq!((name.as_str(), ok), ("lower camera", false));
                assert!(detail.contains("not present"));
            }
            other => panic!("{other:?}"),
        }

        // One camera working doesn't hide the other's failure.
        let (st, _, _) = get_path(&app, "/camera/upper.jpg").await;
        assert_eq!(st, StatusCode::OK);
        assert!(matches!(
            rx.try_recv(),
            Ok(Inbound::CameraResult { ok: false, name, .. }) if name == "lower camera"
        ));

        let (st, _, _) = get_path(&app, "/camera/side.jpg").await;
        assert_eq!(st, StatusCode::NOT_FOUND);
        let (st, _, _) = get_path(&app, "/camera/upper.png").await;
        assert_eq!(st, StatusCode::NOT_FOUND);
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn a_client_that_hangs_up_doesnt_lose_the_result() {
        let (app, rx, _) = app();
        let request = tokio::spawn(async move { get_path(&app, "/camera/slow.jpg").await });
        tokio::time::sleep(Duration::from_millis(30)).await;
        request.abort();
        let reported = tokio::task::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(5)))
            .await
            .unwrap();
        assert!(matches!(
            reported,
            Ok(Inbound::CameraResult { ok: false, name, .. }) if name == "slow camera"
        ));
    }

    /// What the engine is told after one report.
    fn report(health: &CameraHealth, name: &str, failure: Option<&str>) -> Inbound {
        let (tx, rx) = std::sync::mpsc::channel();
        health.report(name, failure.map(str::to_owned), &tx);
        rx.try_recv().unwrap()
    }

    fn expect_failure(result: Inbound) -> (String, String) {
        match result {
            Inbound::CameraResult {
                name,
                ok: false,
                detail,
            } => (name, detail),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn camera_missing_stays_up_until_every_camera_has_recovered() {
        let health = CameraHealth::default();
        let (name, detail) = expect_failure(report(&health, "upper", Some("torn")));
        assert_eq!((name.as_str(), detail.as_str()), ("upper camera", "torn"));

        // The other camera's good frame leaves it standing, unchanged.
        let (name, detail) = expect_failure(report(&health, "lower", None));
        assert_eq!((name.as_str(), detail.as_str()), ("upper camera", "torn"));

        // Both failing: the alert names both.
        let (name, detail) = expect_failure(report(&health, "lower", Some("gone")));
        assert_eq!(
            format!("{name}: {detail}"),
            "lower camera: gone; upper camera: torn"
        );

        let (name, detail) = expect_failure(report(&health, "lower", None));
        assert_eq!((name.as_str(), detail.as_str()), ("upper camera", "torn"));

        assert!(matches!(
            report(&health, "upper", None),
            Inbound::CameraResult { ok: true, .. }
        ));
    }

    #[test]
    fn the_engine_hears_results_in_the_order_they_were_recorded() {
        let health = CameraHealth::default();
        let (tx, rx) = std::sync::mpsc::channel();
        let writers: Vec<_> = (0..8)
            .map(|i| {
                let (health, tx) = (health.clone(), tx.clone());
                std::thread::spawn(move || {
                    for n in 0..=200 {
                        let failure = (n % 2 == 1).then(|| "torn".to_owned());
                        health.report(if i % 2 == 0 { "upper" } else { "lower" }, failure, &tx);
                    }
                })
            })
            .collect();
        writers.into_iter().for_each(|w| w.join().unwrap());
        drop(tx);
        // Every writer ends on a success, so whatever arrived last must say all clear.
        assert!(matches!(
            rx.iter().last(),
            Some(Inbound::CameraResult { ok: true, .. })
        ));
    }

    /// A still with `damaged` refused frames along the way.
    struct Glitchy(u32);
    impl Camera for Glitchy {
        fn name(&self) -> &str {
            "glitchy"
        }
        fn capture(&mut self) -> Result<Vec<u8>, DeviceError> {
            Ok(vec![0xFF, 0xD8])
        }
        fn damaged_frames(&self) -> u32 {
            self.0
        }
    }

    #[test]
    fn link_headers_carry_the_damage_and_the_boots_when_known() {
        let h = link_headers(2, Some((8, 10)));
        assert_eq!(h["x-seedypod-damaged-frames"], "2");
        assert_eq!(h["x-seedypod-hub-boots"], "8/10");
        let h = link_headers(0, None);
        assert_eq!(h["x-seedypod-damaged-frames"], "0");
        assert!(!h.contains_key("x-seedypod-hub-boots"));
    }

    #[tokio::test]
    async fn every_still_says_how_many_frames_it_took() {
        let (state, _rx) = state_with("glitchy", Box::new(Glitchy(2)));
        let res = camera(State(state), Path("glitchy.jpg".to_owned())).await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers()["x-seedypod-damaged-frames"], "2");

        // A refused capture says so too.
        let (state, _rx) = state_with("lower", Box::new(Broken));
        let res = camera(State(state), Path("lower.jpg".to_owned())).await;
        assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(res.headers()["x-seedypod-damaged-frames"], "0");
    }

    #[tokio::test]
    async fn a_full_size_still_is_served_without_touching_camera_missing() {
        let (app, rx, _) = app();
        let (st, ct, body) = get_path(&app, "/camera/full/upper.jpg").await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(ct.as_deref(), Some("image/jpeg"));
        assert_eq!(&body[..2], &[0xFF, 0xD8]);

        // A camera without one says so, and the alert hears nothing either way.
        let (st, _, body) = get_path(&app, "/camera/full/lower.jpg").await;
        assert_eq!(st, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            String::from_utf8(body).unwrap(),
            "lower camera has no full-size still"
        );
        assert!(rx.try_recv().is_err());

        let (st, _, _) = get_path(&app, "/camera/full/side.jpg").await;
        assert_eq!(st, StatusCode::NOT_FOUND);
        let (st, _, _) = get_path(&app, "/camera/full/../upper.jpg").await;
        assert_eq!(st, StatusCode::NOT_FOUND);

        // The regular still is unchanged.
        let (st, _, _) = get_path(&app, "/camera/upper.jpg").await;
        assert_eq!(st, StatusCode::OK);
    }

    #[test]
    fn camera_names_are_validated() {
        assert_eq!(camera_name("upper.jpg"), Some("upper"));
        assert_eq!(camera_name("cam-2_x.jpg"), Some("cam-2_x"));
        assert_eq!(camera_name(".jpg"), None);
        assert_eq!(camera_name("upper.png"), None);
        assert_eq!(camera_name("../etc.jpg"), None);
    }
}
