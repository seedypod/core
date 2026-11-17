//! `state.json` — what must survive a power cut: the light level (so a
//! reboot does not plunge the plants into darkness mid-day), cumulative light
//! hours (LED ageing, Phase 6.4), and the dosing ledgers (so a restart cannot
//! reset the daily cap).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use hal_core::safety::DoseLedger;
use hal_core::DryGuard;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Persisted {
    pub light_level: f64,
    /// RFC 3339 of the last light change.
    pub light_since: Option<String>,
    /// Cumulative hours the light has been on (any level > 0).
    pub light_hours_total: f64,
    pub last_pump_run: Option<String>,
    pub doses: BTreeMap<String, DoseLedger>,
    /// The current guard's spin-up grace the app asked for (ms), clamped at boot
    /// into hal.toml's bounds; unset, hal.toml's default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pump_dry_grace_ms: Option<u64>,
    /// The rest of what the app may set on the dry-run guard, each kept the same
    /// way: re-clamped at boot into hal.toml's bounds as they are then (the mode
    /// re-resolved, and dropped if hal.toml now locks it); unset, hal.toml's.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pump_dry_current_a: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pump_dry_guard: Option<DryGuard>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub water_low_cm: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub water_low_hold_ms: Option<u64>,
}

pub struct StateFile {
    path: PathBuf,
}

impl StateFile {
    pub fn new(dir: &Path) -> Self {
        Self {
            path: dir.join("state.json"),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Missing or unreadable file → defaults (and a warning); never fatal.
    pub fn load(&self) -> Persisted {
        match std::fs::read_to_string(&self.path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
                tracing::warn!(path = %self.path.display(), %e, "state file unreadable; starting fresh");
                Persisted::default()
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Persisted::default(),
            Err(e) => {
                tracing::warn!(path = %self.path.display(), %e, "state file unreadable; starting fresh");
                Persisted::default()
            }
        }
    }

    /// Atomic write (tmp + rename) so a power cut mid-write leaves the old file.
    pub fn save(&self, s: &Persisted) -> std::io::Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(s)?)?;
        std::fs::rename(&tmp, &self.path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hald-state-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn round_trips_and_creates_the_directory() {
        let dir = tmpdir("rt");
        let f = StateFile::new(&dir.join("nested"));
        assert_eq!(f.load(), Persisted::default());
        let mut s = Persisted {
            light_level: 72.5,
            light_since: Some("2026-10-31T03:57:23Z".into()),
            light_hours_total: 12.25,
            last_pump_run: None,
            pump_dry_grace_ms: Some(1500),
            pump_dry_current_a: Some(0.8),
            pump_dry_guard: Some(DryGuard::Current),
            water_low_cm: Some(15.5),
            water_low_hold_ms: Some(4000),
            doses: BTreeMap::new(),
        };
        s.doses.insert(
            "dose_1".into(),
            DoseLedger {
                day: 20757,
                dosed_ml: 4.0,
                doses: 1,
                fault: None,
            },
        );
        f.save(&s).unwrap();
        assert_eq!(f.load(), s);
        let text = std::fs::read_to_string(f.path()).unwrap();
        for k in [
            r#""pumpDryGraceMs": 1500"#,
            r#""pumpDryCurrentA": 0.8"#,
            r#""pumpDryGuard": "current""#,
            r#""waterLowCm": 15.5"#,
            r#""waterLowHoldMs": 4000"#,
        ] {
            assert!(text.contains(k), "{k} in {text}");
        }
        // Nothing set from the app, nothing written for it.
        f.save(&Persisted::default()).unwrap();
        let text = std::fs::read_to_string(f.path()).unwrap();
        assert!(!text.contains("pumpDry") && !text.contains("waterLow"), "{text}");
        assert!(f.path().ends_with("state.json"));
        assert!(!f.path().with_extension("json.tmp").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupt_file_falls_back_to_defaults() {
        let dir = tmpdir("corrupt");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("state.json"), "{not json").unwrap();
        assert_eq!(StateFile::new(&dir).load(), Persisted::default());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn unknown_fields_are_tolerated_and_missing_ones_default() {
        let s: Persisted = serde_json::from_str(r#"{"lightLevel": 10, "future": true}"#).unwrap();
        assert_eq!(s.light_level, 10.0);
        assert_eq!(s.light_hours_total, 0.0);
    }
}
