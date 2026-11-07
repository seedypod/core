//! Boot-time USB recovery. The Gardyn's cameras sit behind a USB hub that often
//! doesn't enumerate at boot, on stock firmware too. When it misses, the port is
//! stuck in SE1 (`hprt0` reads 0x1c00) and nothing short of a reboot clears it: bus
//! power, port disable, root hub re-probes and unbinding all fail, and binding
//! `dwc_otg` again segfaults the kernel. Each boot is its own chance.
//!
//! So `hald --usb-recover` runs once per boot as root. If the bus is still empty
//! after `boot_wait_s` it asks for a reboot, up to `reboot_attempts` in a row. That
//! count is on the card, written and synced first, and only resets when the hub is
//! seen, so nothing here can loop: no count, no reboot. It won't reboot while the
//! pump or a doser runs, or before an image's first boot has finished.
//!
//! The daemon itself is unprivileged, so it only watches, and raises
//! `camera_missing` once the bus is still empty after recovery must be over.
//!
//! It only ever acts on a bus with nothing on it, so a hub that came up (or any
//! other USB device, such as a Pi 3's Ethernet) is untouched. Wi-Fi is on SDIO and
//! not affected.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use tracing::{info, warn};

use crate::config::UsbRecovery;
use crate::engine::Inbound;

/// The Pi's USB controller drivers. Others are left alone.
const DWC_DRIVERS: [&str; 2] = ["dwc_otg", "dwc2"];

/// How long a port is left unbound before binding it again.
const UNBOUND: Duration = Duration::from_secs(1);

/// One character per boot in the state dir, newest last: `+` if the hub came up by
/// itself, `-` if not. One small write per boot.
const BOOTS_FILE: &str = "usb-boots";
const BOOTS_KEPT: usize = 10;

/// How many reboots in a row this has asked for, in the state dir.
const REBOOTS_FILE: &str = "usb-reboots";

#[derive(Debug, Clone, PartialEq)]
pub enum BusState {
    /// Something besides the root hub is attached.
    Populated,
    /// Only the root hub. The case recovery is for.
    Empty(Bus),
    /// Not a bus this should touch.
    NotApplicable(&'static str),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Bus {
    /// `None` once the controller is unbound, say by a rebind that failed halfway.
    root_hub: Option<String>,
    controller: String,
}

/// What's on the USB bus now, from `<sysfs>/bus/usb/devices`.
pub fn bus_state(sysfs: &Path) -> BusState {
    let devices = sysfs.join("bus/usb/devices");
    let Ok(entries) = std::fs::read_dir(&devices) else {
        return BusState::NotApplicable("no USB bus");
    };
    let names: Vec<String> = entries
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| !n.contains(':'))
        .collect();
    if names.iter().any(|n| !n.starts_with("usb")) {
        return BusState::Populated;
    }
    let (root_hub, parent) = match names.as_slice() {
        [root_hub] => {
            let parent = std::fs::canonicalize(devices.join(root_hub))
                .ok()
                .and_then(|p| p.parent().map(Path::to_path_buf));
            let Some(parent) = parent else {
                return BusState::NotApplicable("root hub has no controller");
            };
            (Some(root_hub.clone()), parent)
        }
        [] => {
            let Some(parent) = platform_controller(sysfs) else {
                return BusState::NotApplicable("no USB controller");
            };
            (None, parent)
        }
        _ => return BusState::NotApplicable("not one root hub"),
    };
    let controller = parent
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let bound = std::fs::canonicalize(parent.join("driver")).ok();
    // An unbound controller has no driver link, so go by which driver this kernel has.
    let driver = bound.or_else(|| match root_hub {
        Some(_) => None,
        None => DWC_DRIVERS
            .iter()
            .map(|d| sysfs.join("bus/platform/drivers").join(d))
            .find(|d| d.is_dir()),
    });
    let Some(driver) = driver else {
        return BusState::NotApplicable("controller has no driver");
    };
    let driver_name = driver.file_name().map(|n| n.to_string_lossy().into_owned());
    if !DWC_DRIVERS.iter().any(|d| driver_name.as_deref() == Some(d)) {
        return BusState::NotApplicable("not a Pi USB controller");
    }
    // In gadget mode the bus is empty by design, and could be the link someone is logged in over.
    if sysfs.join("class/udc").join(&controller).exists() {
        return BusState::NotApplicable("controller is in gadget mode");
    }
    BusState::Empty(Bus { root_hub, controller })
}

/// The board's one USB controller, whether or not a driver holds it.
fn platform_controller(sysfs: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(sysfs.join("bus/platform/devices")).ok()?;
    let mut usb = entries
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".usb"));
    let (only, None) = (usb.next()?, usb.next()) else {
        return None;
    };
    std::fs::canonicalize(only.path()).ok()
}

/// Write `name` to `<dir>/unbind`, wait, then to `<dir>/bind`. The bind is always
/// tried: a failed unbind may only mean it was already unbound.
fn rebind(dir: &Path, name: &str, sleep: &mut impl FnMut(Duration)) -> Result<(), String> {
    if let Err(e) = std::fs::write(dir.join("unbind"), name) {
        info!(%name, %e, "unbind refused");
    }
    sleep(UNBOUND);
    std::fs::write(dir.join("bind"), name).map_err(|e| format!("bind {name}: {e}"))
}

#[derive(Debug, Clone, PartialEq)]
pub enum Recovery {
    /// Something's on the bus, with no help needed.
    AlreadyUp,
    /// Nothing here to do; says why.
    NoAction(String),
    /// A re-probe brought it back.
    Recovered { attempts: u32 },
    /// The count is on the card: the caller should reboot now.
    Reboot { attempt: u32, limit: u32 },
    /// The hub is missing and this boot won't reboot for it; says why.
    NotRebooting(String),
    /// Out of reboots, or they're turned off. Waits for the hub to be seen.
    GaveUp { reboots: u32 },
}

/// What `recover` needs to know about this boot.
pub struct Boot<'a> {
    pub sysfs: &'a Path,
    pub state_dir: &'a Path,
    /// Where to look for first-boot markers: `/`, or a scratch dir in tests.
    pub root: &'a Path,
    pub uptime: Duration,
    pub has_cameras: bool,
}

/// What still has to finish on a new card, so a reboot can't interrupt it. `unit.env`
/// is the last thing first boot writes; neither applies off an image.
fn setup_pending(root: &Path) -> Option<&'static str> {
    let unit_env = std::fs::metadata(root.join("var/lib/seedypod-image/unit.env"));
    if root.join("usr/local/sbin/seedypod-first-boot").exists() && unit_env.map_or(true, |m| m.len() == 0) {
        return Some("first boot hasn't finished");
    }
    let cloud = root.join("etc/cloud");
    if cloud.is_dir()
        && !cloud.join("cloud-init.disabled").exists()
        && !root.join("var/lib/cloud/instance/boot-finished").exists()
    {
        return Some("cloud-init hasn't finished");
    }
    None
}

/// Reboots asked for so far. A file that can't be read is an error, not zero:
/// without a trustworthy count there is no bound, so there must be no reboot.
fn reboots_so_far(state_dir: &Path) -> Result<u32, String> {
    match std::fs::read_to_string(state_dir.join(REBOOTS_FILE)) {
        Ok(text) => text.trim().parse().map_err(|e| format!("bad reboot count: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(e) => Err(format!("reboot count: {e}")),
    }
}

/// On the card before it returns, so a reboot that follows can't lose it.
fn save_reboots(state_dir: &Path, count: u32) -> std::io::Result<()> {
    let path = state_dir.join(REBOOTS_FILE);
    let tmp = path.with_extension("tmp");
    let mut file = std::fs::File::create(&tmp)?;
    file.write_all(count.to_string().as_bytes())?;
    file.sync_all()?;
    std::fs::rename(&tmp, &path)?;
    std::fs::File::open(state_dir)?.sync_all()
}

/// The hub was seen, so the next miss starts a fresh run of reboots.
fn reset_reboots(state_dir: &Path) {
    match std::fs::remove_file(state_dir.join(REBOOTS_FILE)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => warn!(%e, "couldn't reset the reboot count"),
        _ => {}
    }
}

/// Wait until nothing that a reboot would cut short is running, up to the limit.
/// Not knowing counts as running: this only reboots on a clear no.
fn wait_until_idle(
    cfg: &UsbRecovery,
    sleep: &mut impl FnMut(Duration),
    running: &mut impl FnMut() -> Result<bool, String>,
) -> Result<(), String> {
    let mut last = String::new();
    for check in 0..=cfg.busy_checks {
        if check > 0 {
            sleep(Duration::from_secs(cfg.busy_wait_s));
        }
        match running() {
            Ok(false) => return Ok(()),
            Ok(true) => last = "the pump or a doser is running".to_owned(),
            Err(e) => last = format!("can't tell if the pump is running: {e}"),
        }
    }
    Err(last)
}

/// Ask for a reboot if it is safe to, with the count saved first.
fn reboot_for_hub(
    boot: &Boot,
    cfg: &UsbRecovery,
    sleep: &mut impl FnMut(Duration),
    running: &mut impl FnMut() -> Result<bool, String>,
) -> Recovery {
    if cfg.reboot_attempts == 0 {
        return Recovery::GaveUp { reboots: 0 };
    }
    if !boot.has_cameras {
        return Recovery::NotRebooting("no cameras configured".into());
    }
    if let Some(why) = setup_pending(boot.root) {
        return Recovery::NotRebooting(why.into());
    }
    let done = match reboots_so_far(boot.state_dir) {
        Ok(done) => done,
        Err(e) => return Recovery::NotRebooting(e),
    };
    if done >= cfg.reboot_attempts {
        return Recovery::GaveUp { reboots: done };
    }
    if let Err(why) = wait_until_idle(cfg, sleep, running) {
        return Recovery::NotRebooting(why);
    }
    match save_reboots(boot.state_dir, done + 1) {
        Ok(()) => Recovery::Reboot {
            attempt: done + 1,
            limit: cfg.reboot_attempts,
        },
        Err(e) => Recovery::NotRebooting(format!("can't save the reboot count: {e}")),
    }
}

/// After `boot_wait_s`, deal with an empty bus. Every step runs at most once, and
/// nothing here repeats within a boot: the unit has no `Restart=`.
pub fn recover(
    boot: &Boot,
    cfg: &UsbRecovery,
    sleep: &mut impl FnMut(Duration),
    running: &mut impl FnMut() -> Result<bool, String>,
) -> Recovery {
    if !cfg.enabled {
        return Recovery::NoAction("disabled".into());
    }
    if cfg.rebind_controller {
        warn!("rebind_controller has no effect: binding dwc_otg again segfaults the kernel");
    }
    sleep(Duration::from_secs(cfg.boot_wait_s).saturating_sub(boot.uptime));
    let bus = match bus_state(boot.sysfs) {
        BusState::Populated => {
            reset_reboots(boot.state_dir);
            return Recovery::AlreadyUp;
        }
        BusState::NotApplicable(why) => return Recovery::NoAction(why.into()),
        BusState::Empty(bus) => bus,
    };
    warn!(controller = %bus.controller, "USB bus is empty after boot");
    let usbcore = boot.sysfs.join("bus/usb/drivers/usb");
    for attempt in 1..=cfg.attempts {
        let result = match &bus.root_hub {
            Some(root_hub) => {
                info!(attempt, %root_hub, "re-probing the root hub");
                rebind(&usbcore, root_hub, sleep)
            }
            None => Err("the controller has no root hub to re-probe".to_owned()),
        };
        if let Err(e) = result {
            warn!(attempt, %e, "re-enumeration failed");
        }
        for _ in 0..cfg.settle_s {
            sleep(Duration::from_secs(1));
            if bus_state(boot.sysfs) == BusState::Populated {
                info!(attempt, "USB bus came up");
                reset_reboots(boot.state_dir);
                return Recovery::Recovered { attempts: attempt };
            }
        }
    }
    reboot_for_hub(boot, cfg, sleep, running)
}

/// Whether `/state`'s JSON has the pump or a doser on.
fn actuators_running(state: &str) -> Result<bool, String> {
    let state: serde_json::Value = serde_json::from_str(state).map_err(|e| format!("bad /state: {e}"))?;
    let actuators = state["actuators"].as_object().ok_or("no actuators in /state")?;
    Ok(actuators.iter().any(|(id, a)| {
        (id == "pump" || id.starts_with("dose_")) && a["on"] != serde_json::Value::Bool(false)
    }))
}

/// Ask this unit's hald. Its HTTP is all this process can see of the engine.
pub fn pump_or_dose_running(http_bind: &str) -> Result<bool, String> {
    let port = http_bind.rsplit(':').next().unwrap_or_default();
    let addr: SocketAddr = format!("127.0.0.1:{port}")
        .parse()
        .map_err(|e| format!("{http_bind}: {e}"))?;
    let timeout = Duration::from_secs(5);
    let mut stream = TcpStream::connect_timeout(&addr, timeout).map_err(|e| format!("hald: {e}"))?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|e| e.to_string())?;
    stream
        .write_all(b"GET /state HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .map_err(|e| format!("hald: {e}"))?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|e| format!("hald: {e}"))?;
    let (head, body) = response.split_once("\r\n\r\n").ok_or("hald sent no body")?;
    if !head.starts_with("HTTP/1.1 200") {
        return Err(format!("hald said {}", head.lines().next().unwrap_or_default()));
    }
    actuators_running(body)
}

/// Clean, so hald stops the pump and the card is synced on the way down.
pub fn reboot() -> std::io::Result<()> {
    let status = std::process::Command::new("systemctl").arg("reboot").status()?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| std::io::Error::other(format!("systemctl reboot exited {status}")))
}

impl Recovery {
    /// Whether this boot says anything about the hub: was it up by itself?
    pub fn hub_came_up(&self) -> Option<bool> {
        match self {
            Recovery::AlreadyUp => Some(true),
            Recovery::Recovered { .. }
            | Recovery::Reboot { .. }
            | Recovery::NotRebooting(_)
            | Recovery::GaveUp { .. } => Some(false),
            Recovery::NoAction(_) => None,
        }
    }
}

/// Add this boot to the record, dropping the oldest.
pub fn record_boot(state_dir: &Path, came_up: bool) -> std::io::Result<()> {
    let path = state_dir.join(BOOTS_FILE);
    let mut boots = std::fs::read_to_string(&path).unwrap_or_default();
    boots.push(if came_up { '+' } else { '-' });
    let keep = boots.len().saturating_sub(BOOTS_KEPT);
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, &boots[keep..])?;
    std::fs::rename(&tmp, &path)
}

/// Of the boots on record, `(hub missing, total)`.
pub fn boot_record(state_dir: &Path) -> Option<(usize, usize)> {
    let boots = std::fs::read_to_string(state_dir.join(BOOTS_FILE)).ok()?;
    let boots = boots.trim();
    (!boots.is_empty()).then(|| (boots.matches('-').count(), boots.len()))
}

/// Seconds since boot, from the first field of `/proc/uptime`.
pub fn parse_uptime(text: &str) -> Option<Duration> {
    let secs: f64 = text.split_whitespace().next()?.parse().ok()?;
    Duration::try_from_secs_f64(secs).ok()
}

pub fn uptime() -> Option<Duration> {
    parse_uptime(&std::fs::read_to_string("/proc/uptime").ok()?)
}

/// Raises `camera_missing` for an empty bus once recovery must have finished, and
/// clears it when the bus fills. Runs in the daemon, which can't touch the bus.
pub struct Watch {
    grace: Duration,
    raised: bool,
}

impl Watch {
    pub fn new(cfg: &UsbRecovery) -> Self {
        Self {
            grace: Duration::from_secs(cfg.boot_wait_s + u64::from(cfg.attempts) * (cfg.settle_s + 2) + 30),
            raised: false,
        }
    }

    /// While the bus is empty this repeats, so a camera's own failure doesn't bury the cause.
    pub fn tick(&mut self, state: &BusState, uptime: Duration) -> Option<Inbound> {
        match state {
            BusState::Empty(_) if uptime >= self.grace => {
                self.raised = true;
                Some(Inbound::CameraResult {
                    name: "USB hub".into(),
                    ok: false,
                    detail: "it didn't come up, even with automatic restarts, so there are no cameras. Reseat or replace the cable between the Pi and the hub, then restart the unit (journalctl -u seedypod-usb-recover)".into(),
                })
            }
            BusState::Populated if self.raised => {
                self.raised = false;
                Some(Inbound::CameraResult {
                    name: "USB hub".into(),
                    ok: true,
                    detail: String::new(),
                })
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fake sysfs with one root hub under a controller bound to `driver`.
    fn fake_sysfs(tag: &str, driver: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("hald-usb-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let controller = root.join("devices/platform/soc/20980000.usb");
        let usb1 = controller.join("usb1");
        let drivers = root.join("bus/platform/drivers").join(driver);
        let devices = root.join("bus/usb/devices");
        let platform = root.join("bus/platform/devices");
        for d in [
            &usb1,
            &drivers,
            &devices,
            &platform,
            &root.join("bus/usb/drivers/usb"),
        ] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::os::unix::fs::symlink(&controller, platform.join("20980000.usb")).unwrap();
        std::os::unix::fs::symlink(&drivers, controller.join("driver")).unwrap();
        std::os::unix::fs::symlink(&usb1, devices.join("usb1")).unwrap();
        std::os::unix::fs::symlink(&usb1, devices.join("1-0:1.0")).unwrap();
        root
    }

    fn plug_in(root: &Path, name: &str) {
        std::fs::create_dir_all(root.join("bus/usb/devices").join(name)).unwrap();
    }

    fn cfg() -> UsbRecovery {
        UsbRecovery {
            enabled: true,
            boot_wait_s: 90,
            attempts: 2,
            settle_s: 3,
            reboot_attempts: 0,
            busy_checks: 2,
            busy_wait_s: 60,
            rebind_controller: false,
        }
    }

    /// `recover` on `root`, for the tests that are about the re-probes.
    fn run(root: &Path, cfg: &UsbRecovery, uptime: Duration, sleep: &mut impl FnMut(Duration)) -> Recovery {
        let boot = Boot {
            sysfs: root,
            state_dir: root,
            root,
            uptime,
            has_cameras: true,
        };
        recover(&boot, cfg, sleep, &mut || Ok(false))
    }

    fn written(root: &Path, file: &str) -> Option<String> {
        std::fs::read_to_string(root.join(file)).ok()
    }

    const USBCORE_BIND: &str = "bus/usb/drivers/usb/bind";

    #[test]
    fn an_empty_bus_is_told_from_a_populated_one() {
        let root = fake_sysfs("state", "dwc_otg");
        let BusState::Empty(bus) = bus_state(&root) else {
            panic!("should be empty");
        };
        assert_eq!(bus.root_hub.as_deref(), Some("usb1"));
        assert_eq!(bus.controller, "20980000.usb");
        plug_in(&root, "1-1");
        plug_in(&root, "1-1:1.0");
        assert_eq!(bus_state(&root), BusState::Populated);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn buses_this_shouldnt_touch_are_recognised() {
        assert_eq!(
            bus_state(Path::new("/nonexistent")),
            BusState::NotApplicable("no USB bus")
        );

        let other = fake_sysfs("xhci", "xhci-hcd");
        assert_eq!(
            bus_state(&other),
            BusState::NotApplicable("not a Pi USB controller")
        );
        let _ = std::fs::remove_dir_all(other);

        let gadget = fake_sysfs("gadget", "dwc2");
        assert!(matches!(bus_state(&gadget), BusState::Empty(_)));
        std::fs::create_dir_all(gadget.join("class/udc/20980000.usb")).unwrap();
        assert_eq!(
            bus_state(&gadget),
            BusState::NotApplicable("controller is in gadget mode")
        );
        let _ = std::fs::remove_dir_all(gadget);

        let two = fake_sysfs("two", "dwc_otg");
        plug_in(&two, "usb2");
        assert_eq!(bus_state(&two), BusState::NotApplicable("not one root hub"));
        let _ = std::fs::remove_dir_all(two);

        let none = fake_sysfs("nohub", "dwc_otg");
        std::fs::remove_file(none.join("bus/usb/devices/usb1")).unwrap();
        std::fs::remove_file(none.join("bus/platform/devices/20980000.usb")).unwrap();
        assert_eq!(bus_state(&none), BusState::NotApplicable("no USB controller"));
        let _ = std::fs::remove_dir_all(none);

        let unbound = fake_sysfs("unbound", "dwc_otg");
        std::fs::remove_file(unbound.join("devices/platform/soc/20980000.usb/driver")).unwrap();
        assert_eq!(
            bus_state(&unbound),
            BusState::NotApplicable("controller has no driver")
        );
        let _ = std::fs::remove_dir_all(unbound);

        let dangling = fake_sysfs("dangling", "dwc_otg");
        std::fs::remove_dir_all(dangling.join("devices/platform/soc/20980000.usb/usb1")).unwrap();
        assert_eq!(
            bus_state(&dangling),
            BusState::NotApplicable("root hub has no controller")
        );
        let _ = std::fs::remove_dir_all(dangling);
    }

    /// `fake_sysfs` after a rebind that unbound the controller and never bound it back.
    fn controller_gone(tag: &str, driver: &str) -> PathBuf {
        let root = fake_sysfs(tag, driver);
        std::fs::remove_file(root.join("bus/usb/devices/usb1")).unwrap();
        std::fs::remove_file(root.join("bus/usb/devices/1-0:1.0")).unwrap();
        std::fs::remove_file(root.join("devices/platform/soc/20980000.usb/driver")).unwrap();
        root
    }

    #[test]
    fn a_controller_left_unbound_still_counts_as_an_empty_bus() {
        let root = controller_gone("gone", "dwc_otg");
        let BusState::Empty(bus) = bus_state(&root) else {
            panic!("{:?}", bus_state(&root));
        };
        assert_eq!(bus.root_hub, None);
        assert_eq!(bus.controller, "20980000.usb");
        // So the daemon raises the alert.
        let mut watch = Watch::new(&cfg());
        let up = watch.tick(&bus_state(&root), Duration::from_secs(600));
        assert!(failed(up).starts_with("USB hub: it didn't come up"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn an_unbound_controller_is_only_claimed_for_a_driver_this_kernel_has() {
        let root = controller_gone("gone-xhci", "xhci-hcd");
        assert_eq!(
            bus_state(&root),
            BusState::NotApplicable("controller has no driver")
        );
        let _ = std::fs::remove_dir_all(root);

        // Bound, in gadget mode, with no root hub: an empty bus is normal there.
        let gadget = fake_sysfs("gone-gadget", "dwc2");
        std::fs::remove_file(gadget.join("bus/usb/devices/usb1")).unwrap();
        std::fs::create_dir_all(gadget.join("class/udc/20980000.usb")).unwrap();
        assert_eq!(
            bus_state(&gadget),
            BusState::NotApplicable("controller is in gadget mode")
        );
        let _ = std::fs::remove_dir_all(gadget);

        // Two candidates: no way to tell which is the host port.
        let two = controller_gone("gone-two", "dwc_otg");
        std::fs::create_dir_all(two.join("bus/platform/devices/fe980000.usb")).unwrap();
        assert_eq!(bus_state(&two), BusState::NotApplicable("no USB controller"));
        let _ = std::fs::remove_dir_all(two);
    }

    #[test]
    fn a_hub_that_came_up_is_left_alone() {
        let root = fake_sysfs("noop", "dwc_otg");
        plug_in(&root, "1-1");
        let mut slept = Duration::ZERO;
        let got = run(&root, &cfg(), Duration::from_secs(30), &mut |d| slept += d);
        assert_eq!(got, Recovery::AlreadyUp);
        assert_eq!(slept, Duration::from_secs(60));
        assert_eq!(written(&root, USBCORE_BIND), None);
        assert_eq!(written(&root, "bus/usb/drivers/usb/unbind"), None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_disabled_recovery_does_nothing_at_all() {
        let root = fake_sysfs("off", "dwc_otg");
        let off = UsbRecovery {
            enabled: false,
            ..cfg()
        };
        let got = run(&root, &off, Duration::ZERO, &mut |_| panic!("no waiting"));
        assert_eq!(got, Recovery::NoAction("disabled".into()));
        assert_eq!(written(&root, USBCORE_BIND), None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_bus_this_shouldnt_touch_gets_no_writes() {
        let root = fake_sysfs("skip", "xhci-hcd");
        let got = run(&root, &cfg(), Duration::from_secs(600), &mut |_| {});
        assert_eq!(got, Recovery::NoAction("not a Pi USB controller".into()));
        assert_eq!(written(&root, USBCORE_BIND), None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn stops_as_soon_as_the_hub_appears() {
        let root = fake_sysfs("works", "dwc_otg");
        let hub_appears = root.clone();
        let mut sleeps = 0;
        let got = run(&root, &cfg(), Duration::from_secs(600), &mut |_| {
            sleeps += 1;
            if sleeps == 4 {
                plug_in(&hub_appears, "1-1");
            }
        });
        assert_eq!(got, Recovery::Recovered { attempts: 1 });
        assert_eq!(
            written(&root, "bus/usb/drivers/usb/unbind").as_deref(),
            Some("usb1")
        );
        assert_eq!(written(&root, USBCORE_BIND).as_deref(), Some("usb1"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn gives_up_after_its_reprobes_with_reboots_turned_off() {
        let root = fake_sysfs("gaveup", "dwc_otg");
        let mut slept = Duration::ZERO;
        let got = run(&root, &cfg(), Duration::from_secs(600), &mut |d| slept += d);
        assert_eq!(got, Recovery::GaveUp { reboots: 0 });
        // Two attempts of one second unbound and three settling, and nothing more.
        assert_eq!(slept, Duration::from_secs(8));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_refused_unbind_still_binds_and_a_refused_bind_doesnt_stop_it() {
        let root = fake_sysfs("refused", "dwc_otg");
        // A directory where the file should be makes the write fail.
        std::fs::create_dir_all(root.join("bus/usb/drivers/usb/unbind")).unwrap();
        run(&root, &cfg(), Duration::from_secs(600), &mut |_| {});
        assert_eq!(written(&root, USBCORE_BIND).as_deref(), Some("usb1"));

        std::fs::remove_dir_all(root.join("bus/usb/drivers/usb")).unwrap();
        let got = run(&root, &cfg(), Duration::from_secs(600), &mut |_| {});
        assert_eq!(got, Recovery::GaveUp { reboots: 0 });
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_boot_only_counts_when_it_says_something_about_the_hub() {
        assert_eq!(Recovery::AlreadyUp.hub_came_up(), Some(true));
        assert_eq!(Recovery::Recovered { attempts: 1 }.hub_came_up(), Some(false));
        assert_eq!(Recovery::GaveUp { reboots: 2 }.hub_came_up(), Some(false));
        let rebooting = Recovery::Reboot { attempt: 1, limit: 4 };
        assert_eq!(rebooting.hub_came_up(), Some(false));
        assert_eq!(Recovery::NotRebooting("busy".into()).hub_came_up(), Some(false));
        assert_eq!(Recovery::NoAction("disabled".into()).hub_came_up(), None);
    }

    #[test]
    fn boots_are_recorded_up_to_a_limit() {
        let root = fake_sysfs("boots", "dwc_otg");
        assert_eq!(boot_record(&root), None);
        record_boot(&root, false).unwrap();
        record_boot(&root, true).unwrap();
        assert_eq!(boot_record(&root), Some((1, 2)));
        for _ in 0..BOOTS_KEPT {
            record_boot(&root, true).unwrap();
        }
        // The missed boot has aged out.
        assert_eq!(boot_record(&root), Some((0, BOOTS_KEPT)));
        assert!(record_boot(&root.join("nope"), true).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    fn reboot_cfg() -> UsbRecovery {
        UsbRecovery {
            attempts: 0,
            reboot_attempts: 4,
            ..cfg()
        }
    }

    /// One boot of `root`'s unit, with nothing running.
    fn boot(root: &Path) -> Recovery {
        boot_with(root, &reboot_cfg(), &mut || Ok(false))
    }

    fn boot_with(
        root: &Path,
        cfg: &UsbRecovery,
        running: &mut impl FnMut() -> Result<bool, String>,
    ) -> Recovery {
        let boot = Boot {
            sysfs: root,
            state_dir: root,
            root,
            uptime: Duration::from_secs(600),
            has_cameras: true,
        };
        recover(&boot, cfg, &mut |_| {}, running)
    }

    fn counted(root: &Path) -> Option<String> {
        written(root, REBOOTS_FILE)
    }

    #[test]
    fn asks_for_reboots_up_to_the_limit_then_stops_for_good() {
        let root = fake_sysfs("limit", "dwc_otg");
        for attempt in 1..=4 {
            assert_eq!(boot(&root), Recovery::Reboot { attempt, limit: 4 });
            // On the card by the time a reboot is asked for.
            assert_eq!(counted(&root), Some(attempt.to_string()));
        }
        // However many more boots or power cycles follow, nothing resets it but the hub.
        for _ in 0..3 {
            assert_eq!(boot(&root), Recovery::GaveUp { reboots: 4 });
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn seeing_the_hub_resets_the_count() {
        let root = fake_sysfs("reset", "dwc_otg");
        boot(&root);
        boot(&root);
        plug_in(&root, "1-1");
        assert_eq!(boot(&root), Recovery::AlreadyUp);
        assert_eq!(counted(&root), None);
        std::fs::remove_dir(root.join("bus/usb/devices/1-1")).unwrap();
        assert_eq!(boot(&root), Recovery::Reboot { attempt: 1, limit: 4 });
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_reprobe_that_brings_the_hub_back_resets_the_count_too() {
        let root = fake_sysfs("reset-probe", "dwc_otg");
        boot(&root);
        let hub_appears = root.clone();
        let on = UsbRecovery {
            attempts: 1,
            ..reboot_cfg()
        };
        let what = Boot {
            sysfs: &root,
            state_dir: &root,
            root: &root,
            uptime: Duration::from_secs(600),
            has_cameras: true,
        };
        let got = recover(&what, &on, &mut |_| plug_in(&hub_appears, "1-1"), &mut || {
            Ok(false)
        });
        assert_eq!(got, Recovery::Recovered { attempts: 1 });
        assert_eq!(counted(&root), None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_running_pump_holds_the_reboot_then_this_boot_goes_without() {
        let root = fake_sysfs("pump", "dwc_otg");
        let mut looks = 0;
        let got = boot_with(&root, &reboot_cfg(), &mut || {
            looks += 1;
            Ok(true)
        });
        assert_eq!(
            got,
            Recovery::NotRebooting("the pump or a doser is running".into())
        );
        // The first look and one per wait, and no more.
        assert_eq!(looks, 3);
        assert_eq!(counted(&root), None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_pump_that_finishes_lets_the_reboot_go_ahead() {
        let root = fake_sysfs("pump-done", "dwc_otg");
        let mut looks = 0;
        let got = boot_with(&root, &reboot_cfg(), &mut || {
            looks += 1;
            Ok(looks < 3)
        });
        assert_eq!(got, Recovery::Reboot { attempt: 1, limit: 4 });
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn not_knowing_about_the_pump_is_the_same_as_it_running() {
        let root = fake_sysfs("pump-unknown", "dwc_otg");
        let got = boot_with(&root, &reboot_cfg(), &mut || Err("connection refused".into()));
        assert_eq!(
            got,
            Recovery::NotRebooting("can't tell if the pump is running: connection refused".into())
        );
        assert_eq!(counted(&root), None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn no_reboot_without_a_count_it_can_trust() {
        let root = fake_sysfs("counter", "dwc_otg");
        let on_missing_dir = |state_dir: &Path| {
            let what = Boot {
                sysfs: &root,
                state_dir,
                root: &root,
                uptime: Duration::from_secs(600),
                has_cameras: true,
            };
            recover(&what, &reboot_cfg(), &mut |_| {}, &mut || Ok(false))
        };
        // Can't be written.
        let got = on_missing_dir(&root.join("no-such-dir"));
        assert!(
            matches!(&got, Recovery::NotRebooting(why) if why.contains("can't save")),
            "{got:?}"
        );
        // Can't be read, whether it's garbage or not a file at all.
        std::fs::write(root.join(REBOOTS_FILE), "junk").unwrap();
        assert!(matches!(boot(&root), Recovery::NotRebooting(why) if why.contains("bad reboot count")));
        std::fs::remove_file(root.join(REBOOTS_FILE)).unwrap();
        std::fs::create_dir(root.join(REBOOTS_FILE)).unwrap();
        assert!(matches!(boot(&root), Recovery::NotRebooting(why) if why.contains("reboot count")));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_new_card_finishes_setting_up_before_any_reboot() {
        let root = fake_sysfs("first-boot", "dwc_otg");
        let waiting = Recovery::NotRebooting("first boot hasn't finished".into());
        std::fs::create_dir_all(root.join("usr/local/sbin")).unwrap();
        std::fs::write(root.join("usr/local/sbin/seedypod-first-boot"), "").unwrap();
        assert_eq!(boot(&root), waiting);
        // First boot writes this last, through a temp file; empty means it didn't finish.
        std::fs::create_dir_all(root.join("var/lib/seedypod-image")).unwrap();
        std::fs::write(root.join("var/lib/seedypod-image/unit.env"), "").unwrap();
        assert_eq!(boot(&root), waiting);
        assert_eq!(counted(&root), None);
        std::fs::write(root.join("var/lib/seedypod-image/unit.env"), "HAL_UNIT_ID=u1\n").unwrap();
        assert_eq!(boot(&root), Recovery::Reboot { attempt: 1, limit: 4 });
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn cloud_init_finishes_first_unless_it_has_been_turned_off() {
        let root = fake_sysfs("cloud", "dwc_otg");
        std::fs::create_dir_all(root.join("etc/cloud")).unwrap();
        assert_eq!(
            boot(&root),
            Recovery::NotRebooting("cloud-init hasn't finished".into())
        );
        std::fs::create_dir_all(root.join("var/lib/cloud/instance")).unwrap();
        std::fs::write(root.join("var/lib/cloud/instance/boot-finished"), "").unwrap();
        assert_eq!(boot(&root), Recovery::Reboot { attempt: 1, limit: 4 });
        std::fs::remove_file(root.join("var/lib/cloud/instance/boot-finished")).unwrap();
        std::fs::write(root.join("etc/cloud/cloud-init.disabled"), "").unwrap();
        assert_eq!(boot(&root), Recovery::Reboot { attempt: 2, limit: 4 });
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_unit_with_no_cameras_never_reboots_for_a_hub() {
        let root = fake_sysfs("no-cameras", "dwc_otg");
        let what = Boot {
            sysfs: &root,
            state_dir: &root,
            root: &root,
            uptime: Duration::from_secs(600),
            has_cameras: false,
        };
        let got = recover(&what, &reboot_cfg(), &mut |_| {}, &mut || {
            panic!("no need to look")
        });
        assert_eq!(got, Recovery::NotRebooting("no cameras configured".into()));
        assert_eq!(counted(&root), None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn reboots_can_be_turned_off_and_only_happen_on_a_pi_controller() {
        let root = fake_sysfs("off", "dwc_otg");
        let off = UsbRecovery {
            reboot_attempts: 0,
            ..reboot_cfg()
        };
        assert_eq!(
            boot_with(&root, &off, &mut || Ok(false)),
            Recovery::GaveUp { reboots: 0 }
        );
        assert_eq!(counted(&root), None);
        let _ = std::fs::remove_dir_all(root);

        let xhci = fake_sysfs("off-xhci", "xhci-hcd");
        assert_eq!(boot(&xhci), Recovery::NoAction("not a Pi USB controller".into()));
        assert_eq!(counted(&xhci), None);
        let _ = std::fs::remove_dir_all(xhci);
    }

    #[test]
    fn rebind_controller_does_nothing_now_that_binding_is_known_to_segfault() {
        let root = fake_sysfs("no-rebind", "dwc_otg");
        let on = UsbRecovery {
            rebind_controller: true,
            ..reboot_cfg()
        };
        assert_eq!(
            boot_with(&root, &on, &mut || Ok(false)),
            Recovery::Reboot { attempt: 1, limit: 4 }
        );
        assert_eq!(written(&root, "bus/platform/drivers/dwc_otg/bind"), None);
        assert_eq!(written(&root, "bus/platform/drivers/dwc_otg/unbind"), None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn the_pump_and_dosers_count_as_running_and_the_light_doesnt() {
        let state =
            |id: &str, on: bool| format!(r#"{{"actuators":{{"light":{{"on":true}},"{id}":{{"on":{on}}}}}}}"#);
        assert_eq!(actuators_running(&state("pump", false)), Ok(false));
        assert_eq!(actuators_running(&state("pump", true)), Ok(true));
        assert_eq!(actuators_running(&state("dose_1", true)), Ok(true));
        assert_eq!(actuators_running(r#"{"actuators":{}}"#), Ok(false));
        // An entry this can't read isn't a clear no.
        assert_eq!(actuators_running(r#"{"actuators":{"pump":{}}}"#), Ok(true));
        assert!(actuators_running(r#"{"sensors":{}}"#).is_err());
        assert!(actuators_running("not json").is_err());
    }

    /// One reply to one request on a local port; returns the bind address.
    fn serve_once(reply: &'static str) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 256];
            let _ = stream.read(&mut request);
            let _ = stream.write_all(reply.as_bytes());
        });
        format!("0.0.0.0:{port}")
    }

    #[test]
    fn asks_hald_over_http_and_says_so_when_it_cant() {
        let bind = serve_once("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{\"actuators\":{\"pump\":{\"on\":true}}}");
        assert_eq!(pump_or_dose_running(&bind), Ok(true));
        let bind = serve_once("HTTP/1.1 500 Internal Server Error\r\n\r\n");
        assert!(pump_or_dose_running(&bind).unwrap_err().contains("500"));
        let bind = serve_once("HTTP/1.1 200 OK");
        assert!(pump_or_dose_running(&bind).is_err());
        assert!(pump_or_dose_running("no-port").is_err());
        // Nothing listening: bind a port, then let it go.
        let free = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        assert!(pump_or_dose_running(&format!("0.0.0.0:{free}")).is_err());
    }

    #[test]
    fn uptime_is_read_from_proc() {
        assert_eq!(
            parse_uptime("123.45 67.89\n"),
            Some(Duration::from_secs_f64(123.45))
        );
        assert_eq!(parse_uptime(""), None);
        assert_eq!(parse_uptime("soon"), None);
        assert_eq!(parse_uptime("-1 0"), None);
    }

    fn failed(result: Option<Inbound>) -> String {
        match result {
            Some(Inbound::CameraResult {
                name,
                ok: false,
                detail,
            }) => format!("{name}: {detail}"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn the_alert_waits_for_recovery_repeats_while_empty_and_clears_when_it_fills() {
        let empty = BusState::Empty(Bus {
            root_hub: Some("usb1".into()),
            controller: "20980000.usb".into(),
        });
        let mut watch = Watch::new(&cfg());
        // 90 s wait, two re-probes of 3 + 2 s, 30 s margin.
        assert_eq!(watch.grace, Duration::from_secs(130));
        assert!(watch.tick(&empty, Duration::from_secs(129)).is_none());
        assert!(watch
            .tick(&BusState::Populated, Duration::from_secs(200))
            .is_none());
        let up = failed(watch.tick(&empty, Duration::from_secs(130)));
        assert!(up.starts_with("USB hub: it didn't come up"), "{up}");
        assert_eq!(failed(watch.tick(&empty, Duration::from_secs(160))), up);

        assert!(matches!(
            watch.tick(&BusState::Populated, Duration::from_secs(190)),
            Some(Inbound::CameraResult { ok: true, .. })
        ));
        assert!(watch
            .tick(&BusState::Populated, Duration::from_secs(220))
            .is_none());
    }

    #[test]
    fn the_alert_stays_out_of_it_on_a_bus_this_doesnt_manage() {
        let mut watch = Watch::new(&cfg());
        let other = BusState::NotApplicable("not a Pi USB controller");
        assert!(watch.tick(&other, Duration::from_secs(9999)).is_none());
    }
}
