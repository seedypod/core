//! Per-unit identity (upstream bug #130: every unit shared one MQTT id).

/// Raspberry Pi serial from /proc/cpuinfo, else a stable fallback.
pub fn unit_id(override_id: Option<&str>) -> String {
    if let Some(id) = override_id {
        return id.to_owned();
    }
    std::fs::read_to_string("/proc/cpuinfo")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("Serial"))
                .and_then(|l| l.split(':').nth(1))
                .map(|v| v.trim().trim_start_matches('0').to_owned())
                .filter(|v| !v.is_empty())
        })
        .map(|serial| format!("gardyn-{serial}"))
        .unwrap_or_else(|| "gardyn-unknown".to_owned())
}

#[cfg(test)]
mod tests {
    #[test]
    fn override_wins() {
        assert_eq!(super::unit_id(Some("x")), "x");
    }
}
