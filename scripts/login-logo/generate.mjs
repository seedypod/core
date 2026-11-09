#!/usr/bin/env node
// Pre-renders the SSH login logo into logo.frames, so a Pi Zero W only has to
// printf it. Output is deterministic: same icon, same bytes.
//
//   pnpm logo:generate              # from web/public/brand/icon-192.png
//   pnpm logo:generate <icon.png>   # from any RGBA PNG of the same artwork
//
// logo.frames has one record per line, each a run of raw terminal bytes that
// starts and ends at the logo's top-left corner:
//   1  rows, column and row of the text beside the logo, seconds per frame
//   2  final frame, truecolor
//   3  final frame, 256 colours
//   4+ the animation, each line only the cells that changed since the last
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

const ICON = fileURLToPath(new URL('../../web/public/brand/icon-192.png', import.meta.url))
const OUT = fileURLToPath(new URL('logo.frames', import.meta.url))

// Two pixels per cell. The crop is in 1024-px icon units, picked so the
// scattered squares land on the pixel grid instead of blurring across it.
const WIDTH = 40
const HEIGHT = 40
const CROP = { x: 64, y: 50, cell: 22.75 }
const ROWS = HEIGHT / 2
const INDENT = 2
const TEXT_COL = INDENT + WIDTH + 4
const TEXT_ROW = 8
const WORD = 'seedypod'
const COLS = TEXT_COL + WORD.length

const FRAMES = 30
const FRAME_SECONDS = 0.045
const POT_FRAMES = 6
const LEAF_FRAMES = [4, 17]
const WORD_START = 13
const SHEEN_FRAMES = [20, 29]

// Everything below this row is the pot; left of the V between the leaves is the
// left leaf and its pixels; the rest is the right leaf, growing from STEM to TIP.
const RIM = 23
const STEM = [23, 23]
const TIP = [39, 1]
const inLeftLeaf = (x, y) => y < RIM && x < 21.5 + Math.max(0, y - 12) * 0.15

const WHITE = [255, 255, 255]
const SHEEN = [215, 255, 230]
const MINT = [150, 255, 190]
const WORD_FROM = [64, 230, 140]
const WORD_TO = [190, 250, 130]

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t)
const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v))
const easeOut = t => 1 - (1 - t) ** 3

/** Same stream on every run, so regenerating doesn't churn the file. */
function random(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Decodes an 8-bit non-interlaced RGBA PNG, the only kind the brand icons are. */
function decodePng(file) {
  const png = readFileSync(file)
  if (png.toString('latin1', 1, 4) !== 'PNG') throw new Error(`${file} isn't a PNG; if it's a Git LFS pointer, run git lfs pull`)
  const idat = []
  let width = 0
  let height = 0
  for (let at = 8; at < png.length;) {
    const size = png.readUInt32BE(at)
    const type = png.toString('latin1', at + 4, at + 8)
    const data = png.subarray(at + 8, at + 8 + size)
    at += size + 12
    if (type === 'IDAT') idat.push(data)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error(`${file} isn't 8-bit non-interlaced RGBA`)
    }
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const rgba = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    for (let i = 0; i < stride; i++) {
      const left = i >= 4 ? rgba[y * stride + i - 4] : 0
      const up = y ? rgba[(y - 1) * stride + i] : 0
      const upLeft = y && i >= 4 ? rgba[(y - 1) * stride + i - 4] : 0
      const paeth = () => {
        const p = left + up - upLeft
        const [a, b, c] = [left, up, upLeft].map(v => Math.abs(p - v))
        return a <= b && a <= c ? left : b <= c ? up : upLeft
      }
      const predicted = [0, left, up, (left + up) >> 1, filter === 4 ? paeth() : 0][filter]
      rgba[y * stride + i] = raw[y * (stride + 1) + 1 + i] + predicted
    }
  }
  return { width, height, rgba }
}

/**
 * Box-filters the crop down to WIDTH x HEIGHT, weighting colour by alpha so the
 * icon's transparent edge doesn't darken it. A pixel is on or off: the terminal
 * has its own background, so there's nothing to blend into.
 */
function sample({ width, height, rgba }) {
  const scale = width / 1024
  const cell = CROP.cell * scale
  const pixels = []
  for (let j = 0; j < HEIGHT; j++) {
    for (let i = 0; i < WIDTH; i++) {
      const [x0, y0] = [CROP.x * scale + i * cell, CROP.y * scale + j * cell]
      const sum = [0, 0, 0]
      let alpha = 0
      for (let y = Math.floor(y0); y < y0 + cell && y < height; y++) {
        for (let x = Math.floor(x0); x < x0 + cell && x < width; x++) {
          const area = (Math.min(x + 1, x0 + cell) - Math.max(x, x0)) * (Math.min(y + 1, y0 + cell) - Math.max(y, y0))
          const a = rgba[(y * width + x) * 4 + 3] / 255 * area
          for (let c = 0; c < 3; c++) sum[c] += rgba[(y * width + x) * 4 + c] * a
          alpha += a
        }
      }
      pixels.push(alpha / cell ** 2 >= 0.5 ? liftShadow(sum.map(v => v / alpha)) : null)
    }
  }
  return pixels
}

/** The icon is drawn for white; its near-black greens vanish on a dark terminal. */
function liftShadow(rgb) {
  const luma = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
  return mix(rgb, [20, 110, 80], clamp((90 - luma) / 90) * 0.55)
}

/** The left leaf as 2x2 squares, each drifting in from the upper left. */
function particles(pixels) {
  const rand = random(1024)
  const squares = []
  for (let y = 0; y < RIM; y += 2) {
    for (let x = 0; x < WIDTH; x += 2) {
      const cells = [[0, 0], [1, 0], [0, 1], [1, 1]]
        .filter(([dx, dy]) => inLeftLeaf(x + dx, y + dy) && pixels[(y + dy) * WIDTH + x + dx])
      if (!cells.length) continue
      const fromStem = Math.hypot(x - STEM[0], y - STEM[1]) / Math.hypot(...STEM)
      const reach = 12 + rand() * 12
      const angle = Math.PI * (1.12 + rand() * 0.22)
      squares.push({
        x, y, cells,
        fromX: x + Math.cos(angle) * reach,
        fromY: y + Math.sin(angle) * reach,
        start: 1 + fromStem * 8 + rand() * 2,
        flight: 7 + rand() * 3,
      })
    }
  }
  return squares
}

/** The logo's pixels at frame f, each [r, g, b] or null. */
function renderPixels(pixels, squares, f) {
  const out = new Array(WIDTH * HEIGHT).fill(null)
  const potFront = HEIGHT - (HEIGHT - RIM) * clamp((f + 1) / POT_FRAMES)
  const axis = [TIP[0] - STEM[0], TIP[1] - STEM[1]]
  const leafFront = 1.1 * easeOut(clamp((f - LEAF_FRAMES[0]) / (LEAF_FRAMES[1] - LEAF_FRAMES[0])))

  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const rgb = pixels[y * WIDTH + x]
      if (!rgb || inLeftLeaf(x, y)) continue
      if (y >= RIM) {
        if (y >= potFront) out[y * WIDTH + x] = rgb
        continue
      }
      const along = ((x - STEM[0]) * axis[0] + (y - STEM[1]) * axis[1]) / (axis[0] ** 2 + axis[1] ** 2)
      const ahead = leafFront - along
      if (f >= LEAF_FRAMES[0] && ahead >= 0) out[y * WIDTH + x] = mix(rgb, MINT, clamp(1 - ahead * 8) * 0.7)
    }
  }

  for (const s of squares) {
    const t = (f - s.start) / s.flight
    if (t < 0) continue
    const eased = easeOut(clamp(t))
    const px = Math.round(s.fromX + (s.x - s.fromX) * eased)
    const py = Math.round(s.fromY + (s.y - s.fromY) * eased)
    for (const [dx, dy] of s.cells) {
      const [x, y] = [px + dx, py + dy]
      if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) continue
      out[y * WIDTH + x] = mix(pixels[(s.y + dy) * WIDTH + s.x + dx], MINT, (1 - clamp(t)) * 0.75)
    }
  }

  if (f >= SHEEN_FRAMES[0] && f < SHEEN_FRAMES[1]) {
    const front = 8 + 70 * (f - SHEEN_FRAMES[0]) / (SHEEN_FRAMES[1] - SHEEN_FRAMES[0] - 1)
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const rgb = out[y * WIDTH + x]
        const band = 1 - Math.abs(x + (HEIGHT - y) * 0.8 - front) / 7
        if (rgb && band > 0) out[y * WIDTH + x] = mix(rgb, SHEEN, band ** 1.5 * 0.6)
      }
    }
  }
  return out
}

/** The word beside the logo, letter by letter, then held at its gradient. */
function wordColours(f) {
  return [...WORD].map((_, i) => {
    const shown = f - WORD_START - i
    if (shown < 0) return null
    return mix(mix(WORD_FROM, WORD_TO, i / (WORD.length - 1)), WHITE, clamp(1 - shown / 4) * 0.8)
  })
}

/** Folds half-block pixels and the word into one grid of terminal cells. */
function toCells(out, word) {
  const grid = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => ({ ch: ' ', fg: null, bg: null, bold: false })))
  for (let row = 0; row < ROWS; row++) {
    for (let x = 0; x < WIDTH; x++) {
      const top = out[row * 2 * WIDTH + x]
      const bottom = out[(row * 2 + 1) * WIDTH + x]
      const cell = grid[row][INDENT + x]
      if (top && bottom) {
        const same = top.every((v, i) => Math.round(v) === Math.round(bottom[i]))
        Object.assign(cell, same ? { ch: '█', fg: top } : { ch: '▀', fg: top, bg: bottom })
      }
      else if (top) Object.assign(cell, { ch: '▀', fg: top })
      else if (bottom) Object.assign(cell, { ch: '▄', fg: bottom })
    }
  }
  word.forEach((fg, i) => {
    if (fg) Object.assign(grid[TEXT_ROW][TEXT_COL + i], { ch: WORD[i], fg, bold: true })
  })
  return grid
}

const truecolor = rgb => `2;${rgb.map(Math.round).join(';')}`

/** Nearest xterm-256 entry: the 6x6x6 cube or the grey ramp. */
function palette256(rgb) {
  const levels = [0, 95, 135, 175, 215, 255]
  const distance = (a, b) => a.reduce((sum, v, i) => sum + (v - b[i]) ** 2, 0)
  const cube = rgb.map(v => levels.reduce((best, l, i) => Math.abs(l - v) < Math.abs(levels[best] - v) ? i : best, 0))
  const cubeRgb = cube.map(i => levels[i])
  const step = clamp(Math.round((rgb[0] + rgb[1] + rgb[2]) / 3 / 10 - 0.8), 0, 23)
  const grey = 8 + step * 10
  return `5;${distance(rgb, [grey, grey, grey]) < distance(rgb, cubeRgb) ? 232 + step : 16 + cube[0] * 36 + cube[1] * 6 + cube[2]}`
}

/**
 * Writes `next` to the terminal given it already shows `prev` (null repaints
 * every cell, blanks included), leaving the cursor where it started.
 */
function encode(next, prev, colour) {
  const code = (cell) => {
    const fg = cell.fg && colour(cell.fg)
    const bg = cell.bg && colour(cell.bg)
    return { fg, bg, bold: cell.bold, ch: cell.ch }
  }
  let out = ''
  let row = 0
  let col = 0
  let pen = { fg: null, bg: null, bold: false }
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const cell = code(next[r][c])
      if (prev && JSON.stringify(cell) === JSON.stringify(code(prev[r][c]))) continue
      if (r > row) out += `\x1b[${r - row}B`
      if (c > col) out += `\x1b[${c - col}C`
      if (c < col) out += `\x1b[${col - c}D`
      const sgr = []
      if (cell.bold !== pen.bold) sgr.push(cell.bold ? 1 : 22)
      if (cell.fg !== pen.fg && cell.ch !== ' ') sgr.push(cell.fg ? `38;${cell.fg}` : 39)
      if (cell.bg !== pen.bg) sgr.push(cell.bg ? `48;${cell.bg}` : 49)
      if (sgr.length) out += `\x1b[${sgr.join(';')}m`
      pen = { fg: cell.ch === ' ' ? pen.fg : cell.fg, bg: cell.bg, bold: cell.bold }
      out += cell.ch
      row = r
      col = c + 1
    }
  }
  if (pen.fg || pen.bg || pen.bold) out += '\x1b[0m'
  if (row) out += `\x1b[${row}A`
  return col ? `${out}\r` : out
}

/**
 * One row of cells as text for bash's printf %b, from the left edge, with the
 * blanks at its end left off and the colour reset where it stops.
 */
function encodeRow(cells, colour) {
  const last = cells.findLastIndex(cell => cell.ch !== ' ' || cell.bg)
  let out = ''
  let pen = { fg: null, bg: null, bold: false }
  for (const cell of cells.slice(0, last + 1)) {
    const fg = cell.ch === ' ' ? pen.fg : cell.fg && colour(cell.fg)
    const bg = cell.bg && colour(cell.bg)
    const sgr = []
    if (cell.bold !== pen.bold) sgr.push(cell.bold ? 1 : 22)
    if (fg !== pen.fg) sgr.push(fg ? `38;${fg}` : 39)
    if (bg !== pen.bg) sgr.push(bg ? `48;${bg}` : 49)
    if (sgr.length) out += `\\e[${sgr.join(';')}m`
    pen = { fg, bg, bold: cell.bold }
    out += cell.ch
  }
  return pen.fg || pen.bg || pen.bold ? `${out}\\e[0m` : out
}

export const BANNER_START = '# >>> logo: scripts/login-logo/generate.mjs writes this block (pnpm logo:generate)'
export const BANNER_END = '# <<< logo'
export const INSTALLERS = ['../install', '../install-hal'].map(f => fileURLToPath(new URL(f, import.meta.url)))

/**
 * The final frame for the installers, which run before anything is unpacked, so
 * it's written into each. 256 colours: an installer can't ask the terminal what
 * it does, and every terminal that takes truecolor takes these.
 */
export function banner(icon = ICON) {
  const grid = toCells(sample(decodePng(icon)), wordColours(FRAMES + 8))
  return [
    BANNER_START,
    `UI_LOGO_COLS=${COLS}`,
    `UI_LOGO_COL=${TEXT_COL}`,
    `UI_LOGO_ROW=${TEXT_ROW}`,
    'UI_LOGO=(',
    ...grid.map(row => `'${encodeRow(row, palette256)}'`),
    ')',
    BANNER_END,
  ].join('\n')
}

/** `script` with its logo block replaced by `block`. */
export function withBanner(script, block) {
  const start = script.indexOf(BANNER_START)
  const end = script.indexOf(BANNER_END, start)
  if (start < 0 || end < 0) throw new Error('no logo block to replace')
  return script.slice(0, start) + block + script.slice(end + BANNER_END.length)
}

export function generate(icon = ICON) {
  const pixels = sample(decodePng(icon))
  const squares = particles(pixels)
  const finalWord = wordColours(FRAMES + 8)
  const final = toCells(pixels, finalWord)
  const lines = [
    `${ROWS} ${TEXT_COL} ${TEXT_ROW} ${FRAME_SECONDS}`,
    encode(final, null, truecolor),
    encode(final, null, palette256),
  ]
  let prev = toCells(new Array(WIDTH * HEIGHT).fill(null), wordColours(-1))
  for (let f = 0; f < FRAMES; f++) {
    const grid = toCells(renderPixels(pixels, squares, f), wordColours(f))
    lines.push(encode(grid, prev, truecolor))
    prev = grid
  }
  return `${lines.join('\n')}\n`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const data = generate(process.argv[2])
  writeFileSync(OUT, data)
  console.log(`logo.frames: ${FRAMES} frames, ${data.length} characters`)
  const block = banner(process.argv[2])
  for (const script of INSTALLERS) writeFileSync(script, withBanner(readFileSync(script, 'utf8'), block))
  console.log(`installer logo: ${block.length} characters in each of ${INSTALLERS.length} scripts`)
}
