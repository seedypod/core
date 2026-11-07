//! Boot-time USB recovery. The Gardyn's cameras sit behind a USB hub that
//! doesn't always enumerate at boot, on stock firmware too. `hald --usb-recover`
//! runs once per boot as root: if the bus is still empty after `boot_wait_s` it
//! makes a bounded number of attempts to enumerate it again, then gives up.
//! The daemon itself is unprivileged, so it only watches, and raises
//! `camera_missing` once the attempts must be over and the bus is still empty.
//!
//! It only ever acts on a bus with nothing on it, so a hub that came up (or any
//! other USB device, such as a Pi 3's Ethernet) is untouched, and there is no
//! device to lose. Wi-Fi is on SDIO and not affected either way.

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
    /// The controller's driver directory, holding `bind` and `unbind`.
    driver: PathBuf,
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
    BusState::Empty(Bus {
        root_hub,
        controller,
        driver,
    })
}

/// The board's one USB controller, whether or not a driver holds it.
pub fn platform_controller(sysfs: &Path) -> Option<PathBuf> {
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
    Recovered {
        attempts: u32,
    },
    GaveUp {
        attempts: u32,
    },
}

/// After `boot_wait_s`, try to enumerate an empty bus. Every attempt runs at most
/// once, and nothing here repeats: the unit has no `Restart=`.
pub fn recover(
    sysfs: &Path,
    cfg: &UsbRecovery,
    uptime: Duration,
    sleep: &mut impl FnMut(Duration),
) -> Recovery {
    if !cfg.enabled {
        return Recovery::NoAction("disabled".into());
    }
    sleep(Duration::from_secs(cfg.boot_wait_s).saturating_sub(uptime));
    let bus = match bus_state(sysfs) {
        BusState::Populated => return Recovery::AlreadyUp,
        BusState::NotApplicable(why) => return Recovery::NoAction(why.into()),
        BusState::Empty(bus) => bus,
    };
    warn!(controller = %bus.controller, "USB bus is empty after boot; trying to enumerate it again");
    let usbcore = sysfs.join("bus/usb/drivers/usb");
    let attempts = cfg.attempts + u32::from(cfg.rebind_controller);
    for attempt in 1..=attempts {
        // The gentle one first: usbcore re-probes the root hub, and the controller keeps running.
        let result = if attempt <= cfg.attempts {
            match &bus.root_hub {
                Some(root_hub) => {
                    info!(attempt, %root_hub, "re-probing the root hub");
                    rebind(&usbcore, root_hub, sleep)
                }
                None => Err("the controller has no root hub to re-probe".to_owned()),
            }
        } else {
            warn!(attempt, controller = %bus.controller, "rebinding the USB controller");
            rebind(&bus.driver, &bus.controller, sleep)
        };
        if let Err(e) = result {
            warn!(attempt, %e, "re-enumeration failed");
        }
        for _ in 0..cfg.settle_s {
            sleep(Duration::from_secs(1));
            if bus_state(sysfs) == BusState::Populated {
                info!(attempt, "USB bus came up");
                return Recovery::Recovered { attempts: attempt };
            }
        }
    }
    Recovery::GaveUp { attempts }
}

impl Recovery {
    /// Whether this boot says anything about the hub: was it up by itself?
    pub fn hub_came_up(&self) -> Option<bool> {
        match self {
            Recovery::AlreadyUp => Some(true),
            Recovery::Recovered { .. } | Recovery::GaveUp { .. } => Some(false),
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
        let attempts = u64::from(cfg.attempts + u32::from(cfg.rebind_controller));
        Self {
            grace: Duration::from_secs(cfg.boot_wait_s + attempts * (cfg.settle_s + 2) + 30),
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
                    detail: "nothing on the USB bus since boot, so no cameras. Recovery didn't bring it up (journalctl -u seedypod-usb-recover); check the hub's cable and reboot".into(),
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
            rebind_controller: false,
        }
    }

    fn written(root: &Path, file: &str) -> Option<String> {
        std::fs::read_to_string(root.join(file)).ok()
    }

    const USBCORE_BIND: &str = "bus/usb/drivers/usb/bind";
    const DRIVER_BIND: &str = "bus/platform/drivers/dwc_otg/bind";

    #[test]
    fn an_empty_bus_is_told_from_a_populated_one() {
        let root = fake_sysfs("state", "dwc_otg");
        let BusState::Empty(bus) = bus_state(&root) else {
            panic!("should be empty");
        };
        assert_eq!(bus.root_hub.as_deref(), Some("usb1"));
        assert_eq!(bus.controller, "20980000.usb");
        assert!(bus.driver.ends_with("drivers/dwc_otg"));
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
        assert!(bus.driver.ends_with("drivers/dwc_otg"));
        // So the daemon raises the alert.
        let mut watch = Watch::new(&cfg());
        let up = watch.tick(&bus_state(&root), Duration::from_secs(600));
        assert!(failed(up).starts_with("USB hub: nothing on the USB bus"));
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
    fn a_controller_left_unbound_gets_the_bind_it_needs_and_no_root_hub_writes() {
        let root = controller_gone("gone-bind", "dwc_otg");
        let on = UsbRecovery {
            rebind_controller: true,
            ..cfg()
        };
        let got = recover(&root, &on, Duration::from_secs(600), &mut |_| {});
        assert_eq!(got, Recovery::GaveUp { attempts: 3 });
        assert_eq!(written(&root, DRIVER_BIND).as_deref(), Some("20980000.usb"));
        assert_eq!(written(&root, USBCORE_BIND), None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_hub_that_came_up_is_left_alone() {
        let root = fake_sysfs("noop", "dwc_otg");
        plug_in(&root, "1-1");
        let mut slept = Duration::ZERO;
        let got = recover(&root, &cfg(), Duration::from_secs(30), &mut |d| slept += d);
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
        let got = recover(&root, &off, Duration::ZERO, &mut |_| panic!("no waiting"));
        assert_eq!(got, Recovery::NoAction("disabled".into()));
        assert_eq!(written(&root, USBCORE_BIND), None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_bus_this_shouldnt_touch_gets_no_writes() {
        let root = fake_sysfs("skip", "xhci-hcd");
        let got = recover(&root, &cfg(), Duration::from_secs(600), &mut |_| {});
        assert_eq!(got, Recovery::NoAction("not a Pi USB controller".into()));
        assert_eq!(written(&root, USBCORE_BIND), None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn stops_as_soon_as_the_hub_appears() {
        let root = fake_sysfs("works", "dwc_otg");
        let hub_appears = root.clone();
        let mut sleeps = 0;
        let got = recover(&root, &cfg(), Duration::from_secs(600), &mut |_| {
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
        assert_eq!(written(&root, DRIVER_BIND), None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn gives_up_after_its_attempts_without_touching_the_controller_unless_told_to() {
        let root = fake_sysfs("gaveup", "dwc_otg");
        let mut slept = Duration::ZERO;
        let got = recover(&root, &cfg(), Duration::from_secs(600), &mut |d| slept += d);
        assert_eq!(got, Recovery::GaveUp { attempts: 2 });
        // Two attempts of one second unbound and three settling, and nothing more.
        assert_eq!(slept, Duration::from_secs(8));
        assert_eq!(written(&root, DRIVER_BIND), None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn the_controller_is_rebound_last_and_only_when_asked() {
        let root = fake_sysfs("controller", "dwc_otg");
        let on = UsbRecovery {
            rebind_controller: true,
            ..cfg()
        };
        let got = recover(&root, &on, Duration::from_secs(600), &mut |_| {});
        assert_eq!(got, Recovery::GaveUp { attempts: 3 });
        assert_eq!(written(&root, DRIVER_BIND).as_deref(), Some("20980000.usb"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_refused_unbind_still_binds_and_a_refused_bind_doesnt_stop_it() {
        let root = fake_sysfs("refused", "dwc_otg");
        // A directory where the file should be makes the write fail.
        std::fs::create_dir_all(root.join("bus/usb/drivers/usb/unbind")).unwrap();
        recover(&root, &cfg(), Duration::from_secs(600), &mut |_| {});
        assert_eq!(written(&root, USBCORE_BIND).as_deref(), Some("usb1"));

        std::fs::remove_dir_all(root.join("bus/usb/drivers/usb")).unwrap();
        let got = recover(&root, &cfg(), Duration::from_secs(600), &mut |_| {});
        assert_eq!(got, Recovery::GaveUp { attempts: 2 });
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_boot_only_counts_when_it_says_something_about_the_hub() {
        assert_eq!(Recovery::AlreadyUp.hub_came_up(), Some(true));
        assert_eq!(Recovery::Recovered { attempts: 1 }.hub_came_up(), Some(false));
        assert_eq!(Recovery::GaveUp { attempts: 2 }.hub_came_up(), Some(false));
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
            driver: "/drivers/dwc_otg".into(),
        });
        let mut watch = Watch::new(&cfg());
        // 90 s wait, two attempts of 3 + 2 s, 30 s margin.
        assert_eq!(watch.grace, Duration::from_secs(130));
        assert!(watch.tick(&empty, Duration::from_secs(129)).is_none());
        assert!(watch
            .tick(&BusState::Populated, Duration::from_secs(200))
            .is_none());
        let up = failed(watch.tick(&empty, Duration::from_secs(130)));
        assert!(up.starts_with("USB hub: nothing on the USB bus"), "{up}");
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
