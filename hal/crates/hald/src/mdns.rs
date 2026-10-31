//! mDNS advertisement `_leafypod-hal._tcp` with TXT `id`, `model`, `v`, so
//! core discovers units instead of being configured with their addresses
//! (sleepypod probe-first pattern, ADR-0007 / plan 2.1).

use mdns_sd::{ServiceDaemon, ServiceInfo};

pub const SERVICE_TYPE: &str = "_leafypod-hal._tcp.local.";

pub fn service_info(unit: &str, model: &str, version: &str, port: u16) -> Result<ServiceInfo, String> {
    let props = [("id", unit), ("model", model), ("v", version)];
    ServiceInfo::new(
        SERVICE_TYPE,
        unit,
        &format!("{unit}.local."),
        "",
        port,
        &props[..],
    )
    .map(|i| i.enable_addr_auto())
    .map_err(|e| e.to_string())
}

/// Keeps the daemon alive; unregisters on drop.
pub struct Advert {
    daemon: ServiceDaemon,
    fullname: String,
}

impl Advert {
    pub fn start(unit: &str, model: &str, version: &str, port: u16) -> Result<Self, String> {
        let info = service_info(unit, model, version, port)?;
        let fullname = info.get_fullname().to_owned();
        let daemon = ServiceDaemon::new().map_err(|e| e.to_string())?;
        daemon.register(info).map_err(|e| e.to_string())?;
        Ok(Self { daemon, fullname })
    }
}

impl Drop for Advert {
    fn drop(&mut self) {
        let _ = self.daemon.unregister(&self.fullname);
        let _ = self.daemon.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_info_carries_the_txt_records() {
        let i = service_info("gardyn-abc", "gardyn 3.0", "0.1.0", 3001).unwrap();
        assert_eq!(i.get_type(), SERVICE_TYPE);
        assert_eq!(i.get_fullname(), "gardyn-abc._leafypod-hal._tcp.local.");
        assert_eq!(i.get_port(), 3001);
        assert_eq!(i.get_hostname(), "gardyn-abc.local.");
        let txt = i.get_properties();
        assert_eq!(txt.get_property_val_str("id"), Some("gardyn-abc"));
        assert_eq!(txt.get_property_val_str("model"), Some("gardyn 3.0"));
        assert_eq!(txt.get_property_val_str("v"), Some("0.1.0"));
        assert!(i.is_addr_auto());
    }
}
