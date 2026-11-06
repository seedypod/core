//! Integrity check for a camera's own MJPEG frame.
//!
//! `fswebcam` decodes each frame and encodes a new JPEG, so the file it saves
//! always has valid markers: a torn frame comes out as a well-formed picture
//! of a torn frame. Only the raw frame (`--dumpframe`) shows the damage. When
//! USB packets go missing the entropy-coded data no longer adds up, so walking
//! it finds the tear: the scan ends short, runs on past the last MCU, hits a
//! code no table holds, a restart marker arrives out of turn, or a DC value
//! leaves the range 8-bit samples can produce. That last one catches a parse
//! that lost its place and found it again with the MCU count still right: it
//! leaves every block after it offset, which is the visible tear.
//!
//! The walk Huffman-decodes every block and throws the values away. No IDCT,
//! no colour conversion, no image buffer, so its cost is a small fraction of
//! the decode `fswebcam` does anyway.
//!
//! Refusing a good frame makes a working camera look dead, which is worse than
//! passing a blemish. So anything libjpeg reads without having to repair it
//! passes here too, however odd: partial tables, padding, stray header bytes.

/// Stray bytes tolerated before a marker, as libjpeg does ("extraneous bytes
/// before marker"), not counting 0x00 and 0xFF fill, which can run to any
/// length. The stale tail of an earlier frame runs to far more than this.
const MARKER_SLACK: usize = 64;

/// What a frame's walk found. `Err` from [`inspect`] means it is damaged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameScan {
    /// Every MCU decoded, ending at EOI.
    Complete,
    /// A valid JPEG of a kind this walker doesn't read (progressive, several
    /// scans), so it says nothing either way.
    NotInspected(&'static str),
}

/// One Huffman table in the decoding form of T.81 F.2.2.3.
#[derive(Clone)]
struct Table {
    /// Largest code of each length, -1 when the length has none.
    max_code: [i32; 17],
    /// `values` index of each length's first code, less that code.
    offset: [i32; 17],
    values: Vec<u8>,
}

impl Table {
    fn new(counts: &[u8], values: &[u8]) -> Self {
        let (mut max_code, mut offset) = ([-1; 17], [0; 17]);
        let (mut code, mut index) = (0i32, 0i32);
        for len in 1..=16 {
            let n = i32::from(counts[len - 1]);
            if n > 0 {
                offset[len] = index - code;
                index += n;
                code += n;
                max_code[len] = code - 1;
            }
            code <<= 1;
        }
        Self {
            max_code,
            offset,
            values: values.to_vec(),
        }
    }
}

/// Bits of the entropy-coded data, with stuffed zero bytes removed.
struct Bits<'a> {
    data: &'a [u8],
    pos: usize,
    byte: u8,
    left: u32,
}

impl<'a> Bits<'a> {
    fn new(data: &'a [u8], pos: usize) -> Self {
        Self {
            data,
            pos,
            byte: 0,
            left: 0,
        }
    }

    /// The next bit; `None` at a marker or the end of the data.
    fn bit(&mut self) -> Option<i32> {
        if self.left == 0 {
            let b = *self.data.get(self.pos)?;
            if b == 0xFF {
                if *self.data.get(self.pos + 1)? != 0 {
                    return None;
                }
                self.pos += 1;
            }
            self.pos += 1;
            self.byte = b;
            self.left = 8;
        }
        self.left -= 1;
        Some(i32::from(self.byte >> self.left) & 1)
    }

    fn skip(&mut self, n: u8) -> Option<()> {
        for _ in 0..n {
            self.bit()?;
        }
        Some(())
    }

    /// A signed `n`-bit value (T.81 F.2.2.1, `EXTEND`).
    fn value(&mut self, n: u8) -> Option<i32> {
        let mut v = 0;
        for _ in 0..n {
            v = (v << 1) | self.bit()?;
        }
        Some(if n > 0 && v < 1 << (n - 1) {
            v - (1 << n) + 1
        } else {
            v
        })
    }

    fn symbol(&mut self, table: &Table) -> Result<u8, Stop> {
        let mut code = 0;
        for len in 1..=16 {
            code = (code << 1) | self.bit().ok_or(Stop::Marker)?;
            if code <= table.max_code[len] {
                let index = (table.offset[len] + code) as usize;
                return table.values.get(index).copied().ok_or(Stop::BadCode);
            }
        }
        Err(Stop::BadCode)
    }

    /// Drop the padding bits and find the next marker within the slack.
    fn next_marker(&mut self) -> Option<u8> {
        self.left = 0;
        let mut stray = 0;
        while let [byte, next, ..] = self.data[self.pos.min(self.data.len())..] {
            self.pos += 1;
            if byte == 0xFF && next != 0 && next != 0xFF {
                self.pos += 1;
                return Some(next);
            }
            if byte != 0 && byte != 0xFF {
                stray += 1;
                if stray > MARKER_SLACK {
                    return None;
                }
            }
        }
        None
    }
}

/// Why a block stopped decoding.
enum Stop {
    /// Ran into a marker (or the end of the data) inside a block.
    Marker,
    BadCode,
    BadBlock,
    BadDc,
}

/// One scan component: how many blocks it puts in each MCU, and its tables.
struct ScanComponent {
    blocks: u32,
    dc: Table,
    ac: Table,
    /// Largest DC magnitude a real block can have, and the running value.
    dc_limit: i32,
    dc_now: i32,
}

fn walk_block(bits: &mut Bits, c: &mut ScanComponent) -> Result<(), Stop> {
    let size = bits.symbol(&c.dc)?;
    if size > 11 {
        return Err(Stop::BadBlock);
    }
    c.dc_now += bits.value(size).ok_or(Stop::Marker)?;
    if c.dc_now.abs() > c.dc_limit {
        return Err(Stop::BadDc);
    }
    let mut k = 1;
    while k <= 63 {
        let rs = bits.symbol(&c.ac)?;
        let (run, size) = (rs >> 4, rs & 0x0F);
        if size == 0 {
            if run != 15 {
                break;
            }
            k += 16;
            continue;
        }
        k += run;
        if k > 63 {
            return Err(Stop::BadBlock);
        }
        bits.skip(size).ok_or(Stop::Marker)?;
        k += 1;
    }
    Ok(())
}

fn walk_scan(
    data: &[u8],
    start: usize,
    comps: &mut [ScanComponent],
    mcus: u32,
    restart: u32,
) -> Result<(), String> {
    let mut bits = Bits::new(data, start);
    let mut next_rst = 0u8;
    for mcu in 0..mcus {
        if restart > 0 && mcu > 0 && mcu % restart == 0 {
            match bits.next_marker() {
                Some(m) if m == 0xD0 + next_rst => {
                    next_rst = (next_rst + 1) % 8;
                    comps.iter_mut().for_each(|c| c.dc_now = 0);
                }
                Some(m) => {
                    return Err(format!(
                        "restart marker {m:#04x} out of turn at MCU {mcu} of {mcus}"
                    ))
                }
                None => return Err(format!("restart marker missing at MCU {mcu} of {mcus}")),
            }
        }
        for c in comps.iter_mut() {
            for _ in 0..c.blocks {
                match walk_block(&mut bits, c) {
                    Ok(()) => {}
                    // A scan a few bits short of the end, which libjpeg fills in.
                    Err(Stop::Marker) if mcu + 1 == mcus && bits.next_marker() == Some(0xD9) => return Ok(()),
                    Err(Stop::Marker) => return Err(format!("scan ended after {mcu} of {mcus} MCUs")),
                    Err(Stop::BadCode) => return Err(format!("bad Huffman code at MCU {mcu} of {mcus}")),
                    Err(Stop::BadBlock) => return Err(format!("impossible block at MCU {mcu} of {mcus}")),
                    Err(Stop::BadDc) => return Err(format!("DC out of range at MCU {mcu} of {mcus}")),
                }
            }
        }
    }
    match bits.next_marker() {
        // A comment or application segment may sit between the scan and EOI.
        Some(0xD9 | 0xE0..=0xEF | 0xFE) => Ok(()),
        Some(m) => Err(format!("marker {m:#04x} after the last MCU, expected EOI")),
        None => Err(format!("no EOI after all {mcus} MCUs")),
    }
}

/// `SOF` fields the scan needs.
struct Frame {
    width: u32,
    height: u32,
    components: Vec<FrameComponent>,
}

struct FrameComponent {
    id: u8,
    h: u32,
    v: u32,
    /// Index of its quantisation table.
    tq: usize,
}

fn parse_sof(seg: &[u8]) -> Result<Frame, String> {
    if seg.len() < 6 || seg[0] != 8 {
        return Err("malformed frame header".into());
    }
    let (height, width) = (
        u32::from(seg[1]) << 8 | u32::from(seg[2]),
        u32::from(seg[3]) << 8 | u32::from(seg[4]),
    );
    let count = usize::from(seg[5]);
    if width == 0 || count == 0 || count > 4 || seg.len() < 6 + 3 * count {
        return Err("malformed frame header".into());
    }
    let components = seg[6..6 + 3 * count]
        .chunks_exact(3)
        .map(|c| FrameComponent {
            id: c[0],
            h: u32::from(c[1] >> 4),
            v: u32::from(c[1] & 0x0F),
            tq: usize::from(c[2] & 0x03),
        })
        .collect::<Vec<_>>();
    if components
        .iter()
        .any(|c| !(1..=4).contains(&c.h) || !(1..=4).contains(&c.v))
    {
        return Err("malformed frame header".into());
    }
    Ok(Frame {
        width,
        height,
        components,
    })
}

/// Note each table's DC step from a DQT segment. Its first entry is the DC one.
fn parse_dqt(mut seg: &[u8], dc_steps: &mut [Option<i32>; 4]) -> Result<(), String> {
    while !seg.is_empty() {
        let id = usize::from(seg[0] & 0x03);
        let wide = seg[0] >> 4 != 0;
        let len = if wide { 129 } else { 65 };
        if seg.len() < len {
            return Err("malformed quantisation table".into());
        }
        dc_steps[id] = Some(if wide {
            i32::from(seg[1]) << 8 | i32::from(seg[2])
        } else {
            i32::from(seg[1])
        });
        seg = &seg[len..];
    }
    Ok(())
}

/// Load a DHT segment into `tables` (`[class * 4 + id]`).
fn parse_dht(mut seg: &[u8], tables: &mut [Option<Table>; 8]) -> Result<(), String> {
    while !seg.is_empty() {
        let id = usize::from(seg[0] & 0x0F);
        let class = usize::from(seg[0] >> 4);
        if seg.len() < 17 || class > 1 || id > 3 {
            return Err("malformed Huffman table".into());
        }
        let counts = &seg[1..17];
        let total = counts.iter().map(|&n| usize::from(n)).sum::<usize>();
        if total > 256 || seg.len() < 17 + total {
            return Err("malformed Huffman table".into());
        }
        tables[class * 4 + id] = Some(Table::new(counts, &seg[17..17 + total]));
        seg = &seg[17 + total..];
    }
    Ok(())
}

/// The tables of T.81 Annex K.3, which MJPEG streams leave out of each frame.
/// Slots 2 and 3 have no standard table, so a scan using one must have sent it.
fn standard_tables() -> [Option<Table>; 8] {
    let digits: Vec<u8> = (0..12).collect();
    let mut t: [Option<Table>; 8] = Default::default();
    t[0] = Some(Table::new(
        &[0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0],
        &digits,
    ));
    t[1] = Some(Table::new(
        &[0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
        &digits,
    ));
    t[4] = Some(Table::new(
        &[0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7D],
        &STD_AC_LUMA,
    ));
    t[5] = Some(Table::new(
        &[0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
        &STD_AC_CHROMA,
    ));
    t
}

#[rustfmt::skip]
const STD_AC_LUMA: [u8; 162] = [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
    0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xA1, 0x08, 0x23, 0x42, 0xB1, 0xC1, 0x15, 0x52, 0xD1, 0xF0,
    0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0A, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2A, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3A, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
    0x4A, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5A, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
    0x6A, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7A, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8A, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9A, 0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7,
    0xA8, 0xA9, 0xAA, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6, 0xB7, 0xB8, 0xB9, 0xBA, 0xC2, 0xC3, 0xC4, 0xC5,
    0xC6, 0xC7, 0xC8, 0xC9, 0xCA, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7, 0xD8, 0xD9, 0xDA, 0xE1, 0xE2,
    0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xF1, 0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7, 0xF8,
    0xF9, 0xFA,
];

#[rustfmt::skip]
const STD_AC_CHROMA: [u8; 162] = [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
    0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xA1, 0xB1, 0xC1, 0x09, 0x23, 0x33, 0x52, 0xF0,
    0x15, 0x62, 0x72, 0xD1, 0x0A, 0x16, 0x24, 0x34, 0xE1, 0x25, 0xF1, 0x17, 0x18, 0x19, 0x1A, 0x26,
    0x27, 0x28, 0x29, 0x2A, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3A, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
    0x49, 0x4A, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5A, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
    0x69, 0x6A, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7A, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
    0x88, 0x89, 0x8A, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9A, 0xA2, 0xA3, 0xA4, 0xA5,
    0xA6, 0xA7, 0xA8, 0xA9, 0xAA, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6, 0xB7, 0xB8, 0xB9, 0xBA, 0xC2, 0xC3,
    0xC4, 0xC5, 0xC6, 0xC7, 0xC8, 0xC9, 0xCA, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7, 0xD8, 0xD9, 0xDA,
    0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7, 0xF8,
    0xF9, 0xFA,
];

/// 8-bit samples give a DC coefficient of at most 1024 before quantisation.
/// The rest is headroom: this only has to catch values far out of range.
fn dc_limit(step: Option<i32>) -> i32 {
    step.filter(|&s| s > 0).map_or(i32::MAX, |s| 1280 / s + 2)
}

/// Blocks per MCU for each scan component, and MCUs in the frame.
fn scan_layout(
    frame: &Frame,
    sos: &[u8],
    tables: &[Option<Table>; 8],
    dc_steps: &[Option<i32>; 4],
) -> Result<(Vec<ScanComponent>, u32), String> {
    let count = usize::from(*sos.first().ok_or("malformed scan header")?);
    if count == 0 || sos.len() < 1 + 2 * count {
        return Err("malformed scan header".into());
    }
    let (h_max, v_max) = frame
        .components
        .iter()
        .fold((1, 1), |(h, v), c| (c.h.max(h), c.v.max(v)));
    let single = count == 1;
    let mut comps = Vec::with_capacity(count);
    for sel in sos[1..1 + 2 * count].chunks_exact(2) {
        let component = frame
            .components
            .iter()
            .find(|c| c.id == sel[0])
            .ok_or("scan names an unknown component")?;
        let table = |index: usize| {
            tables
                .get(index)
                .cloned()
                .flatten()
                .ok_or_else(|| "scan uses an undefined Huffman table".to_owned())
        };
        comps.push(ScanComponent {
            // A single-component scan isn't interleaved: one block per MCU.
            blocks: if single { 1 } else { component.h * component.v },
            dc: table(usize::from(sel[1] >> 4))?,
            ac: table(4 + usize::from(sel[1] & 0x0F))?,
            dc_limit: dc_limit(dc_steps[component.tq]),
            dc_now: 0,
        });
    }
    let (unit_w, unit_h) = if single {
        let c = &frame.components[0];
        (8 * h_max / c.h, 8 * v_max / c.v)
    } else {
        (8 * h_max, 8 * v_max)
    };
    Ok((
        comps,
        frame.width.div_ceil(unit_w) * frame.height.div_ceil(unit_h),
    ))
}

/// Walk a raw frame. `Err` says what is wrong with it. Anything after EOI is
/// ignored: `fswebcam` dumps the whole V4L2 buffer, not the bytes used.
pub fn inspect(data: &[u8]) -> Result<FrameScan, String> {
    if !data.starts_with(&[0xFF, 0xD8]) {
        return Err("not a JPEG frame".into());
    }
    let mut pos = 2;
    let mut frame = None;
    // libjpeg-turbo starts from these too, so a DHT may replace only some of them.
    let mut tables = standard_tables();
    let mut dc_steps = [None; 4];
    let mut restart = 0;
    loop {
        // Stray bytes may come before a marker, and extra 0xFF bytes may pad it.
        let start = pos;
        while data.get(pos).is_some_and(|&b| b != 0xFF) && pos - start < MARKER_SLACK {
            pos += 1;
        }
        if data.get(pos) != Some(&0xFF) {
            return Err(format!("expected a marker at byte {pos}"));
        }
        while data.get(pos) == Some(&0xFF) {
            pos += 1;
        }
        let marker = *data.get(pos).ok_or("frame ended inside the headers")?;
        pos += 1;
        // These have no length to skip.
        if matches!(marker, 0x00 | 0x01 | 0xD0..=0xD7) {
            continue;
        }
        if marker == 0xD9 {
            return Err("frame ended before any scan".into());
        }
        let len = match data.get(pos..pos + 2) {
            Some(b) => usize::from(b[0]) << 8 | usize::from(b[1]),
            None => return Err("frame ended inside the headers".into()),
        };
        let seg = len
            .checked_sub(2)
            .and_then(|n| data.get(pos + 2..pos + 2 + n))
            .ok_or("frame ended inside the headers")?;
        pos += len;
        match marker {
            0xC0 | 0xC1 => frame = Some(parse_sof(seg)?),
            0xC2 | 0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF => {
                return Ok(FrameScan::NotInspected("not a baseline JPEG"))
            }
            0xC4 => parse_dht(seg, &mut tables)?,
            0xDB => parse_dqt(seg, &mut dc_steps)?,
            0xDD => {
                let b = seg.get(..2).ok_or("malformed restart interval")?;
                restart = u32::from(b[0]) << 8 | u32::from(b[1]);
            }
            0xDA => {
                let frame = frame.ok_or("scan before any frame header")?;
                if frame.height == 0 {
                    return Ok(FrameScan::NotInspected("height set by a later DNL"));
                }
                let (mut comps, mcus) = scan_layout(&frame, seg, &tables, &dc_steps)?;
                if comps.len() < frame.components.len() {
                    return Ok(FrameScan::NotInspected("more than one scan"));
                }
                walk_scan(data, pos, &mut comps, mcus, restart)?;
                return Ok(FrameScan::Complete);
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A flat 320×240 scene, the simplest frame there is.
    const FIXTURE: &[u8] = include_bytes!("../../hal-sim/fixtures/upper.jpg");
    /// Two 640×480 frames with per-pixel noise, as a real sensor gives, and no tables of their own.
    const SENSOR: &[u8] = include_bytes!("../fixtures/sensor.jpg");
    const SENSOR_NEXT: &[u8] = include_bytes!("../fixtures/sensor-next.jpg");

    /// Offset of the first byte after the SOS header.
    fn scan_start(data: &[u8]) -> usize {
        let mut pos = 2;
        loop {
            let len = usize::from(data[pos + 2]) << 8 | usize::from(data[pos + 3]);
            if data[pos + 1] == 0xDA {
                return pos + 2 + len;
            }
            pos += 2 + len;
        }
    }

    /// A deterministic stand-in for `rand`, which hal-drivers doesn't depend on.
    fn lcg(seed: &mut u64) -> usize {
        *seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (*seed >> 33) as usize
    }

    #[test]
    fn accepts_a_whole_frame() {
        assert_eq!(inspect(FIXTURE), Ok(FrameScan::Complete));
        assert_eq!(inspect(SENSOR), Ok(FrameScan::Complete));
    }

    #[test]
    fn ignores_what_follows_eoi_because_fswebcam_dumps_the_whole_buffer() {
        let mut stale = FIXTURE.to_vec();
        stale.extend_from_slice(&[0u8; 4096]);
        stale.extend_from_slice(&FIXTURE[100..1000]);
        assert_eq!(inspect(&stale), Ok(FrameScan::Complete));
    }

    #[test]
    fn tolerates_a_few_padding_bytes_before_eoi() {
        let eoi = FIXTURE.len() - 2;
        let mut padded = FIXTURE[..eoi].to_vec();
        padded.extend_from_slice(&[0u8; 8]);
        padded.extend_from_slice(&[0xFF, 0xD9]);
        assert_eq!(inspect(&padded), Ok(FrameScan::Complete));
    }

    #[test]
    fn rejects_frames_that_are_not_jpegs_or_stop_in_the_headers() {
        assert_eq!(inspect(&[]), Err("not a JPEG frame".to_owned()));
        assert_eq!(inspect(&[0u8; 4096]), Err("not a JPEG frame".to_owned()));
        for cut in [2, 3, 4, 5, 40, scan_start(FIXTURE) - 1] {
            assert!(inspect(&FIXTURE[..cut]).is_err(), "cut at {cut}");
        }
    }

    #[test]
    fn rejects_every_truncation_of_the_scan() {
        let start = scan_start(FIXTURE);
        for cut in start..FIXTURE.len() - 1 {
            assert!(inspect(&FIXTURE[..cut]).is_err(), "cut at {cut}");
        }
    }

    #[test]
    fn rejects_a_frame_whose_end_was_zero_filled() {
        let start = scan_start(FIXTURE);
        let mut frame = FIXTURE.to_vec();
        for b in &mut frame[start + (FIXTURE.len() - start) / 2..] {
            *b = 0;
        }
        frame.extend_from_slice(&[0u8; 1 << 16]);
        assert!(inspect(&frame).is_err());
    }

    #[test]
    fn rejects_frames_with_a_run_of_packets_missing() {
        let start = scan_start(SENSOR);
        let end = SENSOR.len() - 2;
        let mut seed = 1;
        for _ in 0..300 {
            let at = start + lcg(&mut seed) % (end - start - 4096);
            let gap = 512 + lcg(&mut seed) % 3584;
            let mut torn = SENSOR[..at].to_vec();
            torn.extend_from_slice(&SENSOR[at + gap..]);
            assert!(inspect(&torn).is_err(), "gap of {gap} at {at}");
        }
    }

    #[test]
    fn rejects_two_frames_spliced_together() {
        let start = scan_start(SENSOR);
        let other_start = scan_start(SENSOR_NEXT);
        let mut seed = 2;
        let mut missed = 0;
        for _ in 0..300 {
            let at = start + 16 + lcg(&mut seed) % (SENSOR.len() - start - 32);
            let from = other_start + 16 + lcg(&mut seed) % (SENSOR_NEXT.len() - other_start - 32);
            let mut torn = SENSOR[..at].to_vec();
            torn.extend_from_slice(&SENSOR_NEXT[from..]);
            missed += usize::from(inspect(&torn).is_ok());
        }
        // A join that lands on the same MCU of both frames is a valid frame, and nearly seamless.
        assert!(missed <= 3, "missed {missed} of 300");
    }

    /// `data` with its DHT segments cut out, as a camera sends it.
    fn without_dht(data: &[u8]) -> Vec<u8> {
        let mut out = data[..2].to_vec();
        let mut pos = 2;
        loop {
            let len = usize::from(data[pos + 2]) << 8 | usize::from(data[pos + 3]);
            if data[pos + 1] == 0xDA {
                out.extend_from_slice(&data[pos..]);
                return out;
            }
            if data[pos + 1] != 0xC4 {
                out.extend_from_slice(&data[pos..pos + 2 + len]);
            }
            pos += 2 + len;
        }
    }

    /// `data` with only the DHT tables `keep` accepts, in one segment before the SOS.
    fn with_tables(data: &[u8], keep: impl Fn(u8) -> bool) -> Vec<u8> {
        let mut tables = Vec::new();
        let mut pos = 2;
        while data[pos + 1] != 0xDA {
            let len = usize::from(data[pos + 2]) << 8 | usize::from(data[pos + 3]);
            if data[pos + 1] == 0xC4 {
                let mut seg = &data[pos + 4..pos + 2 + len];
                while !seg.is_empty() {
                    let size = 17 + seg[1..17].iter().map(|&n| usize::from(n)).sum::<usize>();
                    if keep(seg[0]) {
                        tables.extend_from_slice(&seg[..size]);
                    }
                    seg = &seg[size..];
                }
            }
            pos += 2 + len;
        }
        let stripped = without_dht(data);
        let sos = scan_start(&stripped) - 14;
        let [hi, lo] = (tables.len() as u16 + 2).to_be_bytes();
        [&stripped[..sos], &[0xFF, 0xC4, hi, lo], &tables, &stripped[sos..]].concat()
    }

    /// Each of these came through libjpeg-turbo 2.1.5 with no complaint, so
    /// refusing one would make a healthy camera look dead.
    #[test]
    fn accepts_what_libjpeg_reads_without_repair() {
        let eoi = SENSOR.len() - 2;
        let dqt = SENSOR.windows(2).position(|w| w == [0xFF, 0xDB]).unwrap();
        let shapes: Vec<(&str, Vec<u8>)> = vec![
            ("luma tables only", with_tables(SENSOR, |t| t & 0x0F == 0)),
            ("chroma tables only", with_tables(SENSOR, |t| t & 0x0F == 1)),
            ("AC tables only", with_tables(SENSOR, |t| t >> 4 == 1)),
            (
                "zero fill before EOI",
                [&SENSOR[..eoi], &[0; 500], &SENSOR[eoi..]].concat(),
            ),
            (
                "0xFF fill before EOI",
                [&SENSOR[..eoi], &[0xFF; 500], &SENSOR[eoi..]].concat(),
            ),
            (
                "a comment after the scan",
                [&SENSOR[..eoi], b"\xFF\xFE\x00\x05abc", &SENSOR[eoi..]].concat(),
            ),
            (
                "the last byte of the scan missing",
                [&SENSOR[..eoi - 1], &SENSOR[eoi..]].concat(),
            ),
            (
                "stray bytes in the headers",
                [&SENSOR[..dqt], &[1, 2, 3, 4, 5], &SENSOR[dqt..]].concat(),
            ),
            (
                "a TEM marker in the headers",
                [&SENSOR[..dqt], &[0xFF, 0x01], &SENSOR[dqt..]].concat(),
            ),
        ];
        for (what, frame) in shapes {
            assert_eq!(inspect(&frame), Ok(FrameScan::Complete), "{what}");
        }
    }

    #[test]
    fn a_table_with_no_standard_form_must_be_sent() {
        // Point the scan at table 2, which only a DHT can define.
        let mut frame = SENSOR.to_vec();
        let selectors = scan_start(&frame) - 8;
        frame[selectors] = 0x22;
        let e = inspect(&frame).unwrap_err();
        assert!(e.contains("undefined Huffman table"), "{e}");
    }

    #[test]
    fn a_stale_tail_is_not_mistaken_for_padding() {
        let start = scan_start(SENSOR);
        let cut = start + (SENSOR.len() - start) / 2;
        // Enough zero bytes for the walk to finish its MCUs, then an old frame's data.
        let frame = [&SENSOR[..cut], &[0; 1 << 16], &SENSOR_NEXT[1000..]].concat();
        assert!(inspect(&frame).is_err());
    }

    #[test]
    fn a_frame_without_tables_is_read_with_the_standard_ones() {
        // Encoded with the standard tables, so it reads the same without them.
        assert_eq!(inspect(&without_dht(SENSOR)), Ok(FrameScan::Complete));
    }

    /// `FIXTURE` with restart markers: its scan as one interval, then EOI.
    fn with_dri(data: &[u8], interval: u16, scan: &[u8]) -> Vec<u8> {
        let start = scan_start(data);
        let sos = data[..start].windows(2).rposition(|w| w == [0xFF, 0xDA]).unwrap();
        let mut out = data[..sos].to_vec();
        let [hi, lo] = interval.to_be_bytes();
        out.extend_from_slice(&[0xFF, 0xDD, 0, 4, hi, lo]);
        out.extend_from_slice(&data[sos..start]);
        out.extend_from_slice(scan);
        out
    }

    #[test]
    fn a_restart_marker_must_arrive_on_time_and_in_turn() {
        let scan = &FIXTURE[scan_start(FIXTURE)..];
        // No RST where the interval promised one.
        assert!(inspect(&with_dri(FIXTURE, 1, scan))
            .unwrap_err()
            .contains("restart marker"));
        // An interval longer than the frame never needs one.
        assert_eq!(
            inspect(&with_dri(FIXTURE, u16::MAX, scan)),
            Ok(FrameScan::Complete)
        );
    }

    /// A 16×8 frame of two flat 8×8 blocks: one Y component, restart every MCU.
    fn tiny_restart_frame(rst: u8) -> Vec<u8> {
        let mut f = vec![0xFF, 0xD8];
        f.extend_from_slice(&[0xFF, 0xC0, 0, 11, 8, 0, 8, 0, 16, 1, 1, 0x11, 0]);
        f.extend_from_slice(&[0xFF, 0xDD, 0, 4, 0, 1]);
        f.extend_from_slice(&[0xFF, 0xDA, 0, 8, 1, 1, 0x00, 0, 63, 0]);
        // DC size 0 is `00`, AC EOB is `1010`, then padding ones.
        f.extend_from_slice(&[0b0010_1011, 0xFF, rst, 0b0010_1011, 0xFF, 0xD9]);
        f
    }

    #[test]
    fn restart_intervals_are_followed_through_the_scan() {
        assert_eq!(inspect(&tiny_restart_frame(0xD0)), Ok(FrameScan::Complete));
        let e = inspect(&tiny_restart_frame(0xD3)).unwrap_err();
        assert!(e.contains("out of turn at MCU 1 of 2"), "{e}");
    }

    #[test]
    fn a_dc_value_no_8_bit_sample_can_produce_is_damage() {
        let mut f = tiny_restart_frame(0xD0);
        // A DQT of all ones limits DC to 1282; size 11 reaches 2047.
        let dqt = [&[0xFF, 0xDB, 0, 67, 0][..], &[1; 64]].concat();
        f.splice(2..2, dqt);
        assert_eq!(inspect(&f), Ok(FrameScan::Complete));
        let scan = f.len() - 6;
        // `1111 1111 0` is size 11 in the standard DC table, then 11 one bits.
        f.splice(scan..scan + 1, [0xFF, 0x00, 0x7F, 0xFF, 0x00, 0xFD, 0x4F]);
        let e = inspect(&f).unwrap_err();
        assert!(e.contains("DC out of range at MCU 0"), "{e}");
    }

    #[test]
    fn says_so_when_a_valid_jpeg_cant_be_read() {
        let mut progressive = FIXTURE.to_vec();
        let sof = progressive.windows(2).position(|w| w == [0xFF, 0xC0]).unwrap();
        progressive[sof + 1] = 0xC2;
        assert!(matches!(inspect(&progressive), Ok(FrameScan::NotInspected(_))));

        let mut dnl = FIXTURE.to_vec();
        dnl[sof + 5] = 0;
        dnl[sof + 6] = 0;
        assert!(matches!(inspect(&dnl), Ok(FrameScan::NotInspected(_))));
    }

    #[test]
    fn a_scan_of_one_component_of_several_isnt_judged() {
        let mut several = FIXTURE.to_vec();
        let sos = scan_start(&several) - 14;
        assert_eq!(&several[sos..sos + 2], [0xFF, 0xDA]);
        // One selector instead of three: the frame's other planes are in later scans.
        several.splice(sos + 2..sos + 2 + 2 + 1 + 6, [0, 8, 1, 1, 0x00]);
        assert!(matches!(inspect(&several), Ok(FrameScan::NotInspected(_))));
    }

    #[test]
    fn rejects_corrupt_headers() {
        let sof = FIXTURE.windows(2).position(|w| w == [0xFF, 0xC0]).unwrap();
        let sos = scan_start(FIXTURE) - 14;
        assert_eq!(&FIXTURE[sos..sos + 2], [0xFF, 0xDA]);
        let with = |at: usize, v: u8| {
            let mut f = FIXTURE.to_vec();
            f[at] = v;
            f
        };
        for (at, v) in [
            (sof + 4, 12),    // 12-bit samples
            (sof + 7, 0),     // no width
            (sof + 9, 9),     // nine components
            (sof + 11, 0x00), // sampling factors of zero
            (sos + 5, 99),    // a component the frame doesn't have
            (sos + 6, 0x33),  // Huffman tables that were never defined
            (sos + 4, 0),     // no components in the scan
        ] {
            assert!(inspect(&with(at, v)).is_err(), "byte {at} = {v}");
        }
        let dqt = FIXTURE.windows(2).position(|w| w == [0xFF, 0xDB]).unwrap();
        assert!(inspect(&with(dqt + 3, 66)).is_err());
        let dht = FIXTURE.windows(2).position(|w| w == [0xFF, 0xC4]).unwrap();
        assert!(inspect(&with(dht + 4, 0x7F)).is_err());
        assert!(inspect(&with(dht + 5, 0xFF)).is_err());
        assert!(inspect(&[0xFF, 0xD8, 0xFF, 0xD9]).is_err());
        assert!(inspect(&[0xFF, 0xD8, 0x12, 0x34]).is_err());
        assert!(inspect(&[0xFF, 0xD8, 0xFF, 0xDD, 0, 2, 0xFF, 0xD9]).is_err());
        assert!(inspect(&[0xFF, 0xD8, 0xFF, 0xDA, 0, 2]).is_err());
    }

    #[test]
    fn a_marker_after_the_last_mcu_must_be_eoi() {
        let mut f = FIXTURE.to_vec();
        let n = f.len();
        f[n - 1] = 0xD0;
        let e = inspect(&f).unwrap_err();
        assert!(e.contains("expected EOI"), "{e}");
    }
}
