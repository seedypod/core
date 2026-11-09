//! Decoding a still and reading the pods out of it, the way
//! `src/vision/podState.ts` and `src/vision/analyze.ts` do.
//!
//! The model only needs a small crop of each pod, so the JPEG is decoded at
//! 1/2, 1/4 or 1/8 scale (DCT scaling: jpeg-decoder runs a smaller inverse DCT
//! per block) whenever every pod's crop stays at least as large as the
//! model's input, or as large as it is at full size if that is smaller. The
//! crops are then never upsampled more than they would be at full size.

use std::collections::BTreeMap;
use std::io::Cursor;

use anyhow::{bail, Context, Result};
use serde::Deserialize;

use crate::cnn::Input;

/// The same cap jpeg-js gets (`maxMemoryUsageInMB: 64`).
const MAX_DECODE_BYTES: usize = 64 << 20;

/// An 8-bit RGB image, row-major.
pub struct Rgb {
    pub width: usize,
    pub height: usize,
    pub data: Vec<u8>,
}

/// A pod box. In a request it is a fraction of the frame; `to_pixels` makes it pixels.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub fn to_pixels(self, width: usize, height: usize) -> Rect {
        let (w, h) = (width as f64, height as f64);
        Rect {
            x: self.x * w,
            y: self.y * h,
            w: self.w * w,
            h: self.h * h,
        }
    }
}

/// The integer pixel window of a box, clamped to the frame and at least one pixel: `cropWindow`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Window {
    pub x0: usize,
    pub y0: usize,
    pub x1: usize,
    pub y1: usize,
}

impl Window {
    pub fn width(&self) -> usize {
        self.x1 - self.x0
    }
    pub fn height(&self) -> usize {
        self.y1 - self.y0
    }
}

pub fn crop_window(r: &Rect, width: usize, height: usize) -> Window {
    let (w, h) = (width as f64, height as f64);
    let x0 = (w - 1.0).min(r.x.floor().max(0.0));
    let y0 = (h - 1.0).min(r.y.floor().max(0.0));
    let x1 = w.min((r.x + r.w).ceil());
    let y1 = h.min((r.y + r.h).ceil());
    let (x0, y0) = (x0 as usize, y0 as usize);
    Window {
        x0,
        y0,
        x1: (x1.max(0.0) as usize).max(x0 + 1),
        y1: (y1.max(0.0) as usize).max(y0 + 1),
    }
}

/// One output cell's source span along an axis: floor(start + o·len/n) … floor(start + (o+1)·len/n), at least one.
fn span(o: usize, n: usize, len: usize, start: usize, limit: usize) -> (usize, usize) {
    let at = |i: usize| (start as f64 + (i * len) as f64 / n as f64).floor() as usize;
    let a = (limit - 1).min(at(o));
    (a, limit.min((a + 1).max(at(o + 1))))
}

/// One pod's crop as the model's normalised HWC input: `cropInput`, cell for cell.
pub fn crop_input(img: &Rgb, rect: &Rect, inp: &Input) -> Vec<f32> {
    let mut out = vec![0f32; inp.width * inp.height * inp.channels];
    let win = crop_window(rect, img.width, img.height);
    let c = inp.channels;
    for oy in 0..inp.height {
        let (ya, yb) = span(oy, inp.height, win.height(), win.y0, win.y1);
        for ox in 0..inp.width {
            let (xa, xb) = span(ox, inp.width, win.width(), win.x0, win.x1);
            let o = (oy * inp.width + ox) * c;
            let n = ((yb - ya) * (xb - xa)) as f64;
            for ch in 0..c {
                let mut s = 0u32;
                for y in ya..yb {
                    let row = &img.data[(y * img.width + xa) * 3..(y * img.width + xb) * 3];
                    s += row.iter().skip(ch).step_by(3).map(|v| u32::from(*v)).sum::<u32>();
                }
                out[o + ch] = ((f64::from(s) / n / inp.scale - inp.mean[ch]) / inp.std[ch]) as f32;
            }
        }
    }
    out
}

/// Mean of R, G and B over a still, 0–1, from every 7th pixel: `brightness`.
pub fn brightness(img: &Rgb) -> f64 {
    let (mut sum, mut n) = (0u64, 0u64);
    for p in (0..img.width * img.height).step_by(7) {
        sum += img.data[p * 3..p * 3 + 3]
            .iter()
            .map(|v| u64::from(*v))
            .sum::<u64>();
        n += 3;
    }
    if n == 0 {
        0.0
    } else {
        sum as f64 / n as f64 / 255.0
    }
}

/// Checked rows of zero fill that make a frame damaged: `FILLED_ROWS`.
const FILLED_ROWS: usize = 2;

/// Whether full-width rows are the solid green of a zero-filled YUV frame: `hasZeroFilledRows`.
/// `stride` is rows to step; core's is 4 at full size, so 4 / scale here.
pub fn has_zero_filled_rows(img: &Rgb, stride: usize) -> bool {
    let zero_fill = |p: &[u8]| p[0] <= 16 && p[2] <= 16 && (119..=151).contains(&p[1]);
    let filled = (0..img.height)
        .step_by(stride.max(1))
        .filter(|y| {
            img.data[y * img.width * 3..(y + 1) * img.width * 3]
                .chunks_exact(3)
                .all(zero_fill)
        })
        .take(FILLED_ROWS)
        .count();
    filled >= FILLED_ROWS
}

/// The decode scale to use: the largest of 8, 4 and 2 at which no pod's crop is smaller
/// than every model's input (or than its own full-size crop, if that is smaller); else 1.
pub fn choose_scale(width: usize, height: usize, pods: &BTreeMap<u32, Rect>, inputs: &[&Input]) -> usize {
    [8, 4, 2]
        .into_iter()
        .find(|s| {
            let (sw, sh) = (width.div_ceil(*s), height.div_ceil(*s));
            pods.values().all(|r| {
                let full = crop_window(&r.to_pixels(width, height), width, height);
                let at = crop_window(&r.to_pixels(sw, sh), sw, sh);
                inputs.iter().all(|i| {
                    at.width() >= i.width.min(full.width()) && at.height() >= i.height.min(full.height())
                })
            })
        })
        .unwrap_or(1)
}

/// A decoded still: its full size, the scale it was decoded at, and the pixels.
pub struct Decoded {
    pub width: usize,
    pub height: usize,
    pub scale: usize,
    pub image: Rgb,
}

/// How to pick the scale: from the crops, or one forced (for measuring).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scale {
    Auto,
    Fixed(usize),
}

/// Decode a JPEG, or a binary PPM (P6, always full size), for these pods and model inputs.
pub fn decode(bytes: &[u8], scale: Scale, pods: &BTreeMap<u32, Rect>, inputs: &[&Input]) -> Result<Decoded> {
    if bytes.starts_with(b"P6") {
        let image = read_ppm(bytes)?;
        return Ok(Decoded {
            width: image.width,
            height: image.height,
            scale: 1,
            image,
        });
    }
    if !bytes.starts_with(&[0xFF, 0xD8]) {
        bail!("not a JPEG");
    }
    let mut d = jpeg_decoder::Decoder::new(Cursor::new(bytes));
    d.set_max_decoding_buffer_size(MAX_DECODE_BYTES);
    d.read_info().context("not a decodable JPEG")?;
    let info = d.info().context("not a decodable JPEG")?;
    let (width, height) = (usize::from(info.width), usize::from(info.height));
    let s = match scale {
        Scale::Auto => choose_scale(width, height, pods, inputs),
        Scale::Fixed(s) => s,
    };
    let (sw, sh) = if s > 1 {
        let (w, h) = d
            .scale(width.div_ceil(s) as u16, height.div_ceil(s) as u16)
            .context("not a decodable JPEG")?;
        (usize::from(w), usize::from(h))
    } else {
        (width, height)
    };
    let pixels = d.decode().context("not a decodable JPEG")?;
    let format = d.info().context("not a decodable JPEG")?.pixel_format;
    let data = match format {
        jpeg_decoder::PixelFormat::RGB24 => pixels,
        jpeg_decoder::PixelFormat::L8 => pixels.iter().flat_map(|v| [*v; 3]).collect(),
        jpeg_decoder::PixelFormat::L16 => pixels.chunks_exact(2).flat_map(|v| [v[0]; 3]).collect(),
        jpeg_decoder::PixelFormat::CMYK32 => bail!("a CMYK JPEG is not a camera still"),
    };
    if data.len() != sw * sh * 3 {
        bail!(
            "the JPEG decoded to {} bytes, expected {}×{}×3",
            data.len(),
            sw,
            sh
        );
    }
    Ok(Decoded {
        width,
        height,
        scale: s,
        image: Rgb {
            width: sw,
            height: sh,
            data,
        },
    })
}

/// A binary PPM (P6, maxval 255): how the parity fixture's raw pixels reach the binary.
pub fn read_ppm(bytes: &[u8]) -> Result<Rgb> {
    let mut fields = Vec::with_capacity(4);
    let mut i = 0;
    while fields.len() < 4 {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if bytes.get(i) == Some(&b'#') {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        let start = i;
        while i < bytes.len() && !bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if start == i {
            bail!("a PPM header ends early");
        }
        fields.push(std::str::from_utf8(&bytes[start..i]).context("a PPM header is not text")?);
    }
    let num = |s: &str| {
        s.parse::<usize>()
            .with_context(|| format!("{s} is not a PPM size"))
    };
    let (width, height, max) = (num(fields[1])?, num(fields[2])?, num(fields[3])?);
    if fields[0] != "P6" || max != 255 || width == 0 || height == 0 {
        bail!("only 8-bit binary PPMs (P6, maxval 255) are read");
    }
    let n = width
        .checked_mul(height)
        .and_then(|n| n.checked_mul(3))
        .filter(|n| *n <= MAX_DECODE_BYTES);
    let Some(n) = n else {
        bail!("a {width}×{height} PPM is larger than any still")
    };
    let data = bytes.get(i + 1..i + 1 + n).context("a PPM's pixels end early")?;
    Ok(Rgb {
        width,
        height,
        data: data.to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixture::{model_json, Fixture};

    fn solid(width: usize, height: usize, px: [u8; 3]) -> Rgb {
        Rgb {
            width,
            height,
            data: px.repeat(width * height),
        }
    }

    fn input(size: usize) -> Input {
        Input {
            width: size,
            height: size,
            channels: 3,
            layout: "HWC".into(),
            scale: 255.0,
            mean: vec![0.0; 3],
            std: vec![1.0; 3],
        }
    }

    #[test]
    fn crop_window_matches_core_at_the_edges() {
        let r = Rect {
            x: 10.4,
            y: 7.6,
            w: 70.3,
            h: 66.2,
        };
        assert_eq!(
            crop_window(&r, 160, 120),
            Window {
                x0: 10,
                y0: 7,
                x1: 81,
                y1: 74
            }
        );
        let off = Rect {
            x: 300.0,
            y: -5.0,
            w: 10.0,
            h: 2.0,
        };
        assert_eq!(
            crop_window(&off, 160, 120),
            Window {
                x0: 159,
                y0: 0,
                x1: 160,
                y1: 1
            }
        );
        let empty = Rect {
            x: 5.0,
            y: 5.0,
            w: 0.0,
            h: 0.0,
        };
        assert_eq!(
            crop_window(&empty, 160, 120),
            Window {
                x0: 5,
                y0: 5,
                x1: 6,
                y1: 6
            }
        );
    }

    #[test]
    fn crop_input_matches_the_fixture_first_values() {
        let f = Fixture::load();
        let m = crate::cnn::Model::parse(&model_json()).unwrap();
        for c in &f.cases {
            let x = crop_input(&f.image, &c.rect, &m.input);
            assert_eq!(x.len(), 64 * 64 * 3);
            for (i, v) in c.input_head.iter().enumerate() {
                assert!((f64::from(x[i]) - v).abs() < 1e-6);
            }
        }
    }

    #[test]
    fn brightness_is_the_mean_of_rgb() {
        assert!((brightness(&solid(10, 10, [255, 0, 0])) - 1.0 / 3.0).abs() < 1e-9);
        assert_eq!(
            brightness(&Rgb {
                width: 0,
                height: 0,
                data: vec![]
            }),
            0.0
        );
    }

    #[test]
    fn zero_filled_rows_mark_a_frame_damaged() {
        let mut img = solid(8, 16, [120, 120, 120]);
        assert!(!has_zero_filled_rows(&img, 1));
        for y in 8..16 {
            img.data[y * 24..(y + 1) * 24].copy_from_slice(&[0, 135, 0].repeat(8));
        }
        assert!(has_zero_filled_rows(&img, 1));
        assert!(
            has_zero_filled_rows(&img, 4),
            "rows 8 and 12 are checked at stride 4"
        );
        // One row isn't enough: a real pixel makes the others a scene.
        for y in 9..16 {
            img.data[y * 24] = 200;
        }
        assert!(!has_zero_filled_rows(&img, 1));
    }

    #[test]
    fn the_scale_keeps_every_crop_at_least_the_model_input() {
        let big: BTreeMap<u32, Rect> = [(
            1,
            Rect {
                x: 0.1,
                y: 0.1,
                w: 0.2,
                h: 0.27,
            },
        )]
        .into();
        // 256 × 259 px at full size: 1/2 is 128 px, 1/4 is 64, 1/8 is 32.
        assert_eq!(choose_scale(1280, 960, &big, &[&input(64)]), 4);
        assert_eq!(choose_scale(1280, 960, &big, &[&input(64), &input(100)]), 2);
        assert_eq!(choose_scale(1280, 960, &big, &[&input(300)]), 1);
        // A box under the input keeps the pixels it has at full size.
        let tiny: BTreeMap<u32, Rect> = [(
            2,
            Rect {
                x: 0.5,
                y: 0.5,
                w: 0.001,
                h: 0.001,
            },
        )]
        .into();
        assert_eq!(choose_scale(1280, 960, &tiny, &[&input(64)]), 1);
        assert_eq!(choose_scale(1280, 960, &BTreeMap::new(), &[&input(64)]), 8);
    }

    #[test]
    fn reads_a_binary_ppm() {
        let mut ppm = b"P6\n# a comment\n2 1\n255\n".to_vec();
        ppm.extend_from_slice(&[1, 2, 3, 4, 5, 6]);
        let img = read_ppm(&ppm).unwrap();
        assert_eq!((img.width, img.height, img.data), (2, 1, vec![1, 2, 3, 4, 5, 6]));
        assert!(read_ppm(b"P6\n2 1\n255\n\x01").is_err());
        assert!(read_ppm(b"P6\n2 1\n65535\n").is_err());
        assert!(read_ppm(b"P6\n2").is_err());
        assert!(read_ppm(b"P6\n99999 99999\n255\n").is_err());
        let d = decode(&ppm, Scale::Auto, &BTreeMap::new(), &[]).unwrap();
        assert_eq!((d.width, d.height, d.scale), (2, 1, 1));
    }

    #[test]
    fn refuses_what_isnt_a_still() {
        assert!(decode(b"<svg/>", Scale::Auto, &BTreeMap::new(), &[]).is_err());
        assert!(decode(
            &[0xFF, 0xD8, 0xFF, 0x00, 0x12],
            Scale::Auto,
            &BTreeMap::new(),
            &[]
        )
        .is_err());
    }

    #[test]
    fn decodes_a_jpeg_at_the_scale_its_crops_allow() {
        let jpeg = include_bytes!("../../hal-drivers/fixtures/sensor.jpg");
        let big: BTreeMap<u32, Rect> = [(
            1,
            Rect {
                x: 0.0,
                y: 0.0,
                w: 0.5,
                h: 0.5,
            },
        )]
        .into();
        // A 320 × 240 px box at full size: 1/4 keeps 80 × 60, under the 64 × 64 input; 1/2 keeps 160 × 120.
        let d = decode(jpeg, Scale::Auto, &big, &[&input(64)]).unwrap();
        assert_eq!((d.width, d.height, d.scale), (640, 480, 2));
        assert_eq!((d.image.width, d.image.height), (320, 240));
        let full = decode(jpeg, Scale::Fixed(1), &big, &[&input(64)]).unwrap();
        assert_eq!((full.image.width, full.image.height, full.scale), (640, 480, 1));
        // The scaled decode is the full one averaged down, near enough: a mean of 0.04 here (10 of 255 levels).
        let half = crop_input(&d.image, &big[&1].to_pixels(320, 240), &input(64));
        let whole = crop_input(&full.image, &big[&1].to_pixels(640, 480), &input(64));
        let mean = half.iter().zip(&whole).map(|(a, b)| (a - b).abs()).sum::<f32>() / half.len() as f32;
        assert!(
            mean < 0.05,
            "a 1/2 scale crop is within 0.05 of the full one on average, got {mean}"
        );
    }
}
