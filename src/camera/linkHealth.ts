/**
 * Camera link health: a failing cable or connector shows as damaged frames long
 * before the camera stops working, and a retry hides most of them from
 * `camera_missing`. So each camera keeps a rolling window of frames, and a
 * pattern raises a plain-language notice of its own.
 *
 * The window lives in memory; only raising and clearing touch the card, and the
 * running count goes out as a live detail (ADR-0021). After a restart the window
 * starts empty, but a notice that was up stays up until a good run clears it.
 */
import type { Store } from '../store/types'

type Cam = 'upper' | 'lower'

/** Frames remembered per camera: most of a day at the default hourly capture. */
export const LINK_WINDOW = 20
/** Damaged frames in the window that raise a notice. */
export const LINK_RAISE_AT = 4
/**
 * Most one capture can add, whatever `capture_attempts` is set to. This keeps a
 * single glitch below `LINK_RAISE_AT`: a notice always takes two separate captures.
 */
const LINK_MOST_PER_CAPTURE = LINK_RAISE_AT - 1
/** Damaged in a row: past degrading, and said differently. Two full rounds of attempts. */
export const LINK_FAILED_RUN = 6
/**
 * Good frames in a row that clear a notice. Longer than a flaky link usually
 * manages, so it doesn't flap: at 1 frame in 6 damaged, about 1 run in 9 gets here.
 */
export const LINK_CLEAR_RUN = 12

/** Boots on record before the hub's are worth judging, and the misses that raise and clear. */
const HUB_MIN_BOOTS = 5
const HUB_RAISE_AT = 3
const HUB_CLEAR_AT = 1

export const LINK_ALERT: Record<Cam, string> = { upper: 'camera_link_upper', lower: 'camera_link_lower' }
export const HUB_ALERT = 'camera_hub_flaky'

const NAME: Record<Cam, string> = { upper: 'Top', lower: 'Bottom' }

/** Trailing entries equal to `value`. */
function runOf(window: boolean[], value: boolean): number {
  const last = window.lastIndexOf(!value)
  return window.length - 1 - last
}

export class LinkWatch {
  /** Oldest first; true is a damaged frame. */
  private readonly frames = new Map<Cam, boolean[]>()
  /** Cameras whose notice this has raised, to tell when someone closed it. */
  private readonly shown = new Set<Cam>()
  /** The boot record a closed hub notice was about: it stays closed until that changes. */
  private hubClosedAt: string | null = null
  private hubShown = false

  constructor(private readonly alerts: Store['alerts']) {}

  private active(kind: string): boolean {
    return this.alerts.list({ activeOnly: true }).some(a => a.kind === kind)
  }

  /** The first raise writes the row; after that the text only changes in memory. */
  private show(kind: string, detail: string, active: boolean, ts: string): void {
    this.alerts.raise(kind, detail, ts, active ? { live: true } : undefined)
  }

  /**
   * One capture: `damaged` frames refused, then a `good` one if it got there. A
   * camera that gave no frames at all (unplugged, or hald unreachable) adds
   * nothing: that says nothing about the link, and `camera_missing` covers it.
   */
  record(camera: Cam, damaged: number, good: boolean, ts: string): void {
    if (damaged === 0 && !good) return
    const window = this.frames.get(camera) ?? []
    this.frames.set(camera, window)
    const kind = LINK_ALERT[camera]
    const active = this.active(kind)
    // Acknowledged, most likely after a reseat: what raised it is dealt with.
    if (this.shown.delete(camera) && !active) window.length = 0
    window.push(...Array.from({ length: Math.min(damaged, LINK_MOST_PER_CAPTURE) }, () => true))
    if (good) window.push(false)
    window.splice(0, Math.max(0, window.length - LINK_WINDOW))

    const bad = window.filter(Boolean).length
    const badRun = runOf(window, true)
    if (active && runOf(window, false) >= LINK_CLEAR_RUN) {
      this.alerts.clear(kind, ts)
      // Otherwise the frames that raised it would raise it again at once.
      window.length = 0
      return
    }
    if (badRun >= LINK_FAILED_RUN) {
      this.show(kind, `${NAME[camera]} camera's connection has failed: its last ${badRun} photos were all damaged. Reseat its cable and check it for damage.`, active, ts)
    }
    // With nothing bad in the window, as after a restart, a notice keeps what it said.
    else if (bad > 0 && (active || bad >= LINK_RAISE_AT)) {
      this.show(kind, `${NAME[camera]} camera's connection may be failing: ${bad} of its last ${window.length} photos were damaged. Reseat its cable.`, active, ts)
    }
    if (active || this.active(kind)) this.shown.add(camera)
  }

  /** The hub shares the cameras' physical link, so its boots are the same story. */
  recordBoots(boots: { missing: number, total: number } | null, ts: string): void {
    if (!boots || boots.total < HUB_MIN_BOOTS) return
    const record = `${boots.missing}/${boots.total}`
    const active = this.active(HUB_ALERT)
    if (this.hubShown && !active) this.hubClosedAt = record
    this.hubShown = false
    if (active && boots.missing <= HUB_CLEAR_AT) {
      this.alerts.clear(HUB_ALERT, ts)
    }
    else if (active || (boots.missing >= HUB_RAISE_AT && record !== this.hubClosedAt)) {
      this.show(HUB_ALERT, `The cameras' USB hub didn't come up by itself on ${boots.missing} of the last ${boots.total} starts. Reseat its cable.`, active, ts)
      this.hubShown = true
    }
  }
}
