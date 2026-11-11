//! The binary as core runs it: arguments in, the still on stdin or from a path, JSON out.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

use base64::Engine as _;

const PARITY: &str = include_str!("../../../../src/vision/tests/parity/pod-state-parity.json");

struct Fixture {
    dir: PathBuf,
    model: PathBuf,
    ppm: Vec<u8>,
    pods: String,
}

fn fixture(name: &str) -> Fixture {
    let v: serde_json::Value = serde_json::from_str(PARITY).unwrap();
    let dir = std::env::temp_dir().join(format!("podvision-cli-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let model = dir.join("model.json");
    std::fs::write(&model, v["model"].to_string()).unwrap();
    let (w, h) = (
        v["image"]["width"].as_u64().unwrap(),
        v["image"]["height"].as_u64().unwrap(),
    );
    let rgba = base64::engine::general_purpose::STANDARD
        .decode(v["image"]["rgba"].as_str().unwrap())
        .unwrap();
    let mut ppm = format!("P6\n{w} {h}\n255\n").into_bytes();
    ppm.extend(rgba.chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]));
    let pods = serde_json::json!({ "1": { "x": 0.25, "y": 0.25, "w": 0.5, "h": 0.5 }, "7": { "x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0 } }).to_string();
    Fixture {
        dir,
        model,
        ppm,
        pods,
    }
}

fn podvision(args: &[&str], stdin: &[u8]) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_podvision"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // A binary that refuses its arguments exits before reading; the pipe breaking then is fine.
    let _ = child.stdin.take().unwrap().write_all(stdin);
    child.wait_with_output().unwrap()
}

fn stderr(o: &Output) -> String {
    String::from_utf8_lossy(&o.stderr).into_owned()
}

#[test]
fn scores_a_still_from_stdin_or_a_path() {
    let f = fixture("ok");
    let model = format!("pod-state={}", f.model.display());
    let o = podvision(&["--pods", &f.pods, "--model", &model], &f.ppm);
    assert!(o.status.success(), "{}", stderr(&o));
    let out: serde_json::Value = serde_json::from_slice(&o.stdout).unwrap();
    assert_eq!(out["width"], 160);
    assert_eq!(out["scale"], 1);
    assert_eq!(out["damaged"], false);
    assert_eq!(out["models"][0]["id"], "pod-state");
    let slots: Vec<_> = out["models"][0]["pods"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["slot"].as_u64().unwrap())
        .collect();
    assert_eq!(slots, [1, 7]);

    let still = f.dir.join("still.ppm");
    std::fs::write(&still, &f.ppm).unwrap();
    let o = podvision(
        &[
            "--image",
            still.to_str().unwrap(),
            "--pods",
            &f.pods,
            "--model",
            &model,
            "--model",
            &format!("pod-state-b={}", f.model.display()),
            "--scale",
            "2",
        ],
        b"",
    );
    assert!(o.status.success(), "{}", stderr(&o));
    let again: serde_json::Value = serde_json::from_slice(&o.stdout).unwrap();
    assert_eq!(again["models"].as_array().unwrap().len(), 2);
    assert_eq!(again["models"][0]["pods"], out["models"][0]["pods"]);
}

#[test]
fn reads_dot_codes_from_a_pod_id_still() {
    let still = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/fixtures/dotcodes/upper-2026-11-10-pod6.jpg"
    );
    let bytes = std::fs::read(still).unwrap();
    // The crop is 432 × 314; pod 6's box in it, as fractions.
    let pods = serde_json::json!({ "6": { "x": 53.6 / 432.0, "y": -130.0 / 314.0, "w": 326.3 / 432.0, "h": 326.4 / 314.0 } }).to_string();
    for (args, stdin) in [
        (
            vec!["--codes", "--pods", pods.as_str(), "--image", still],
            &b""[..],
        ),
        (vec!["--codes", "--pods", pods.as_str()], &bytes[..]),
    ] {
        let o = podvision(&args, stdin);
        assert!(o.status.success(), "{}", stderr(&o));
        let out: serde_json::Value = serde_json::from_slice(&o.stdout).unwrap();
        assert_eq!(
            (out["width"].as_u64(), out["damaged"].as_bool()),
            (Some(432), Some(false))
        );
        assert_eq!(out["pods"][0]["slot"], 6);
        assert_eq!(out["pods"][0]["code"], "oo||");
        assert_eq!(out["pods"][0]["dots"].as_array().unwrap().len(), 5);
    }
    // Codes or models, not both; and one or the other.
    let o = podvision(&["--codes", "--pods", &pods, "--model", "a=b"], b"");
    assert_eq!(o.status.code(), Some(2));
    let o = podvision(&["--pods", &pods], b"");
    assert_eq!(o.status.code(), Some(2));
}

#[test]
fn says_its_version() {
    let o = podvision(&["--version"], b"");
    assert!(o.status.success());
    assert!(String::from_utf8_lossy(&o.stdout).starts_with("podvision "));
}

#[test]
fn exits_1_naming_what_is_wrong() {
    let f = fixture("bad");
    let model = format!("pod-state={}", f.model.display());
    let broken = f.dir.join("broken.json");
    std::fs::write(&broken, r#"{"format":"onnx"}"#).unwrap();
    let cases: Vec<(Vec<String>, &[u8], &str)> = vec![
        (
            vec!["--pods".into(), f.pods.clone(), "--model".into(), model.clone()],
            &[0xFF, 0xD8, 0xFF, 0x00],
            "not a decodable JPEG",
        ),
        (
            vec!["--pods".into(), f.pods.clone(), "--model".into(), model.clone()],
            b"<svg/>",
            "not a JPEG",
        ),
        (
            vec!["--pods".into(), "[1]".into(), "--model".into(), model.clone()],
            &f.ppm,
            "--pods is not a JSON object",
        ),
        (
            vec![
                "--pods".into(),
                r#"{"one":{"x":0,"y":0,"w":1,"h":1}}"#.into(),
                "--model".into(),
                model.clone(),
            ],
            &f.ppm,
            "pod slot one",
        ),
        (
            vec![
                "--pods".into(),
                f.pods.clone(),
                "--model".into(),
                "pod-state".into(),
            ],
            &f.ppm,
            "ID=PATH",
        ),
        (
            vec![
                "--pods".into(),
                f.pods.clone(),
                "--model".into(),
                "pod-state=/nonexistent/model.json".into(),
            ],
            &f.ppm,
            "can't read /nonexistent",
        ),
        (
            vec![
                "--pods".into(),
                f.pods.clone(),
                "--model".into(),
                format!("pod-state={}", broken.display()),
            ],
            &f.ppm,
            "not a seedypod-cnn",
        ),
        (
            vec![
                "--pods".into(),
                f.pods.clone(),
                "--model".into(),
                model.clone(),
                "--scale".into(),
                "3".into(),
            ],
            &f.ppm,
            "--scale must be",
        ),
        (
            vec![
                "--pods".into(),
                f.pods.clone(),
                "--model".into(),
                model.clone(),
                "--image".into(),
                "/nonexistent.jpg".into(),
            ],
            b"",
            "can't read /nonexistent.jpg",
        ),
    ];
    for (args, stdin, message) in cases {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let o = podvision(&args, stdin);
        assert_eq!(o.status.code(), Some(1), "{args:?}: {}", stderr(&o));
        assert!(stderr(&o).contains(message), "{args:?}: {}", stderr(&o));
    }
    // A usage error is clap's: exit 2.
    assert_eq!(podvision(&["--pods", "{}"], b"").status.code(), Some(2));
}
