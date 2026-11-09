/**
 * Stills the timelapse player has fetched, kept in IndexedDB so a replay or a
 * revisit doesn't download them again. The cache is capped in bytes and drops
 * the least recently shown frames first.
 *
 * Not Cache Storage: browsers only offer it on HTTPS or localhost, and a unit
 * is reached over plain http on the LAN. Any storage failure (private mode,
 * blocked site data, a full quota) leaves the player on the network.
 */

/** About 300 stills at the unit's 1280×960 JPEG size. */
export const CACHE_CAP_BYTES = 64 * 1024 * 1024
const DB_NAME = 'seedypod-frames'
const BLOBS = 'blobs'
const META = 'meta'

interface Entry { key: string, size: number, used: number }
interface Stored { bytes: ArrayBuffer, type: string }

export interface FrameCacheOptions {
  /** Bytes kept before the least recently used frames are evicted. */
  cap?: number
  /** Returns IndexedDB. Returning `undefined` or throwing means no cache: every load goes to the network. */
  idb?: () => IDBFactory | undefined
  fetch?: (url: string) => Promise<Response>
  now?: () => number
  name?: string
}

const done = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  r.onsuccess = () => resolve(r.result)
  r.onerror = () => reject(r.error)
})
const committed = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve()
  tx.onerror = () => reject(tx.error)
  tx.onabort = () => reject(tx.error)
})

export class FrameCache {
  readonly cap: number
  private readonly fetch: (url: string) => Promise<Response>
  private readonly now: () => number
  private readonly index = new Map<string, Entry>()
  private readonly inflight = new Map<string, Promise<Blob>>()
  private readonly ready: Promise<IDBDatabase | null>

  constructor(o: FrameCacheOptions = {}) {
    this.cap = o.cap ?? CACHE_CAP_BYTES
    this.fetch = o.fetch ?? (url => globalThis.fetch(url))
    this.now = o.now ?? Date.now
    this.ready = this.open(o.idb, o.name ?? DB_NAME)
  }

  private async open(factory: (() => IDBFactory | undefined) | undefined, name: string): Promise<IDBDatabase | null> {
    try {
      // Reading `indexedDB` itself throws where site data is blocked.
      const idb = factory?.()
      if (!idb) return null
      const req = idb.open(name, 1)
      req.onupgradeneeded = () => {
        req.result.createObjectStore(BLOBS)
        req.result.createObjectStore(META, { keyPath: 'key' })
      }
      const db = await done(req)
      const entries = await done(db.transaction(META).objectStore(META).getAll() as IDBRequest<Entry[]>)
      for (const e of entries) this.index.set(e.key, e)
      return db
    }
    catch {
      return null
    }
  }

  /** Bytes held now. */
  get bytes(): number {
    let n = 0
    for (const e of this.index.values()) n += e.size
    return n
  }

  /** Whether `key` is held, once the stored index has been read. */
  async has(key: string): Promise<boolean> {
    await this.ready
    return this.index.has(key)
  }

  /** The still for `key`: from the cache when held, else fetched from `url` and kept. */
  load(key: string, url: string): Promise<Blob> {
    const running = this.inflight.get(key)
    if (running) return running
    const p = this.resolve(key, url).finally(() => this.inflight.delete(key))
    this.inflight.set(key, p)
    return p
  }

  private async resolve(key: string, url: string): Promise<Blob> {
    const db = await this.ready
    const hit = db && this.index.has(key) ? await this.read(db, key) : null
    if (hit) return hit
    const res = await this.fetch(url)
    if (!res.ok) throw new Error(`${url} answered ${res.status}`)
    const blob = await res.blob()
    if (db) await this.write(db, key, blob)
    return blob
  }

  private async read(db: IDBDatabase, key: string): Promise<Blob | null> {
    try {
      const tx = db.transaction([BLOBS, META], 'readwrite')
      const got = await done(tx.objectStore(BLOBS).get(key) as IDBRequest<Stored | undefined>)
      const entry = this.index.get(key)
      if (!got || !entry) {
        this.index.delete(key)
        tx.objectStore(META).delete(key)
        return null
      }
      entry.used = this.now()
      tx.objectStore(META).put(entry)
      await committed(tx)
      return new Blob([got.bytes], { type: got.type })
    }
    catch {
      return null
    }
  }

  private async write(db: IDBDatabase, key: string, blob: Blob): Promise<void> {
    if (blob.size > this.cap) return
    try {
      const entry: Entry = { key, size: blob.size, used: this.now() }
      const stored: Stored = { bytes: await blob.arrayBuffer(), type: blob.type }
      const tx = db.transaction([BLOBS, META], 'readwrite')
      tx.objectStore(BLOBS).put(stored, key)
      tx.objectStore(META).put(entry)
      await committed(tx)
      this.index.set(key, entry)
      await this.evict(db)
    }
    catch {
      // Quota or a closed database: the frame still plays, it just isn't kept.
    }
  }

  private async evict(db: IDBDatabase): Promise<void> {
    let total = this.bytes
    if (total <= this.cap) return
    const drop: string[] = []
    for (const e of [...this.index.values()].sort((a, b) => a.used - b.used)) {
      if (total <= this.cap) break
      total -= e.size
      drop.push(e.key)
    }
    const tx = db.transaction([BLOBS, META], 'readwrite')
    for (const key of drop) {
      tx.objectStore(BLOBS).delete(key)
      tx.objectStore(META).delete(key)
      this.index.delete(key)
    }
    await committed(tx)
  }
}

let shared: FrameCache | null = null

/** The page's one cache, opened on first use. */
export function frameCache(): FrameCache {
  shared ??= new FrameCache({ idb: () => globalThis.indexedDB })
  return shared
}
