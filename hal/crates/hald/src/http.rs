//! HTTP (axum): health, system info, the state snapshot and camera stills.
//! Stills go through one mutex per camera (upstream #117) and the capture
//! runs on a blocking thread; every result is reported to the engine so
//! `camera_missing` reflects reality.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use hal_core::{Camera, SystemInfo};
use serde_json::json;

use crate::engine::{Inbound, SharedSnapshot};

pub type SharedCamera = Arc<Mutex<Box<dyn Camera>>>;

#[derive(Clone)]
pub struct AppState {
    pub system: SystemInfo,
    pub snapshot: SharedSnapshot,
    pub cameras: Arc<BTreeMap<String, SharedCamera>>,
    pub started: Instant,
    pub mqtt_connected: Arc<AtomicBool>,
    pub inbound: Sender<Inbound>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/system", get(system))
        .route("/state", get(snapshot))
        .route("/camera/{file}", get(camera))
        .with_state(state)
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

async fn camera(State(s): State<AppState>, Path(file): Path<String>) -> Response {
    let Some(name) = camera_name(&file) else {
        return (StatusCode::NOT_FOUND, "expected /camera/<name>.jpg").into_response();
    };
    let Some(cam) = s.cameras.get(name).cloned() else {
        return (StatusCode::NOT_FOUND, format!("no camera {name:?}")).into_response();
    };
    let name = name.to_owned();
    let captured = tokio::task::spawn_blocking(move || {
        let mut c = cam.lock().unwrap_or_else(|e| e.into_inner());
        c.capture()
    })
    .await;
    match captured {
        Ok(Ok(bytes)) => {
            let _ = s.inbound.send(Inbound::CameraResult {
                name,
                ok: true,
                detail: String::new(),
            });
            (
                [
                    (header::CONTENT_TYPE, "image/jpeg".to_owned()),
                    (header::CACHE_CONTROL, "no-store".to_owned()),
                ],
                bytes,
            )
                .into_response()
        }
        Ok(Err(e)) => {
            let _ = s.inbound.send(Inbound::CameraResult {
                name,
                ok: false,
                detail: e.to_string(),
            });
            (StatusCode::SERVICE_UNAVAILABLE, e.to_string()).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use hal_core::{ActuatorId, Caps, DeviceError, Limits, SensorId, CONTRACT_VERSION};
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

    fn app() -> (Router, std::sync::mpsc::Receiver<Inbound>, Arc<AtomicBool>) {
        let (tx, rx) = std::sync::mpsc::channel();
        let connected = Arc::new(AtomicBool::new(true));
        let mut cameras: BTreeMap<String, SharedCamera> = BTreeMap::new();
        cameras.insert(
            "upper".into(),
            Arc::new(Mutex::new(Box::new(hal_sim::SimCamera::new("upper")))),
        );
        cameras.insert("lower".into(), Arc::new(Mutex::new(Box::new(Broken))));
        let snapshot: SharedSnapshot = Arc::default();
        snapshot.write().unwrap().unit_id = "u1".into();
        let state = AppState {
            system: SystemInfo {
                contract: CONTRACT_VERSION,
                unit_id: "u1".into(),
                model: "sim".into(),
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
            started: Instant::now(),
            mqtt_connected: connected.clone(),
            inbound: tx,
        };
        (router(state), rx, connected)
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
                assert_eq!((name.as_str(), ok), ("lower", false));
                assert!(detail.contains("not present"));
            }
            other => panic!("{other:?}"),
        }

        let (st, _, _) = get_path(&app, "/camera/side.jpg").await;
        assert_eq!(st, StatusCode::NOT_FOUND);
        let (st, _, _) = get_path(&app, "/camera/upper.png").await;
        assert_eq!(st, StatusCode::NOT_FOUND);
        assert!(rx.try_recv().is_err());
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
