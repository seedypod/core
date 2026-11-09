//! Decoding a still and cutting the model's input out of it: ports of
//! `decodeJpeg`, `hasZeroFilledRows`, `brightness`, `cropWindow` and
//! `cropInput` in core's `src/vision/` (#191).
//!
//! The JPEG can be decoded at 1/2, 1/4 or 1/8 scale by scaling the inverse DCT
//! (libjpeg's trick, as `jpeg-decoder` implements it), which skips most of the
//! decode. A scale is only used when every pod's crop still covers at least the
//! model's input size, so no output cell is ever an upsampled pixel.

use crate::model::Input;
use std::fmt;

/// Packed 8-bit RGB, row-major.
#[derive(Debug, Clone)]
pub struct Rgb {
    pub width: usize,
    pub height: usize,
    pub data: Vec<u8>,
}

/// A box in pixels (fractional) or, for regions, in fractions of the frame.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Largest still accepted, in pixels: 16 MP, far above any camera on the unit.
pub const MAX_PIXELS: usize = 16 << 20;

#[derive(Debug, Clone, PartialEq)]
pub struct ImageError(pub String);

impl fmt::Display for ImageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ImageError {}

/// Width and height from the JPEG header, without decoding it.
pub fn jpeg_size(bytes: &[u8]) -> Result<(usize, usize), ImageError> {
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return Err(ImageError("not a JPEG".into()));
    }
    let mut d = jpeg_decoder::Decoder::new(bytes);
    d.read_info()
        .map_err(|e| ImageError(format!("bad JPEG header: {e}")))?;
    let info = d.info().ok_or_else(|| ImageError("bad JPEG header".into()))?;
    Ok((usize::from(info.width), usize::from(info.height)))
}

/// Size of a frame decoded with the inverse DCT at `eighths`/8 (8 is full size).
pub fn scaled_size(width: usize, height: usize, eighths: usize) -> (usize, usize) {
    ((width * eighths).div_ceil(8), (height * eighths).div_ceil(8))
}

/// Decode at `eighths`/8 of full size (1, 2, 4 or 8) into RGB.
pub fn decode_jpeg(bytes: &[u8], eighths: usize) -> Result<Rgb, ImageError> {
    let (w, h) = jpeg_size(bytes)?;
    if w == 0 || h == 0 || w * h > MAX_PIXELS {
        return Err(ImageError(format!("a {w}×{h} still is out of range")));
    }
    let mut d = jpeg_decoder::Decoder::new(bytes);
    let (sw, sh) = scaled_size(w, h, eighths);
    if eighths != 8 {
        d.scale(sw as u16, sh as u16)
            .map_err(|e| ImageError(format!("bad JPEG: {e}")))?;
    }
    let pixels = d.decode().map_err(|e| ImageError(format!("bad JPEG: {e}")))?;
    let info = d.info().ok_or_else(|| ImageError("bad JPEG".into()))?;
    let (width, height) = (usize::from(info.width), usize::from(info.height));
    let data = match info.pixel_format {
        jpeg_decoder::PixelFormat::RGB24 => pixels,
        jpeg_decoder::PixelFormat::L8 => pixels.iter().flat_map(|v| [*v, *v, *v]).collect(),
        f => return Err(ImageError(format!("{f:?} JPEGs are not supported"))),
    };
    if data.len() != width * height * 3 {
        return Err(ImageError(
            "the JPEG decoded to the wrong number of pixels".into(),
        ));
    }
    Ok(Rgb { width, height, data })
}

/// Boxes as fractions of the frame, in pixels of a `width × height` frame (`toPixels`).
pub fn to_pixels(r: &Rect, width: usize, height: usize) -> Rect {
    let (w, h) = (width as f64, height as f64);
    Rect {
        x: r.x * w,
        y: r.y * h,
        w: r.w * w,
        h: r.h * h,
    }
}

/// The integer pixel window of a box, clamped to the frame and at least one pixel (`cropWindow`).
pub fn crop_window(r: &Rect, width: usize, height: usize) -> (usize, usize, usize, usize) {
    let (wf, hf) = (width as f64, height as f64);
    let x0 = (wf - 1.0).min(r.x.floor().max(0.0));
    let y0 = (hf - 1.0).min(r.y.floor().max(0.0));
    let x1 = wf.min((r.x + r.w).ceil());
    let y1 = hf.min((r.y + r.h).ceil());
    let (x0, y0) = (x0 as usize, y0 as usize);
    let x1 = (x1.max(0.0) as usize).max(x0 + 1);
    let y1 = (y1.max(0.0) as usize).max(y0 + 1);
    (x0, y0, x1, y1)
}

/// The rows (or columns) output cell `o` of `n` averages: floor(start + o·len/n) up to the next
/// cell's start, at least one, as cropInput's `span` computes it.
fn span(o: usize, n: usize, len: usize, start: usize, limit: usize) -> (usize, usize) {
    let (o, n, len, start) = (o as f64, n as f64, len as f64, start as f64);
    let a = ((limit - 1) as f64).min((start + (o * len) / n).floor()) as usize;
    let b = (limit as f64).min(((a + 1) as f64).max((start + ((o + 1.0) * len) / n).floor())) as usize;
    (a, b)
}

/// One pod's crop as the model's normalised HWC input (`cropInput`): each output cell averages the
/// source pixels that fall in it.
pub fn crop_input(img: &Rgb, rect: &Rect, inp: &Input) -> Vec<f32> {
    let mut out = vec![0f32; inp.width * inp.height * inp.channels];
    crop_input_into(img, rect, inp, &mut out);
    out
}

pub fn crop_input_into(img: &Rgb, rect: &Rect, inp: &Input, out: &mut [f32]) {
    let (x0, y0, x1, y1) = crop_window(rect, img.width, img.height);
    let (sw, sh) = (x1 - x0, y1 - y0);
    let c = inp.channels;
    let xs: Vec<(usize, usize)> = (0..inp.width).map(|ox| span(ox, inp.width, sw, x0, x1)).collect();
    for oy in 0..inp.height {
        let (ya, yb) = span(oy, inp.height, sh, y0, y1);
        for (ox, &(xa, xb)) in xs.iter().enumerate() {
            let o = (oy * inp.width + ox) * c;
            let n = ((yb - ya) * (xb - xa)) as f64;
            for ch in 0..c {
                let mut s = 0u32;
                for y in ya..yb {
                    let row = (y * img.width) * 3;
                    for x in xa..xb {
                        // A fourth channel reads opaque alpha, as cropInput does on jpeg-js's RGBA.
                        s += u32::from(if ch < 3 { img.data[row + x * 3 + ch] } else { 255 });
                    }
                }
                out[o + ch] = ((f64::from(s) / n / inp.scale - inp.mean[ch]) / inp.std[ch]) as f32;
            }
        }
    }
}

/// Mean of R, G and B over a still, 0–1, from every 7th pixel (`brightness`).
pub fn brightness(img: &Rgb) -> f64 {
    let (mut sum, mut n) = (0u64, 0u64);
    let mut p = 0;
    while p < img.width * img.height {
        let i = p * 3;
        sum += u64::from(img.data[i]) + u64::from(img.data[i + 1]) + u64::from(img.data[i + 2]);
        n += 3;
        p += 7;
    }
    if n == 0 {
        0.0
    } else {
        sum as f64 / n as f64 / 255.0
    }
}

/// Whether full-width rows are the solid green of a zero-filled YUV frame (`hasZeroFilledRows`):
/// every 4th row checked, two such rows make the frame damaged.
pub fn has_zero_filled_rows(img: &Rgb) -> bool {
    let zero = |p: &[u8]| p[0] <= 16 && p[2] <= 16 && (119..=151).contains(&p[1]);
    let mut filled = 0;
    for y in (0..img.height).step_by(4) {
        let row = &img.data[y * img.width * 3..(y + 1) * img.width * 3];
        if row.chunks_exact(3).all(zero) {
            filled += 1;
            if filled >= 2 {
                return true;
            }
        }
    }
    false
}

/// The smallest decode (in eighths of full size) at which every box's crop window still covers the
/// model's input, so the crop averages real pixels and never repeats one. Full size if none does.
pub fn choose_eighths(width: usize, height: usize, regions: &[Rect], inputs: &[&Input]) -> usize {
    for eighths in [1, 2, 4] {
        let (sw, sh) = scaled_size(width, height, eighths);
        let fits = regions.iter().all(|r| {
            let (x0, y0, x1, y1) = crop_window(&to_pixels(r, sw, sh), sw, sh);
            inputs.iter().all(|i| x1 - x0 >= i.width && y1 - y0 >= i.height)
        });
        if fits && !regions.is_empty() {
            return eighths;
        }
    }
    8
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(size: usize) -> Input {
        Input {
            width: size,
            height: size,
            channels: 3,
            scale: 255.0,
            mean: vec![0.0; 3],
            std: vec![1.0; 3],
        }
    }

    fn solid(width: usize, height: usize, px: [u8; 3]) -> Rgb {
        Rgb {
            width,
            height,
            data: px.repeat(width * height),
        }
    }

    /// The hal-sim fixture stills: real 320×240 baseline JPEGs.
    const UPPER: &[u8] = include_bytes!("../../hal-sim/fixtures/upper.jpg");

    #[test]
    fn decodes_at_full_and_reduced_scale() {
        assert_eq!(jpeg_size(UPPER).unwrap(), (320, 240));
        let full = decode_jpeg(UPPER, 8).unwrap();
        assert_eq!(
            (full.width, full.height, full.data.len()),
            (320, 240, 320 * 240 * 3)
        );
        let half = decode_jpeg(UPPER, 4).unwrap();
        assert_eq!((half.width, half.height), (160, 120));
        let eighth = decode_jpeg(UPPER, 1).unwrap();
        assert_eq!((eighth.width, eighth.height), scaled_size(320, 240, 1));
        // The scaled decode is the same picture: its brightness is the full one's, near enough.
        assert!((brightness(&half) - brightness(&full)).abs() < 0.01);
    }

    #[test]
    fn refuses_what_is_not_a_whole_jpeg() {
        assert_eq!(decode_jpeg(b"", 8).unwrap_err().0, "not a JPEG");
        assert_eq!(decode_jpeg(b"<svg/>", 8).unwrap_err().0, "not a JPEG");
        assert!(decode_jpeg(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 2], 8)
            .unwrap_err()
            .0
            .starts_with("bad JPEG"));
        // Cut off halfway through the entropy-coded data.
        let torn = &UPPER[..UPPER.len() / 2];
        assert!(decode_jpeg(torn, 8).is_err() || decode_jpeg(torn, 8).is_ok_and(|i| i.width == 320));
        // Garbage after a valid header never hangs or panics.
        let mut junk = UPPER[..600].to_vec();
        junk.extend((0..20_000u32).map(|i| (i.wrapping_mul(2_654_435_761) >> 24) as u8));
        let _ = decode_jpeg(&junk, 8);
    }

    #[test]
    fn a_grey_jpeg_decodes_to_rgb() {
        let img = decode_jpeg(include_bytes!("../fixtures/grey.jpg"), 8).unwrap();
        assert_eq!((img.width, img.height), (16, 8));
        assert!(img.data.chunks_exact(3).all(|p| p[0] == p[1] && p[1] == p[2]));
    }

    #[test]
    fn crop_window_matches_core() {
        // floor of the top-left, ceil of the bottom-right, clamped, at least one pixel.
        assert_eq!(
            crop_window(
                &Rect {
                    x: 10.4,
                    y: 7.6,
                    w: 70.3,
                    h: 66.2
                },
                160,
                120
            ),
            (10, 7, 81, 74)
        );
        assert_eq!(
            crop_window(
                &Rect {
                    x: -5.0,
                    y: -5.0,
                    w: 500.0,
                    h: 500.0
                },
                160,
                120
            ),
            (0, 0, 160, 120)
        );
        assert_eq!(
            crop_window(
                &Rect {
                    x: 200.0,
                    y: 200.0,
                    w: 0.0,
                    h: 0.0
                },
                160,
                120
            ),
            (159, 119, 160, 120)
        );
        assert_eq!(
            crop_window(
                &Rect {
                    x: 3.0,
                    y: 3.0,
                    w: 0.0,
                    h: 0.0
                },
                160,
                120
            ),
            (3, 3, 4, 4)
        );
        assert_eq!(
            to_pixels(
                &Rect {
                    x: 0.5,
                    y: 0.25,
                    w: 0.1,
                    h: 0.2
                },
                200,
                100
            ),
            Rect {
                x: 100.0,
                y: 25.0,
                w: 20.0,
                h: 20.0
            }
        );
    }

    #[test]
    fn a_crop_smaller_than_the_input_repeats_pixels_like_core() {
        // A 2×2 window into a 4×4 input: every source pixel fills a 2×2 block.
        let img = Rgb {
            width: 2,
            height: 2,
            data: vec![0, 0, 0, 255, 255, 255, 51, 51, 51, 102, 102, 102],
        };
        let x = crop_input(
            &img,
            &Rect {
                x: 0.0,
                y: 0.0,
                w: 2.0,
                h: 2.0,
            },
            &Input {
                scale: 255.0,
                ..input(4)
            },
        );
        let at = |ox: usize, oy: usize| x[(oy * 4 + ox) * 3];
        assert_eq!(
            [at(0, 0), at(1, 1), at(2, 0), at(3, 1), at(0, 2), at(3, 3)],
            [0.0, 0.0, 1.0, 1.0, 0.2, 0.4]
        );
        // A fourth channel reads as opaque alpha.
        let four = Input {
            channels: 4,
            mean: vec![0.0; 4],
            std: vec![1.0; 4],
            ..input(1)
        };
        assert_eq!(
            crop_input(
                &img,
                &Rect {
                    x: 0.0,
                    y: 0.0,
                    w: 1.0,
                    h: 1.0
                },
                &four
            ),
            [0.0, 0.0, 0.0, 1.0]
        );
    }

    #[test]
    fn brightness_and_damage_follow_core() {
        assert!((brightness(&solid(10, 10, [20, 20, 20])) - 20.0 / 255.0).abs() < 1e-12);
        assert_eq!(
            brightness(&Rgb {
                width: 0,
                height: 0,
                data: vec![]
            }),
            0.0
        );
        assert!(has_zero_filled_rows(&solid(64, 64, [0, 135, 0])));
        assert!(!has_zero_filled_rows(&solid(64, 64, [40, 135, 0])));
        // One zero-filled checked row is a coincidence, two are a torn frame.
        let mut img = solid(8, 8, [90, 90, 90]);
        img.data[..8 * 3].copy_from_slice(&[0, 135, 0].repeat(8));
        assert!(!has_zero_filled_rows(&img));
        img.data[4 * 8 * 3..5 * 8 * 3].copy_from_slice(&[0, 135, 0].repeat(8));
        assert!(has_zero_filled_rows(&img));
    }

    #[test]
    fn picks_the_smallest_decode_every_crop_still_covers() {
        let big = Rect {
            x: 0.1,
            y: 0.1,
            w: 0.4,
            h: 0.4,
        };
        // 1280×960: a 512×384 box covers 64×64 down to 1/4 scale (128×96 at 1/4, 64×48 at 1/8).
        assert_eq!(choose_eighths(1280, 960, &[big], &[&input(64)]), 2);
        // One small pod keeps the whole frame at full size.
        let small = Rect {
            x: 0.5,
            y: 0.5,
            w: 0.05,
            h: 0.07,
        };
        assert_eq!(choose_eighths(1280, 960, &[big, small], &[&input(64)]), 8);
        assert_eq!(choose_eighths(1280, 960, &[big], &[&input(64), &input(16)]), 2);
        assert_eq!(choose_eighths(1280, 960, &[big], &[&input(8)]), 1);
        assert_eq!(choose_eighths(1280, 960, &[], &[&input(64)]), 8);
    }
}
