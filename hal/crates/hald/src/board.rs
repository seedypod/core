//! Which Raspberry Pi hald runs on, from the device tree, so the app can show
//! it: an original Pi Zero W can't run core (docs/INSTALLATION.md#which-pi).

const MODEL_PATH: &str = "/proc/device-tree/model";

/// The model string without the kernel's trailing NUL; None when empty.
pub fn model_from(raw: &str) -> Option<String> {
    let m = raw.trim_matches(|c: char| c == '\0' || c.is_whitespace());
    (!m.is_empty()).then(|| m.to_owned())
}

/// This machine's board, e.g. "Raspberry Pi Zero 2 W Rev 1.0"; None off a Pi.
pub fn read() -> Option<String> {
    std::fs::read_to_string(MODEL_PATH)
        .ok()
        .and_then(|s| model_from(&s))
}

#[cfg(test)]
mod tests {
    use super::model_from;

    #[test]
    fn strips_the_trailing_nul_and_rejects_empty() {
        assert_eq!(
            model_from("Raspberry Pi Zero W Rev 1.1\0").as_deref(),
            Some("Raspberry Pi Zero W Rev 1.1")
        );
        assert_eq!(model_from("\0"), None);
        assert_eq!(model_from(""), None);
    }
}
