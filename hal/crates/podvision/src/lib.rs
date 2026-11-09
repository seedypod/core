//! podvision (#191): core's native pod-state runner. Core starts it at nice 19
//! for each capture, with the still on stdin, the pod boxes and the weights
//! files of every enabled pod-state revision; it decodes the still (at reduced
//! scale where the crops allow), crops each pod and runs each model, and
//! prints one JSON object. Core turns that into the same analysis rows as its
//! TypeScript runner (`src/vision/podState.ts`), which stays as the fallback.
//!
//! It is a separate process from hald on purpose (ADR 0004, ADR 0019): a
//! malformed JPEG can at worst kill this child, never the hardware daemon.

pub mod image;
pub mod model;

use image::{Rect, Rgb};
use model::Model;
use serde_json::{json, Map, Value};
use std::time::Instant;

/// Flush subnormal floats to zero on 32-bit ARM. The Pi Zero W's VFP11 hands every
/// subnormal operand or result to the kernel's support code, thousands of cycles
/// each, and trained weights hold hundreds of them (405 in the shipped model's
/// last conv, more products that underflow): measured on the unit, the forward
/// pass ran about 10× slower than its instruction count. Values that small change
/// no logit by more than 1e-30, so results stay those of core's runner.
pub fn flush_subnormals() {
    #[cfg(target_arch = "arm")]
    // SAFETY: only sets FPSCR's flush-to-zero (bit 24) and default-NaN (bit 25) mode bits for this thread.
    unsafe {
        let mut fpscr: u32;
        std::arch::asm!("vmrs {0}, fpscr", out(reg) fpscr);
        fpscr |= (1 << 24) | (1 << 25);
        std::arch::asm!("vmsr fpscr, {0}", in(reg) fpscr);
    }
}

/// Why a run failed; each maps to an exit code.
#[derive(Debug, PartialEq)]
pub enum Failure {
    Usage(String),
    Model(String),
    Image(String),
    Io(String),
}

impl Failure {
    pub fn code(&self) -> i32 {
        match self {
            Failure::Io(_) => 1,
            Failure::Usage(_) => 2,
            Failure::Model(_) => 3,
            Failure::Image(_) => 4,
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Failure::Usage(m) | Failure::Model(m) | Failure::Image(m) | Failure::Io(m) => m,
        }
    }
}

/// The pod boxes, as fractions of the frame by slot, in slot order.
pub fn parse_regions(text: &str) -> Result<Vec<(u32, Rect)>, Failure> {
    let bad = |m: String| Failure::Usage(format!("--regions: {m}"));
    let raw: Value = serde_json::from_str(text).map_err(|e| bad(format!("not JSON: {e}")))?;
    let obj = raw
        .as_object()
        .ok_or_else(|| bad("must be an object of slot → {x, y, w, h}".into()))?;
    let mut out = Vec::with_capacity(obj.len());
    for (slot, r) in obj {
        let n = slot
            .parse::<u32>()
            .map_err(|_| bad(format!("slot {slot} is not a whole number")))?;
        let v = |k: &str| r.get(k).and_then(Value::as_f64).filter(|f| f.is_finite());
        let (Some(x), Some(y), Some(w), Some(h)) = (v("x"), v("y"), v("w"), v("h")) else {
            return Err(bad(format!("slot {slot} needs finite x, y, w and h")));
        };
        out.push((n, Rect { x, y, w, h }));
    }
    out.sort_by_key(|(s, _)| *s);
    Ok(out)
}

/// What one run needs: the still's bytes, the boxes, and the models in the order given.
pub struct Job<'a> {
    pub jpeg: &'a [u8],
    pub regions: &'a [(u32, Rect)],
    pub models: &'a [Model],
    /// Decode at this many eighths of full size; chosen from the crops when None.
    pub eighths: Option<usize>,
}

fn ms(t: Instant) -> f64 {
    (t.elapsed().as_secs_f64() * 10_000.0).round() / 10.0
}

/// Decode, crop and score. The result is what the binary prints.
pub fn run(job: &Job) -> Result<Value, Failure> {
    let started = Instant::now();
    let (width, height) = image::jpeg_size(job.jpeg).map_err(|e| Failure::Image(e.0))?;
    let rects: Vec<Rect> = job.regions.iter().map(|(_, r)| *r).collect();
    let inputs: Vec<&model::Input> = job.models.iter().map(|m| &m.input).collect();
    let eighths = job
        .eighths
        .unwrap_or_else(|| image::choose_eighths(width, height, &rects, &inputs));
    let img: Rgb = image::decode_jpeg(job.jpeg, eighths).map_err(|e| Failure::Image(e.0))?;
    let decode_ms = ms(started);
    let mut out = Map::new();
    out.insert("width".into(), json!(width));
    out.insert("height".into(), json!(height));
    out.insert(
        "decoded".into(),
        json!({ "width": img.width, "height": img.height, "eighths": eighths }),
    );
    if image::has_zero_filled_rows(&img) {
        out.insert("damaged".into(), json!(true));
        out.insert("models".into(), json!([]));
        out.insert(
            "timing".into(),
            json!({ "decodeMs": decode_ms, "forwardMs": 0.0, "totalMs": ms(started) }),
        );
        return Ok(Value::Object(out));
    }
    let bright = image::brightness(&img);
    let scoring = Instant::now();
    let mut models = Vec::with_capacity(job.models.len());
    for m in job.models {
        let mut entry = Map::new();
        entry.insert("analyzer".into(), json!(m.analyzer));
        entry.insert("version".into(), json!(m.version));
        entry.insert("revision".into(), json!(m.revision));
        // A still taken with the grow light off says nothing about the pods, and the model never saw one.
        let dark = m.min_brightness.is_some_and(|min| bright < min);
        let mut pods = Vec::new();
        if !dark {
            let mut x = vec![0f32; m.input.width * m.input.height * m.input.channels];
            let mut scratch = m.scratch();
            for (slot, r) in job.regions {
                image::crop_input_into(
                    &img,
                    &image::to_pixels(r, img.width, img.height),
                    &m.input,
                    &mut x,
                );
                let p = model::softmax(&m.forward(&x, &mut scratch).map_err(|e| Failure::Model(e.0))?);
                pods.push(json!({ "slot": slot, "class": model::argmax(&p), "probabilities": p }));
            }
        }
        entry.insert("skipped".into(), if dark { json!("dark") } else { Value::Null });
        entry.insert("pods".into(), Value::Array(pods));
        models.push(Value::Object(entry));
    }
    out.insert("damaged".into(), json!(false));
    out.insert("brightness".into(), json!(bright));
    out.insert("models".into(), Value::Array(models));
    out.insert(
        "timing".into(),
        json!({ "decodeMs": decode_ms, "forwardMs": ms(scoring), "totalMs": ms(started) }),
    );
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    const UPPER: &[u8] = include_bytes!("../../hal-sim/fixtures/upper.jpg");
    const SHIPPED: &str = include_str!("../../../../models/pod-state.json");

    fn shipped() -> Model {
        Model::parse(SHIPPED).unwrap()
    }

    #[test]
    fn scores_every_pod_with_every_model_in_slot_order() {
        let regions =
            parse_regions(r#"{"16":{"x":0.5,"y":0.1,"w":0.3,"h":0.4},"2":{"x":0,"y":0,"w":0.25,"h":0.3}}"#)
                .unwrap();
        assert_eq!(regions.iter().map(|(s, _)| *s).collect::<Vec<_>>(), [2, 16]);
        let models = [shipped(), shipped()];
        let out = run(&Job {
            jpeg: UPPER,
            regions: &regions,
            models: &models,
            eighths: None,
        })
        .unwrap();
        assert_eq!(
            (out["width"].as_u64(), out["height"].as_u64()),
            (Some(320), Some(240))
        );
        // 0.25 × 320 = 80 px wide, so half scale (40 px) would be smaller than the 64 px input.
        assert_eq!(out["decoded"]["eighths"], 8);
        assert_eq!(out["damaged"], false);
        let m = out["models"].as_array().unwrap();
        assert_eq!(m.len(), 2);
        assert_eq!(
            (m[0]["analyzer"].as_str(), m[0]["version"].as_u64()),
            (Some("pod-state"), Some(1))
        );
        assert_eq!(m[0]["skipped"], Value::Null);
        let pods = m[0]["pods"].as_array().unwrap();
        assert_eq!(
            pods.iter()
                .map(|p| p["slot"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            [2, 16]
        );
        let p: Vec<f64> = pods[0]["probabilities"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_f64().unwrap())
            .collect();
        assert_eq!(p.len(), 5);
        assert!((p.iter().sum::<f64>() - 1.0).abs() < 1e-5);
        assert_eq!(m[1]["pods"], m[0]["pods"]);
        assert!(out["timing"]["totalMs"].as_f64().unwrap() >= out["timing"]["decodeMs"].as_f64().unwrap());
    }

    #[test]
    fn decodes_smaller_when_asked_or_when_every_crop_allows() {
        let regions = parse_regions(r#"{"1":{"x":0,"y":0,"w":1,"h":1}}"#).unwrap();
        let models = [shipped()];
        let auto = run(&Job {
            jpeg: UPPER,
            regions: &regions,
            models: &models,
            eighths: None,
        })
        .unwrap();
        // 320×240 at 1/2 is 160×120, at 1/4 80×60: the 64 px input fits the first, not the second.
        assert_eq!(
            auto["decoded"],
            json!({ "width": 160, "height": 120, "eighths": 4 })
        );
        let forced = run(&Job {
            jpeg: UPPER,
            regions: &regions,
            models: &models,
            eighths: Some(1),
        })
        .unwrap();
        assert_eq!(forced["decoded"]["width"], 40);
        assert_eq!(forced["models"][0]["pods"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn skips_a_dark_still_and_flags_a_damaged_one() {
        let regions = parse_regions(r#"{"1":{"x":0,"y":0,"w":0.5,"h":0.5}}"#).unwrap();
        let mut dark = serde_json::from_str::<Value>(SHIPPED).unwrap();
        dark["minBrightness"] = json!(0.99);
        let models = [Model::from_value(&dark).unwrap()];
        let out = run(&Job {
            jpeg: UPPER,
            regions: &regions,
            models: &models,
            eighths: None,
        })
        .unwrap();
        assert_eq!(out["models"][0]["skipped"], "dark");
        assert_eq!(out["models"][0]["pods"], json!([]));

        let torn = include_bytes!("../fixtures/zero-filled.jpg");
        let out = run(&Job {
            jpeg: torn,
            regions: &regions,
            models: &models,
            eighths: None,
        })
        .unwrap();
        assert_eq!(out["damaged"], true);
        assert_eq!(out["models"], json!([]));
    }

    #[test]
    fn refuses_bad_input_with_its_exit_code() {
        let models = [shipped()];
        let regions = parse_regions("{}").unwrap();
        let e = run(&Job {
            jpeg: b"GIF89a",
            regions: &regions,
            models: &models,
            eighths: None,
        })
        .unwrap_err();
        assert_eq!((e.code(), e.message()), (4, "not a JPEG"));
        assert_eq!(parse_regions("[").unwrap_err().code(), 2);
        assert!(parse_regions("[]")
            .unwrap_err()
            .message()
            .contains("must be an object"));
        assert!(parse_regions(r#"{"a":{}}"#)
            .unwrap_err()
            .message()
            .contains("slot a is not a whole number"));
        assert!(parse_regions(r#"{"1":{"x":0,"y":0,"w":1}}"#)
            .unwrap_err()
            .message()
            .contains("needs finite"));
        assert_eq!(Failure::Model("m".into()).code(), 3);
        assert_eq!(Failure::Io("io".into()).code(), 1);
    }
}
