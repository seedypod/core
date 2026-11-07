//! How much hald logs, set from core: `recording-policy.json` beside core's
//! database (ported from sleepypod's `recording_policy.py`). `quiet` keeps
//! warnings and errors, so pump faults, interlocks and refusals stay visible;
//! `off` keeps errors alone, where sleepypod keeps nothing, because a device
//! running a pump must not go silent about a failure; `debugUntil` opens a window
//! that ends by itself, with no timer and no write. A window further off than
//! the API allows counts as none, or a hand-edited file could stay open for ever.
//! Reads never write, and a damaged file means `quiet`.
//!
//! The journal is already in RAM (ADR-0021), so what this saves is CPU and RAM:
//! a dropped event is never formatted.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use tracing::{Level, Subscriber};
use tracing_subscriber::filter::dynamic_filter_fn;
use tracing_subscriber::layer::Filter;

/// Set by install-hal; without it hald logs as `RUST_LOG` says, as in `--sim` and development.
pub const ENV: &str = "SEEDYPOD_RECORDING_POLICY_FILE";

const RELOAD_EVERY: Duration = Duration::from_secs(1);
/// The most the API opens a window for: 240 minutes, in the file's milliseconds.
const MAX_DEBUG_MS: f64 = 240.0 * 60_000.0;

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
    reload_every: Duration,
    cached: Mutex<Option<(Instant, PolicyFile)>>,
}

impl RecordingPolicy {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            reload_every: RELOAD_EVERY,
            cached: Mutex::new(None),
        }
    }

    pub fn from_env() -> Option<Self> {
        std::env::var_os(ENV).map(Self::new)
    }

    fn allows_at(&self, level: Level, now: Instant, epoch_ms: f64) -> bool {
        let mut cached = self.cached.lock().unwrap_or_else(|e| e.into_inner());
        let fresh = cached.filter(|(read_at, _)| now.duration_since(*read_at) < self.reload_every);
        let policy = fresh.map_or_else(|| load(&self.path), |(_, p)| p);
        if fresh.is_none() {
            *cached = Some((now, policy));
        }
        if policy
            .debug_until
            .is_some_and(|until| until > epoch_ms && until - epoch_ms <= MAX_DEBUG_MS)
        {
            return true;
        }
        match policy.logging_mode {
            LoggingMode::Quiet => level <= Level::WARN,
            LoggingMode::Off => level == Level::ERROR,
        }
    }

    /// Whether a record at `level` is kept; for the log filter, so before any formatting.
    pub fn allows(&self, level: Level) -> bool {
        let epoch_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
        self.allows_at(level, Instant::now(), epoch_ms)
    }
}

/// The log filter. Dynamic, because a plain `filter_fn` result gets cached per log line:
/// a line that first passes in a debug window would then pass for ever.
pub fn log_filter<S: Subscriber>(policy: Option<RecordingPolicy>) -> impl Filter<S> {
    dynamic_filter_fn(move |meta, _| policy.as_ref().map_or(true, |p| p.allows(*meta.level())))
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
    const ERRORS: [bool; 4] = [true, false, false, false];

    #[test]
    fn quiet_by_default_without_creating_the_file() {
        let s = Scratch::new("default");
        let p = RecordingPolicy::new(&s.file);
        assert_eq!(levels(&p, Instant::now(), 0.0), QUIET);
        assert!(!s.file.exists());
    }

    #[test]
    fn off_keeps_only_errors() {
        let s = Scratch::new("off");
        s.write(r#"{"loggingMode":"off"}"#);
        assert_eq!(
            levels(&RecordingPolicy::new(&s.file), Instant::now(), 0.0),
            ERRORS
        );
    }

    #[test]
    fn a_window_further_off_than_the_api_allows_counts_as_none() {
        let s = Scratch::new("cap");
        s.write(&format!(r#"{{"debugUntil":{}}}"#, MAX_DEBUG_MS + 1.0));
        assert_eq!(levels(&RecordingPolicy::new(&s.file), Instant::now(), 0.0), QUIET);
        s.write(&format!(r#"{{"debugUntil":{MAX_DEBUG_MS}}}"#));
        assert_eq!(levels(&RecordingPolicy::new(&s.file), Instant::now(), 0.0), ALL);
    }

    #[test]
    fn a_debug_window_ends_by_itself_without_writing() {
        let s = Scratch::new("window");
        let body = r#"{"loggingMode":"off","debugUntil":2000}"#;
        s.write(body);
        let p = RecordingPolicy::new(&s.file);
        let now = Instant::now();
        assert_eq!(levels(&p, now, 1999.0), ALL);
        assert_eq!(levels(&p, now, 2000.0), ERRORS);
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
        assert_eq!(levels(&p, start + Duration::from_secs(1), 0.0), ERRORS);
    }

    #[test]
    fn allows_reads_the_real_clock() {
        let s = Scratch::new("clock");
        let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis();
        s.write(&format!(r#"{{"debugUntil":{}}}"#, now_ms + 60_000));
        assert!(RecordingPolicy::new(&s.file).allows(Level::INFO));
    }

    /// tracing caches interest per log line for the process, so this needs a global
    /// subscriber and a process of its own, or the bug it guards against stays hidden.
    #[test]
    fn a_log_line_follows_the_policy_every_time_it_is_hit() {
        let out = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "recording::tests::same_lines_across_modes",
                "--ignored",
            ])
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(out.status.success() && stdout.contains("1 passed"), "{stdout}");
    }

    #[test]
    #[ignore = "run in its own process by the test above"]
    fn same_lines_across_modes() {
        use std::io::Write;
        use std::sync::Arc;
        use tracing_subscriber::layer::{Layer, SubscriberExt};
        use tracing_subscriber::util::SubscriberInitExt;

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

        let s = Scratch::new("modes");
        let mut policy = RecordingPolicy::new(&s.file);
        policy.reload_every = Duration::ZERO;
        let buf = Buf::default();
        let sink = buf.clone();
        tracing_subscriber::registry()
            .with(
                tracing_subscriber::fmt::layer()
                    .with_writer(move || sink.clone())
                    .with_filter(log_filter(Some(policy))),
            )
            .init();
        let hit = |file: &str| {
            s.write(file);
            buf.0.lock().unwrap().clear();
            for _ in 0..2 {
                tracing::info!("routine");
                tracing::warn!("trouble");
                tracing::error!("failure");
            }
            let log = String::from_utf8_lossy(&buf.0.lock().unwrap()).into_owned();
            ["routine", "trouble", "failure"].map(|l| log.contains(l))
        };
        let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis();
        let window = format!(r#"{{"debugUntil":{}}}"#, now_ms + 60_000);
        assert_eq!(hit(&window), [true, true, true], "lines pass first in a window");
        assert_eq!(hit("{}"), [false, true, true], "and don't stay on after it");
        assert_eq!(hit(r#"{"loggingMode":"off"}"#), [false, false, true]);
        assert_eq!(hit(&window), [true, true, true]);
    }
}
