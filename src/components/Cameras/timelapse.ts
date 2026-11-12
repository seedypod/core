import { useEffect, useState, useSyncExternalStore } from 'react'
import { type FrameCache, frameCache } from './frameCache'

/** Playback speeds, in frames a second. */
export const SPEEDS = [2, 5, 10, 20] as const
export type Speed = typeof SPEEDS[number]
/** Frames fetched ahead of the one on screen, so playback doesn't wait on each one. */
export const LOOKAHEAD = 8

/** A still the player can show: `src` is its network URL, or the data URL the demo uses. */
export interface TimelapseFrame { id: string, src: string }

export const nextSpeed = (s: Speed): Speed => SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length] ?? SPEEDS[0]

/**
 * Object URLs for the frames around the playhead. Frames come through the
 * cache, and only the ones asked for are held, so a long timelapse doesn't
 * keep every still in memory.
 */
export class FrameLoader {
  private readonly urls = new Map<string, string>()
  private readonly failed = new Set<string>()
  private readonly pending = new Set<string>()
  private readonly listeners = new Set<() => void>()
  private version = 0
  /** Bumped by `clear`, so a load that lands after it is dropped. */
  private generation = 0

  constructor(
    private readonly cache: FrameCache,
    private readonly toUrl: (b: Blob) => string = b => URL.createObjectURL(b),
    private readonly revoke: (url: string) => void = u => URL.revokeObjectURL(u),
  ) {}

  subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => void this.listeners.delete(l)
  }

  getVersion = () => this.version

  private changed() {
    this.version++
    for (const l of this.listeners) l()
  }

  url(id: string): string | undefined {
    return this.urls.get(id)
  }

  /** The first frame at or after `from` that hasn't failed to load, or -1 past the end. */
  nextPlayable(frames: TimelapseFrame[], from: number): number {
    return frames.findIndex((f, j) => j >= from && !this.failed.has(f.id))
  }

  /** Loads `want`, and lets go of every frame not in `want` or `keep`. */
  sync(want: TimelapseFrame[], keep: TimelapseFrame[]): void {
    const hold = new Set([...want, ...keep].map(f => f.id))
    for (const [id, u] of this.urls) {
      if (hold.has(id)) continue
      if (u.startsWith('blob:')) this.revoke(u)
      this.urls.delete(id)
    }
    for (const f of want) this.load(f)
  }

  private load(f: TimelapseFrame): void {
    if (this.urls.has(f.id) || this.pending.has(f.id) || this.failed.has(f.id)) return
    if (f.src.startsWith('data:')) {
      this.urls.set(f.id, f.src)
      this.changed()
      return
    }
    const gen = this.generation
    this.pending.add(f.id)
    this.cache.load(f.id, f.src).then(
      (blob) => {
        if (gen === this.generation) this.urls.set(f.id, this.toUrl(blob))
      },
      () => {
        if (gen === this.generation) this.failed.add(f.id)
      },
    ).finally(() => {
      this.pending.delete(f.id)
      this.changed()
    })
  }

  /** Releases everything held. */
  clear(): void {
    this.generation++
    for (const u of this.urls.values()) if (u.startsWith('blob:')) this.revoke(u)
    this.urls.clear()
    this.pending.clear()
    this.failed.clear()
  }
}

/**
 * Plays a camera's stills oldest to newest. `index` is the frame on screen,
 * `null` while following the latest one. Playback only moves to a frame once
 * it has loaded, and skips frames that won't.
 */
export function useTimelapse(frames: TimelapseFrame[], cache: FrameCache = frameCache()) {
  const [loader] = useState(() => new FrameLoader(cache))
  useSyncExternalStore(loader.subscribe, loader.getVersion)
  const [index, setIndex] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [target, setTarget] = useState(0)
  const [speed, setSpeed] = useState<Speed>(SPEEDS[1])
  const last = frames.length - 1
  const next = playing ? loader.nextPlayable(frames, target) : -1
  const active = next !== -1
  const nextFrame = frames[next]
  const nextReady = !!nextFrame && loader.url(nextFrame.id) !== undefined
  const shown = index === null ? undefined : frames[index]

  useEffect(() => () => loader.clear(), [loader])

  useEffect(() => {
    if (active) loader.sync(frames.slice(next, next + LOOKAHEAD), shown ? [shown] : [])
  }, [active, next, frames, shown, loader])

  useEffect(() => {
    if (!nextReady) return
    const t = setTimeout(() => {
      setIndex(next)
      setTarget(next + 1)
    }, 1000 / speed)
    return () => clearTimeout(t)
  }, [nextReady, next, speed])

  return {
    index,
    playing: active,
    /** Playing, but the next frame is still on its way. */
    waiting: active && !nextReady,
    speed,
    /** Play from here, or from the oldest frame when at the newest; pause while playing. */
    toggle: () => {
      if (active) return setPlaying(false)
      const at = index ?? last
      setTarget(at >= last ? 0 : at + 1)
      setPlaying(true)
    },
    /** Show frame `i`; playback, if running, carries on from there. */
    seek: (i: number) => {
      setIndex(i)
      setTarget(i + 1)
      setPlaying(active)
    },
    cycleSpeed: () => setSpeed(nextSpeed),
    /** Where to load `f` from: the cached copy when the player holds it. */
    src: (f: TimelapseFrame) => loader.url(f.id) ?? f.src,
  }
}
