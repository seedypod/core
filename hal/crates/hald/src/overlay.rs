//! Sensors added from the app, persisted in `<state_dir>/sensors.json`.
//! Kept apart from `hal.toml` (read-only to the daemon under systemd, and a
//! `[[sensor]]` table there replaces the whole stock list); appended to the
//! configured sensors at boot.

use std::path::{Path, PathBuf};

use crate::config::SensorEntry;

pub struct Overlay {
    path: PathBuf,
}

impl Overlay {
    pub fn new(dir: &Path) -> Self {
        Self {
            path: dir.join("sensors.json"),
        }
    }

    /// Missing or unreadable file → no user sensors (and a warning); never fatal.
    pub fn load(&self) -> Vec<SensorEntry> {
        match std::fs::read_to_string(&self.path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
                tracing::warn!(path = %self.path.display(), %e, "sensor overlay unreadable; ignoring it");
                Vec::new()
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => {
                tracing::warn!(path = %self.path.display(), %e, "sensor overlay unreadable; ignoring it");
                Vec::new()
            }
        }
    }

    /// Atomic write (tmp + rename), like the state file.
    pub fn save(&self, entries: &[SensorEntry]) -> std::io::Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(entries)?)?;
        std::fs::rename(&tmp, &self.path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_tolerates_garbage() {
        let dir = std::env::temp_dir().join(format!("hald-overlay-{}", std::process::id()));
        let o = Overlay::new(&dir);
        assert!(o.load().is_empty());
        let e = SensorEntry {
            kind: "ezo_ph".into(),
            addr: Some(0x63),
            pin: None,
            trigger: None,
            echo: None,
            optional: false,
            active_low: None,
        };
        o.save(std::slice::from_ref(&e)).unwrap();
        assert_eq!(o.load(), vec![e]);
        std::fs::write(dir.join("sensors.json"), "not json").unwrap();
        assert!(o.load().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
