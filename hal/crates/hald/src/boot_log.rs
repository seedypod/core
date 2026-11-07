//! A line per boot that survives the boot. The journal is in RAM (ADR-0021), so a
//! reboot wipes the evidence of why it happened. `hald --usb-recover` runs once per
//! boot, as root, once the boot has settled and just before any reboot it asks for,
//! so it adds one line here: a few hundred bytes a boot. Core serves the file and
//! reads the hub rate from it, which is how a cable swap gets judged.
//!
//! Only counts and hardware readings: no SSIDs, addresses or log text. The Pi has no
//! real-time clock, so a boot that hasn't reached NTP is tagged `clock=stale`, and
//! `up` says how far into the boot the line was written whatever the clock said.

use std::fmt::Write as _;
use std::io::Write as _;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

use crate::usb::Recovery;

pub const FILE: &str = "boot-log";

/// Lines kept. It is only cut back once past `TRIM_AT`, so the whole file is
/// rewritten once every 50 boots, not on every boot.
const KEPT: usize = 500;
const TRIM_AT: usize = 550;

/// One boot. `None` is written as `-`: not known, or not on this kind of unit.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Facts {
    pub ts: String,
    pub clock_synced: bool,
    pub up_s: u64,
    pub boot_id: Option<String>,
    /// Seconds from boot until core's service was up.
    pub core_s: Option<u64>,
    /// Whether the USB hub came up by itself.
    pub hub: Option<bool>,
    pub hprt0: Option<String>,
    pub cameras: usize,
    /// Reboots in a row for a missing hub, this one included.
    pub reboots: Option<u32>,
    /// Whether the last shutdown was clean.
    pub clean: Option<bool>,
    pub temp_c: Option<f64>,
    /// Log lines at `err` or worse so far this boot.
    pub errors: Option<usize>,
    pub outcome: &'static str,
}

fn or_dash<T: ToString>(value: &Option<T>) -> String {
    value.as_ref().map_or_else(|| "-".to_owned(), ToString::to_string)
}

fn flag(value: Option<bool>) -> String {
    or_dash(&value.map(u8::from))
}

impl Facts {
    /// `key=value` after the timestamp, so a new field never breaks an old reader.
    pub fn line(&self) -> String {
        let mut line = self.ts.clone();
        let _ = write!(
            line,
            " clock={} up={} boot={} core_s={} hub={} hprt0={} cameras={} reboots={} clean={} temp={} errors={} outcome={}",
            if self.clock_synced { "synced" } else { "stale" },
            self.up_s,
            or_dash(&self.boot_id),
            or_dash(&self.core_s),
            flag(self.hub),
            or_dash(&self.hprt0),
            self.cameras,
            or_dash(&self.reboots),
            flag(self.clean),
            or_dash(&self.temp_c.map(|t| format!("{t:.1}"))),
            or_dash(&self.errors),
            self.outcome,
        );
        line
    }
}

/// Short for a log line: a boot only has to be told from the ones around it.
fn parse_boot_id(text: &str) -> Option<String> {
    let id: String = text
        .trim()
        .chars()
        .filter(char::is_ascii_hexdigit)
        .take(8)
        .collect();
    (id.len() == 8).then_some(id)
}

/// `dwc_otg` shows the register as `hprt0 = 0x00001c00`.
fn parse_hprt0(text: &str) -> Option<String> {
    let value = text.rsplit(' ').next()?.trim();
    let digits = value.strip_prefix("0x")?;
    (!digits.is_empty() && digits.chars().all(|c| c.is_ascii_hexdigit())).then(|| value.to_owned())
}

/// `systemctl show` gives microseconds since boot, or 0 for a service that isn't up.
fn parse_core_s(text: &str) -> Option<u64> {
    let micros: u64 = text.trim().parse().ok()?;
    (micros > 0).then_some(micros / 1_000_000)
}

/// ext4 replays its journal only after an unclean shutdown, and says so.
fn parse_clean(kernel_log: &str) -> bool {
    !kernel_log.contains("recovery complete")
}

fn parse_temp_c(text: &str) -> Option<f64> {
    text.trim().parse::<f64>().ok().map(|milli| milli / 1000.0)
}

fn outcome(recovery: &Recovery) -> &'static str {
    match recovery {
        Recovery::AlreadyUp => "up",
        Recovery::Recovered { .. } => "recovered",
        Recovery::Reboot { .. } => "reboot",
        Recovery::NotRebooting(_) => "held",
        Recovery::GaveUp { .. } => "gave-up",
        Recovery::NoAction(_) => "none",
    }
}

fn output(program: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(program).args(args).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Read what this boot left behind. `root` and `sysfs` are `/` and `/sys` on a unit.
pub fn gather(
    recovery: &Recovery,
    root: &Path,
    sysfs: &Path,
    state_dir: &Path,
    ts: String,
    uptime: Duration,
) -> Facts {
    let read = |path: &Path| std::fs::read_to_string(path).ok();
    Facts {
        ts,
        clock_synced: root.join("run/systemd/timesync/synchronized").exists(),
        up_s: uptime.as_secs(),
        boot_id: read(&root.join("proc/sys/kernel/random/boot_id")).and_then(|t| parse_boot_id(&t)),
        core_s: output(
            "systemctl",
            &[
                "show",
                "--property=ActiveEnterTimestampMonotonic",
                "--value",
                "seedypod-core.service",
            ],
        )
        .and_then(|t| parse_core_s(&t)),
        hub: recovery.hub_came_up(),
        hprt0: crate::usb::platform_controller(sysfs)
            .and_then(|c| read(&c.join("hprt0")))
            .and_then(|t| parse_hprt0(&t)),
        cameras: crate::cameras::discover(sysfs, &root.join("dev")).len(),
        reboots: crate::usb::reboots_so_far(state_dir).ok(),
        clean: output(
            "journalctl",
            &["--boot", "--dmesg", "--quiet", "--no-pager", "--output=cat"],
        )
        .map(|t| parse_clean(&t)),
        temp_c: read(&sysfs.join("class/thermal/thermal_zone0/temp")).and_then(|t| parse_temp_c(&t)),
        errors: output(
            "journalctl",
            &[
                "--boot",
                "--priority=err",
                "--quiet",
                "--no-pager",
                "--output=cat",
            ],
        )
        .map(|t| t.lines().count()),
        outcome: outcome(recovery),
    }
}

/// Add a line, on the card before this returns. Read as bytes, so a line a power cut
/// tore, or a garbled block, can't stop the line being added or the file being cut back.
pub fn append(state_dir: &Path, line: &str) -> std::io::Result<()> {
    let path = state_dir.join(FILE);
    let (old, created) = match std::fs::read(&path) {
        Ok(bytes) => (bytes, false),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (Vec::new(), true),
        Err(e) => return Err(e),
    };
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    // A torn last line stays on a line of its own, not glued to the front of this one.
    if old.last().is_some_and(|&b| b != b'\n') {
        file.write_all(b"\n")?;
    }
    writeln!(file, "{line}")?;
    file.sync_data()?;
    drop(file);
    // A new file's name is in the directory, which needs its own sync to survive a power cut.
    if created {
        std::fs::File::open(state_dir)?.sync_all()?;
    }

    let mut lines: Vec<&[u8]> = old.split(|&b| b == b'\n').filter(|l| !l.is_empty()).collect();
    lines.push(line.as_bytes());
    if lines.len() <= TRIM_AT {
        return Ok(());
    }
    let tmp = path.with_extension("tmp");
    let mut kept = lines[lines.len() - KEPT..].join(&b'\n');
    kept.push(b'\n');
    let mut file = std::fs::File::create(&tmp)?;
    file.write_all(&kept)?;
    file.sync_all()?;
    std::fs::rename(&tmp, &path)?;
    std::fs::File::open(state_dir)?.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hald-boot-log-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_line_says_everything_and_marks_what_isnt_known() {
        let facts = Facts {
            ts: "2026-11-07T04:42:17Z".into(),
            clock_synced: true,
            up_s: 92,
            boot_id: Some("ab12cd34".into()),
            core_s: Some(41),
            hub: Some(false),
            hprt0: Some("0x00001c00".into()),
            cameras: 0,
            reboots: Some(2),
            clean: Some(true),
            temp_c: Some(48.312),
            errors: Some(3),
            outcome: "reboot",
        };
        assert_eq!(
            facts.line(),
            "2026-11-07T04:42:17Z clock=synced up=92 boot=ab12cd34 core_s=41 hub=0 hprt0=0x00001c00 cameras=0 reboots=2 clean=1 temp=48.3 errors=3 outcome=reboot"
        );
        assert!(facts.line().len() < 200);
        let unknown = Facts {
            ts: "1970-01-01T00:01:30Z".into(),
            outcome: "none",
            ..Facts::default()
        };
        assert_eq!(
            unknown.line(),
            "1970-01-01T00:01:30Z clock=stale up=0 boot=- core_s=- hub=- hprt0=- cameras=0 reboots=- clean=- temp=- errors=- outcome=none"
        );
    }

    #[test]
    fn readings_are_parsed_and_anything_odd_is_left_out() {
        assert_eq!(
            parse_boot_id("ab12cd34-5678-90ab-cdef-1234567890ab\n").as_deref(),
            Some("ab12cd34")
        );
        assert_eq!(parse_boot_id("xyz"), None);
        assert_eq!(parse_hprt0("hprt0 = 0x00001c00\n").as_deref(), Some("0x00001c00"));
        assert_eq!(parse_hprt0("hprt0 = nope"), None);
        assert_eq!(parse_hprt0("0x"), None);
        assert_eq!(parse_core_s("41500000\n"), Some(41));
        assert_eq!(parse_core_s("0\n"), None);
        assert_eq!(parse_core_s(""), None);
        assert_eq!(parse_temp_c("48312\n"), Some(48.312));
        assert_eq!(parse_temp_c("hot"), None);
        assert!(parse_clean("EXT4-fs (mmcblk0p2): mounted filesystem"));
        assert!(!parse_clean("EXT4-fs (mmcblk0p2): recovery complete"));
    }

    #[test]
    fn every_outcome_has_a_short_name() {
        assert_eq!(outcome(&Recovery::AlreadyUp), "up");
        assert_eq!(outcome(&Recovery::Recovered { attempts: 1 }), "recovered");
        assert_eq!(outcome(&Recovery::Reboot { attempt: 1, limit: 4 }), "reboot");
        assert_eq!(outcome(&Recovery::NotRebooting("busy".into())), "held");
        assert_eq!(outcome(&Recovery::GaveUp { reboots: 4 }), "gave-up");
        assert_eq!(outcome(&Recovery::NoAction("off".into())), "none");
    }

    #[test]
    fn gathers_from_a_fake_unit() {
        let root = scratch("gather");
        let sysfs = root.join("sys");
        std::fs::create_dir_all(root.join("run/systemd/timesync")).unwrap();
        std::fs::write(root.join("run/systemd/timesync/synchronized"), "").unwrap();
        std::fs::create_dir_all(root.join("proc/sys/kernel/random")).unwrap();
        std::fs::write(root.join("proc/sys/kernel/random/boot_id"), "ab12cd34-0000\n").unwrap();
        std::fs::create_dir_all(sysfs.join("class/thermal/thermal_zone0")).unwrap();
        std::fs::write(sysfs.join("class/thermal/thermal_zone0/temp"), "51000\n").unwrap();
        let controller = root.join("soc/20980000.usb");
        std::fs::create_dir_all(&controller).unwrap();
        std::fs::write(controller.join("hprt0"), "hprt0 = 0x00001c00\n").unwrap();
        std::fs::create_dir_all(sysfs.join("bus/platform/devices")).unwrap();
        std::os::unix::fs::symlink(&controller, sysfs.join("bus/platform/devices/20980000.usb")).unwrap();
        std::fs::write(root.join("usb-reboots"), "2").unwrap();

        let recovery = Recovery::Reboot { attempt: 2, limit: 4 };
        let facts = gather(
            &recovery,
            &root,
            &sysfs,
            &root,
            "t".into(),
            Duration::from_secs(95),
        );
        assert!(facts.clock_synced);
        assert_eq!(facts.up_s, 95);
        assert_eq!(facts.boot_id.as_deref(), Some("ab12cd34"));
        assert_eq!(facts.hub, Some(false));
        assert_eq!(facts.hprt0.as_deref(), Some("0x00001c00"));
        assert_eq!(facts.cameras, 0);
        assert_eq!(facts.reboots, Some(2));
        assert_eq!(facts.temp_c, Some(51.0));
        assert_eq!(facts.outcome, "reboot");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_unit_with_none_of_this_still_gets_a_line() {
        let root = scratch("bare");
        let facts = gather(
            &Recovery::AlreadyUp,
            &root,
            &root,
            &root,
            "t".into(),
            Duration::ZERO,
        );
        assert!(!facts.clock_synced);
        assert_eq!(facts.hprt0, None);
        assert_eq!(facts.boot_id, None);
        assert_eq!(facts.reboots, Some(0));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn lines_are_appended_and_the_file_stays_small() {
        let dir = scratch("trim");
        append(&dir, "first").unwrap();
        assert_eq!(std::fs::read_to_string(dir.join(FILE)).unwrap(), "first\n");
        std::fs::remove_file(dir.join(FILE)).unwrap();
        for n in 0..TRIM_AT {
            append(&dir, &format!("boot {n}")).unwrap();
        }
        let text = std::fs::read_to_string(dir.join(FILE)).unwrap();
        assert_eq!(text.lines().count(), TRIM_AT);
        assert!(text.ends_with(&format!("boot {}\n", TRIM_AT - 1)));

        append(&dir, "boot latest").unwrap();
        let text = std::fs::read_to_string(dir.join(FILE)).unwrap();
        assert_eq!(text.lines().count(), KEPT);
        assert!(text.ends_with("boot latest\n"));
        assert!(!text.contains("boot 0\n"));
        assert!(!dir.join("boot-log.tmp").exists());
        assert!(append(&dir.join("nope"), "boot").is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_torn_or_garbled_file_still_takes_a_line_and_is_still_cut_back() {
        let dir = scratch("torn");
        std::fs::write(dir.join(FILE), b"boot 0\nboot 1 cut sh").unwrap();
        append(&dir, "boot 2").unwrap();
        let text = std::fs::read_to_string(dir.join(FILE)).unwrap();
        assert_eq!(text, "boot 0\nboot 1 cut sh\nboot 2\n");

        let mut garbled = vec![0xff_u8, 0xfe, b'\n'];
        for n in 0..TRIM_AT {
            garbled.extend_from_slice(format!("boot {n}\n").as_bytes());
        }
        std::fs::write(dir.join(FILE), garbled).unwrap();
        append(&dir, "boot latest").unwrap();
        let text = std::fs::read_to_string(dir.join(FILE)).unwrap();
        assert_eq!(text.lines().count(), KEPT);
        assert!(text.ends_with("boot latest\n"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
