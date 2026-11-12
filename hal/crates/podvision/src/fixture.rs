//! The parity fixture seedypod/training generates (scripts/make_parity_fixture.py):
//! seeded weights, a small RGBA image, and PyTorch's outputs for four crops.
//! Core's TypeScript tests read the same file.

use base64::Engine as _;
use serde::Deserialize;

use crate::image::{Rect, Rgb};

const PARITY: &str = include_str!("../../../../src/vision/tests/parity/pod-state-parity.json");

#[derive(Deserialize)]
struct Raw {
    model: serde_json::Value,
    image: RawImage,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct RawImage {
    width: usize,
    height: usize,
    rgba: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Case {
    pub rect: Rect,
    pub input_sum: f64,
    pub input_head: Vec<f64>,
    pub logits: Vec<f64>,
    pub probabilities: Vec<f64>,
}

pub struct Fixture {
    pub image: Rgb,
    pub cases: Vec<Case>,
}

impl Fixture {
    pub fn load() -> Fixture {
        let raw: Raw = serde_json::from_str(PARITY).unwrap();
        let rgba = base64::engine::general_purpose::STANDARD
            .decode(raw.image.rgba)
            .unwrap();
        let data = rgba.chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect();
        Fixture {
            image: Rgb {
                width: raw.image.width,
                height: raw.image.height,
                data,
            },
            cases: raw.cases,
        }
    }
}

/// The fixture's weights file, as text.
pub fn model_json() -> String {
    let raw: Raw = serde_json::from_str(PARITY).unwrap();
    raw.model.to_string()
}
