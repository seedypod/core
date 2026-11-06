//! USB UVC still capture via `fswebcam` (one process per frame; no libv4l
//! link-time dependency, so the cross build stays plain).
//!
//! Upstream lessons baked in: skip ≥ 10 frames so auto-exposure settles
//! (#143), and validate the output — `fswebcam` exits 0 with an empty or
//! truncated file when the camera is unplugged (#144). The daemon serialises
//! access per device (#117).
//!
//! `fswebcam` re-encodes every frame, so its output always has valid markers,
//! even when it shows a torn frame or (when the decode failed and it carried
//! on) a black one. The palette is set explicitly because it otherwise
//! persists per camera between runs, and each capture also dumps the camera's
//! raw frame for [`mjpeg::inspect`](crate::mjpeg::inspect). A bad frame is
//! retried in a new process, which also renegotiates with the camera.
//!
//! A unit can run for months on one camera with a dead link to the other, so a
//! camera that keeps failing gets one try per still instead of a round of
//! retries, and its error reads the same each time: that text becomes the
//! alert, and a detail that changes is republished and rewritten on the card.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::thread;
use std::time::{Duration, Instant};

use hal_core::{Camera, DeviceError};
use tracing::{info, warn};

use crate::mjpeg::{self, FrameScan};

/// Smallest JPEG we accept as a real frame. A 1280×720 frame is far larger;
/// `fswebcam`'s failure modes produce 0 bytes or a few hundred.
pub const MIN_JPEG_BYTES: usize = 4 * 1024;

/// What `fswebcam` and the libraries under it print when a frame went wrong,
/// including on runs that still exit 0 and save a file.
const FAILURE_TEXT: &[&str] = &[
    "gd-jpeg",
    "GD Error",
    "GD Warning",
    "Not a JPEG file",
    "Corrupt JPEG",
    "Timed out",
    "VIDIOC_ENUMINPUT",
    "VIDIOC_DQBUF",
    "VIDIOC_QBUF",
    "stat: ",
];

/// The first line of `fswebcam`'s output that reports a failure.
pub fn failure_line(output: &str) -> Option<&str> {
    output
        .lines()
        .find(|l| FAILURE_TEXT.iter().any(|t| l.contains(t)))
        .map(str::trim)
}

/// SOI at the start, EOI at the end, and a sane size.
pub fn jpeg_is_plausible(bytes: &[u8], min_len: usize) -> bool {
    bytes.len() >= min_len.max(4) && bytes.starts_with(&[0xFF, 0xD8]) && bytes.ends_with(&[0xFF, 0xD9])
}

#[derive(Debug, Clone, PartialEq)]
pub struct UvcConfig {
    /// Preferred node, normally the stable udev name (`/dev/seedypod/camera-upper`).
    pub device: PathBuf,
    /// Used when `device` doesn't exist, e.g. before the udev rules are installed.
    pub fallback: Option<PathBuf>,
    pub resolution: String,
    /// `fswebcam -p`. A raw frame is only inspected for `MJPEG` and `JPEG`.
    pub palette: String,
    pub skip_frames: u32,
    pub jpeg_quality: u8,
    pub min_bytes: usize,
    /// Tries per capture, for a camera that isn't already failing. Each attempt
    /// is a new `fswebcam` process.
    pub attempts: u32,
    /// Wait before retry N: this times N.
    pub retry_delay: Duration,
    /// Kill an `fswebcam` still running after this long.
    pub attempt_timeout: Duration,
    /// Walk the raw frame. Off, only `fswebcam`'s output and file are checked.
    pub inspect_frames: bool,
}

impl UvcConfig {
    pub fn new(device: impl Into<PathBuf>) -> Self {
        Self {
            device: device.into(),
            fallback: None,
            resolution: "1280x960".into(),
            palette: "MJPEG".into(),
            skip_frames: 15,
            jpeg_quality: 85,
            min_bytes: MIN_JPEG_BYTES,
            attempts: 3,
            retry_delay: Duration::from_secs(1),
            attempt_timeout: Duration::from_secs(15),
            inspect_frames: true,
        }
    }
}

impl UvcConfig {
    /// The node to capture from: `device` if present, else `fallback` if present.
    pub fn resolve(&self) -> Option<&Path> {
        if self.device.exists() {
            return Some(&self.device);
        }
        self.fallback.as_deref().filter(|f| f.exists())
    }

    fn raw_frames(&self) -> bool {
        self.inspect_frames && ["MJPEG", "JPEG"].contains(&self.palette.as_str())
    }
}

/// The `fswebcam` argument vector for one capture from `device` into `out`,
/// dumping the camera's own frame to `raw` when given.
pub fn fswebcam_args(cfg: &UvcConfig, device: &Path, out: &Path, raw: Option<&Path>) -> Vec<String> {
    let mut args = vec![
        "-q".into(),
        "-d".into(),
        device.display().to_string(),
        "-r".into(),
        cfg.resolution.clone(),
        "-p".into(),
        cfg.palette.clone(),
        "-S".into(),
        cfg.skip_frames.to_string(),
        "--no-banner".into(),
        "--jpeg".into(),
        cfg.jpeg_quality.to_string(),
    ];
    if let Some(raw) = raw {
        args.extend(["--dumpframe".into(), raw.display().to_string()]);
    }
    args.extend(["--save".into(), out.display().to_string()]);
    args
}

/// Runs an external program for at most `timeout` and returns what it printed;
/// tests substitute a fake that writes the file.
pub trait CommandRunner: Send {
    fn run(&mut self, program: &str, args: &[String], timeout: Duration) -> Result<String, DeviceError>;
}

/// `std::process::Command`.
#[derive(Debug, Default)]
pub struct ProcessRunner;

/// Collect a pipe on its own thread, so a chatty child can't block on it.
fn drain(pipe: Option<impl Read + Send + 'static>) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut p) = pipe {
            let _ = p.read_to_end(&mut bytes);
        }
        bytes
    })
}

impl CommandRunner for ProcessRunner {
    fn run(&mut self, program: &str, args: &[String], timeout: Duration) -> Result<String, DeviceError> {
        let mut child = std::process::Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| DeviceError::Other(format!("{program} didn't start: {e}")))?;
        let (stdout, stderr) = (drain(child.stdout.take()), drain(child.stderr.take()));
        let deadline = Instant::now() + timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
                Ok(None) => {
                    let _ = child.kill();
                    // A process stuck in the kernel on a wedged USB bus outlives the kill: reap it elsewhere.
                    thread::spawn(move || child.wait());
                    return Err(DeviceError::Other(format!(
                        "{program} still running after {}s",
                        timeout.as_secs()
                    )));
                }
                Err(e) => return Err(DeviceError::Other(format!("{program}: {e}"))),
            }
        };
        let mut printed = stdout.join().unwrap_or_default();
        printed.extend(stderr.join().unwrap_or_default());
        let printed = String::from_utf8_lossy(&printed).into_owned();
        if status.success() {
            Ok(printed)
        } else {
            Err(DeviceError::Other(format!(
                "{program} failed: {status}: {}",
                printed.trim()
            )))
        }
    }
}

pub struct UvcCamera<R: CommandRunner> {
    name: String,
    cfg: UvcConfig,
    runner: R,
    scratch: PathBuf,
    /// The last capture used up its attempts.
    failing: bool,
    fallback_check: FallbackCheck,
}

/// Decides whether `fallback` really is this camera. `/dev/videoN` numbers shift
/// when a camera fails to bind, so the answer can change between two attempts.
pub type FallbackCheck = Box<dyn Fn(&Path) -> Result<(), DeviceError> + Send>;

impl<R: CommandRunner> UvcCamera<R> {
    /// `scratch` is a writable directory for the intermediate file.
    pub fn new(name: &str, cfg: UvcConfig, runner: R, scratch: impl Into<PathBuf>) -> Self {
        Self {
            name: name.to_owned(),
            cfg,
            runner,
            scratch: scratch.into(),
            failing: false,
            fallback_check: Box::new(|_| Ok(())),
        }
    }

    /// Ask `check` about the fallback each time it is about to be used.
    pub fn with_fallback_check(
        mut self,
        check: impl Fn(&Path) -> Result<(), DeviceError> + Send + 'static,
    ) -> Self {
        self.fallback_check = Box::new(check);
        self
    }

    /// The node to capture from now. Called for every attempt: a camera can drop
    /// off the bus mid-retry, and its fallback may by then be the other camera.
    fn node(&self) -> Result<PathBuf, DeviceError> {
        let node = self.cfg.resolve().ok_or(DeviceError::NotPresent)?;
        if node != self.cfg.device {
            (self.fallback_check)(node)?;
        }
        Ok(node.to_path_buf())
    }

    fn out_path(&self) -> PathBuf {
        self.scratch.join(format!("hald-camera-{}.jpg", self.name))
    }

    fn raw_path(&self) -> PathBuf {
        self.scratch.join(format!("hald-camera-{}.raw", self.name))
    }

    /// One `fswebcam` run, leaving no files behind.
    fn attempt(&mut self, device: &Path) -> Result<Vec<u8>, DeviceError> {
        let (out, raw) = (self.out_path(), self.raw_path());
        let _ = std::fs::remove_file(&out);
        let _ = std::fs::remove_file(&raw);
        let result = self.run_and_check(device, &out, &raw);
        let _ = std::fs::remove_file(&out);
        let _ = std::fs::remove_file(&raw);
        result
    }

    fn run_and_check(&mut self, device: &Path, out: &Path, raw: &Path) -> Result<Vec<u8>, DeviceError> {
        let inspect = self.cfg.raw_frames();
        let args = fswebcam_args(&self.cfg, device, out, inspect.then_some(raw));
        let printed = self.runner.run("fswebcam", &args, self.cfg.attempt_timeout)?;
        if let Some(line) = failure_line(&printed) {
            return Err(DeviceError::Other(format!("fswebcam reported: {line}")));
        }
        let bytes = std::fs::read(out).map_err(|e| DeviceError::Other(format!("read capture: {e}")))?;
        if !jpeg_is_plausible(&bytes, self.cfg.min_bytes) {
            return Err(DeviceError::Other(format!(
                "not a plausible JPEG: {} bytes from {}",
                bytes.len(),
                device.display()
            )));
        }
        if inspect {
            let frame = std::fs::read(raw).map_err(|e| DeviceError::Other(format!("read raw frame: {e}")))?;
            match mjpeg::inspect(&frame) {
                Ok(FrameScan::Complete) => {}
                Ok(FrameScan::NotInspected(why)) => {
                    warn!(camera = %self.name, why, "raw frame not inspected")
                }
                Err(e) => return Err(DeviceError::Other(format!("damaged frame: {e}"))),
            }
        }
        Ok(bytes)
    }
}

impl<R: CommandRunner> Camera for UvcCamera<R> {
    fn name(&self) -> &str {
        &self.name
    }
    fn capture(&mut self) -> Result<Vec<u8>, DeviceError> {
        let attempts = if self.failing { 1 } else { self.cfg.attempts.max(1) };
        let mut last = None;
        for attempt in 1..=attempts {
            // Looked up each time: a camera that drops off the bus mid-retry is missing, not failing.
            let device = self.node()?;
            match self.attempt(&device) {
                Ok(bytes) => {
                    if attempt > 1 || self.failing {
                        info!(camera = %self.name, attempt, "capture recovered");
                    }
                    self.failing = false;
                    return Ok(bytes);
                }
                Err(e) => {
                    warn!(camera = %self.name, attempt, attempts, %e, "capture rejected");
                    last = Some(e);
                }
            }
            if attempt < attempts {
                thread::sleep(self.cfg.retry_delay * attempt);
            }
        }
        self.failing = true;
        let last = last.map(|e| e.to_string()).unwrap_or_default();
        // The kind of failure only: the specifics are in the log above.
        let kind = last.split_once(": ").map_or(last.as_str(), |(kind, _)| kind);
        Err(DeviceError::Other(format!("no good frame: {kind}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    /// A real frame: the walker has to accept it.
    const GOOD_RAW: &[u8] = include_bytes!("../../hal-sim/fixtures/lower.jpg");

    fn fake_jpeg(len: usize) -> Vec<u8> {
        let mut v = vec![0u8; len];
        v[0] = 0xFF;
        v[1] = 0xD8;
        v[len - 2] = 0xFF;
        v[len - 1] = 0xD9;
        v
    }

    #[test]
    fn plausibility_checks_markers_and_size() {
        assert!(jpeg_is_plausible(&fake_jpeg(5000), 4096));
        assert!(!jpeg_is_plausible(&fake_jpeg(100), 4096));
        assert!(!jpeg_is_plausible(&[], 0));
        let mut truncated = fake_jpeg(5000);
        truncated.truncate(4999);
        assert!(!jpeg_is_plausible(&truncated, 4096));
        let mut not_jpeg = fake_jpeg(5000);
        not_jpeg[0] = 0x89;
        assert!(!jpeg_is_plausible(&not_jpeg, 4096));
    }

    #[test]
    fn args_follow_the_upstream_lessons() {
        let cfg = UvcConfig::new("/dev/seedypod/camera-upper");
        let a = fswebcam_args(
            &cfg,
            Path::new("/dev/video0"),
            Path::new("/tmp/x.jpg"),
            Some(Path::new("/tmp/x.raw")),
        );
        assert!(a.windows(2).any(|w| w == ["-S", "15"]));
        assert!(a.contains(&"--no-banner".to_string()));
        assert!(a.windows(2).any(|w| w == ["-d", "/dev/video0"]));
        assert!(a.windows(2).any(|w| w == ["--save", "/tmp/x.jpg"]));
        assert!(a.windows(2).any(|w| w == ["-p", "MJPEG"]));
        assert!(a.windows(2).any(|w| w == ["-r", "1280x960"]));
        assert!(a.windows(2).any(|w| w == ["--dumpframe", "/tmp/x.raw"]));
        // `--save` is a job that runs when reached: everything global goes first.
        assert_eq!(a[a.len() - 2], "--save");
        let a = fswebcam_args(&cfg, Path::new("/dev/video0"), Path::new("/tmp/x.jpg"), None);
        assert!(!a.contains(&"--dumpframe".to_string()));
    }

    #[test]
    fn failure_text_is_found_on_any_line_and_noise_is_not() {
        assert_eq!(
            failure_line("Adjusting resolution\n  GD Warning: gd-jpeg: JPEG library reports unrecoverable error: Not a JPEG file\n"),
            Some("GD Warning: gd-jpeg: JPEG library reports unrecoverable error: Not a JPEG file")
        );
        assert_eq!(
            failure_line("Timed out waiting for frame!"),
            Some("Timed out waiting for frame!")
        );
        assert_eq!(
            failure_line("stat: No such file or directory"),
            Some("stat: No such file or directory")
        );
        assert_eq!(
            failure_line("Adjusting resolution from 1280x960 to 1280x720.\nstatus ok"),
            None
        );
        assert_eq!(failure_line(""), None);
    }

    /// One scripted `fswebcam` run.
    #[derive(Default)]
    struct Run {
        saved: Option<Vec<u8>>,
        raw: Option<Vec<u8>>,
        printed: &'static str,
        fails: bool,
        /// Deletes this path, as if the camera dropped off the bus.
        unplugs: Option<PathBuf>,
    }

    /// A run that saved a good picture of a good frame.
    fn good() -> Run {
        Run {
            saved: Some(fake_jpeg(5000)),
            raw: Some(GOOD_RAW.to_vec()),
            ..Run::default()
        }
    }

    /// Plays one `Run` per call; the last repeats.
    struct ScriptedRunner {
        runs: VecDeque<Run>,
        calls: usize,
        timeout: Option<Duration>,
    }

    fn scripted(runs: Vec<Run>) -> ScriptedRunner {
        ScriptedRunner {
            runs: runs.into(),
            calls: 0,
            timeout: None,
        }
    }

    fn after(args: &[String], flag: &str) -> Option<String> {
        args.iter().position(|a| a == flag).map(|i| args[i + 1].clone())
    }

    impl CommandRunner for ScriptedRunner {
        fn run(&mut self, program: &str, args: &[String], timeout: Duration) -> Result<String, DeviceError> {
            assert_eq!(program, "fswebcam");
            self.calls += 1;
            self.timeout = Some(timeout);
            let run = self.runs.pop_front().expect("no more runs scripted");
            if let Some(b) = &run.saved {
                std::fs::write(after(args, "--save").unwrap(), b).unwrap();
            }
            if let (Some(b), Some(path)) = (&run.raw, after(args, "--dumpframe")) {
                std::fs::write(path, b).unwrap();
            }
            if let Some(p) = &run.unplugs {
                std::fs::remove_dir_all(p).unwrap();
            }
            if run.fails {
                return Err(DeviceError::Other("fswebcam failed: exit status: 1: boom".into()));
            }
            Ok(run.printed.to_owned())
        }
    }

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hal-drivers-uvc-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// A config whose device exists, with no wait between retries.
    fn cfg(dir: &Path) -> UvcConfig {
        UvcConfig {
            retry_delay: Duration::ZERO,
            ..UvcConfig::new(dir)
        }
    }

    fn camera(dir: &Path, runs: Vec<Run>) -> UvcCamera<ScriptedRunner> {
        UvcCamera::new("upper", cfg(dir), scripted(runs), dir)
    }

    fn error(result: Result<Vec<u8>, DeviceError>) -> String {
        match result {
            Err(DeviceError::Other(e)) => e,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_good_frame_is_returned_first_time_and_nothing_is_left_behind() {
        let dir = scratch("ok");
        let mut cam = camera(&dir, vec![good()]);
        assert_eq!(cam.name(), "upper");
        assert_eq!(cam.capture().unwrap().len(), 5000);
        assert!(!cam.out_path().exists());
        assert!(!cam.raw_path().exists());
        assert_eq!(cam.runner.calls, 1);
        assert_eq!(cam.runner.timeout, Some(Duration::from_secs(15)));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn what_comes_back_is_fswebcams_file_not_the_raw_frame() {
        let dir = scratch("saved");
        let mut cam = camera(&dir, vec![good()]);
        assert_eq!(cam.capture().unwrap(), fake_jpeg(5000));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_truncated_raw_frame_fails_even_though_the_saved_file_looks_fine() {
        let dir = scratch("torn");
        let torn = || Run {
            raw: Some(GOOD_RAW[..GOOD_RAW.len() / 2].to_vec()),
            ..good()
        };
        let mut cam = camera(&dir, vec![torn(), torn(), torn()]);
        let e = error(cam.capture());
        assert_eq!(e, "no good frame: damaged frame");
        assert_eq!(cam.runner.calls, 3);
        assert!(!cam.out_path().exists());
        assert!(!cam.raw_path().exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn error_text_fails_a_capture_whose_files_look_valid() {
        let dir = scratch("text");
        let warned = || Run {
            printed: "GD Warning: gd-jpeg: JPEG library reports unrecoverable error: Not a JPEG file",
            ..good()
        };
        let mut cam = camera(&dir, vec![warned(), warned(), warned()]);
        let e = error(cam.capture());
        assert_eq!(e, "no good frame: fswebcam reported");
        assert_eq!(cam.runner.calls, 3);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_retry_that_gets_a_good_frame_succeeds() {
        let dir = scratch("retry");
        let torn = Run {
            raw: Some(vec![0x12, 0x34]),
            ..good()
        };
        let exited = Run {
            fails: true,
            ..Run::default()
        };
        let mut cam = camera(&dir, vec![torn, exited, good()]);
        assert_eq!(cam.capture().unwrap().len(), 5000);
        assert_eq!(cam.runner.calls, 3);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn exhausted_retries_report_the_last_reason_and_stop() {
        let dir = scratch("exhausted");
        let mut cam = camera(
            &dir,
            vec![
                Run {
                    printed: "Timed out waiting for frame!",
                    ..good()
                },
                Run {
                    saved: Some(fake_jpeg(200)),
                    ..good()
                },
                Run {
                    fails: true,
                    ..Run::default()
                },
            ],
        );
        let e = error(cam.capture());
        assert_eq!(e, "no good frame: fswebcam failed");
        assert_eq!(cam.runner.calls, 3);
        let _ = std::fs::remove_dir_all(dir);
    }

    fn torn_at(cut: usize) -> Run {
        Run {
            raw: Some(GOOD_RAW[..cut].to_vec()),
            ..good()
        }
    }

    #[test]
    fn a_camera_that_keeps_failing_gets_one_try_per_still_until_it_recovers() {
        let dir = scratch("calm");
        let cut = GOOD_RAW.len() / 2;
        let mut runs: Vec<Run> = (0..5).map(|_| torn_at(cut)).collect();
        runs.extend([good(), torn_at(cut), good()]);
        let mut cam = camera(&dir, runs);
        assert!(cam.capture().is_err());
        assert_eq!(cam.runner.calls, 3);
        assert!(cam.capture().is_err());
        assert_eq!(cam.runner.calls, 4);
        assert!(cam.capture().is_err());
        assert_eq!(cam.runner.calls, 5);
        assert!(cam.capture().is_ok());
        assert_eq!(cam.runner.calls, 6);
        // Recovered, so it gets its retries back.
        assert!(cam.capture().is_ok());
        assert_eq!(cam.runner.calls, 8);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_error_reads_the_same_however_the_frame_was_torn() {
        let dir = scratch("stable");
        let n = GOOD_RAW.len();
        let mut cam = camera(
            &dir,
            vec![torn_at(n / 2), torn_at(n / 2), torn_at(n / 2), torn_at(n / 3)],
        );
        let first = error(cam.capture());
        assert_eq!(error(cam.capture()), first);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn retries_back_off_longer_each_time() {
        let dir = scratch("backoff");
        let mut cam = camera(&dir, vec![Run::default(), Run::default(), Run::default()]);
        cam.cfg.retry_delay = Duration::from_millis(30);
        let started = Instant::now();
        assert!(cam.capture().is_err());
        assert!(started.elapsed() >= Duration::from_millis(90));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn zero_attempts_still_means_one() {
        let dir = scratch("zero");
        let mut cam = camera(&dir, vec![good()]);
        cam.cfg.attempts = 0;
        assert!(cam.capture().is_ok());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_camera_that_drops_off_mid_retry_is_missing_not_failing() {
        let dir = scratch("unplug");
        let device = dir.join("video0");
        std::fs::create_dir_all(&device).unwrap();
        let mut cam = UvcCamera::new(
            "upper",
            cfg(&device),
            scripted(vec![Run {
                unplugs: Some(device.clone()),
                ..Run::default()
            }]),
            dir.clone(),
        );
        assert!(matches!(cam.capture(), Err(DeviceError::NotPresent)));
        assert_eq!(cam.runner.calls, 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_missing_raw_frame_is_a_failure() {
        let dir = scratch("noraw");
        let run = || Run { raw: None, ..good() };
        let mut cam = camera(&dir, vec![run(), run(), run()]);
        assert!(error(cam.capture()).contains("read raw frame"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_raw_frame_the_walker_cant_read_is_let_through() {
        let dir = scratch("uninspected");
        let mut progressive = GOOD_RAW.to_vec();
        let sof = progressive.windows(2).position(|w| w == [0xFF, 0xC0]).unwrap();
        progressive[sof + 1] = 0xC2;
        let mut cam = camera(
            &dir,
            vec![Run {
                raw: Some(progressive),
                ..good()
            }],
        );
        assert!(cam.capture().is_ok());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn raw_frames_are_only_asked_for_when_they_can_be_read() {
        let dir = scratch("noinspect");
        // Scripted runs with no `raw` would fail if `--dumpframe` were passed and read.
        for change in [
            (|c: &mut UvcConfig| c.inspect_frames = false) as fn(&mut UvcConfig),
            |c| c.palette = "YUYV".into(),
        ] {
            let mut cam = camera(&dir, vec![Run { raw: None, ..good() }]);
            change(&mut cam.cfg);
            assert!(cam.capture().is_ok());
        }
        let mut cam = camera(&dir, vec![good()]);
        cam.cfg.palette = "JPEG".into();
        assert!(cam.capture().is_ok());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn capture_rejects_tiny_output_and_missing_file() {
        let dir = scratch("bad");
        let tiny = || Run {
            saved: Some(fake_jpeg(200)),
            ..good()
        };
        let mut cam = camera(&dir, vec![tiny(), tiny(), tiny()]);
        assert!(error(cam.capture()).contains("not a plausible JPEG"));
        let mut cam = camera(&dir, vec![Run::default(), Run::default(), Run::default()]);
        assert!(error(cam.capture()).contains("read capture"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn missing_device_node_is_not_present() {
        let mut cam = UvcCamera::new(
            "upper",
            UvcConfig::new("/dev/video-does-not-exist"),
            scripted(vec![]),
            std::env::temp_dir(),
        );
        assert!(matches!(cam.capture(), Err(DeviceError::NotPresent)));
        assert_eq!(cam.runner.calls, 0);
    }

    #[test]
    fn falls_back_when_the_stable_name_is_missing() {
        let dir = scratch("fallback");
        let mut cfg = UvcConfig::new("/dev/seedypod/camera-does-not-exist");
        assert_eq!(cfg.resolve(), None);
        cfg.fallback = Some("/dev/video-does-not-exist".into());
        assert_eq!(cfg.resolve(), None);
        cfg.fallback = Some(dir.clone());
        assert_eq!(cfg.resolve(), Some(dir.as_path()));
        let mut cam = UvcCamera::new("upper", cfg.clone(), scripted(vec![good()]), dir.clone());
        assert_eq!(cam.capture().unwrap().len(), 5000);
        // The stable name wins as soon as it exists.
        cfg.device = std::env::temp_dir();
        assert_eq!(cfg.resolve(), Some(std::env::temp_dir().as_path()));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// `upper` on a stable link with a fallback node, both real paths.
    fn with_fallback(dir: &Path, runs: Vec<Run>) -> (UvcCamera<ScriptedRunner>, PathBuf) {
        let (device, fallback) = (dir.join("camera-upper"), dir.join("video0"));
        std::fs::create_dir_all(&device).unwrap();
        std::fs::create_dir_all(&fallback).unwrap();
        let mut c = cfg(&device);
        c.fallback = Some(fallback);
        (UvcCamera::new("upper", c, scripted(runs), dir), device)
    }

    #[test]
    fn a_fallback_is_checked_on_every_attempt_not_just_the_first() {
        let dir = scratch("midretry");
        let device = dir.join("camera-upper");
        // The first attempt reads the stable link, gets a bad frame, and the camera drops off.
        let drops_off = Run {
            raw: Some(vec![0x12, 0x34]),
            unplugs: Some(device.clone()),
            ..good()
        };
        let (cam, _) = with_fallback(&dir, vec![drops_off]);
        let asked = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = asked.clone();
        let mut cam = cam.with_fallback_check(move |_| {
            counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Err(DeviceError::NotPresent)
        });
        // video0 is the other camera now: no second run, and nothing saved under this name.
        assert!(matches!(cam.capture(), Err(DeviceError::NotPresent)));
        assert_eq!(cam.runner.calls, 1);
        assert_eq!(asked.load(std::sync::atomic::Ordering::Relaxed), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_stable_link_needs_no_check_and_a_good_fallback_is_used() {
        let dir = scratch("checked");
        let (cam, _) = with_fallback(&dir, vec![good()]);
        let mut cam = cam.with_fallback_check(|_| panic!("the stable link is enough"));
        assert!(cam.capture().is_ok());

        let (cam, device) = with_fallback(&dir, vec![good()]);
        std::fs::remove_dir_all(device).unwrap();
        let mut cam = cam.with_fallback_check(|node| {
            assert!(node.ends_with("video0"));
            Ok(())
        });
        assert!(cam.capture().is_ok());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_refusal_says_why_and_runs_nothing() {
        let dir = scratch("refused");
        let (cam, device) = with_fallback(&dir, vec![]);
        std::fs::remove_dir_all(device).unwrap();
        let mut cam = cam.with_fallback_check(|_| Err(DeviceError::Other("pin it".into())));
        assert_eq!(error(cam.capture()), "pin it");
        assert_eq!(cam.runner.calls, 0);
        let _ = std::fs::remove_dir_all(dir);
    }

    const SECOND: Duration = Duration::from_secs(1);

    #[test]
    fn process_runner_reports_failures() {
        let mut r = ProcessRunner;
        assert!(r.run("/nonexistent/program", &[], SECOND).is_err());
        assert!(r.run("false", &[], SECOND).is_err());
        assert_eq!(r.run("true", &[], SECOND).unwrap(), "");
    }

    #[test]
    fn process_runner_returns_both_streams() {
        let script = ["-c".to_owned(), "echo out; echo err >&2".to_owned()];
        let printed = ProcessRunner.run("sh", &script, SECOND).unwrap();
        assert!(printed.contains("out") && printed.contains("err"), "{printed}");
        let script = ["-c".to_owned(), "echo why >&2; exit 3".to_owned()];
        let Err(DeviceError::Other(e)) = ProcessRunner.run("sh", &script, SECOND) else {
            panic!("should fail");
        };
        assert!(e.contains("why"), "{e}");
    }

    #[test]
    fn process_runner_kills_what_outlives_its_timeout() {
        let started = Instant::now();
        let args = ["10".to_owned()];
        let Err(DeviceError::Other(e)) = ProcessRunner.run("sleep", &args, Duration::from_millis(100)) else {
            panic!("should time out");
        };
        assert!(e.contains("still running"), "{e}");
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
