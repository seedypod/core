import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CATALOG } from '../../components/Grow/plants/catalog'
import { decodeJpeg } from '../analyze'
import { podRegions, cropPixels } from '../regions'
import { catalogName, FINGERPRINT, formFields, pairLines, parsePairs, POD_CODES_FIELDS, podCrop, shareablePairs, shareUrl, unitFingerprint } from '../shareCodes'
import { jpeg } from './fixtures'

const PLANTS = CATALOG.map(c => c.name)
const FORM = readFileSync(resolve(import.meta.dirname, '../../../.github/ISSUE_TEMPLATE/pod-codes.yml'), 'utf8')

/** The form's fields as `id: label`, read from the YAML. */
function formIds(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of FORM.matchAll(/\n {4}id: (\S+)\n {4}attributes:\n {6}label: (.+)/g)) out[m[1] as string] = (m[2] as string).trim()
  return out
}

/** The issue body GitHub writes for a submitted form: a heading per field, `_No response_` when empty. */
function rendered(answers: Record<string, string>): string {
  return Object.entries(formIds()).map(([id, label]) => `### ${label}\n\n${answers[id] || '_No response_'}`).join('\n\n')
}

const CODES = ['o', '|', '/', 'h']
const thirty = Array.from({ length: 30 }, (_, i) => ({ code: [0, 1, 2, 3].map(k => CODES[Math.floor(i / 4 ** k) % 4]).join(''), plant: PLANTS[i] as string }))

describe('the pod-codes issue form (#259)', () => {
  it('has the fields the app fills in and the bot reads, labelled as they expect', () => {
    expect(formIds()).toEqual(POD_CODES_FIELDS)
    expect(FORM).toMatch(/^labels: \[pod-codes\]$/m)
  })
})

describe('shareUrl', () => {
  it('pre-fills the form through query parameters named after its field ids', () => {
    const url = new URL(shareUrl({ pairs: [{ code: 'oo||', plant: 'Green Bok Choy' }, { code: 'o|hh', plant: 'Thyme' }], version: '1.4.0', fingerprint: 'a1b2c3d4e5f60718' }))
    expect(url.origin + url.pathname).toBe('https://github.com/seedypod/core/issues/new')
    expect(url.searchParams.get('template')).toBe('pod-codes.yml')
    const ids = Object.keys(formIds())
    for (const k of url.searchParams.keys()) expect(['template', 'title', ...ids]).toContain(k)
    expect(url.searchParams.get('pairs')).toBe('oo|| → Green Bok Choy\no|hh → Thyme')
    expect(url.searchParams.get('version')).toBe('1.4.0')
    expect(url.searchParams.get('fingerprint')).toBe('a1b2c3d4e5f60718')
    expect(url.searchParams.get('title')).toBe('Pod codes: 2 confirmed')
  })

  it('leaves the fingerprint out when the unit has no id', () => {
    expect(new URL(shareUrl({ pairs: thirty.slice(0, 1), version: 'v', fingerprint: null })).searchParams.has('fingerprint')).toBe(false)
  })

  it('stays under 8 KB with 30 pairs, and the bot reads back exactly what it sent', () => {
    expect(new Set(thirty.map(p => p.code)).size).toBe(30)
    const url = shareUrl({ pairs: thirty, version: '1.4.0', fingerprint: 'a1b2c3d4e5f60718' })
    expect(new TextEncoder().encode(url).length).toBeLessThan(8 * 1024)
    const q = new URL(url).searchParams
    const form = formFields(rendered({ pairs: q.get('pairs') ?? '', version: q.get('version') ?? '', fingerprint: q.get('fingerprint') ?? '' }))
    expect(form).toEqual({ pairs: pairLines(thirty), version: '1.4.0', fingerprint: 'a1b2c3d4e5f60718', crops: '' })
    expect(parsePairs(form.pairs, PLANTS)).toEqual({ pairs: thirty, problems: [] })
  })
})

describe('unitFingerprint', () => {
  it('is a one-way 16-hex-digit hash, the same for one unit and different for another', async () => {
    const a = await unitFingerprint('gardyn-9')
    expect(a).toMatch(FINGERPRINT)
    expect(a).not.toContain('gardyn')
    expect(await unitFingerprint('gardyn-9')).toBe(a)
    expect(await unitFingerprint('gardyn-10')).not.toBe(a)
  })
})

describe('shareablePairs', () => {
  it('shares pairs by their catalog name and skips plants the catalog lacks', () => {
    expect(catalogName(' green bok choy ', PLANTS)).toBe('Green Bok Choy')
    expect(catalogName('Genovese Basil', PLANTS)).toBeNull()
    expect(shareablePairs([{ code: 'oo||', plant: 'green bok choy', confirmedAt: 't' }, { code: 'o|hh', plant: 'Genovese Basil', confirmedAt: 't' }], PLANTS)).toEqual({
      pairs: [{ code: 'oo||', plant: 'Green Bok Choy' }],
      skipped: [{ code: 'o|hh', plant: 'Genovese Basil' }],
    })
  })
})

describe('formFields and parsePairs', () => {
  it('reads each field under its heading, CRLF or not, and ignores headings it doesn\'t know', () => {
    const body = '### Pairs\r\n\r\n```\r\noo|| -> Basil\r\n```\r\n\r\n### App version\r\n\r\n_No response_\r\n\r\n### Other\r\n\r\nx\r\n\r\n### Crops'
    expect(formFields(body)).toEqual({ pairs: '```\noo|| -> Basil\n```', version: '', fingerprint: '', crops: '' })
    expect(formFields('no headings')).toEqual({ pairs: '', version: '', fingerprint: '', crops: '' })
  })

  it('takes `code → plant` or `code -> plant`, in a code block or not, and names each bad line', () => {
    const text = '```text\noo|| → basil\n\no|hh->Thyme\nooo → Basil\nhhhh → Moon Lettuce\nnonsense\n```'
    expect(parsePairs(text, PLANTS)).toEqual({
      pairs: [{ code: 'oo||', plant: 'Basil' }, { code: 'o|hh', plant: 'Thyme' }],
      problems: [
        '`ooo → Basil`: not `code → plant` with a code of four of o | / h',
        '`hhhh → Moon Lettuce`: Moon Lettuce isn\'t a plant in the catalog',
        '`nonsense`: not `code → plant` with a code of four of o | / h',
      ],
    })
    expect(parsePairs('xxxx → Basil', PLANTS).problems).toHaveLength(1)
  })
})

describe('podCrop', () => {
  const still = jpeg(320, 240, true)
  const source = (podId: Uint8Array | null, latest: Uint8Array | null) => ({
    podId: async () => (podId ? { bytes: podId } : null),
    latest: async () => (latest ? { bytes: latest } : null),
  })

  it('cuts the pod\'s box out of the pod-ID still, else the newest still', async () => {
    const box = cropPixels(podRegions('upper')[6] as never, 320, 240)
    for (const s of [source(still, null), source(null, still)]) {
      const crop = await podCrop(s, 6, null)
      const img = decodeJpeg(crop as Uint8Array)
      expect([img?.width, img?.height]).toEqual([box.w, box.h])
    }
    // The owner's calibration moves the box.
    const own = await podCrop(source(still, null), 6, { upper: { 6: { x: 0, y: 0, w: 0.5, h: 0.5 } } })
    expect([decodeJpeg(own as Uint8Array)?.width, decodeJpeg(own as Uint8Array)?.height]).toEqual([160, 120])
  })

  it('is null for a pod that isn\'t there, without a still, or with one that isn\'t a JPEG', async () => {
    expect(await podCrop(source(still, still), 31, null)).toBeNull()
    expect(await podCrop(source(still, still), 6, { upper: { 6: null } })).toBeNull()
    expect(await podCrop(source(null, null), 6, null)).toBeNull()
    expect(await podCrop(source(new Uint8Array([1, 2, 3, 4]), null), 20, null)).toBeNull()
  })
})
