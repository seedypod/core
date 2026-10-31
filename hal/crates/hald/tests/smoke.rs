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
fn camera_rules_are_printed_for_explicit_ports_and_bad_input_is_refused() {
    let out = hald()
        .args(["--camera-rules", "upper=1-1.3:1.0", "lower=1-1.2:1.0"])
        .output()
        .expect("hald runs");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let rules = String::from_utf8(out.stdout).unwrap();
    assert!(rules.contains("KERNELS==\"1-1.3:1.0\", ATTR{index}==\"0\", SYMLINK+=\"seedypod/camera-upper\""));
    assert!(rules.contains("SYMLINK+=\"seedypod/camera-lower\""));
    let bad = hald().args(["--camera-rules", "upper"]).output().expect("hald runs");
    assert!(!bad.status.success());
    let listed = hald().arg("--list-cameras").output().expect("hald runs");
    assert!(listed.status.success());
    assert!(serde_json::from_slice::<serde_json::Value>(&listed.stdout).unwrap().is_array());
}
