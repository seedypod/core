//! Binary smoke tests: the simulator path end to end through the CLI, with
//! publishes captured as JSON lines (`--stdout`) instead of a broker.

use std::path::PathBuf;
use std::process::Command;

fn hald() -> Command {
    Command::new(env!("CARGO_BIN_EXE_hald"))
}

fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("hald-smoke-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn sim_run_publishes_the_contract_and_goes_offline() {
    let dir = tmp("run");
    let cfg = dir.join("hal.toml");
    std::fs::write(
        &cfg,
        format!(
            "unit_id = \"smoke\"\nhttp_bind = \"127.0.0.1:0\"\nmdns = false\ntelemetry_interval_s = 1\nstate_dir = {:?}\n",
            dir.join("state")
        ),
    )
    .unwrap();
    let out = hald()
        .args(["--sim", "--stdout", "--ticks", "2", "--config"])
        .arg(&cfg)
        .output()
        .expect("hald runs");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let stdout = String::from_utf8(out.stdout).unwrap();
    let lines: Vec<serde_json::Value> = stdout
        .lines()
        .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("{e}: {l}")))
        .collect();
    let topics: Vec<&str> = lines.iter().map(|v| v["topic"].as_str().unwrap()).collect();
    assert_eq!(topics[0], "seedypod/smoke/system");
    assert_eq!(
        lines[0]["payload"]["caps"]["actuators"],
        serde_json::json!(["light", "pump"])
    );
    assert!(topics.contains(&"homeassistant/light/smoke_light/config"));
    assert!(topics.contains(&"homeassistant/fan/smoke_pump/config"));
    assert!(topics.contains(&"seedypod/smoke/alert/water_low"));
    assert!(
        topics
            .iter()
            .filter(|t| **t == "seedypod/smoke/sensor/air_temp")
            .count()
            >= 2
    );
    let last = lines.last().unwrap();
    assert_eq!(last["topic"], "seedypod/smoke/availability");
    assert_eq!(last["payload"], "offline");
    assert_eq!(last["retain"], true);
    assert!(dir.join("state").join("state.json").exists());
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn check_validates_and_reports_unknown_kinds() {
    let dir = tmp("check");
    let cfg = dir.join("hal.toml");
    std::fs::write(&cfg, "[[sensor]]\nkind = \"bme280\"\n").unwrap();
    let out = hald().args(["--check", "--config"]).arg(&cfg).output().unwrap();
    assert_eq!(out.status.code(), Some(1));
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["ok"], false);
    assert!(v["errors"][0].as_str().unwrap().contains("bme280"));

    let out = hald().args(["--check"]).output().unwrap();
    assert!(out.status.success());
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["ok"], true);
    assert_eq!(v["actuators"], serde_json::json!(["light", "pump"]));
    // The pump current guard ships off until a baseline is measured.
    assert!(v["limits"]["pump_dry_current_a"].is_null());
    assert_eq!(v["limits"]["pump_dry_after_ms"], 300);
    assert_eq!(v["limits"]["pump_dry_grace_ms"], 3000);
    assert_eq!(v["limits"]["pump_dry_grace_min_ms"], 300);
    assert_eq!(v["limits"]["pump_dry_grace_max_ms"], 5000);
    // The bounds the app's settings are held to, and the mode open to it.
    assert_eq!(v["limits"]["pump_dry_current_min_a"], 0.1);
    assert_eq!(v["limits"]["pump_dry_current_max_a"], 3.0);
    assert_eq!(v["limits"]["water_low_cm"], 16.0);
    assert_eq!(v["limits"]["water_low_min_cm"], 8.0);
    assert_eq!(v["limits"]["water_low_max_cm"], 19.0);
    assert_eq!(v["limits"]["water_low_hold_ms"], 0);
    assert_eq!(v["limits"]["water_low_hold_min_ms"], 0);
    assert_eq!(v["limits"]["water_low_hold_max_ms"], 60_000);
    assert_eq!(v["limits"]["pump_dry_guard_app"], true);
    // Both asked, no cutoff yet: the tank level alone, and a warning that says so.
    assert_eq!(v["limits"]["pump_dry_guard_asked"], "both");
    assert_eq!(v["limits"]["pump_dry_guard"], "level");
    assert_eq!(
        v["limits"]["pump_dry_guard_why"],
        "tank level only: no pump_dry_current_a"
    );
    assert_eq!(
        v["warnings"],
        serde_json::json!(["tank level only: no pump_dry_current_a"])
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn check_prints_the_dry_run_guard_in_effect_and_why() {
    let dir = tmp("check-guard");
    let cfg = dir.join("hal.toml");
    let check = |toml: &str| {
        std::fs::write(&cfg, toml).unwrap();
        let out = hald().args(["--check", "--config"]).arg(&cfg).output().unwrap();
        serde_json::from_slice::<serde_json::Value>(&out.stdout).unwrap()
    };
    let v = check("[limits]\npump_dry_guard = \"current\"\npump_dry_current_a = 1.2\n");
    assert_eq!(v["limits"]["pump_dry_guard"], "current");
    assert_eq!(v["warnings"], serde_json::json!([]));
    let v = check("[limits]\npump_dry_current_a = 1.2\n");
    assert_eq!(v["limits"]["pump_dry_guard"], "both");
    assert_eq!(v["limits"]["pump_dry_guard_why"], "tank level + pump current");
    // Current without a monitor falls back to the tank, never to no guard.
    let v = check(
        "[limits]\npump_dry_guard = \"current\"\npump_dry_current_a = 1.2\n[[sensor]]\nkind = \"pct2075\"\naddr = 0x48\n[[sensor]]\nkind = \"dyp_a01\"\ntrigger = 26\necho = 19\n",
    );
    assert_eq!(v["limits"]["pump_dry_guard"], "level");
    assert_eq!(
        v["warnings"][0],
        "pump_dry_guard = \"current\" needs a pump monitor (ina219): falling back to the tank level"
    );
    // The brown-out guard: on by default against the INA219's bus voltage.
    let v = check("");
    assert_eq!(v["limits"]["pump_max_duty"], 100.0);
    assert_eq!(v["limits"]["pump_brownout_v"], 10.8);
    assert_eq!(v["limits"]["pump_brownout_ms"], 300);
    assert_eq!(v["limits"]["pump_brownout_pi"], true);
    // Off a Pi there's no get_throttled to read.
    let guard = v["limits"]["pump_brownout_guard"].as_str().unwrap();
    assert!(guard.starts_with("supply below 10.8 V for 0.3 s"), "{guard}");
    assert_eq!(
        v["limits"]["pump_brownout_pi_readable"],
        std::path::Path::new("/sys/devices/platform/soc/soc:firmware/get_throttled").exists()
    );
    let v = check("[limits]\npump_brownout_v = 0\npump_brownout_pi = false\n");
    assert!(v["limits"]["pump_brownout_v"].is_null());
    assert!(v["warnings"]
        .as_array()
        .unwrap()
        .contains(&serde_json::json!("off: pump_brownout_v = 0")));
    let v = check("[limits]\npump_brownout_v = 13\n");
    assert_eq!(v["ok"], false);
    assert!(v["errors"][0]
        .as_str()
        .unwrap()
        .contains("pump_brownout_v must be 6–12 V"));
    // Bounds the default sits outside of are refused.
    let v = check("[limits]\npump_dry_grace_ms = 6000\n");
    assert_eq!(v["ok"], false);
    assert!(v["errors"][0]
        .as_str()
        .unwrap()
        .contains("pump_dry_grace_max_ms (5000)"));
    // So are bounds the other app settings can't sit in, and a hal.toml value outside them.
    let v = check("[limits]\npump_dry_current_min_a = 2\npump_dry_current_max_a = 1\n");
    assert_eq!(v["ok"], false);
    assert!(v["errors"][0]
        .as_str()
        .unwrap()
        .contains("pump_dry_current_min_a (2) ≤ pump_dry_current_max_a (1)"));
    let v = check("[limits]\npump_dry_current_a = 3.1\n");
    assert_eq!(v["ok"], false);
    assert!(v["errors"][0]
        .as_str()
        .unwrap()
        .contains("pump_dry_current_a (3.1) must lie within"));
    let v = check("[limits]\nwater_low_cm = 4\n");
    assert_eq!(v["ok"], false);
    assert!(v["errors"][0]
        .as_str()
        .unwrap()
        .contains("water_low_cm (4) must lie within water_low_min_cm (8)"));
    let v = check("[limits]\nwater_low_hold_ms = 61000\nwater_low_hold_max_ms = 61000\n");
    assert_eq!(v["ok"], false);
    assert!(v["errors"][0]
        .as_str()
        .unwrap()
        .contains("water_low_hold_max_ms must be ≤ 60000"));
    // Set, they're printed as set.
    let v = check(
        "[limits]\npump_dry_guard_app = false\npump_dry_current_a = 0.8\nwater_low_hold_ms = 2000\nwater_low_min_cm = 10\n",
    );
    assert_eq!(v["ok"], true, "{v}");
    assert_eq!(v["limits"]["pump_dry_guard_app"], false);
    assert_eq!(v["limits"]["pump_dry_current_a"], 0.8);
    assert_eq!(v["limits"]["water_low_hold_ms"], 2000);
    assert_eq!(v["limits"]["water_low_min_cm"], 10.0);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_pump_trace_file_is_opened_up_front_and_a_bad_path_is_refused() {
    let dir = tmp("trace");
    let cfg = dir.join("hal.toml");
    std::fs::write(
        &cfg,
        format!(
            "unit_id = \"smoke\"\nhttp_bind = \"127.0.0.1:0\"\nmdns = false\ntelemetry_interval_s = 1\nstate_dir = {:?}\n",
            dir.join("state")
        ),
    )
    .unwrap();
    let trace = dir.join("pump-trace.csv");
    let out = hald()
        .args(["--sim", "--stdout", "--ticks", "2", "--config"])
        .arg(&cfg)
        .arg("--pump-trace")
        .arg(&trace)
        .output()
        .expect("hald runs");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(trace.exists());
    let out = hald()
        .args(["--sim", "--stdout", "--ticks", "1", "--config"])
        .arg(&cfg)
        .arg("--pump-trace")
        .arg(dir.join("no-such-dir").join("pump-trace.csv"))
        .output()
        .expect("hald runs");
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("pump trace"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn print_default_config_round_trips_through_check() {
    let dir = tmp("default");
    let out = hald().arg("--print-default-config").output().unwrap();
    assert!(out.status.success());
    let text = String::from_utf8(out.stdout).unwrap();
    assert!(text.contains("[limits]"));
    let cfg = dir.join("hal.toml");
    std::fs::write(&cfg, text).unwrap();
    let out = hald().args(["--check", "--config"]).arg(&cfg).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stdout));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn invalid_config_is_refused_before_starting() {
    let dir = tmp("invalid");
    let cfg = dir.join("hal.toml");
    std::fs::write(&cfg, "telemetry_interval_s = 0\n").unwrap();
    let out = hald()
        .args(["--sim", "--stdout", "--config"])
        .arg(&cfg)
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("telemetry_interval_s"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn usb_recovery_can_be_turned_off_and_does_nothing_then() {
    let dir = tmp("usb");
    let cfg = dir.join("hal.toml");
    std::fs::write(&cfg, "[usb_recovery]\nenabled = false\n").unwrap();
    let out = hald()
        .args(["--usb-recover", "--config"])
        .arg(&cfg)
        .output()
        .expect("hald runs");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(String::from_utf8_lossy(&out.stderr).contains("disabled"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn camera_rules_are_printed_for_explicit_ports_and_bad_input_is_refused() {
    let out = hald()
        .args(["--camera-rules", "upper=1-1.3:1.0", "lower=1-1.2:1.0"])
        .output()
        .expect("hald runs");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let rules = String::from_utf8(out.stdout).unwrap();
    assert!(rules.contains("KERNELS==\"1-1.3:1.0\", ATTR{index}==\"0\", SYMLINK+=\"seedypod/camera-upper\""));
    assert!(rules.contains("SYMLINK+=\"seedypod/camera-lower\""));
    let bad = hald()
        .args(["--camera-rules", "upper"])
        .output()
        .expect("hald runs");
    assert!(!bad.status.success());
    let bad = hald()
        .args(["--camera-rules", "upper=bcm2835-codec"])
        .output()
        .expect("hald runs");
    assert!(!bad.status.success());
    let listed = hald().arg("--list-cameras").output().expect("hald runs");
    assert!(listed.status.success());
    assert!(serde_json::from_slice::<serde_json::Value>(&listed.stdout)
        .unwrap()
        .is_array());
}

#[test]
fn syncing_camera_rules_with_no_cameras_changes_nothing() {
    let out = hald().arg("--sync-camera-rules").output().expect("hald runs");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(String::from_utf8_lossy(&out.stdout).contains("names are pinned when both appear"));
}
