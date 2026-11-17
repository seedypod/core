/**
 * Sharing pod codes (#259, phase 2): the owner's confirmed pairs as a link to
 * the `pod-codes` issue form, pre-filled through query parameters named after
 * the form's field ids. The owner's browser opens the link and the owner
 * signs in to GitHub and submits; core only builds the URL and never contacts
 * GitHub itself. The pod-codes bot (scripts/pod-codes-merge.ts) reads the
 * submitted form back with `formFields` and `parsePairs`.
 */
import { encode } from 'jpeg-js'
import { POD_CODE, profileKey, type PodCodePair } from '../store/types'
import { decodeJpeg } from './analyze'
import { cameraOf, cropPixels, podRegions, type Camera, type RegionCalibration } from './regions'

export const POD_CODES_REPO = 'seedypod/core'
export const POD_CODES_TEMPLATE = 'pod-codes.yml'

/** The form's field ids (the query parameters) and labels (the headings of a submitted issue). */
export const POD_CODES_FIELDS = {
  pairs: 'Pairs',
  version: 'App version',
  fingerprint: 'Unit fingerprint',
  crops: 'Crops',
} as const
export type PodCodesField = keyof typeof POD_CODES_FIELDS

/** A unit fingerprint: 16 hex digits of a SHA-256. */
export const FINGERPRINT = /^[0-9a-f]{16}$/

export interface CodePlant { code: string, plant: string }

/**
 * A one-way hash of the unit id, so the bot can tell two units that agree
 * from one unit submitting twice. Nothing else about the unit goes in.
 */
export async function unitFingerprint(unitId: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(`seedypod-pod-codes:${unitId}`))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
}

/** The catalog's spelling of a plant name, or null when it isn't a catalog plant (case and spaces aside). */
export function catalogName(plant: string, plants: string[]): string | null {
  return plants.find(p => profileKey(p) === profileKey(plant)) ?? null
}

/** The owner's pairs the table can take, by their catalog name; the rest are skipped. */
export function shareablePairs(pairs: PodCodePair[], plants: string[]): { pairs: CodePlant[], skipped: CodePlant[] } {
  const out: CodePlant[] = []
  const skipped: CodePlant[] = []
  for (const p of pairs) {
    const name = catalogName(p.plant, plants)
    if (name) out.push({ code: p.code, plant: name })
    else skipped.push({ code: p.code, plant: p.plant })
  }
  return { pairs: out, skipped }
}

/** One `code → plant` per line. */
export const pairLines = (pairs: CodePlant[]) => pairs.map(p => `${p.code} → ${p.plant}`).join('\n')

/** The pre-filled issue form for these pairs. */
export function shareUrl(o: { pairs: CodePlant[], version: string, fingerprint: string | null }): string {
  const q = new URLSearchParams({ template: POD_CODES_TEMPLATE, title: `Pod codes: ${o.pairs.length} confirmed` })
  q.set('pairs', pairLines(o.pairs))
  q.set('version', o.version)
  if (o.fingerprint) q.set('fingerprint', o.fingerprint)
  return `https://github.com/${POD_CODES_REPO}/issues/new?${q.toString()}`
}

/** A submitted form's answers by field id; an unanswered field (`_No response_`) is empty. */
export function formFields(body: string): Record<PodCodesField, string> {
  const out = { pairs: '', version: '', fingerprint: '', crops: '' }
  const byLabel = new Map<string, PodCodesField>(Object.entries(POD_CODES_FIELDS).map(([id, label]) => [label, id as PodCodesField]))
  for (const section of `\n${body.replace(/\r\n/g, '\n')}`.split(/\n### /).slice(1)) {
    const nl = section.indexOf('\n')
    const id = byLabel.get((nl < 0 ? section : section.slice(0, nl)).trim())
    const value = nl < 0 ? '' : section.slice(nl + 1).trim()
    if (id) out[id] = value === '_No response_' ? '' : value
  }
  return out
}

/** The pairs in a submitted form, one `code → plant` per line, and a problem for each line that isn't one. */
export function parsePairs(text: string, plants: string[]): { pairs: CodePlant[], problems: string[] } {
  const pairs: CodePlant[] = []
  const problems: string[] = []
  for (const raw of text.replace(/^```\w*$/gm, '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const m = /^(\S{4})\s*(?:→|->)\s*(.+)$/.exec(line)
    if (!m || !POD_CODE.test(m[1] as string)) {
      problems.push(`\`${line}\`: not \`code → plant\` with a code of four of o | / h`)
      continue
    }
    const plant = catalogName(m[2] as string, plants)
    if (!plant) problems.push(`\`${line}\`: ${(m[2] as string).trim()} isn't a plant in the catalog`)
    else pairs.push({ code: m[1] as string, plant })
  }
  return { pairs, problems }
}

/** The still a pod's crop is cut from: the pod-ID still the code was read on, else the newest still. */
export interface CropSource {
  podId(camera: Camera): Promise<{ bytes: Uint8Array } | null>
  latest(camera: Camera): Promise<{ bytes: Uint8Array } | null>
}

/** One pod's crop as a JPEG, to drag into the form; null without a readable still. */
export async function podCrop(captures: CropSource, slot: number, calibration: RegionCalibration | null): Promise<Uint8Array | null> {
  const camera = cameraOf(slot)
  const box = camera ? podRegions(camera, calibration)[slot] : undefined
  if (!camera || !box) return null
  const got = (await captures.podId(camera)) ?? (await captures.latest(camera))
  const img = got ? decodeJpeg(got.bytes) : null
  if (!img) return null
  const r = cropPixels(box, img.width, img.height)
  const data = new Uint8Array(r.w * r.h * 4)
  for (let y = 0; y < r.h; y++) data.set(img.data.subarray(((r.y + y) * img.width + r.x) * 4, ((r.y + y) * img.width + r.x + r.w) * 4), y * r.w * 4)
  return new Uint8Array(encode({ data, width: r.w, height: r.h }, 90).data)
}
