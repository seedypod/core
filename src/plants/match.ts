/**
 * Order matching (#126): turn pasted order lines ("Genovese Basil x2",
 * "3 × Butterhead Lettuce yCube") into catalog plant ids and counts, with a
 * confidence for each and the lines it could not place, so an agent can go
 * from an order to `save_plan` in one step and ask about the rest.
 *
 * Names are compared as weighted word sets: words that many catalog names
 * share ("pepper", "red", "lettuce") count for less than distinctive ones
 * ("butterhead"), near-miss spellings count for most of a word, and a few
 * common synonyms map straight to their catalog plant. Pure; no I/O.
 */
import { BUILTIN, type Catalog, type Plant } from './catalog'

/** Below this a line is unmatched (its best candidates come back as suggestions). */
export const MATCH_THRESHOLD = 0.5
/** A plan request entry holds at most this many pods (the router's limit). */
const MAX_COUNT = 30

export interface Candidate { plantId: string, plantName: string, confidence: number }

export interface OrderMatch extends Candidate {
  line: string
  /** The plant name as read from the line, quantity and noise words removed. */
  name: string
  count: number
  /** Other plants that scored close enough to be worth a look. */
  alternatives: Candidate[]
}

export interface OrderUnmatched {
  line: string
  name: string
  count: number
  suggestions: Candidate[]
}

export interface OrderResult {
  matched: OrderMatch[]
  unmatched: OrderUnmatched[]
  /** Matched lines summed per plant, ready for plan_layout / save_plan. */
  plants: { plantId: string, count: number }[]
  /** Lines with nothing to match (blank, prices, headers without letters). */
  skipped: string[]
}

/** Common names for catalog plants that share no distinctive word with them. */
const ALIASES: Record<string, string> = {
  'genovese basil': 'basil',
  'sweet basil': 'basil',
  'thai basil': 'sweet-thai-basil',
  'cherry tomato': 'red-cherry-tomato',
  'tomato': 'red-cherry-tomato',
  'parsley': 'italian-parsley',
  'flat leaf parsley': 'italian-parsley',
  'coriander': 'cilantro',
  'scallion': 'bunching-onions',
  'green onion': 'bunching-onions',
  'lacinato kale': 'kale-lacinato',
  'tuscan kale': 'kale-lacinato',
  'dino kale': 'kale-lacinato',
  'butter lettuce': 'butterhead',
  'bibb lettuce': 'butterhead',
  'spinach': 'perpetual-spinach',
  'strawberry': 'red-mini-strawberries',
}

const NOISE = new Set(['ycube', 'pod', 'seed', 'pack', 'kit', 'organic', 'plant', 'refill', 'gardyn', 'the', 'of', 'and', 'qty', 'quantity', 'x', 'pc', 'pcs'])

function stem(w: string): string {
  if (w.length <= 3) return w
  if (w.endsWith('ies')) return `${w.slice(0, -3)}y`
  if (w.endsWith('oes')) return w.slice(0, -2)
  if (/(?:s|x|ch|sh)es$/.test(w)) return w.slice(0, -2)
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1)
  return w
}

/** Lower-case ASCII words, singular, without order noise. */
export function words(s: string): string[] {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’]/g, '').split(/[^a-z0-9]+/).filter(Boolean).map(stem).filter(w => !NOISE.has(w) && !/^\d+$/.test(w))
}

/** Splits a line into its name and quantity: "Basil x2", "2 × Basil", "Basil (2)", "Basil - Qty: 2", "Basil 2 pods". */
export function parseLine(line: string): { name: string, count: number } {
  let s = line.replace(/\$\s?\d+(?:[.,]\d+)?/g, ' ').replace(/^\s*(?:[-*•·]|\d+[.)])\s+/, '').trim()
  let count = 1
  const patterns = [
    /^(\d+)\s*(?:[x×*]\s*)?(?=\D)/i,
    /[x×*]\s*(\d+)\s*$/i,
    /\(\s*(\d+)\s*(?:pods?|ycubes?|pcs?)?\s*\)\s*$/i,
    /(?:qty|quantity)\s*[:=]?\s*(\d+)\s*$/i,
    /\s(\d+)\s*(?:pods?|ycubes?|pcs?|pack)?\s*$/i,
  ]
  for (const re of patterns) {
    const m = re.exec(s)
    if (!m) continue
    count = Number(m[1])
    s = `${s.slice(0, m.index)} ${s.slice(m.index + m[0].length)}`
    break
  }
  return { name: s.replace(/\s*[-–:,]\s*$/, '').replace(/\s+/g, ' ').trim(), count: Math.max(1, count) }
}

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0] as number
    d[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cur = d[j] as number
      d[j] = Math.min(cur + 1, (d[j - 1] as number) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = cur
    }
  }
  return d[b.length] as number
}

/** 1 for the same word, 0.8 for a near-miss spelling of a long word, else 0. */
function wordMatch(a: string, b: string): number {
  if (a === b) return 1
  const n = Math.min(a.length, b.length)
  if (n < 5) return 0
  return editDistance(a, b) <= (n >= 8 ? 2 : 1) ? 0.8 : 0
}

interface Indexed { plant: Plant, variants: string[][] }

function index(catalog: Catalog) {
  const plants: Indexed[] = catalog.plants.map(p => ({ plant: p, variants: [p.name, p.id, p.gardynHandle ?? ''].map(words).filter(v => v.length > 0) }))
  const df = new Map<string, number>()
  for (const p of plants) for (const w of new Set(p.variants.flat())) df.set(w, (df.get(w) ?? 0) + 1)
  const weight = (w: string) => Math.log(1 + plants.length / (df.get(w) ?? 1))
  return { plants, weight }
}

/** Weighted Dice similarity of two word sets, 0–1. */
function similarity(a: string[], b: string[], weight: (w: string) => number): number {
  const total = [...a, ...b].reduce((s, w) => s + weight(w), 0)
  let common = 0
  const used = new Set<number>()
  for (const w of a) {
    let best = 0
    let at = -1
    b.forEach((v, i) => {
      const m = used.has(i) ? 0 : wordMatch(w, v)
      if (m > best) [best, at] = [m, i]
    })
    if (at < 0) continue
    used.add(at)
    common += best * (weight(w) + weight(b[at] as string)) / 2
  }
  return (2 * common) / total
}

const round = (n: number) => Math.round(n * 100) / 100

/** Catalog plants for one name, best first. */
export function rankNames(name: string, catalog: Catalog = BUILTIN): Candidate[] {
  const q = words(name)
  if (q.length === 0) return []
  const { plants, weight } = index(catalog)
  const alias = ALIASES[q.join(' ')]
  return plants
    .map(({ plant, variants }) => {
      const score = Math.max(plant.id === alias ? 0.95 : 0, ...variants.map(v => (v.join(' ') === q.join(' ') ? 1 : similarity(q, v, weight))))
      return { plantId: plant.id, plantName: plant.name, confidence: round(score) }
    })
    .filter(c => c.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence || a.plantName.length - b.plantName.length)
}

/** Match order lines (or one pasted block, split on new lines, commas and semicolons) to catalog plants. */
export function matchOrder(lines: string[], catalog: Catalog = BUILTIN): OrderResult {
  const out: OrderResult = { matched: [], unmatched: [], plants: [], skipped: [] }
  const totals = new Map<string, number>()
  for (const line of lines.flatMap(l => l.split(/[\n;,]/)).map(l => l.trim()).filter(Boolean)) {
    const { name, count } = parseLine(line)
    const ranked = words(name).length ? rankNames(name, catalog) : null
    if (!ranked) {
      out.skipped.push(line)
      continue
    }
    const [best, ...rest] = ranked
    if (best && best.confidence >= MATCH_THRESHOLD) {
      out.matched.push({ line, name, count, ...best, alternatives: rest.filter(c => c.confidence >= 0.35 && c.confidence >= best.confidence - 0.2).slice(0, 2) })
      totals.set(best.plantId, (totals.get(best.plantId) ?? 0) + count)
    }
    else {
      out.unmatched.push({ line, name, count, suggestions: ranked.filter(c => c.confidence >= 0.2).slice(0, 3) })
    }
  }
  out.plants = [...totals].map(([plantId, count]) => ({ plantId, count: Math.min(count, MAX_COUNT) }))
  return out
}
