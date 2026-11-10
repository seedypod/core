//! The forward pass of a `seedypod-cnn` v1 weights file, the same network
//! `src/vision/cnn.ts` runs: conv3x3 (+ ReLU), maxpool2, gap and dense, on
//! height × width × channels (HWC) activations.
//!
//! The file stores a conv3x3 weight as [out][ky][kx][in], so for one output
//! channel each row of the 3×3 window is one contiguous run of weights against
//! one contiguous run of the HWC input. Sums are f32, as PyTorch's are; the
//! parity fixture holds to 1e-4.

use std::collections::HashMap;

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use serde::Deserialize;

pub const MODEL_FORMAT: &str = "seedypod-cnn";
pub const MODEL_FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, Deserialize)]
pub struct Input {
    pub width: usize,
    pub height: usize,
    pub channels: usize,
    pub layout: String,
    /// Pixel values are divided by this (255) before the per-channel mean and std.
    pub scale: f64,
    pub mean: Vec<f64>,
    pub std: Vec<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum LayerFile {
    #[serde(rename = "conv3x3")]
    Conv3x3 {
        #[serde(rename = "in")]
        cin: usize,
        out: usize,
        weight: String,
        bias: String,
    },
    #[serde(rename = "maxpool2")]
    MaxPool2,
    #[serde(rename = "gap")]
    Gap,
    #[serde(rename = "dense")]
    Dense {
        #[serde(rename = "in")]
        cin: usize,
        out: usize,
        weight: String,
        bias: String,
    },
}

#[derive(Debug, Deserialize)]
struct TensorFile {
    shape: Vec<usize>,
    dtype: String,
    /// Little-endian float32, base64.
    data: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelFile {
    format: String,
    format_version: u32,
    analyzer: String,
    version: i64,
    revision: String,
    classes: Vec<String>,
    input: Input,
    layers: Vec<LayerFile>,
    tensors: HashMap<String, TensorFile>,
    min_brightness: Option<f64>,
}

enum Layer {
    /// Weights [out][ky][kx][in], as the file stores them.
    Conv3x3 {
        cin: usize,
        out: usize,
        w: Vec<f32>,
        b: Vec<f32>,
    },
    MaxPool2,
    Gap,
    /// Weights [out][in], as PyTorch's Linear stores them.
    Dense {
        cin: usize,
        out: usize,
        w: Vec<f32>,
        b: Vec<f32>,
    },
}

/// A parsed, shape-checked model, ready to run.
pub struct Model {
    pub analyzer: String,
    pub version: u32,
    pub revision: String,
    pub classes: Vec<String>,
    pub input: Input,
    pub min_brightness: Option<f64>,
    pub params: usize,
    layers: Vec<Layer>,
    /// The largest activation, which sizes the two scratch buffers.
    biggest: usize,
}

fn decode_f32(t: &TensorFile, name: &str) -> Result<Vec<f32>> {
    if t.dtype != "float32" {
        bail!("tensor {name} must be float32");
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(t.data.as_bytes())
        .with_context(|| format!("tensor {name} is not base64"))?;
    let n: usize = t.shape.iter().product();
    if bytes.len() != n * 4 {
        bail!("tensor {name} has {} values, its shape says {n}", bytes.len() / 4);
    }
    Ok(bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect())
}

fn tensor(file: &ModelFile, name: &str, shape: &[usize]) -> Result<Vec<f32>> {
    let t = file
        .tensors
        .get(name)
        .ok_or_else(|| anyhow!("tensor {name} is missing"))?;
    if t.shape != shape {
        bail!("tensor {name} is {:?}, expected {shape:?}", t.shape);
    }
    decode_f32(t, name)
}

impl Model {
    /// Validate a weights file and decode its tensors, with the checks `parseModel` makes.
    pub fn parse(text: &str) -> Result<Model> {
        let file: ModelFile = serde_json::from_str(text).context("not a seedypod-cnn weights file")?;
        if file.format != MODEL_FORMAT {
            bail!("not a {MODEL_FORMAT} weights file");
        }
        if file.format_version != MODEL_FORMAT_VERSION {
            bail!(
                "format version {} is not supported (expected {MODEL_FORMAT_VERSION})",
                file.format_version
            );
        }
        let version = u32::try_from(file.version)
            .ok()
            .filter(|v| *v >= 1)
            .ok_or_else(|| anyhow!("version must be a positive integer"))?;
        if file.classes.len() < 2 {
            bail!("classes must list at least two names");
        }
        let inp = &file.input;
        if inp.layout != "HWC"
            || inp.width == 0
            || inp.height == 0
            || inp.channels == 0
            || inp.scale.is_nan()
            || inp.scale <= 0.0
        {
            bail!("input must give width, height, channels, scale and layout HWC");
        }
        if inp.channels > 3 {
            bail!("input takes {} channels; a still has 3", inp.channels);
        }
        if inp.mean.len() != inp.channels
            || inp.std.len() != inp.channels
            || inp.std.iter().any(|s| s.is_nan() || *s <= 0.0)
        {
            bail!("input mean and std need one positive value per channel");
        }
        if file.layers.is_empty() {
            bail!("layers is empty");
        }

        let (mut h, mut w, mut c) = (inp.height, inp.width, inp.channels);
        let mut flat = false;
        let mut biggest = h * w * c;
        let mut params = 0;
        let mut layers = Vec::with_capacity(file.layers.len());
        for (i, l) in file.layers.iter().enumerate() {
            let dense = matches!(l, LayerFile::Dense { .. });
            if flat != dense {
                if dense {
                    bail!("layer {i} (dense) needs a gap layer before it");
                }
                bail!("layer {i} follows a flattening layer");
            }
            layers.push(match l {
                LayerFile::Conv3x3 {
                    cin,
                    out,
                    weight,
                    bias,
                } => {
                    if *cin != c {
                        bail!("layer {i} (conv3x3) takes {cin} channels, gets {c}");
                    }
                    let cw = tensor(&file, weight, &[*out, 3, 3, *cin])?;
                    let b = tensor(&file, bias, &[*out])?;
                    params += cw.len() + b.len();
                    c = *out;
                    biggest = biggest.max(h * w * c);
                    Layer::Conv3x3 {
                        cin: *cin,
                        out: *out,
                        w: cw,
                        b,
                    }
                }
                LayerFile::MaxPool2 => {
                    if h < 2 || w < 2 {
                        bail!("layer {i} (maxpool2) on a {h}×{w} map");
                    }
                    h /= 2;
                    w /= 2;
                    Layer::MaxPool2
                }
                LayerFile::Gap => {
                    flat = true;
                    h = 1;
                    w = 1;
                    Layer::Gap
                }
                LayerFile::Dense {
                    cin,
                    out,
                    weight,
                    bias,
                } => {
                    if *cin != h * w * c {
                        bail!("layer {i} (dense) takes {cin} inputs, gets {}", h * w * c);
                    }
                    let dw = tensor(&file, weight, &[*out, *cin])?;
                    let db = tensor(&file, bias, &[*out])?;
                    params += dw.len() + db.len();
                    c = *out;
                    biggest = biggest.max(c);
                    Layer::Dense {
                        cin: *cin,
                        out: *out,
                        w: dw,
                        b: db,
                    }
                }
            });
        }
        if !matches!(layers.last(), Some(Layer::Dense { .. })) || c != file.classes.len() {
            bail!(
                "the last layer must be dense with one output per class ({})",
                file.classes.len()
            );
        }
        Ok(Model {
            analyzer: file.analyzer,
            version,
            revision: file.revision,
            classes: file.classes,
            input: file.input,
            min_brightness: file.min_brightness,
            params,
            layers,
            biggest,
        })
    }

    /// Values in one input: height × width × channels.
    pub fn input_len(&self) -> usize {
        self.input.width * self.input.height * self.input.channels
    }

    /// Two activation buffers sized for this model, to reuse across calls.
    pub fn scratch(&self) -> Scratch {
        Scratch([vec![0.0; self.biggest], vec![0.0; self.biggest]])
    }

    /// Run the network on one normalised input. Returns the logits, one per class.
    pub fn forward(&self, input: &[f32], scratch: &mut Scratch) -> Result<Vec<f32>> {
        if input.len() != self.input_len() {
            bail!(
                "input has {} values, the model takes {}",
                input.len(),
                self.input_len()
            );
        }
        let (mut h, mut w, mut c) = (self.input.height, self.input.width, self.input.channels);
        let [a, b] = &mut scratch.0;
        let (mut src, mut dst) = (a, b);
        src[..input.len()].copy_from_slice(input);
        for l in &self.layers {
            match l {
                Layer::Conv3x3 {
                    cin,
                    out,
                    w: wt,
                    b: bias,
                } => {
                    conv3x3(src, h, w, *cin, *out, wt, bias, dst);
                    c = *out;
                }
                Layer::MaxPool2 => {
                    max_pool2(src, h, w, c, dst);
                    h /= 2;
                    w /= 2;
                }
                Layer::Gap => {
                    let n = h * w;
                    for ch in 0..c {
                        let s: f64 = (0..n).map(|p| f64::from(src[p * c + ch])).sum();
                        dst[ch] = (s / n as f64) as f32;
                    }
                    h = 1;
                    w = 1;
                }
                Layer::Dense {
                    cin,
                    out,
                    w: dw,
                    b: db,
                } => {
                    for j in 0..*out {
                        let row = &dw[j * cin..(j + 1) * cin];
                        dst[j] = db[j] + row.iter().zip(&src[..*cin]).map(|(w, x)| w * x).sum::<f32>();
                    }
                    h = 1;
                    w = 1;
                    c = *out;
                }
            }
            std::mem::swap(&mut src, &mut dst);
        }
        Ok(src[..c].to_vec())
    }
}

pub struct Scratch([Vec<f32>; 2]);

/// conv3x3 + ReLU, HWC, stride 1, zero padding 1. Weights [out][ky][kx][in].
///
/// Four output channels at a time, swept over the whole map before the next
/// four. Their weights (at most 4 × 9 × 64 floats) then stay in the Pi Zero's
/// 16 KB L1 cache instead of every weight streaming from RAM once per pixel,
/// and the four independent sums keep the VFP, which has no vector unit and a
/// long multiply-add latency, busy. Each sum adds its terms in cnn.ts's order:
/// bias, then the window row by row, channels innermost.
#[allow(clippy::too_many_arguments)]
fn conv3x3(
    src: &[f32],
    h: usize,
    w: usize,
    cin: usize,
    cout: usize,
    wt: &[f32],
    bias: &[f32],
    dst: &mut [f32],
) {
    let tap = 9 * cin;
    // The window's rows and columns inside the map: (first, last + 1) of ky and of kx.
    let rows = |y: usize| (usize::from(y == 0), if y + 1 == h { 2 } else { 3 });
    let cols = |x: usize| (usize::from(x == 0), if x + 1 == w { 2 } else { 3 });
    let mut k = 0;
    while k + 4 <= cout {
        let (w0, rest) = wt[k * tap..(k + 4) * tap].split_at(tap);
        let (w1, rest) = rest.split_at(tap);
        let (w2, w3) = rest.split_at(tap);
        for y in 0..h {
            let (ky0, ky1) = rows(y);
            for x in 0..w {
                let (kx0, kx1) = cols(x);
                let mut s = [bias[k], bias[k + 1], bias[k + 2], bias[k + 3]];
                for ky in ky0..ky1 {
                    // One row of the window is contiguous in HWC: (kx1 − kx0) pixels × cin channels.
                    let start = ((y + ky - 1) * w + x + kx0 - 1) * cin;
                    let px = &src[start..start + (kx1 - kx0) * cin];
                    let t = (ky * 3 + kx0) * cin..(ky * 3 + kx1) * cin;
                    let (a, b, c, d) = (&w0[t.clone()], &w1[t.clone()], &w2[t.clone()], &w3[t]);
                    for i in 0..px.len() {
                        let v = px[i];
                        s[0] += v * a[i];
                        s[1] += v * b[i];
                        s[2] += v * c[i];
                        s[3] += v * d[i];
                    }
                }
                let o = (y * w + x) * cout + k;
                for (d, v) in dst[o..o + 4].iter_mut().zip(s) {
                    *d = if v > 0.0 { v } else { 0.0 };
                }
            }
        }
        k += 4;
    }
    for k in k..cout {
        let wk = &wt[k * tap..(k + 1) * tap];
        for y in 0..h {
            let (ky0, ky1) = rows(y);
            for x in 0..w {
                let (kx0, kx1) = cols(x);
                let mut s = bias[k];
                for ky in ky0..ky1 {
                    let start = ((y + ky - 1) * w + x + kx0 - 1) * cin;
                    let px = &src[start..start + (kx1 - kx0) * cin];
                    for (a, b) in px.iter().zip(&wk[(ky * 3 + kx0) * cin..(ky * 3 + kx1) * cin]) {
                        s += a * b;
                    }
                }
                dst[(y * w + x) * cout + k] = if s > 0.0 { s } else { 0.0 };
            }
        }
    }
}

/// 2×2 max pool, stride 2; an odd last row or column is dropped, as PyTorch does.
fn max_pool2(src: &[f32], h: usize, w: usize, c: usize, dst: &mut [f32]) {
    let (oh, ow) = (h / 2, w / 2);
    for y in 0..oh {
        for x in 0..ow {
            let i = (2 * y * w + 2 * x) * c;
            let o = (y * ow + x) * c;
            for ch in 0..c {
                let a = i + ch;
                dst[o + ch] = src[a].max(src[a + c]).max(src[a + w * c]).max(src[a + w * c + c]);
            }
        }
    }
}

/// Probabilities from logits, stable for large values.
pub fn softmax(logits: &[f32]) -> Vec<f32> {
    let max = logits.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let e: Vec<f64> = logits.iter().map(|v| f64::from(v - max).exp()).collect();
    let sum: f64 = e.iter().sum();
    e.iter().map(|v| (v / sum) as f32).collect()
}

/// Index of the largest value; the first on a tie, as the TS analyser picks.
pub fn argmax(p: &[f32]) -> usize {
    let mut best = 0;
    for i in 1..p.len() {
        if p[i] > p[best] {
            best = i;
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixture::{model_json, Fixture};

    #[test]
    fn parses_the_parity_model() {
        let m = Model::parse(&model_json()).unwrap();
        assert_eq!(m.params, 23_909);
        assert_eq!(m.classes.len(), 5);
        assert_eq!(m.revision, "parity-fixture");
    }

    #[test]
    fn matches_pytorch_on_the_fixture_within_1e4() {
        let f = Fixture::load();
        let m = Model::parse(&model_json()).unwrap();
        let mut scratch = m.scratch();
        for case in &f.cases {
            let x = crate::image::crop_input(&f.image, &case.rect, &m.input);
            for (i, v) in case.input_head.iter().enumerate() {
                assert!((f64::from(x[i]) - v).abs() < 1e-6, "input {i}: {} vs {v}", x[i]);
            }
            let sum: f64 = x.iter().map(|v| f64::from(*v)).sum();
            assert!(
                (sum - case.input_sum).abs() < 0.05,
                "input sum {sum} vs {}",
                case.input_sum
            );
            let logits = m.forward(&x, &mut scratch).unwrap();
            for (i, v) in case.logits.iter().enumerate() {
                assert!(
                    (f64::from(logits[i]) - v).abs() < 1e-4,
                    "logit {i}: {} vs {v}",
                    logits[i]
                );
            }
            let p = softmax(&logits);
            for (i, v) in case.probabilities.iter().enumerate() {
                assert!(
                    (f64::from(p[i]) - v).abs() < 1e-4,
                    "probability {i}: {} vs {v}",
                    p[i]
                );
            }
        }
    }

    #[test]
    fn reuses_its_buffers_without_one_call_leaking_into_the_next() {
        let f = Fixture::load();
        let m = Model::parse(&model_json()).unwrap();
        let mut scratch = m.scratch();
        let a = crate::image::crop_input(&f.image, &f.cases[0].rect, &m.input);
        let b = crate::image::crop_input(&f.image, &f.cases[1].rect, &m.input);
        let first = m.forward(&a, &mut scratch).unwrap();
        m.forward(&b, &mut scratch).unwrap();
        assert_eq!(m.forward(&a, &mut scratch).unwrap(), first);
    }

    #[test]
    fn refuses_inputs_of_the_wrong_size() {
        let m = Model::parse(&model_json()).unwrap();
        assert!(m.forward(&[0.0; 10], &mut m.scratch()).is_err());
    }

    #[test]
    fn softmax_sums_to_one_for_large_values() {
        let p = softmax(&[1000.0, 1000.0, 0.0]);
        assert!((p[0] - 0.5).abs() < 1e-6);
        assert!((p.iter().sum::<f32>() - 1.0).abs() < 1e-6);
        assert_eq!(argmax(&[0.2, 0.4, 0.4]), 1);
    }

    fn broken(edit: impl FnOnce(&mut serde_json::Value)) -> String {
        let mut v: serde_json::Value = serde_json::from_str(&model_json()).unwrap();
        edit(&mut v);
        Model::parse(&v.to_string())
            .err()
            .expect("should refuse")
            .to_string()
    }

    #[test]
    fn refuses_broken_files_naming_the_problem() {
        assert!(Model::parse("{").is_err());
        assert!(broken(|v| v["format"] = "onnx".into()).contains("not a seedypod-cnn"));
        assert!(broken(|v| v["formatVersion"] = 2.into()).contains("format version 2"));
        assert!(broken(|v| v["version"] = 0.into()).contains("version must"));
        assert!(broken(|v| v["classes"] = serde_json::json!(["a"])).contains("at least two"));
        assert!(broken(|v| v["input"]["layout"] = "CHW".into()).contains("layout HWC"));
        assert!(broken(|v| v["input"]["channels"] = 4.into()).contains("4 channels"));
        assert!(broken(|v| v["input"]["std"][0] = 0.into()).contains("mean and std"));
        assert!(broken(|v| v["layers"] = serde_json::json!([])).contains("layers is empty"));
        assert!(broken(|v| v["layers"][0]["in"] = 4.into()).contains("takes 4 channels"));
        assert!(broken(|v| v["layers"][6]["in"] = 63.into()).contains("takes 63 inputs"));
        assert!(
            broken(|v| v["layers"][5] = serde_json::json!({ "type": "maxpool2" })).contains("needs a gap")
        );
        assert!(broken(|v| v["layers"][0]["type"] = "conv5x5".into()).contains("not a seedypod-cnn"));
        assert!(broken(|v| {
            let l = v["layers"].as_array_mut().unwrap();
            l.push(serde_json::json!({ "type": "gap" }));
        })
        .contains("follows a flattening"));
        assert!(
            broken(|v| v["classes"] = serde_json::json!(["a", "b", "c"])).contains("one output per class")
        );
        assert!(broken(|v| {
            v["tensors"].as_object_mut().unwrap().remove("fc.bias");
        })
        .contains("fc.bias is missing"));
        assert!(
            broken(|v| v["tensors"]["fc.bias"]["shape"] = serde_json::json!([4])).contains("expected [5]")
        );
        assert!(broken(|v| v["tensors"]["fc.bias"]["data"] = "AAAA".into()).contains("its shape says 5"));
        assert!(broken(|v| v["tensors"]["fc.bias"]["data"] = "!!".into()).contains("not base64"));
        assert!(broken(|v| v["tensors"]["fc.bias"]["dtype"] = "float16".into()).contains("must be float32"));
        assert!(broken(|v| {
            let l = v["layers"].as_array_mut().unwrap();
            for _ in 0..7 {
                l.insert(0, serde_json::json!({ "type": "maxpool2" }));
            }
        })
        .contains("on a 1×1 map"));
    }
}
