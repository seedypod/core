/**
 * Model registry (#186): pod-state weights files as revisions, bound by their
 * sha256, so a model trained off the unit gets onto it without a release. The
 * release's file is the `shipped` revision and runs as `pod-state`; every
 * uploaded one runs as its own analyser (`pod-state-<revision>`) when enabled,
 * so the Analysis screen sets them side by side against each other and the
 * rule-based analysers. Each change to which revisions run, or which is
 * primary, is recorded, and rollback undoes the newest one.
 *
 * Storage is behind `ModelFiles`; `modelFiles.ts` keeps it under DATA_DIR,
 * outside the release, so updates keep uploaded models.
 */
import type { ModelError, ModelFile } from './cnn'
import { NO_WEIGHTS, parsePodStateModel, POD_STATE_ID, type LearnedSpec } from './podState'

export const MAX_MODEL_BYTES = 2_000_000
const MAX_EVENTS = 200

/** Which revisions run, and which one is primary. */
export interface Selection { enabled: string[], primary: string | null }

export type ModelAction = 'upload' | 'enable' | 'disable' | 'primary' | 'delete' | 'reset' | 'rollback'

export interface ModelEvent {
  id: number
  ts: string
  action: ModelAction
  /** The revision acted on; null for reset and rollback. */
  revision: string | null
  before: Selection
  after: Selection
  /** Undone by a later rollback. */
  rolledBack: boolean
}

export interface RegistryState extends Selection {
  /** When each uploaded revision arrived, by id. */
  uploaded: Record<string, string>
  events: ModelEvent[]
}

export interface ModelFiles {
  /** The release's weights file, or why there is none, and where it is when it's a file. */
  shipped(): { text: string | null, missing?: string, path?: string }
  /** Uploaded weights files' sha256s. */
  list(): string[]
  read(sha256: string): string | null
  /** Where an uploaded file is on disk, for the native runner (#191); storage that isn't files leaves it out. */
  path?(sha256: string): string
  write(sha256: string, text: string): void
  remove(sha256: string): void
  readState(): RegistryState | null
  writeState(state: RegistryState): void
}

export interface Revision {
  /** The first 12 hex digits of the file's sha256. */
  id: string
  sha256: string | null
  source: 'shipped' | 'uploaded'
  /** The analyser id it runs as. */
  analyzer: string
  version: number | null
  revision: string | null
  bytes: number
  uploadedAt: string | null
  trainedAt: string | null
  notes: string | null
  enabled: boolean
  primary: boolean
  /** Why it can't run (the shipped file is missing or broken). */
  disabled?: string
}

/** A refused request, with the HTTP status that says why. */
export class ModelRefused extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) {
    super(message)
  }
}

export interface ModelRegistryOptions {
  files: ModelFiles
  sha256: (text: string) => string
  now?: () => Date
  /** Called with the analysers to run after every change, to update this thread and the vision worker. */
  onChange?: (specs: LearnedSpec[]) => void
}

/** Shipped id when the release has no weights file. */
const NO_FILE = 'shipped'

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)

interface Loaded { info: Revision, text: string | null, path?: string }

export class ModelRegistry {
  private readonly now: () => Date
  private shippedMemo?: { text: string | null, missing?: string, path?: string, sha: string | null }
  private readonly headers = new Map<string, Omit<ModelFile, 'tensors'> | Error>()

  constructor(private readonly o: ModelRegistryOptions) {
    this.now = o.now ?? (() => new Date())
  }

  /** Every revision, shipped first, then uploads oldest first. */
  list(): Revision[] {
    return this.load().map(l => l.info)
  }

  events(limit = 50): ModelEvent[] {
    return this.state().events.slice(-limit).reverse()
  }

  /** What to run: every enabled revision, and the shipped one even when it can't, so the screen can say why. */
  specs(): LearnedSpec[] {
    return this.load()
      .filter(l => l.info.enabled || (l.info.source === 'shipped' && l.info.disabled))
      .map(l => ({ id: l.info.analyzer, label: label(l.info), text: l.text, ...(l.info.disabled ? { missing: l.info.disabled } : {}), ...(l.text !== null && l.path ? { path: l.path } : {}) }))
  }

  /**
   * Add a weights file. `sha256` is what the sender computed; a mismatch means
   * a truncated or altered upload. Stored disabled unless `enable`.
   */
  upload(text: string, sha256: string, opts: { enable?: boolean } = {}): Revision {
    const bytes = new TextEncoder().encode(text).byteLength
    if (bytes > MAX_MODEL_BYTES) throw new ModelRefused(400, `the weights file is ${bytes} bytes; the limit is ${MAX_MODEL_BYTES}`)
    const actual = this.o.sha256(text)
    if (!/^[0-9a-f]{64}$/i.test(sha256)) throw new ModelRefused(400, 'sha256 must be the file\'s 64 hex digit SHA-256')
    if (sha256.toLowerCase() !== actual) throw new ModelRefused(400, `sha256 mismatch: the file hashes to ${actual}`)
    let model
    try {
      model = parsePodStateModel(text)
    }
    catch (e) {
      throw new ModelRefused(400, `invalid weights file: ${(e as ModelError).message}`)
    }
    const all = this.load()
    const same = all.find(l => l.info.sha256 === actual)
    if (same) return opts.enable && !same.info.enabled ? this.set(same.info.id, { enabled: true }) : same.info
    const analyzer = `${POD_STATE_ID}-${slug(model.file.revision) || actual.slice(0, 12)}`
    const clash = all.find(l => l.info.analyzer === analyzer)
    if (clash) throw new ModelRefused(409, `revision ${clash.info.revision} (${clash.info.id}) already runs as ${analyzer}; give this model another revision name`)
    this.o.files.write(actual, text)
    this.headers.set(actual, model.file)
    const id = actual.slice(0, 12)
    this.change('upload', id, (st) => {
      st.uploaded[id] = this.now().toISOString()
      if (opts.enable) st.enabled.push(id)
    })
    return this.get(id)
  }

  /** Enable or disable a revision, or make it primary (which enables it). */
  set(id: string, patch: { enabled?: boolean, primary?: boolean }): Revision {
    const rev = this.get(id)
    if (patch.primary === false) throw new ModelRefused(400, 'make another revision primary instead')
    if (patch.enabled === false && (rev.primary || (patch.primary ?? false))) throw new ModelRefused(409, `${id} is primary; make another revision primary before disabling it`)
    if ((patch.enabled || patch.primary) && rev.disabled) throw new ModelRefused(409, `${id} can't run: ${rev.disabled}`)
    if (patch.enabled !== undefined && patch.enabled !== rev.enabled) {
      this.change(patch.enabled ? 'enable' : 'disable', id, (st) => {
        st.enabled = patch.enabled ? [...st.enabled, id] : st.enabled.filter(e => e !== id)
      })
    }
    if (patch.primary && !rev.primary) {
      this.change('primary', id, (st) => {
        if (!st.enabled.includes(id)) st.enabled.push(id)
        st.primary = id
      })
    }
    return this.get(id)
  }

  /** Delete an uploaded revision; the shipped one stays. */
  remove(id: string): void {
    const rev = this.get(id)
    if (rev.source === 'shipped') throw new ModelRefused(409, 'the shipped model can\'t be deleted; disable it instead')
    if (rev.primary) throw new ModelRefused(409, `${id} is primary; make another revision primary before deleting it`)
    this.change('delete', id, (st) => {
      st.enabled = st.enabled.filter(e => e !== id)
      st.uploaded = Object.fromEntries(Object.entries(st.uploaded).filter(([k]) => k !== id))
    })
    this.o.files.remove(rev.sha256 as string)
  }

  /** Back to the release's model alone: shipped enabled and primary, every upload disabled (kept). */
  reset(): Selection {
    const shipped = this.shippedId()
    this.change('reset', null, (st) => {
      st.enabled = [shipped]
      st.primary = shipped
    })
    return this.selection()
  }

  /** Undo the newest change not yet undone, restoring which revisions ran before it. */
  rollback(): ModelEvent {
    const st = this.state()
    const last = [...st.events].reverse().find(e => !e.rolledBack && e.action !== 'rollback' && e.action !== 'upload' && e.action !== 'delete')
    if (!last) throw new ModelRefused(409, 'nothing to roll back')
    const known = new Set(this.load().map(l => l.info.id))
    this.change('rollback', last.revision, (s) => {
      s.enabled = last.before.enabled.filter(e => known.has(e))
      s.primary = last.before.primary && known.has(last.before.primary) ? last.before.primary : null
      const undone = s.events.find(e => e.id === last.id)
      if (undone) undone.rolledBack = true
    })
    return this.events(1)[0] as ModelEvent
  }

  get(id: string): Revision {
    const rev = this.list().find(r => r.id === id)
    if (!rev) throw new ModelRefused(404, `no model revision ${id}`)
    return rev
  }

  private shippedId(): string {
    return this.shipped().sha?.slice(0, 12) ?? NO_FILE
  }

  /** The release's file doesn't change while core runs: read and hash it once. */
  private shipped(): { text: string | null, missing?: string, path?: string, sha: string | null } {
    if (!this.shippedMemo) {
      const s = this.o.files.shipped()
      this.shippedMemo = { ...s, sha: s.text === null ? null : this.o.sha256(s.text) }
    }
    return this.shippedMemo
  }

  /** A weights file's header, parsed once per sha256. */
  private header(sha: string, text: string): Omit<ModelFile, 'tensors'> | Error {
    let h = this.headers.get(sha)
    if (!h) {
      try {
        h = parsePodStateModel(text).file
      }
      catch (e) {
        h = e as Error
      }
      this.headers.set(sha, h)
    }
    return h
  }

  private state(): RegistryState {
    const saved = this.o.files.readState()
    if (saved) return saved
    // First run: the shipped model runs and is primary.
    const shipped = this.shippedId()
    return { enabled: [shipped], primary: shipped, uploaded: {}, events: [] }
  }

  private selection(st = this.state()): Selection {
    return { enabled: [...st.enabled], primary: st.primary }
  }

  private change(action: ModelAction, revision: string | null, apply: (st: RegistryState) => void): void {
    const st = this.state()
    const before = this.selection(st)
    apply(st)
    st.enabled = [...new Set(st.enabled)]
    const id = (st.events.at(-1)?.id ?? 0) + 1
    st.events = [...st.events, { id, ts: this.now().toISOString(), action, revision, before, after: this.selection(st), rolledBack: false }].slice(-MAX_EVENTS)
    this.o.files.writeState(st)
    this.o.onChange?.(this.specs())
  }

  private load(): Loaded[] {
    const st = this.state()
    const shipped = this.shipped()
    const out: Loaded[] = [{ ...this.describe(shipped.text, shipped.sha, 'shipped', st, null, shipped.missing), path: shipped.path }]
    for (const sha of this.o.files.list()) {
      if (sha === shipped.sha) continue
      out.push({ ...this.describe(this.o.files.read(sha), sha, 'uploaded', st, st.uploaded[sha.slice(0, 12)] ?? null), path: this.o.files.path?.(sha) })
    }
    return out.sort((a, b) => (a.info.source === b.info.source ? (a.info.uploadedAt ?? '').localeCompare(b.info.uploadedAt ?? '') : a.info.source === 'shipped' ? -1 : 1))
  }

  private describe(text: string | null, sha: string | null, source: Revision['source'], st: RegistryState, uploadedAt: string | null, missing?: string): Loaded {
    const id = sha ? sha.slice(0, 12) : NO_FILE
    const base: Revision = {
      id,
      sha256: sha,
      source,
      analyzer: POD_STATE_ID,
      version: null,
      revision: null,
      bytes: text === null ? 0 : new TextEncoder().encode(text).byteLength,
      uploadedAt,
      trainedAt: null,
      notes: null,
      enabled: st.enabled.includes(id),
      primary: st.primary === id,
    }
    const h = text === null || sha === null ? new Error(missing ?? NO_WEIGHTS) : this.header(sha, text)
    if (h instanceof Error) {
      const why = text === null ? h.message : `The weights file could not be loaded: ${h.message}.`
      return { info: { ...base, enabled: false, primary: false, disabled: why }, text: null }
    }
    const analyzer = source === 'shipped' ? POD_STATE_ID : `${POD_STATE_ID}-${slug(h.revision) || id}`
    return { info: { ...base, analyzer, version: h.version, revision: h.revision, trainedAt: h.trainedAt ?? null, notes: h.notes ?? null }, text }
  }
}

function label(r: Revision): string {
  return r.source === 'shipped' ? 'Pod state (learned)' : `Pod state: ${r.revision ?? r.id}`
}
