//! The `seedypod-cnn` v1 weights file and its forward pass, a port of core's
//! `src/vision/cnn.ts` (#185, #191).
//!
//! The file is a JSON header with the tensors inline as base64 little-endian
//! float32. Activations are height × width × channels (HWC); a conv3x3 weight
//! is `[out][ky][kx][in]`, a dense weight `[out][in]`. The checks match
//! `parseModel`, so a file core refuses is refused here too.

use base64::Engine as _;
use serde_json::{Map, Value};
use std::fmt;

pub const MODEL_FORMAT: &str = "seedypod-cnn";
pub const MODEL_FORMAT_VERSION: u64 = 1;

#[derive(Debug, Clone, PartialEq)]
pub struct ModelError(pub String);

impl fmt::Display for ModelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ModelError {}

fn err<T>(msg: impl Into<String>) -> Result<T, ModelError> {
    Err(ModelError(msg.into()))
}

/// What the model takes: an HWC crop, scaled then normalised per channel.
#[derive(Debug, Clone)]
pub struct Input {
    pub width: usize,
    pub height: usize,
    pub channels: usize,
    /// Pixel values are divided by this (255) before the mean and std.
    pub scale: f64,
    pub mean: Vec<f64>,
    pub std: Vec<f64>,
}

#[derive(Debug)]
pub enum Layer {
    /// 3×3, stride 1, zero padding 1, then ReLU.
    Conv3x3 { out: usize, w: Vec<f32>, b: Vec<f32> },
    /// 2×2 max pool, stride 2; an odd last row or column is dropped.
    MaxPool2,
    /// Mean over height and width.
    Gap,
    Dense {
        inp: usize,
        out: usize,
        w: Vec<f32>,
        b: Vec<f32>,
    },
}

/// A parsed, shape-checked model.
#[derive(Debug)]
pub struct Model {
    pub analyzer: String,
    pub version: u64,
    pub revision: String,
    pub classes: Vec<String>,
    pub input: Input,
    pub layers: Vec<Layer>,
    pub min_brightness: Option<f64>,
    pub params: usize,
    /// The largest activation, in values: the size of each scratch buffer.
    biggest: usize,
}

fn positive(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|n| *n > 0.0)
}

fn dim(v: Option<&Value>) -> Option<usize> {
    v.and_then(Value::as_u64).filter(|n| *n > 0).map(|n| n as usize)
}

fn floats(v: Option<&Value>) -> Option<Vec<f64>> {
    v?.as_array()?.iter().map(Value::as_f64).collect()
}

fn decode_tensor(tensors: &Map<String, Value>, name: &str, shape: &[usize]) -> Result<Vec<f32>, ModelError> {
    let Some(t) = tensors.get(name) else {
        return err(format!("tensor {name} is missing"));
    };
    let got: Option<Vec<usize>> = t
        .get("shape")
        .and_then(Value::as_array)
        .map(|a| a.iter().map(|d| d.as_u64().unwrap_or(0) as usize).collect());
    let show = |s: &[usize]| s.iter().map(usize::to_string).collect::<Vec<_>>().join("×");
    let data = t.get("data").and_then(Value::as_str);
    let (Some(got), Some(data), Some("float32")) = (got, data, t.get("dtype").and_then(Value::as_str)) else {
        return err(format!(
            "tensor {name} must be float32 with a shape and base64 data"
        ));
    };
    if got != shape {
        return err(format!(
            "tensor {name} is {}, expected {}",
            show(&got),
            show(shape)
        ));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| ModelError(format!("tensor {name} is not base64: {e}")))?;
    let n: usize = shape.iter().product();
    if bytes.len() != n * 4 {
        return err(format!(
            "tensor {name} has {} values, its shape says {n}",
            bytes.len() / 4
        ));
    }
    Ok(bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect())
}

impl Model {
    /// Parse and check a weights file's text.
    pub fn parse(text: &str) -> Result<Model, ModelError> {
        let raw: Value = serde_json::from_str(text).map_err(|e| ModelError(format!("not JSON: {e}")))?;
        Model::from_value(&raw)
    }

    pub fn from_value(raw: &Value) -> Result<Model, ModelError> {
        let Some(file) = raw
            .as_object()
            .filter(|f| f.get("format").and_then(Value::as_str) == Some(MODEL_FORMAT))
        else {
            return err(format!("not a {MODEL_FORMAT} weights file"));
        };
        let fv = file.get("formatVersion");
        if fv.and_then(Value::as_f64) != Some(MODEL_FORMAT_VERSION as f64) {
            return err(format!(
                "format version {} is not supported (expected {MODEL_FORMAT_VERSION})",
                fv.map_or("undefined".to_owned(), Value::to_string)
            ));
        }
        let Some(version) = file
            .get("version")
            .and_then(Value::as_f64)
            .filter(|v| v.fract() == 0.0 && *v >= 1.0)
        else {
            return err("version must be a positive integer");
        };
        let version = version as u64;
        let classes: Option<Vec<String>> = file.get("classes").and_then(Value::as_array).map(|a| {
            a.iter()
                .map(|c| c.as_str().map(str::to_owned).unwrap_or_else(|| c.to_string()))
                .collect()
        });
        let Some(classes) = classes.filter(|c| c.len() >= 2) else {
            return err("classes must list at least two names");
        };
        let inp = file.get("input").and_then(Value::as_object);
        let (Some(width), Some(height), Some(channels), Some(scale), true) = (
            dim(inp.and_then(|i| i.get("width"))),
            dim(inp.and_then(|i| i.get("height"))),
            dim(inp.and_then(|i| i.get("channels"))),
            positive(inp.and_then(|i| i.get("scale"))),
            inp.and_then(|i| i.get("layout")).and_then(Value::as_str) == Some("HWC"),
        ) else {
            return err("input must give width, height, channels, scale and layout HWC");
        };
        let mean = floats(inp.and_then(|i| i.get("mean"))).filter(|m| m.len() == channels);
        let std = floats(inp.and_then(|i| i.get("std")))
            .filter(|s| s.len() == channels && s.iter().all(|v| *v > 0.0));
        let (Some(mean), Some(std)) = (mean, std) else {
            return err("input mean and std need one positive value per channel");
        };
        let Some(specs) = file
            .get("layers")
            .and_then(Value::as_array)
            .filter(|l| !l.is_empty())
        else {
            return err("layers is empty");
        };
        let empty = Map::new();
        let tensors = file.get("tensors").and_then(Value::as_object).unwrap_or(&empty);

        let (mut h, mut w, mut c) = (height, width, channels);
        let mut flat = false;
        let mut biggest = h * w * c;
        let mut params = 0;
        let mut layers = Vec::with_capacity(specs.len());
        for (i, l) in specs.iter().enumerate() {
            let kind = l.get("type").and_then(Value::as_str).unwrap_or("undefined");
            let at = format!("layer {i} ({kind})");
            if flat != (kind == "dense") {
                return err(if kind == "dense" {
                    format!("{at} needs a gap layer before it")
                } else {
                    format!("{at} follows a flattening layer")
                });
            }
            let size = |k: &str| l.get(k).and_then(Value::as_u64).map(|n| n as usize);
            let name = |k: &str| l.get(k).and_then(Value::as_str).unwrap_or("undefined").to_owned();
            match kind {
                "conv3x3" => {
                    let (inp, out) = (size("in"), size("out").unwrap_or(0));
                    if inp != Some(c) {
                        return err(format!(
                            "{at} takes {} channels, gets {c}",
                            inp.map_or("undefined".to_owned(), |n| n.to_string())
                        ));
                    }
                    let cw = decode_tensor(tensors, &name("weight"), &[out, 3, 3, c])?;
                    let cb = decode_tensor(tensors, &name("bias"), &[out])?;
                    params += cw.len() + cb.len();
                    c = out;
                    biggest = biggest.max(h * w * c);
                    layers.push(Layer::Conv3x3 { out, w: cw, b: cb });
                }
                "maxpool2" => {
                    if h < 2 || w < 2 {
                        return err(format!("{at} on a {h}×{w} map"));
                    }
                    h /= 2;
                    w /= 2;
                    layers.push(Layer::MaxPool2);
                }
                "gap" => {
                    flat = true;
                    h = 1;
                    w = 1;
                    layers.push(Layer::Gap);
                }
                "dense" => {
                    let (inp, out) = (size("in"), size("out").unwrap_or(0));
                    if inp != Some(h * w * c) {
                        return err(format!(
                            "{at} takes {} inputs, gets {}",
                            inp.map_or("undefined".to_owned(), |n| n.to_string()),
                            h * w * c
                        ));
                    }
                    let n = h * w * c;
                    let dw = decode_tensor(tensors, &name("weight"), &[out, n])?;
                    let db = decode_tensor(tensors, &name("bias"), &[out])?;
                    params += dw.len() + db.len();
                    h = 1;
                    w = 1;
                    c = out;
                    layers.push(Layer::Dense {
                        inp: n,
                        out,
                        w: dw,
                        b: db,
                    });
                }
                _ => return err(format!("{at} is not a known layer type")),
            }
        }
        if !matches!(layers.last(), Some(Layer::Dense { .. })) || c != classes.len() {
            return err(format!(
                "the last layer must be dense with one output per class ({})",
                classes.len()
            ));
        }
        Ok(Model {
            analyzer: file
                .get("analyzer")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            version,
            revision: file
                .get("revision")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            classes,
            input: Input {
                width,
                height,
                channels,
                scale,
                mean,
                std,
            },
            layers,
            min_brightness: file.get("minBrightness").and_then(Value::as_f64),
            params,
            biggest,
        })
    }

    /// Buffers for `forward`, sized once per model and reused for every pod.
    pub fn scratch(&self) -> Scratch {
        Scratch {
            a: vec![0.0; self.biggest],
            b: vec![0.0; self.biggest],
        }
    }

    /// Run the network on one normalised `height × width × channels` input. Returns the logits.
    pub fn forward(&self, input: &[f32], s: &mut Scratch) -> Result<Vec<f32>, ModelError> {
        let inp = &self.input;
        let (mut h, mut w, mut c) = (inp.height, inp.width, inp.channels);
        if input.len() != h * w * c {
            return err(format!(
                "input has {} values, the model takes {}",
                input.len(),
                h * w * c
            ));
        }
        let (mut a, mut b) = (&mut s.a, &mut s.b);
        a[..input.len()].copy_from_slice(input);
        for l in &self.layers {
            match l {
                Layer::Conv3x3 {
                    out, w: wt, b: bias, ..
                } => {
                    conv3x3(&a[..h * w * c], h, w, c, *out, wt, bias, &mut b[..h * w * out]);
                    c = *out;
                }
                Layer::MaxPool2 => {
                    max_pool2(a, h, w, c, b);
                    h /= 2;
                    w /= 2;
                }
                Layer::Gap => {
                    let n = h * w;
                    for ch in 0..c {
                        let mut sum = 0.0f32;
                        for p in 0..n {
                            sum += a[p * c + ch];
                        }
                        b[ch] = sum / n as f32;
                    }
                    h = 1;
                    w = 1;
                }
                Layer::Dense {
                    inp,
                    out,
                    w: wt,
                    b: bias,
                } => {
                    for j in 0..*out {
                        let row = &wt[j * inp..(j + 1) * inp];
                        let mut sum = bias[j];
                        for (x, k) in a[..*inp].iter().zip(row) {
                            sum += x * k;
                        }
                        b[j] = sum;
                    }
                    h = 1;
                    w = 1;
                    c = *out;
                }
            }
            std::mem::swap(&mut a, &mut b);
        }
        Ok(a[..c].to_vec())
    }
}

pub struct Scratch {
    a: Vec<f32>,
    b: Vec<f32>,
}

/// conv3x3 + ReLU, HWC, zero padding. Four output channels at a time, so the
/// FPU has independent sums in flight (the Pi Zero W's VFP has no SIMD and a
/// long multiply-accumulate latency). Each sum adds its terms in the same
/// order as cnn.ts: bias, then the taps row by row, channels innermost.
#[allow(clippy::too_many_arguments)]
fn conv3x3(src: &[f32], h: usize, w: usize, c: usize, k: usize, wt: &[f32], bias: &[f32], dst: &mut [f32]) {
    let tap = 9 * c;
    for y in 0..h {
        let ys = y.saturating_sub(1)..(y + 2).min(h);
        for x in 0..w {
            let xs = x.saturating_sub(1)..(x + 2).min(w);
            let o = (y * w + x) * k;
            let mut kk = 0;
            while kk + 4 <= k {
                let (mut s0, mut s1, mut s2, mut s3) = (bias[kk], bias[kk + 1], bias[kk + 2], bias[kk + 3]);
                for yy in ys.clone() {
                    let ky = yy + 1 - y;
                    for xx in xs.clone() {
                        let kx = xx + 1 - x;
                        let px = &src[(yy * w + xx) * c..][..c];
                        let off = (ky * 3 + kx) * c;
                        let w0 = &wt[kk * tap + off..][..c];
                        let w1 = &wt[(kk + 1) * tap + off..][..c];
                        let w2 = &wt[(kk + 2) * tap + off..][..c];
                        let w3 = &wt[(kk + 3) * tap + off..][..c];
                        for ch in 0..c {
                            let v = px[ch];
                            s0 += v * w0[ch];
                            s1 += v * w1[ch];
                            s2 += v * w2[ch];
                            s3 += v * w3[ch];
                        }
                    }
                }
                dst[o + kk] = s0.max(0.0);
                dst[o + kk + 1] = s1.max(0.0);
                dst[o + kk + 2] = s2.max(0.0);
                dst[o + kk + 3] = s3.max(0.0);
                kk += 4;
            }
            while kk < k {
                let mut s = bias[kk];
                for yy in ys.clone() {
                    let ky = yy + 1 - y;
                    for xx in xs.clone() {
                        let kx = xx + 1 - x;
                        let px = &src[(yy * w + xx) * c..][..c];
                        let wk = &wt[kk * tap + (ky * 3 + kx) * c..][..c];
                        for ch in 0..c {
                            s += px[ch] * wk[ch];
                        }
                    }
                }
                dst[o + kk] = s.max(0.0);
                kk += 1;
            }
        }
    }
}

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

/// Probabilities from logits, in double precision like cnn.ts's `softmax`.
pub fn softmax(logits: &[f32]) -> Vec<f32> {
    let max = logits.iter().fold(f64::NEG_INFINITY, |m, v| m.max(f64::from(*v)));
    let e: Vec<f64> = logits.iter().map(|v| (f64::from(*v) - max).exp()).collect();
    let sum: f64 = e.iter().sum();
    e.iter().map(|v| (v / sum) as f32).collect()
}

/// The first most likely class, as classifyPods picks it.
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
    use crate::image::{crop_input, Rect, Rgb};

    const FIXTURE: &str = include_str!("../../../../src/vision/tests/parity/pod-state-parity.json");

    fn fixture() -> Value {
        serde_json::from_str(FIXTURE).unwrap()
    }

    /// The fixture's RGBA still as packed RGB.
    fn fixture_image(f: &Value) -> Rgb {
        let img = &f["image"];
        let rgba = base64::engine::general_purpose::STANDARD
            .decode(img["rgba"].as_str().unwrap())
            .unwrap();
        Rgb {
            width: img["width"].as_u64().unwrap() as usize,
            height: img["height"].as_u64().unwrap() as usize,
            data: rgba.chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect(),
        }
    }

    fn rect(v: &Value) -> Rect {
        Rect {
            x: v["x"].as_f64().unwrap(),
            y: v["y"].as_f64().unwrap(),
            w: v["w"].as_f64().unwrap(),
            h: v["h"].as_f64().unwrap(),
        }
    }

    #[test]
    fn matches_pytorch_on_the_parity_fixture_within_1e_4() {
        let f = fixture();
        let model = Model::from_value(&f["model"]).unwrap();
        assert_eq!(model.params, 23_909);
        assert_eq!(model.revision, "parity-fixture");
        let img = fixture_image(&f);
        let mut s = model.scratch();
        let mut worst = 0f64;
        for case in f["cases"].as_array().unwrap() {
            let x = crop_input(&img, &rect(&case["rect"]), &model.input);
            let sum: f64 = x.iter().map(|v| f64::from(*v)).sum();
            assert!(
                (sum - case["inputSum"].as_f64().unwrap()).abs() < 0.05,
                "input sum {sum}"
            );
            for (i, v) in case["inputHead"].as_array().unwrap().iter().enumerate() {
                assert!((f64::from(x[i]) - v.as_f64().unwrap()).abs() < 1e-6);
            }
            let logits = model.forward(&x, &mut s).unwrap();
            for (i, v) in case["logits"].as_array().unwrap().iter().enumerate() {
                let d = (f64::from(logits[i]) - v.as_f64().unwrap()).abs();
                worst = worst.max(d);
                assert!(d < 1e-4, "logit {i}: {} vs {v}", logits[i]);
            }
            let p = softmax(&logits);
            for (i, v) in case["probabilities"].as_array().unwrap().iter().enumerate() {
                assert!((f64::from(p[i]) - v.as_f64().unwrap()).abs() < 1e-4);
            }
        }
        assert!(worst < 1e-4);
    }

    #[test]
    fn reuses_its_buffers_without_one_call_leaking_into_the_next() {
        let f = fixture();
        let model = Model::from_value(&f["model"]).unwrap();
        let img = fixture_image(&f);
        let cases = f["cases"].as_array().unwrap();
        let a = crop_input(&img, &rect(&cases[0]["rect"]), &model.input);
        let b = crop_input(&img, &rect(&cases[1]["rect"]), &model.input);
        let mut s = model.scratch();
        let first = model.forward(&a, &mut s).unwrap();
        model.forward(&b, &mut s).unwrap();
        assert_eq!(model.forward(&a, &mut s).unwrap(), first);
        assert!(model
            .forward(&a[..10], &mut s)
            .unwrap_err()
            .0
            .contains("model takes 12288"));
    }

    #[test]
    fn runs_the_shipped_model() {
        let model = Model::parse(include_str!("../../../../models/pod-state.json")).unwrap();
        assert_eq!((model.analyzer.as_str(), model.version), ("pod-state", 1));
        assert_eq!(model.min_brightness, Some(0.12));
        assert_eq!(
            model.classes,
            ["empty", "sprouted", "growing", "ready", "unhealthy"]
        );
    }

    fn refuse(edit: impl Fn(&mut Value)) -> String {
        let mut m = fixture()["model"].clone();
        edit(&mut m);
        Model::from_value(&m).unwrap_err().0
    }

    #[test]
    fn refuses_a_malformed_weights_file_naming_the_problem() {
        assert!(Model::parse("{").unwrap_err().0.starts_with("not JSON"));
        assert_eq!(
            Model::parse("[]").unwrap_err().0,
            "not a seedypod-cnn weights file"
        );
        assert!(refuse(|m| m["formatVersion"] = 2.into()).contains("format version 2 is not supported"));
        assert_eq!(
            refuse(|m| m["version"] = 0.into()),
            "version must be a positive integer"
        );
        assert_eq!(
            refuse(|m| m["version"] = 1.5.into()),
            "version must be a positive integer"
        );
        assert_eq!(
            refuse(|m| m["classes"] = serde_json::json!(["a"])),
            "classes must list at least two names"
        );
        assert!(refuse(|m| m["input"]["layout"] = "CHW".into()).starts_with("input must give"));
        assert!(refuse(|m| m["input"]["scale"] = 0.into()).starts_with("input must give"));
        assert!(refuse(|m| m["input"]["std"][1] = 0.into()).starts_with("input mean and std"));
        assert!(refuse(|m| m["input"]["mean"] = serde_json::json!([0.5])).starts_with("input mean and std"));
        assert_eq!(refuse(|m| m["layers"] = serde_json::json!([])), "layers is empty");
        assert_eq!(
            refuse(|m| m["layers"][0]["type"] = "conv5x5".into()),
            "layer 0 (conv5x5) is not a known layer type"
        );
        assert_eq!(
            refuse(|m| m["layers"][0]["in"] = 4.into()),
            "layer 0 (conv3x3) takes 4 channels, gets 3"
        );
        assert!(refuse(|m| {
            m["tensors"].as_object_mut().unwrap().remove("convs.0.bias");
        })
        .contains("convs.0.bias is missing"));
        assert_eq!(
            refuse(|m| m["tensors"]["convs.0.bias"]["shape"] = serde_json::json!([15])),
            "tensor convs.0.bias is 15, expected 16"
        );
        assert!(refuse(|m| m["tensors"]["fc.bias"]["data"] = "AAAA".into())
            .contains("has 0 values, its shape says 5"));
        assert!(refuse(|m| m["tensors"]["fc.bias"]["data"] = "!!".into()).contains("is not base64"));
        assert!(refuse(|m| m["tensors"]["fc.bias"]["dtype"] = "float16".into()).contains("must be float32"));
        assert_eq!(
            refuse(|m| {
                m["layers"].as_array_mut().unwrap().remove(5);
            }),
            "layer 5 (dense) needs a gap layer before it"
        );
        assert_eq!(
            refuse(|m| m["layers"]
                .as_array_mut()
                .unwrap()
                .push(serde_json::json!({ "type": "gap" }))),
            "layer 7 (gap) follows a flattening layer"
        );
        assert_eq!(
            refuse(|m| m["layers"][6]["in"] = 63.into()),
            "layer 6 (dense) takes 63 inputs, gets 64"
        );
        assert!(refuse(|m| m["classes"] = serde_json::json!(["a", "b", "c"]))
            .starts_with("the last layer must be dense"));
        assert!(refuse(|m| {
            m["input"]["width"] = 1.into();
            m["layers"] = serde_json::json!([{ "type": "maxpool2" }]);
        })
        .contains("layer 0 (maxpool2) on a 64×1 map"));
    }

    #[test]
    fn softmax_and_argmax_follow_core() {
        let p = softmax(&[1.0, 3.0, 3.0, -2.0]);
        assert!((p.iter().sum::<f32>() - 1.0).abs() < 1e-6);
        assert_eq!(argmax(&p), 1);
        assert_eq!(argmax(&[0.5]), 0);
    }

    #[test]
    fn a_conv_with_a_channel_count_not_a_multiple_of_four_matches_the_naive_loop() {
        // 1×2 map, 2 input channels, 5 outputs: the 4-wide block and the remainder.
        let (h, w, c, k) = (1, 2, 2, 5);
        let src = [0.5f32, -1.0, 2.0, 0.25];
        let wt: Vec<f32> = (0..k * 9 * c)
            .map(|i| ((i * 7) % 11) as f32 / 10.0 - 0.5)
            .collect();
        let bias: Vec<f32> = (0..k).map(|i| i as f32 / 10.0 - 0.2).collect();
        let mut dst = vec![0f32; h * w * k];
        conv3x3(&src, h, w, c, k, &wt, &bias, &mut dst);
        for y in 0..h {
            for x in 0..w {
                for kk in 0..k {
                    let mut s = bias[kk];
                    for dy in 0..3 {
                        for dx in 0..3 {
                            let (yy, xx) = (y as isize + dy as isize - 1, x as isize + dx as isize - 1);
                            if yy < 0 || xx < 0 || yy >= h as isize || xx >= w as isize {
                                continue;
                            }
                            for ch in 0..c {
                                s += src[(yy as usize * w + xx as usize) * c + ch]
                                    * wt[kk * 9 * c + (dy * 3 + dx) * c + ch];
                            }
                        }
                    }
                    assert!((dst[(y * w + x) * k + kk] - s.max(0.0)).abs() < 1e-6);
                }
            }
        }
    }
}
