import { describe, expect, it, vi } from 'vitest'
import { MemoryStore } from '../../store/memory'
import { HUB_ALERT, LINK_ALERT, LINK_CLEAR_RUN, LINK_FAILED_RUN, LINK_RAISE_AT, LINK_WINDOW, LinkWatch } from '../linkHealth'

const TS = '2026-11-07T00:00:00.000Z'

function rig() {
  const store = new MemoryStore()
  const watch = new LinkWatch(store.alerts)
  const detail = (kind = LINK_ALERT.upper) => store.alerts.list({ activeOnly: true }).find(a => a.kind === kind)?.detail
  /** Good stills in a row. */
  const good = (n: number, camera: 'upper' | 'lower' = 'upper') => {
    for (let i = 0; i < n; i++) watch.record(camera, 0, true, TS)
  }
  /** Two captures with some damage each: the least that raises a notice. */
  const pattern = (camera: 'upper' | 'lower' = 'upper') => {
    watch.record(camera, 2, true, TS)
    watch.record(camera, 2, true, TS)
  }
  return { store, watch, detail, good, pattern }
}

describe('LinkWatch', () => {
  it('one bad capture, even one that used up every retry, raises nothing', () => {
    const { watch, detail, good } = rig()
    good(5)
    watch.record('upper', 3, false, TS)
    good(5)
    expect(detail()).toBeUndefined()
  })

  it('one capture can\'t raise it however many attempts it was set to make', () => {
    const { watch, detail } = rig()
    watch.record('upper', 9, false, TS)
    expect(detail()).toBeUndefined()
    watch.record('upper', 1, false, TS)
    expect(detail()).toMatch(/^Top camera's connection may be failing: 4 of its last 4/)
  })

  it('a pattern across captures raises a plain notice with the count', () => {
    const { watch, detail, good } = rig()
    good(14)
    watch.record('upper', 2, true, TS)
    good(1)
    watch.record('upper', 2, true, TS)
    expect(detail()).toBe('Top camera\'s connection may be failing: 4 of its last 20 photos were damaged. Reseat its cable.')
  })

  it('counts damage a retry recovered from, which camera_missing never sees', () => {
    const { watch, detail } = rig()
    for (let i = 0; i < LINK_RAISE_AT; i++) watch.record('lower', 1, true, TS)
    expect(detail(LINK_ALERT.lower)).toMatch(/^Bottom camera's connection may be failing: 4 of its last 8 photos/)
  })

  it('says something different when a camera fails every time', () => {
    const { watch, detail } = rig()
    watch.record('upper', 3, false, TS)
    watch.record('upper', 3, false, TS)
    expect(detail()).toBe('Top camera\'s connection has failed: its last 6 photos were all damaged. Reseat its cable and check it for damage.')
    // One good frame means it isn't failing every time any more.
    watch.record('upper', 0, true, TS)
    expect(detail()).toMatch(/may be failing: 6 of its last 7 photos/)
  })

  it('doesn\'t count a camera that gave no frames at all', () => {
    const { watch, detail } = rig()
    for (let i = 0; i < LINK_WINDOW * 2; i++) watch.record('upper', 0, false, TS)
    expect(detail()).toBeUndefined()
  })

  it('tracks each camera on its own', () => {
    const { watch, detail, good } = rig()
    watch.record('upper', 3, false, TS)
    watch.record('upper', 3, false, TS)
    good(LINK_CLEAR_RUN + 1, 'lower')
    expect(detail(LINK_ALERT.upper)).toBeDefined()
    expect(detail(LINK_ALERT.lower)).toBeUndefined()
  })

  it('stays up through a run that isn\'t long enough, so it doesn\'t flap', () => {
    const { watch, detail, good, pattern } = rig()
    pattern()
    good(LINK_CLEAR_RUN - 2)
    expect(detail()).toBeDefined()
    watch.record('upper', 1, true, TS)
    good(LINK_CLEAR_RUN - 2)
    expect(detail()).toBeDefined()
  })

  it('clears after a sustained good run, and needs a fresh pattern to come back', () => {
    const { watch, detail, good, pattern } = rig()
    pattern()
    good(LINK_CLEAR_RUN - 2)
    expect(detail()).toBeDefined()
    good(1)
    expect(detail()).toBeUndefined()
    // The frames that raised it are forgotten: one more bad one isn't a pattern.
    watch.record('upper', 1, true, TS)
    expect(detail()).toBeUndefined()
  })

  it('only writes to the card when it raises and clears', () => {
    const { store, watch, good, pattern } = rig()
    const raise = vi.spyOn(store.alerts, 'raise')
    const lastOptions = () => (raise.mock.calls.at(-1) as unknown[])[3]
    pattern()
    expect(lastOptions()).toBeUndefined()
    for (let i = 0; i < 5; i++) {
      watch.record('upper', 1, true, TS)
      expect(lastOptions()).toEqual({ live: true })
    }
    good(LINK_CLEAR_RUN)
    expect(store.alerts.list().filter(a => a.kind === LINK_ALERT.upper)).toHaveLength(1)
  })

  it('forgets frames past the window', () => {
    const { watch, detail, good } = rig()
    watch.record('upper', 3, false, TS)
    good(LINK_WINDOW)
    watch.record('upper', 1, true, TS)
    expect(detail()).toBeUndefined()
  })

  it('a notice from before a restart stays until a good run clears it', () => {
    const { store, detail } = rig()
    store.alerts.raise(LINK_ALERT.upper, 'from before', TS)
    const after = new LinkWatch(store.alerts)
    after.record('upper', 0, true, TS)
    expect(detail()).toBe('from before')
    for (let i = 1; i < LINK_CLEAR_RUN; i++) after.record('upper', 0, true, TS)
    expect(detail()).toBeUndefined()
  })

  it('a notice closed by hand doesn\'t come back from the frames that raised it', () => {
    const { store, watch, detail, good, pattern } = rig()
    pattern()
    store.alerts.clear(LINK_ALERT.upper, TS)
    good(1)
    expect(detail()).toBeUndefined()
    // Nor does one more bad frame bring it back: it takes a new pattern.
    watch.record('upper', 1, true, TS)
    expect(detail()).toBeUndefined()
    pattern()
    expect(detail()).toBeDefined()
  })

  it('a failed run is long enough that a single full round of retries isn\'t one', () => {
    expect(LINK_FAILED_RUN).toBeGreaterThan(3)
    expect(LINK_RAISE_AT).toBeGreaterThan(3)
  })

  describe('hub boots', () => {
    it('waits for enough boots to judge, and for a pattern', () => {
      const { watch, detail } = rig()
      watch.recordBoots(null, TS)
      watch.recordBoots({ missing: 4, total: 4 }, TS)
      watch.recordBoots({ missing: 2, total: 10 }, TS)
      expect(detail(HUB_ALERT)).toBeUndefined()
    })

    it('stays closed by hand until another boot changes the record', () => {
      const { store, watch, detail } = rig()
      watch.recordBoots({ missing: 8, total: 10 }, TS)
      store.alerts.clear(HUB_ALERT, TS)
      watch.recordBoots({ missing: 8, total: 10 }, TS)
      expect(detail(HUB_ALERT)).toBeUndefined()
      watch.recordBoots({ missing: 8, total: 10 }, TS)
      expect(detail(HUB_ALERT)).toBeUndefined()
      watch.recordBoots({ missing: 9, total: 10 }, TS)
      expect(detail(HUB_ALERT)).toMatch(/on 9 of the last 10/)
    })

    it('raises on a pattern, holds, and clears with hysteresis', () => {
      const { watch, detail } = rig()
      watch.recordBoots({ missing: 8, total: 10 }, TS)
      expect(detail(HUB_ALERT)).toBe('The cameras\' USB hub didn\'t come up by itself on 8 of the last 10 starts. Reseat its cable.')
      watch.recordBoots({ missing: 2, total: 10 }, TS)
      expect(detail(HUB_ALERT)).toMatch(/on 2 of the last 10/)
      watch.recordBoots({ missing: 1, total: 10 }, TS)
      expect(detail(HUB_ALERT)).toBeUndefined()
    })
  })
})
