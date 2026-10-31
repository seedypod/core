//! USB UVC still capture via `fswebcam` (one process per frame; no libv4l
//! link-time dependency, so the cross build stays plain).
//!
//! Upstream lessons baked in: skip ≥ 10 frames so auto-exposure settles
//! (#143), and validate the output — `fswebcam` exits 0 with an empty or
//! truncated file when the camera is unplugged (#144). The daemon serialises
//! access per device (#117).

use std::path::{Path, PathBuf};

use hal_core::{Camera, DeviceError};

/// Smallest JPEG we accept as a real frame. A 1280×720 frame is far larger;
/// `fswebcam`'s failure modes produce 0 bytes or a few hundred.
pub const MIN_JPEG_BYTES: usize = 4 * 1024;

/// SOI at the start, EOI at the end, and a sane size.
pub fn jpeg_is_plausible(bytes: &[u8], min_len: usize) -> bool {
    bytes.len() >= min_len.max(4) && bytes.starts_with(&[0xFF, 0xD8]) && bytes.ends_with(&[0xFF, 0xD9])
}

#[derive(Debug, Clone, PartialEq)]
pub struct UvcConfig {
    pub device: PathBuf,
    pub resolution: String,
    pub skip_frames: u32,
    pub jpeg_quality: u8,
    pub min_bytes: usize,
}

impl UvcConfig {
    pub fn new(device: impl Into<PathBuf>) -> Self {
        Self {
            device: device.into(),
            resolution: "1280x720".into(),
            skip_frames: 15,
            jpeg_quality: 85,
            min_bytes: MIN_JPEG_BYTES,
        }
    }
}

/// The `fswebcam` argument vector for one capture into `out`.
pub fn fswebcam_args(cfg: &UvcConfig, out: &Path) -> Vec<String> {
    vec![
        "-q".into(),
        "-d".into(),
        cfg.device.display().to_string(),
        "-r".into(),
        cfg.resolution.clone(),
        "-S".into(),
        cfg.skip_frames.to_string(),
        "--no-banner".into(),
        "--jpeg".into(),
        cfg.jpeg_quality.to_string(),
        "--save".into(),
        out.display().to_string(),
    ]
}

/// Runs an external program; tests substitute a fake that writes the file.
pub trait CommandRunner: Send {
    fn run(&mut self, program: &str, args: &[String]) -> Result<(), DeviceError>;
}

/// `std::process::Command`.
#[derive(Debug, Default)]
pub struct ProcessRunner;

impl CommandRunner for ProcessRunner {
    fn run(&mut self, program: &str, args: &[String]) -> Result<(), DeviceError> {
        let out = std::process::Command::new(program)
            .args(args)
            .output()
            .map_err(|e| DeviceError::Other(format!("{program}: {e}")))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(DeviceError::Other(format!(
                "{program} exited {}: {}",
                out.status,
                String::from_utf8_lossy(&out.stderr).trim()
            )))
        }
    }
}

pub struct UvcCamera<R: CommandRunner> {
    name: String,
    cfg: UvcConfig,
    runner: R,
    scratch: PathBuf,
}

impl<R: CommandRunner> UvcCamera<R> {
    /// `scratch` is a writable directory for the intermediate file.
    pub fn new(name: &str, cfg: UvcConfig, runner: R, scratch: impl Into<PathBuf>) -> Self {
        Self {
            name: name.to_owned(),
            cfg,
            runner,
            scratch: scratch.into(),
        }
    }

    fn out_path(&self) -> PathBuf {
        self.scratch.join(format!("hald-camera-{}.jpg", self.name))
    }
}

impl<R: CommandRunner> Camera for UvcCamera<R> {
    fn name(&self) -> &str {
        &self.name
    }
    fn capture(&mut self) -> Result<Vec<u8>, DeviceError> {
        if !self.cfg.device.exists() {
            return Err(DeviceError::NotPresent);
        }
        let out = self.out_path();
        let _ = std::fs::remove_file(&out);
        self.runner.run("fswebcam", &fswebcam_args(&self.cfg, &out))?;
        let bytes = std::fs::read(&out).map_err(|e| DeviceError::Other(format!("read capture: {e}")))?;
        let _ = std::fs::remove_file(&out);
        if !jpeg_is_plausible(&bytes, self.cfg.min_bytes) {
            return Err(DeviceError::Other(format!(
                "capture from {} is not a plausible JPEG ({} bytes)",
                self.cfg.device.display(),
                bytes.len()
            )));
        }
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let cfg = UvcConfig::new("/dev/video0");
        let a = fswebcam_args(&cfg, Path::new("/tmp/x.jpg"));
        assert!(a.windows(2).any(|w| w == ["-S", "15"]));
        assert!(a.contains(&"--no-banner".to_string()));
        assert!(a.windows(2).any(|w| w == ["-d", "/dev/video0"]));
        assert!(a.windows(2).any(|w| w == ["--save", "/tmp/x.jpg"]));
    }

    /// Writes scripted bytes to the `--save` path.
    struct ScriptedRunner {
        bytes: Option<Vec<u8>>,
        calls: usize,
    }
    impl CommandRunner for ScriptedRunner {
        fn run(&mut self, program: &str, args: &[String]) -> Result<(), DeviceError> {
            assert_eq!(program, "fswebcam");
            self.calls += 1;
            let out = args
                .iter()
                .position(|a| a == "--save")
                .map(|i| &args[i + 1])
                .unwrap();
            if let Some(b) = &self.bytes {
                std::fs::write(out, b).unwrap();
            }
            Ok(())
        }
    }

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hal-drivers-uvc-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn capture_returns_validated_bytes_and_cleans_up() {
        let dir = scratch("ok");
        // Use a path that exists as the "device" so the presence check passes.
        let cfg = UvcConfig::new(dir.clone());
        let mut cam = UvcCamera::new(
            "upper",
            cfg,
            ScriptedRunner {
                bytes: Some(fake_jpeg(5000)),
                calls: 0,
            },
            dir.clone(),
        );
        assert_eq!(cam.name(), "upper");
        let bytes = cam.capture().unwrap();
        assert_eq!(bytes.len(), 5000);
        assert!(!cam.out_path().exists());
        assert_eq!(cam.runner.calls, 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn capture_rejects_tiny_output_and_missing_file() {
        let dir = scratch("bad");
        let mut cam = UvcCamera::new(
            "lower",
            UvcConfig::new(dir.clone()),
            ScriptedRunner {
                bytes: Some(fake_jpeg(200)),
                calls: 0,
            },
            dir.clone(),
        );
        assert!(matches!(cam.capture(), Err(DeviceError::Other(_))));
        let mut cam = UvcCamera::new(
            "lower",
            UvcConfig::new(dir.clone()),
            ScriptedRunner {
                bytes: None,
                calls: 0,
            },
            dir.clone(),
        );
        assert!(matches!(cam.capture(), Err(DeviceError::Other(_))));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn missing_device_node_is_not_present() {
        let mut cam = UvcCamera::new(
            "upper",
            UvcConfig::new("/dev/video-does-not-exist"),
            ScriptedRunner {
                bytes: None,
                calls: 0,
            },
            std::env::temp_dir(),
        );
        assert!(matches!(cam.capture(), Err(DeviceError::NotPresent)));
        assert_eq!(cam.runner.calls, 0);
    }

    #[test]
    fn process_runner_reports_failures() {
        let mut r = ProcessRunner;
        assert!(r.run("/nonexistent/program", &[]).is_err());
        assert!(r.run("false", &[]).is_err());
        assert!(r.run("true", &[]).is_ok());
    }
}
