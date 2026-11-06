//! How much hald logs, set from core: `recording-policy.json` beside core's
//! database (ported from sleepypod's `recording_policy.py`). `quiet` keeps
//! warnings and errors, so pump faults, interlocks and refusals stay visible;
//! `off` keeps nothing; `debugUntil` opens a window that ends by itself, with
//! no timer and no write. Reads never write, and a damaged file means `quiet`.
//!
//! The journal is already in RAM (ADR-0021), so what this saves is CPU and RAM:
//! a dropped event is never formatted.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use tracing::Level;

/// Set by install-hal; without it hald logs as `RUST_LOG` says, as in `--sim` and development.
pub const ENV: &str = "SEEDYPOD_RECORDING_POLICY_FILE";

const RELOAD_EVERY: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LoggingMode {
    #[default]
    Quiet,
    Off,
}

#[derive(Debug, Clone, Copy, PartialEq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PolicyFile {
    #[serde(default)]
    logging_mode: LoggingMode,
    /// Epoch milliseconds.
    debug_until: Option<f64>,
}

fn load(path: &Path) -> PolicyFile {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice::<PolicyFile>(&b).ok())
        .filter(|p| p.debug_until.map_or(true, |u| u >= 0.0))
        .unwrap_or_default()
}

pub struct RecordingPolicy {
    path: PathBuf,
    cached: Mutex<Option<(Instant, PolicyFile)>>,
}

impl RecordingPolicy {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            cached: Mutex::new(None),
        }
    }

    pub fn from_env() -> Option<Self> {
        std::env::var_os(ENV).map(Self::new)
    }

    fn allows_at(&self, level: Level, now: Instant, epoch_ms: f64) -> bool {
        let mut cached = self.cached.lock().unwrap_or_else(|e| e.into_inner());
        let fresh = cached.filter(|(read_at, _)| now.duration_since(*read_at) < RELOAD_EVERY);
        let policy = fresh.map_or_else(|| load(&self.path), |(_, p)| p);
        if fresh.is_none() {
            *cached = Some((now, policy));
        }
        if policy.debug_until.is_some_and(|until| until > epoch_ms) {
            return true;
        }
        policy.logging_mode == LoggingMode::Quiet && level <= Level::WARN
    }

    /// Whether a record at `level` is kept; for the log filter, so before any formatting.
    pub fn allows(&self, level: Level) -> bool {
        let epoch_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
        self.allows_at(level, Instant::now(), epoch_ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch {
        dir: PathBuf,
        file: PathBuf,
    }

    impl Scratch {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("hald-recording-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let file = dir.join("recording-policy.json");
            Self { dir, file }
        }
        fn write(&self, body: &str) {
            std::fs::write(&self.file, body).unwrap();
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn levels(p: &RecordingPolicy, now: Instant, epoch_ms: f64) -> [bool; 4] {
        [Level::ERROR, Level::WARN, Level::INFO, Level::DEBUG].map(|l| p.allows_at(l, now, epoch_ms))
    }

    const QUIET: [bool; 4] = [true, true, false, false];
    const ALL: [bool; 4] = [true, true, true, true];
    const NONE: [bool; 4] = [false, false, false, false];

    #[test]
    fn quiet_by_default_without_creating_the_file() {
        let s = Scratch::new("default");
        let p = RecordingPolicy::new(&s.file);
        assert_eq!(levels(&p, Instant::now(), 0.0), QUIET);
        assert!(!s.file.exists());
    }

    #[test]
    fn off_keeps_nothing() {
        let s = Scratch::new("off");
        s.write(r#"{"loggingMode":"off"}"#);
        assert_eq!(levels(&RecordingPolicy::new(&s.file), Instant::now(), 0.0), NONE);
    }

    #[test]
    fn a_debug_window_ends_by_itself_without_writing() {
        let s = Scratch::new("window");
        let body = r#"{"loggingMode":"off","debugUntil":2000}"#;
        s.write(body);
        let p = RecordingPolicy::new(&s.file);
        let now = Instant::now();
        assert_eq!(levels(&p, now, 1999.0), ALL);
        assert_eq!(levels(&p, now, 2000.0), NONE);
        assert_eq!(std::fs::read_to_string(&s.file).unwrap(), body);
    }

    #[test]
    fn a_damaged_file_keeps_warnings() {
        let s = Scratch::new("damaged");
        for body in [
            "{broken",
            "[]",
            r#"{"loggingMode":"loud"}"#,
            r#"{"loggingMode":"off","debugUntil":"soon"}"#,
            r#"{"loggingMode":"off","debugUntil":-1}"#,
        ] {
            s.write(body);
            assert_eq!(
                levels(&RecordingPolicy::new(&s.file), Instant::now(), 0.0),
                QUIET,
                "{body}"
            );
        }
    }

    #[test]
    fn rereads_after_a_second_and_no_sooner() {
        let s = Scratch::new("reload");
        let p = RecordingPolicy::new(&s.file);
        let start = Instant::now();
        assert_eq!(levels(&p, start, 0.0), QUIET);
        s.write(r#"{"loggingMode":"off"}"#);
        assert_eq!(levels(&p, start + Duration::from_millis(500), 0.0), QUIET);
        assert_eq!(levels(&p, start + Duration::from_secs(1), 0.0), NONE);
    }

    #[test]
    fn allows_reads_the_real_clock() {
        let s = Scratch::new("clock");
        s.write(r#"{"debugUntil":4102444800000}"#);
        assert!(RecordingPolicy::new(&s.file).allows(Level::INFO));
    }
}
