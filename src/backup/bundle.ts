/**
 * The backup bundle (ADR-0021): `seedypod-backup-<unit>-<date>.tar.gz` holding
 * the database, `hal.toml`, the Mosquitto LAN password file, `hald`'s state
 * files and, optionally, the photos. `manifest.json` is the last entry, so
 * the checksums are taken as the files stream by and no photo is read twice.
 * `scripts/seedypod-restore.cjs` is the reader; keep the two in step.
 */
import { createHash } from 'node:crypto'
import { tarStream, type TarEntry } from '../datasets/tar'

export const BACKUP_FORMAT = { name: 'seedypod-backup', version: 1 } as const

export interface BundleFile {
  /** Path inside the archive, e.g. `etc/seedypod/hal.toml`. */
  name: string
  bytes: Uint8Array
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT
  createdAt: string
  unit: { id: string | null, name: string }
  core: { version: string }
  hald: { version: string | null }
  /** Migrations applied to the database in this bundle; restore refuses one newer than the installed core. */
  schema: { migrations: number, tag: string | null }
  photos: boolean
  files: Record<string, { bytes: number, sha256: string }>
  /** Files that should have been in the bundle but couldn't be read, and why. */
  skipped: { path: string, reason: string }[]
}

/** Archive names the restore helper accepts. Anything else in a bundle makes it refuse the whole bundle. */
export const BUNDLE_NAMES = [
  /^seedypod\.db$/,
  /^etc\/seedypod\/hal\.toml$/,
  /^etc\/mosquitto\/seedypod\.passwd$/,
  /^var\/lib\/seedypod\/[a-z0-9_-]+\.json$/,
  /^captures\/(?:[\w-][\w.@-]*\/)*[\w-][\w.@-]*$/,
]

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'unit'
const stamp = (d: Date) => d.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')

/** `seedypod-backup-kitchen-20261031-030000.tar.gz` (UTC), so names sort by time within a unit. */
export function backupName(unit: string, at: Date): string {
  return `seedypod-backup-${slug(unit)}-${stamp(at)}.tar.gz`
}

/** Unit slug and creation time back out of a bundle's file name; null for anything else. */
export function parseBackupName(name: string): { unit: string, createdAt: string } | null {
  const m = name.match(/^seedypod-backup-([a-z0-9-]+)-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.tar\.gz$/)
  if (!m) return null
  const [, unit, y, mo, d, h, mi, s] = m
  return { unit: unit as string, createdAt: `${y}-${mo}-${d}T${h}:${mi}:${s}Z` }
}

/** Tar entries for the files, then the manifest with their sizes and checksums. */
export async function* bundleEntries(files: AsyncIterable<BundleFile> | Iterable<BundleFile>, meta: Omit<BackupManifest, 'files'>): AsyncGenerator<TarEntry> {
  const mtime = new Date(meta.createdAt).getTime() / 1000
  const index: BackupManifest['files'] = {}
  for await (const f of files) {
    if (!BUNDLE_NAMES.some(re => re.test(f.name))) throw new Error(`not a bundle path: ${f.name}`)
    index[f.name] = { bytes: f.bytes.length, sha256: createHash('sha256').update(f.bytes).digest('hex') }
    yield { name: f.name, bytes: f.bytes, mtime }
  }
  const manifest: BackupManifest = { ...meta, files: index }
  yield { name: 'manifest.json', bytes: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`), mtime }
}

export function gzipTar(entries: AsyncIterable<TarEntry>): ReadableStream<Uint8Array> {
  return tarStream(entries).pipeThrough(new CompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
}

export async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  let n = 0
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    n += value.length
  }
  const out = new Uint8Array(n)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
