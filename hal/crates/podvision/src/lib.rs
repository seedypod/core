//! `podvision` (#191): the pod-state analyser's pixels and forward pass, native.
//!
//! Core runs it as a `nice` 19 child for each capture: it decodes the still
//! (scaled down where the crops allow), crops every pod, runs every enabled
//! pod-state revision and prints JSON. It is a separate binary from `hald`
//! and links none of it (ADR 0004, ADR 0019); core's TypeScript runner is the
//! fallback, and both read the same `seedypod-cnn` weights files.

pub mod cnn;
pub mod image;

#[cfg(test)]
mod fixture;

use std::collections::BTreeMap;
use std::time::Instant;

use anyhow::Result;
use serde::Serialize;

use cnn::{argmax, softmax, Model};
use image::{brightness, crop_input, decode, has_zero_filled_rows, Rect, Scale};

/// Core's zero-fill check steps 4 rows at full size (`ROW_STRIDE`).
const ROW_STRIDE: usize = 4;

#[derive(Debug, Serialize)]
pub struct Response {
    /// The still's size.
    pub width: usize,
    pub height: usize,
    /// What it was decoded at: 1, 2, 4 or 8 times smaller.
    pub scale: usize,
    /// Mean of R, G and B, 0–1.
    pub brightness: f64,
    /// Rows of zero fill: a damaged frame, so nothing was scored.
    pub damaged: bool,
    pub models: Vec<ModelResult>,
    pub ms: Timing,
}

#[derive(Debug, Serialize)]
pub struct ModelResult {
    pub id: String,
    pub version: u32,
    pub revision: String,
    pub classes: Vec<String>,
    /// Darker than the model's `minBrightness`, so no pod was scored.
    pub dark: bool,
    pub pods: Vec<PodResult>,
}

#[derive(Debug, Serialize)]
pub struct PodResult {
    pub slot: u32,
    /// Index of the most likely class.
    pub class: usize,
    pub probabilities: Vec<f32>,
    pub logits: Vec<f32>,
}

#[derive(Debug, Serialize)]
pub struct Timing {
    pub decode: u64,
    pub forward: u64,
}

/// Flush subnormal floats to zero on 32-bit ARM. The Pi Zero W's VFP11 hands every
/// subnormal operand or result to the kernel's support code, and the shipped model
/// has hundreds of subnormal weights (405 in its last conv): found on the unit
/// (#191), where the forward pass ran 3–5× slower for it. Values that small move no
/// logit by anything a float32 sum can hold, so results stay core's runner's.
pub fn flush_subnormals() {
    #[cfg(target_arch = "arm")]
    // SAFETY: sets only FPSCR's flush-to-zero (bit 24) and default-NaN (bit 25) mode bits, for this thread.
    unsafe {
        let mut fpscr: u32;
        std::arch::asm!("vmrs {0}, fpscr", out(reg) fpscr);
        fpscr |= (1 << 24) | (1 << 25);
        std::arch::asm!("vmsr fpscr, {0}", in(reg) fpscr);
    }
}

/// Score one still. `pods` are fractions of the frame, as core's pod regions are.
pub fn run(
    bytes: &[u8],
    pods: &BTreeMap<u32, Rect>,
    models: &[(String, Model)],
    scale: Scale,
) -> Result<Response> {
    flush_subnormals();
    let started = Instant::now();
    let inputs: Vec<_> = models.iter().map(|(_, m)| &m.input).collect();
    let d = decode(bytes, scale, pods, &inputs)?;
    let decoded = started.elapsed();
    let img = &d.image;
    let lit = brightness(img);
    let damaged = has_zero_filled_rows(img, ROW_STRIDE / d.scale);
    let mut results = Vec::new();
    if !damaged {
        for (id, m) in models {
            let dark = m.min_brightness.is_some_and(|min| lit < min);
            let mut out = Vec::new();
            if !dark {
                let mut scratch = m.scratch();
                for (slot, r) in pods {
                    let x = crop_input(img, &r.to_pixels(img.width, img.height), &m.input);
                    let logits = m.forward(&x, &mut scratch)?;
                    let probabilities = softmax(&logits);
                    out.push(PodResult {
                        slot: *slot,
                        class: argmax(&probabilities),
                        probabilities,
                        logits,
                    });
                }
            }
            results.push(ModelResult {
                id: id.clone(),
                version: m.version,
                revision: m.revision.clone(),
                classes: m.classes.clone(),
                dark,
                pods: out,
            });
        }
    }
    Ok(Response {
        width: d.width,
        height: d.height,
        scale: d.scale,
        brightness: lit,
        damaged,
        models: results,
        ms: Timing {
            decode: decoded.as_millis() as u64,
            forward: (started.elapsed() - decoded).as_millis() as u64,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use fixture::{model_json, Fixture};

    fn ppm(img: &image::Rgb) -> Vec<u8> {
        let mut out = format!("P6\n{} {}\n255\n", img.width, img.height).into_bytes();
        out.extend_from_slice(&img.data);
        out
    }

    fn fractions(f: &Fixture) -> BTreeMap<u32, Rect> {
        let (w, h) = (f.image.width as f64, f.image.height as f64);
        f.cases
            .iter()
            .enumerate()
            .map(|(i, c)| {
                (
                    i as u32 + 1,
                    Rect {
                        x: c.rect.x / w,
                        y: c.rect.y / h,
                        w: c.rect.w / w,
                        h: c.rect.h / h,
                    },
                )
            })
            .collect()
    }

    #[test]
    fn scores_every_pod_for_every_model() {
        let f = Fixture::load();
        let models = vec![
            ("pod-state".to_string(), Model::parse(&model_json()).unwrap()),
            ("pod-state-b".to_string(), Model::parse(&model_json()).unwrap()),
        ];
        let r = run(&ppm(&f.image), &fractions(&f), &models, Scale::Auto).unwrap();
        assert_eq!((r.width, r.height, r.scale, r.damaged), (160, 120, 1, false));
        assert_eq!(r.models.len(), 2);
        for m in &r.models {
            assert_eq!(
                (m.version, m.revision.as_str(), m.dark),
                (1, "parity-fixture", false)
            );
            assert_eq!(m.pods.len(), 4);
            for (pod, case) in m.pods.iter().zip(&f.cases) {
                for (a, b) in pod.logits.iter().zip(&case.logits) {
                    assert!((f64::from(*a) - b).abs() < 1e-4);
                }
                assert_eq!(pod.class, argmax(&pod.probabilities));
            }
        }
    }

    #[test]
    fn skips_a_dark_still_and_a_damaged_one() {
        let f = Fixture::load();
        let mut v: serde_json::Value = serde_json::from_str(&model_json()).unwrap();
        v["minBrightness"] = 0.99.into();
        let models = vec![("pod-state".to_string(), Model::parse(&v.to_string()).unwrap())];
        let r = run(&ppm(&f.image), &fractions(&f), &models, Scale::Auto).unwrap();
        assert!(r.models[0].dark && r.models[0].pods.is_empty());

        let img = image::Rgb {
            width: 16,
            height: 16,
            data: [0, 135, 0].repeat(256),
        };
        let r = run(&ppm(&img), &fractions(&f), &models, Scale::Auto).unwrap();
        assert!(r.damaged && r.models.is_empty());
    }
}
