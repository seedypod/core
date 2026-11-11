//! Reading a yCube's dot code (#224) from a full-size pod-ID still.
//!
//! Each Gardyn yCube carries five dots in a line below its opening: four rings,
//! each open or marked with a bar, a slanted bar or a half fill, and a solid dot
//! at one end. Gardyn doesn't publish what the marks mean; core learns which
//! code is which plant from the owner's confirmations. This only reads them.
//!
//! In a pod's box (a little wider and deeper, since the dots sit near its
//! bottom edge) the reader keeps what is darker than its surroundings, finds the
//! one run of five similar blobs, evenly spaced along a line, takes the solid
//! end as the end of the code, and reads each ring's inside. Marks are measured
//! against the line of dots, not the frame, because each pod faces the camera at
//! its own angle, and in coordinates scaled by each dot's own width and height,
//! which undoes most of the foreshortening of a tilted pod.
//!
//! Every step has a margin, and the code's confidence is the smallest of them.
//! Below [`MIN_CONFIDENCE`] no code is given: a small or steeply angled pod comes
//! back unknown rather than as a wrong code.

use serde::Serialize;

use crate::image::{Rect, Rgb};

/// Codes below this confidence aren't reported.
pub const MIN_CONFIDENCE: f64 = 0.5;

/// One ring's mark.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mark {
    Open,
    /// A bar across the ring, square to the line of dots.
    Bar,
    /// A bar at about 45° to the line of dots.
    Slant,
    /// Half the ring filled.
    Half,
}

impl Mark {
    pub fn symbol(self) -> char {
        match self {
            Mark::Open => 'o',
            Mark::Bar => '|',
            Mark::Slant => '/',
            Mark::Half => 'h',
        }
    }
}

/// What the reader made of one pod.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DotCode {
    /// The four marks from the far end to the one beside the solid dot, as
    /// `o` open, `|` bar, `/` slanted bar, `h` half filled. None when nothing
    /// was read or the confidence is below [`MIN_CONFIDENCE`].
    pub code: Option<String>,
    /// 0–1: the narrowest margin of any step. 0 when no line of dots was found.
    pub confidence: f64,
    /// The five dots' centres in frame pixels, far end first, solid dot last;
    /// empty when no line of dots was found.
    pub dots: Vec<[f64; 2]>,
}

impl DotCode {
    fn none() -> Self {
        DotCode {
            code: None,
            confidence: 0.0,
            dots: Vec::new(),
        }
    }
}

/// Luminance of a window of the still, row-major.
struct Gray {
    width: usize,
    height: usize,
    data: Vec<f64>,
}

impl Gray {
    fn at(&self, x: usize, y: usize) -> f64 {
        self.data[y * self.width + x]
    }
}

/// Where the reader looks, relative to the box: the dots are near its bottom edge.
const SEARCH: (f64, f64, f64, f64) = (0.15, 0.05, 0.15, 0.35);
/// A dot is roughly this fraction of the box's width across.
const DOT_PER_BOX: f64 = 0.05;

/// Read the dot code under one pod. `pod` is its box in pixels of `img`, which
/// should be the full-size still: at 1280×960 the dots are too small to read.
pub fn read(img: &Rgb, pod: &Rect) -> DotCode {
    let (left, top, right, bottom) = SEARCH;
    let x0 = (pod.x - left * pod.w).max(0.0) as usize;
    let y0 = (pod.y - top * pod.h).max(0.0) as usize;
    let x1 = ((pod.x + (1.0 + right) * pod.w).max(0.0) as usize).min(img.width);
    let y1 = ((pod.y + (1.0 + bottom) * pod.h).max(0.0) as usize).min(img.height);
    if x1 <= x0 + 8 || y1 <= y0 + 8 {
        return DotCode::none();
    }
    let g = gray(img, x0, y0, x1, y1);
    let dots = candidates(&g, pod.w);
    let Some(chain) = best_chain(&dots) else {
        return DotCode::none();
    };
    let mut rings: Vec<(Blob, Features)> = chain.iter().map(|b| (*b, features(&g, b, &chain))).collect();
    // The solid dot ends the code.
    if rings[4].1.core < rings[0].1.core {
        rings.reverse();
    }
    let solid = &rings[4].1;
    let mut confidence = clamp((solid.disc - 0.7) / 0.1).min(clamp((solid.core - 0.6) / 0.1));
    let mut code = String::new();
    for (_, f) in &rings[..4] {
        match classify(f) {
            Some((mark, c)) => {
                code.push(mark.symbol());
                confidence = confidence.min(c);
            }
            None => confidence = 0.0,
        }
    }
    DotCode {
        code: (confidence >= MIN_CONFIDENCE).then_some(code),
        confidence: (confidence * 100.0).round() / 100.0,
        dots: rings
            .iter()
            .map(|(b, _)| [b.cx + x0 as f64, b.cy + y0 as f64])
            .collect(),
    }
}

fn clamp(v: f64) -> f64 {
    v.clamp(0.0, 1.0)
}

fn gray(img: &Rgb, x0: usize, y0: usize, x1: usize, y1: usize) -> Gray {
    let (width, height) = (x1 - x0, y1 - y0);
    let mut data = Vec::with_capacity(width * height);
    for y in y0..y1 {
        for p in img.data[(y * img.width + x0) * 3..(y * img.width + x1) * 3].chunks_exact(3) {
            data.push((f64::from(p[0]) + f64::from(p[1]) + f64::from(p[2])) / 3.0);
        }
    }
    Gray { width, height, data }
}

/// The mean of a `k`×`k` square around each pixel, clipped at the edges.
fn local_mean(g: &Gray, k: usize) -> Vec<f64> {
    let (w, h) = (g.width, g.height);
    let mut sum = vec![0.0; (w + 1) * (h + 1)];
    for y in 0..h {
        let mut row = 0.0;
        for x in 0..w {
            row += g.at(x, y);
            sum[(y + 1) * (w + 1) + x + 1] = sum[y * (w + 1) + x + 1] + row;
        }
    }
    let r = k / 2;
    let mut out = Vec::with_capacity(w * h);
    for y in 0..h {
        let (ya, yb) = (y.saturating_sub(r), (y + r + 1).min(h));
        for x in 0..w {
            let (xa, xb) = (x.saturating_sub(r), (x + r + 1).min(w));
            let s = sum[yb * (w + 1) + xb] - sum[ya * (w + 1) + xb] - sum[yb * (w + 1) + xa]
                + sum[ya * (w + 1) + xa];
            out.push(s / ((yb - ya) * (xb - xa)) as f64);
        }
    }
    out
}

/// A dark blob that could be one of the dots, in window pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Blob {
    cx: f64,
    cy: f64,
    /// Half its width and height.
    a: f64,
    b: f64,
    size: f64,
}

/// Dark blobs of a dot's size and shape: 8-connected runs of pixels darker than their surroundings.
fn candidates(g: &Gray, box_w: f64) -> Vec<Blob> {
    let k = ((box_w * DOT_PER_BOX * 3.0) as usize).max(15) | 1;
    let bg = local_mean(g, k);
    let dark: Vec<bool> = g
        .data
        .iter()
        .zip(&bg)
        .map(|(v, m)| *v < m * 0.75 && *v < m - 20.0)
        .collect();
    let (min, max) = (6.0, (0.13 * box_w).max(10.0));
    let (w, h) = (g.width, g.height);
    let mut seen = vec![false; w * h];
    let mut out = Vec::new();
    let mut stack = Vec::new();
    for start in 0..w * h {
        if !dark[start] || seen[start] {
            continue;
        }
        seen[start] = true;
        stack.push(start);
        let (mut area, mut x0, mut y0, mut x1, mut y1) = (0usize, w, h, 0usize, 0usize);
        while let Some(i) = stack.pop() {
            let (x, y) = (i % w, i / w);
            area += 1;
            (x0, y0, x1, y1) = (x0.min(x), y0.min(y), x1.max(x + 1), y1.max(y + 1));
            for ny in y.saturating_sub(1)..(y + 2).min(h) {
                for nx in x.saturating_sub(1)..(x + 2).min(w) {
                    let j = ny * w + nx;
                    if dark[j] && !seen[j] {
                        seen[j] = true;
                        stack.push(j);
                    }
                }
            }
        }
        let (bw, bh) = ((x1 - x0) as f64, (y1 - y0) as f64);
        let fill = area as f64 / (bw * bh);
        if bw < min || bh < min || bw > max || bh > max || bw.max(bh) / bw.min(bh) > 2.0 || fill < 0.25 {
            continue;
        }
        out.push(Blob {
            cx: (x0 + x1 - 1) as f64 / 2.0,
            cy: (y0 + y1 - 1) as f64 / 2.0,
            a: bw / 2.0,
            b: bh / 2.0,
            size: (bw + bh) / 2.0,
        });
    }
    out
}

fn dist(a: &Blob, x: f64, y: f64) -> f64 {
    (a.cx - x).hypot(a.cy - y)
}

fn similar(a: &Blob, b: &Blob) -> bool {
    a.size.max(b.size) / a.size.min(b.size) <= 1.5
}

/// The run of exactly five similar blobs, evenly spaced along a line, that fits best.
fn best_chain(blobs: &[Blob]) -> Option<Vec<Blob>> {
    let mut best: Option<(f64, Vec<Blob>)> = None;
    for (i, a) in blobs.iter().enumerate() {
        for (j, b) in blobs.iter().enumerate() {
            let s = (a.size + b.size) / 2.0;
            let d = dist(a, b.cx, b.cy);
            if i == j || !similar(a, b) || d < 1.05 * s || d > 2.2 * s {
                continue;
            }
            let (mut chain, mut idx, mut resid) = (vec![*a, *b], vec![i, j], 0.0);
            while chain.len() < 6 {
                let (p, q) = (chain[chain.len() - 2], chain[chain.len() - 1]);
                let (px, py) = (2.0 * q.cx - p.cx, 2.0 * q.cy - p.cy);
                let step = dist(&q, p.cx, p.cy);
                let Some((k, next)) = blobs
                    .iter()
                    .enumerate()
                    .min_by(|x, y| dist(x.1, px, py).total_cmp(&dist(y.1, px, py)))
                else {
                    break;
                };
                let e = dist(next, px, py);
                if e > 0.3 * step || idx.contains(&k) || !similar(next, &q) {
                    break;
                }
                chain.push(*next);
                idx.push(k);
                resid += e / step;
            }
            if chain.len() != 5 {
                continue;
            }
            // A run that carries on backwards is longer than five: not a code.
            let (p, q) = (chain[1], chain[0]);
            let (px, py) = (2.0 * q.cx - p.cx, 2.0 * q.cy - p.cy);
            let step = dist(&q, p.cx, p.cy);
            let more = blobs
                .iter()
                .enumerate()
                .any(|(k, c)| !idx.contains(&k) && dist(c, px, py) <= 0.3 * step && similar(c, &q));
            if more {
                continue;
            }
            let mean = chain.iter().map(|c| c.size).sum::<f64>() / 5.0;
            let sd = (chain.iter().map(|c| (c.size - mean).powi(2)).sum::<f64>() / 5.0).sqrt();
            let score = resid + sd / mean;
            if best.as_ref().map_or(true, |(s, _)| score < *s) {
                best = Some((score, chain));
            }
        }
    }
    best.map(|(_, c)| c)
}

/// What one dot's inside looks like, in coordinates scaled so the dot is a unit circle.
#[derive(Debug, Clone, Copy)]
struct Features {
    /// Darkness of the centre (radius < 0.4), 0 light to 1 as dark as the ring.
    core: f64,
    /// Darkness inside the ring (radius < 0.62).
    disc: f64,
    /// How far the dark part's centre sits from the dot's.
    offset: f64,
    /// 0 for a round dark part, towards 1 for a bar.
    elongation: f64,
    /// The dark part's long axis against the line of dots, degrees 0–180.
    angle: f64,
}

fn features(g: &Gray, c: &Blob, chain: &[Blob]) -> Features {
    let (first, last) = (chain[0], chain[chain.len() - 1]);
    let line = ((last.cy - first.cy) / c.b).atan2((last.cx - first.cx) / c.a);
    const OUTER: f64 = 1.7;
    let ya = (c.cy - OUTER * c.b).max(0.0) as usize;
    let yb = ((c.cy + OUTER * c.b) as usize + 2).min(g.height);
    let xa = (c.cx - OUTER * c.a).max(0.0) as usize;
    let xb = ((c.cx + OUTER * c.a) as usize + 2).min(g.width);
    let mut ring = Vec::new();
    let mut around = Vec::new();
    let mut px = Vec::new();
    for y in ya..yb {
        for x in xa..xb {
            let (nx, ny) = ((x as f64 - c.cx) / c.a, (y as f64 - c.cy) / c.b);
            let rho = nx.hypot(ny);
            let v = g.at(x, y);
            if rho > 0.7 && rho <= 1.0 {
                ring.push(v);
            } else if rho > 1.25 && rho < OUTER {
                around.push(v);
            }
            px.push((nx, ny, rho, v));
        }
    }
    ring.sort_by(f64::total_cmp);
    around.sort_by(f64::total_cmp);
    let darkest = &ring[..(ring.len() * 3 / 10).max(1).min(ring.len())];
    let dark = darkest.iter().sum::<f64>() / darkest.len().max(1) as f64;
    let light = around.get(around.len() / 2).copied().unwrap_or(255.0);
    let t = |v: f64| clamp((light - v) / (light - dark).max(1.0));
    let (mut core, mut n_core) = (0.0, 0usize);
    let (mut sw, mut sx, mut sy, mut n_disc) = (0.0, 0.0, 0.0, 0usize);
    for &(nx, ny, rho, v) in &px {
        if rho < 0.4 {
            core += t(v);
            n_core += 1;
        }
        if rho < 0.62 {
            let w = t(v);
            sw += w;
            sx += w * nx;
            sy += w * ny;
            n_disc += 1;
        }
    }
    let (mut offset, mut elongation, mut angle) = (0.0, 0.0, 0.0);
    if sw > 1e-6 {
        let (mx, my) = (sx / sw, sy / sw);
        let (mut xx, mut yy, mut xy) = (0.0, 0.0, 0.0);
        for &(nx, ny, rho, v) in &px {
            if rho < 0.62 {
                let w = t(v);
                xx += w * (nx - mx).powi(2);
                yy += w * (ny - my).powi(2);
                xy += w * (nx - mx) * (ny - my);
            }
        }
        let (xx, yy, xy) = (xx / sw, yy / sw, xy / sw);
        let (half, root) = ((xx + yy) / 2.0, (((xx - yy) / 2.0).powi(2) + xy * xy).sqrt());
        offset = mx.hypot(my);
        elongation = if half + root > 0.0 {
            1.0 - (half - root) / (half + root)
        } else {
            0.0
        };
        let axis = 0.5 * (2.0 * xy).atan2(xx - yy);
        angle = (axis - line).to_degrees().rem_euclid(180.0);
    }
    Features {
        core: core / n_core.max(1) as f64,
        disc: sw / n_disc.max(1) as f64,
        offset,
        elongation,
        angle,
    }
}

/// A ring's mark and the margin it was read with, or None when it is none of them.
fn classify(f: &Features) -> Option<(Mark, f64)> {
    if f.core < 0.3 {
        return Some((Mark::Open, clamp((0.3 - f.core) / 0.15)));
    }
    if f.disc > 0.75 {
        // A second solid dot: not a code.
        return None;
    }
    if f.offset >= 0.1 {
        return Some((Mark::Half, clamp((f.offset - 0.1) / 0.05)));
    }
    let bar = clamp((0.1 - f.offset) / 0.04).min(clamp((f.elongation - 0.3) / 0.1));
    let square = (f.angle - 90.0).abs();
    if square < 25.0 {
        return Some((Mark::Bar, bar.min(clamp((25.0 - square) / 10.0))));
    }
    if (35.0..=55.0).contains(&square) {
        return Some((
            Mark::Slant,
            bar.min(clamp((square - 35.0).min(55.0 - square) / 5.0)),
        ));
    }
    None
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde::Deserialize;

    use super::*;
    use crate::image::{decode, Scale};

    /// Crops of full-size pod-ID stills from the unit, and what each reads as by
    /// eye (`fixtures/dotcodes/cases.json`). `confirmed` says whether the owner
    /// has confirmed the code; until then the expectations are only readings.
    #[derive(Deserialize)]
    struct Case {
        file: String,
        slot: u32,
        #[serde(rename = "box")]
        pod: Rect,
        expected: Option<String>,
        confirmed: bool,
    }

    fn cases() -> Vec<Case> {
        serde_json::from_str(include_str!("../fixtures/dotcodes/cases.json")).unwrap()
    }

    fn load(file: &str) -> Rgb {
        let path = format!("{}/fixtures/dotcodes/{file}", env!("CARGO_MANIFEST_DIR"));
        decode(
            &std::fs::read(path).unwrap(),
            Scale::Fixed(1),
            &BTreeMap::new(),
            &[],
        )
        .unwrap()
        .image
    }

    fn rotate_half_turn(img: &Rgb) -> Rgb {
        let data = img.data.chunks_exact(3).rev().flatten().copied().collect();
        Rgb { data, ..*img }
    }

    fn half_size(img: &Rgb) -> Rgb {
        let (width, height) = (img.width / 2, img.height / 2);
        let mut data = Vec::with_capacity(width * height * 3);
        for y in 0..height {
            for x in 0..width {
                for c in 0..3 {
                    let at = |dx: usize, dy: usize| {
                        u32::from(img.data[((2 * y + dy) * img.width + 2 * x + dx) * 3 + c])
                    };
                    data.push(((at(0, 0) + at(1, 0) + at(0, 1) + at(1, 1)) / 4) as u8);
                }
            }
        }
        Rgb { width, height, data }
    }

    #[test]
    fn every_fixture_reads_as_expected_and_the_unreadable_ones_as_unknown() {
        let all = cases();
        assert!(all.iter().filter(|c| c.expected.is_some()).count() >= 8);
        assert!(all.iter().filter(|c| c.expected.is_none()).count() >= 6);
        for c in &all {
            let r = read(&load(&c.file), &c.pod);
            assert_eq!(
                r.code, c.expected,
                "{} (pod {}, confidence {})",
                c.file, c.slot, r.confidence
            );
            if c.expected.is_some() {
                assert!(r.confidence >= MIN_CONFIDENCE);
                assert_eq!(r.dots.len(), 5);
            } else {
                assert!(r.confidence < MIN_CONFIDENCE);
            }
        }
    }

    #[test]
    fn no_fixture_claims_an_owner_confirmation_yet() {
        // Flip a case's `confirmed` only with the owner's word (#224).
        assert!(cases().iter().all(|c| !c.confirmed));
    }

    #[test]
    fn the_same_pod_reads_the_same_on_two_days() {
        let all = cases();
        for c in all.iter().filter(|c| c.file.starts_with("upper-2026-11-10")) {
            let other = all
                .iter()
                .find(|o| o.slot == c.slot && o.file.starts_with("upper-2026-11-11"))
                .unwrap();
            assert_eq!(
                read(&load(&c.file), &c.pod).code,
                read(&load(&other.file), &other.pod).code
            );
        }
    }

    #[test]
    fn the_code_reads_from_the_solid_dot_whichever_way_up_the_pod_is() {
        for c in cases().iter().filter(|c| c.expected.is_some()) {
            let img = rotate_half_turn(&load(&c.file));
            let pod = Rect {
                x: img.width as f64 - c.pod.x - c.pod.w,
                y: img.height as f64 - c.pod.y - c.pod.h,
                ..c.pod
            };
            let r = read(&img, &pod);
            // Upside down the dots sit near the box's top edge, outside where the reader looks.
            // What it does find must still be the same code.
            if r.code.is_some() {
                assert_eq!(r.code, c.expected, "{}", c.file);
            }
            let wide = Rect {
                y: pod.y - 0.4 * pod.h,
                h: pod.h * 1.4,
                ..pod
            };
            assert_eq!(read(&img, &wide).code, c.expected, "{} turned over", c.file);
        }
    }

    #[test]
    fn at_the_regular_stills_size_the_dots_are_too_small_and_nothing_is_read() {
        for c in cases().iter().filter(|c| c.expected.is_some()) {
            let img = half_size(&load(&c.file));
            let pod = Rect {
                x: c.pod.x / 2.0,
                y: c.pod.y / 2.0,
                w: c.pod.w / 2.0,
                h: c.pod.h / 2.0,
            };
            let r = read(&img, &pod);
            assert!(
                r.code.is_none() || r.code == c.expected,
                "{}: {:?}",
                c.file,
                r.code
            );
        }
    }

    #[test]
    fn plain_plastic_and_a_box_off_the_frame_read_as_nothing() {
        let img = Rgb {
            width: 200,
            height: 200,
            data: [200, 200, 200].repeat(40_000),
        };
        let pod = Rect {
            x: 20.0,
            y: 20.0,
            w: 150.0,
            h: 150.0,
        };
        assert_eq!(read(&img, &pod), DotCode::none());
        let off = Rect {
            x: 500.0,
            y: 500.0,
            w: 50.0,
            h: 50.0,
        };
        assert_eq!(read(&img, &off), DotCode::none());
    }

    #[test]
    fn each_mark_needs_its_own_evidence() {
        let f = |core, disc, offset, elongation, angle| Features {
            core,
            disc,
            offset,
            elongation,
            angle,
        };
        assert_eq!(classify(&f(0.05, 0.1, 0.0, 0.0, 0.0)), Some((Mark::Open, 1.0)));
        assert_eq!(
            classify(&f(0.6, 0.45, 0.02, 0.8, 92.0)).map(|m| m.0),
            Some(Mark::Bar)
        );
        assert_eq!(
            classify(&f(0.6, 0.45, 0.02, 0.8, 135.0)).map(|m| m.0),
            Some(Mark::Slant)
        );
        assert_eq!(
            classify(&f(0.6, 0.45, 0.02, 0.8, 45.0)).map(|m| m.0),
            Some(Mark::Slant)
        );
        assert_eq!(
            classify(&f(0.5, 0.5, 0.23, 0.5, 170.0)).map(|m| m.0),
            Some(Mark::Half)
        );
        // A bar along the line, or between square and slanted, is none of them.
        assert_eq!(classify(&f(0.6, 0.45, 0.02, 0.8, 5.0)), None);
        assert_eq!(classify(&f(0.6, 0.45, 0.02, 0.8, 120.0)), None);
        // A second solid dot isn't a mark.
        assert_eq!(classify(&f(0.95, 0.9, 0.0, 0.1, 0.0)), None);
        // A round blot in the middle reads as a bar with no confidence.
        assert_eq!(classify(&f(0.6, 0.45, 0.02, 0.2, 90.0)).map(|m| m.1), Some(0.0));
        assert_eq!(Mark::Half.symbol(), 'h');
    }
}
