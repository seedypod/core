import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { MemorySink } from '../../camera/captures'
import { SimHal } from '../../hardware/sim'
import { createMcpServer } from '../../mcp/server'
import { MemoryStore } from '../../store/memory'
import { jpeg } from '../../vision/tests/fixtures'
import { createCore } from '../bootstrap'
import { appRouter } from '../routers/app'
import { createCallerFactory } from '../trpc'
import { DEFAULT_REGIONS } from '../../vision/regions'
import type { CodeReader } from '../../vision/podCodes'

async function scored(n = 3) {
  const sink = new MemorySink()
  const core = createCore({ hal: new SimHal({ tickMs: 0 }), store: new MemoryStore(), version: 'test', sink })
  const { ctx } = core
  for (let i = 0; i < n; i++) {
    const c = { id: `upper-${i}`, camera: 'upper' as const, ts: `2026-01-0${i + 1}T00:00:00Z`, path: `upper-${i}.jpg`, bytes: 1 }
    const bytes = jpeg(120, 100, true)
    ctx.store.captures.add(c)
    await sink.put(c.path, bytes)
    ctx.analysis.enqueue(c, bytes)
    await ctx.analysis.idle()
  }
  return { ctx, sink, c: createCallerFactory(appRouter)(ctx) }
}

describe('vision router (ADR-0019)', () => {
  it('lists analysers with totals and which one is primary', async () => {
    const { c } = await scored()
    const list = await c.vision.analyzers()
    expect(list.map(a => a.id)).toEqual(['green-threshold', 'exg-otsu'])
    expect(list[0]).toMatchObject({ primary: true, source: 'device', captures: 3, rows: 45 })
    expect(await c.vision.status()).toMatchObject({ running: null, failed: 0 })
  })

  it('compares one pod across analysers and shows every result for a capture', async () => {
    const { c } = await scored()
    const cmp = await c.vision.compare({ slot: 1, metric: 'green_fraction', limit: 200 })
    expect(cmp.map(s => s.analyzer).sort()).toEqual(['exg-otsu', 'green-threshold'])
    expect(cmp.every(s => s.points.length === 3)).toBe(true)
    expect(await c.vision.compare({ slot: 1, metric: 'leaf_count', limit: 200 })).toEqual([])
    const one = await c.vision.capture({ captureId: 'upper-0' })
    expect(one).toHaveLength(30)
    expect(one.find(r => r.analyzer === 'exg-otsu')?.detail).toHaveProperty('threshold')
  })

  it('switches the primary analyser behind pod trends and refuses unknown ones', async () => {
    const { c } = await scored()
    expect((await c.vision.podTrends())[0]?.samples).toBe(3)
    await expect(c.vision.setPrimary({ analyzer: 'nope' })).rejects.toThrow(/no analyser nope/)
    await c.vision.setPrimary({ analyzer: 'exg-otsu' })
    expect((await c.settings.get()).primaryAnalyzer).toBe('exg-otsu')
    expect((await c.vision.analyzers()).find(a => a.primary)?.id).toBe('exg-otsu')
    expect((await c.vision.podSeries({ slot: 1 }))).toHaveLength(3)
    expect((await c.vision.podTrends({ analyzer: 'green-threshold' }))[0]?.samples).toBe(3)
  })

  it('re-runs an analyser in the background and refuses remote ones', async () => {
    const { ctx, c } = await scored()
    expect(await c.vision.rerun({ analyzer: 'exg-otsu', limit: 10 })).toEqual({ captures: 3 })
    await ctx.analysis.idle()
    await expect(c.vision.rerun({ analyzer: 'leaf-unet', limit: 10 })).rejects.toThrow(/not an on-device analyser/)
  })

  it('keeps ingest and mirror secrets out of settings responses', async () => {
    const { c } = await scored(0)
    const s = await c.settings.update({ analysisIngestToken: 'tok', mirrorSecretAccessKey: 'shh', mirrorEndpoint: 'https://s3.example.com', mirrorBucket: 'pods', mirrorAccessKeyId: 'AK' })
    expect(s).not.toHaveProperty('analysisIngestToken')
    expect(s).not.toHaveProperty('mirrorSecretAccessKey')
    expect(s).toMatchObject({ hasAnalysisIngestToken: true, hasMirrorSecret: true, mirrorBucket: 'pods', mirrorAccessKeyId: 'AK' })
  })

  it('MCP list_analyses reports analysers, queue and an optional per-pod comparison', async () => {
    const { ctx } = await scored(2)
    const server = createMcpServer(ctx)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(b)
    const plain = await client.callTool({ name: 'list_analyses', arguments: {} })
    const body = JSON.parse((plain.content as Array<{ text: string }>)[0]?.text ?? '{}') as { analyzers: unknown[], status: unknown, compare?: unknown }
    expect(body.analyzers).toHaveLength(2)
    expect(body.compare).toBeUndefined()
    const withSlot = await client.callTool({ name: 'list_analyses', arguments: { slot: 1 } })
    const cmp = JSON.parse((withSlot.content as Array<{ text: string }>)[0]?.text ?? '{}') as { compare: Array<{ points: unknown[] }> }
    expect(cmp.compare).toHaveLength(2)
    expect(cmp.compare[0]?.points).toHaveLength(2)
    expect(body).toMatchObject({ labels: { pods: 0, captures: [] } })
    ctx.store.podLabels.set({ captureId: 'upper-1', ts: '2026-01-02T00:00:00Z', camera: 'upper', slot: 2, label: 'sprouted', labelledAt: '2026-01-03T00:00:00Z', plant: null, plantedAt: null })
    const labelled = await client.callTool({ name: 'list_analyses', arguments: {} })
    const after = JSON.parse((labelled.content as Array<{ text: string }>)[0]?.text ?? '{}') as { labels: { counts: Record<string, number>, captures: unknown[] } }
    expect(after.labels.counts.sprouted).toBe(1)
    expect(after.labels.captures).toEqual([{ captureId: 'upper-1', ts: '2026-01-02T00:00:00Z', camera: 'upper', pods: 1 }])
    await client.close()
  })

  it('calibrates one camera\'s pod boxes, keeping only the moved ones, and resets them', async () => {
    const { c, ctx } = await scored(0)
    const seen: string[] = []
    ctx.events.subscribe(e => e.kind === 'mutation' && seen.push(e.path))
    const before = await c.vision.regions()
    expect(before.map(r => [r.camera, r.calibrated, r.regions.length])).toEqual([['upper', false, 15], ['lower', false, 15]])
    expect(before[0]?.regions[0]).toEqual({ slot: 1, ...DEFAULT_REGIONS.upper[1], moved: false })

    // Pod 16 moves (and is pulled back inside the frame); pod 17 is sent back unchanged.
    const lower = await c.vision.setRegions({ camera: 'lower', regions: [{ slot: 16, x: 0.95, y: 0.5, w: 0.2, h: 0.1 }, { slot: 17, ...DEFAULT_REGIONS.lower[17] as { x: number, y: number, w: number, h: number } }] })
    expect(lower.calibrated).toBe(true)
    expect(lower.regions.filter(r => r.moved).map(r => r.slot)).toEqual([16])
    expect(lower.regions[0]).toMatchObject({ x: 0.8, y: 0.5, w: 0.2, h: 0.1 })
    expect(ctx.store.settings.get().podRegions).toEqual({ lower: { 16: { x: 0.8, y: 0.5, w: 0.2, h: 0.1 } } })
    expect(seen).toContain('regions')
    await c.vision.setRegions({ camera: 'upper', regions: [{ slot: 1, x: 0.1, y: 0.1, w: 0.1, h: 0.1 }] })
    expect(Object.keys(ctx.store.settings.get().podRegions ?? {})).toEqual(['lower', 'upper'])

    // New stills are scored on the calibrated boxes.
    const capture = { id: 'upper-x', camera: 'upper' as const, ts: '2026-02-01T00:00:00Z', path: 'upper-x.jpg', bytes: 1 }
    ctx.analysis.enqueue(capture, jpeg(200, 100, true))
    await ctx.analysis.idle()
    expect((await c.vision.capture({ captureId: 'upper-x' })).find(r => r.slot === 1 && r.analyzer === 'green-threshold')?.value).toBe(1)

    await expect(c.vision.setRegions({ camera: 'upper', regions: [{ slot: 16, x: 0, y: 0, w: 0.1, h: 0.1 }] })).rejects.toThrow(/pod 16 is not on the upper camera/)
    await c.vision.setRegions({ camera: 'lower', regions: null })
    await c.vision.setRegions({ camera: 'upper', regions: [] })
    expect(ctx.store.settings.get().podRegions).toBeNull()
    expect((await c.vision.regions()).every(r => !r.calibrated)).toBe(true)
  })

  it('labels pods in a capture for training, relabels, clears and counts them', async () => {
    const now = new Date('2026-03-01T00:00:00Z')
    const { c, ctx } = await scored(2)
    ctx.now = () => now
    const seen: string[] = []
    ctx.events.subscribe(e => e.kind === 'mutation' && seen.push(e.path))
    expect(await c.vision.labels({ captureId: 'upper-0' })).toEqual([])

    expect(await c.vision.setLabel({ captureId: 'upper-0', slot: 3, label: 'sprouted' })).toEqual({ captureId: 'upper-0', slot: 3, label: 'sprouted' })
    await c.vision.setLabel({ captureId: 'upper-0', slot: 1, label: 'empty' })
    await c.vision.setLabel({ captureId: 'upper-1', slot: 1, label: 'empty' })
    // Changing a label later replaces it.
    await c.vision.setLabel({ captureId: 'upper-0', slot: 3, label: 'growing' })
    expect(seen.filter(p => p === 'labels')).toHaveLength(4)
    expect(await c.vision.labels({ captureId: 'upper-0' })).toEqual([
      { captureId: 'upper-0', ts: '2026-01-01T00:00:00Z', camera: 'upper', slot: 1, label: 'empty', labelledAt: now.toISOString(), plant: null, plantedAt: null },
      { captureId: 'upper-0', ts: '2026-01-01T00:00:00Z', camera: 'upper', slot: 3, label: 'growing', labelledAt: now.toISOString(), plant: null, plantedAt: null },
    ])
    expect(await c.vision.labelStats()).toEqual({
      counts: { empty: 2, seeded: 0, sprouted: 0, growing: 1, ready: 0, unhealthy: 0 },
      pods: 3,
      captures: [{ captureId: 'upper-1', ts: '2026-01-02T00:00:00Z', camera: 'upper', pods: 1 }, { captureId: 'upper-0', ts: '2026-01-01T00:00:00Z', camera: 'upper', pods: 2 }],
    })
    expect((await c.vision.labelStats({ limit: 1 })).captures).toHaveLength(1)

    await c.vision.setLabel({ captureId: 'upper-0', slot: 1, label: null })
    expect((await c.vision.labels({ captureId: 'upper-0' })).map(l => l.slot)).toEqual([3])
    await expect(c.vision.setLabel({ captureId: 'nope', slot: 1, label: 'ready' })).rejects.toThrow(/no capture nope/)
    await expect(c.vision.setLabel({ captureId: 'upper-0', slot: 16, label: 'ready' })).rejects.toThrow(/pod 16 is not on the upper camera/)
  })

  it('keeps a sown pod\'s plant with each label, but not a planned one or one sown after the photo\'s day', async () => {
    const { c, ctx } = await scored(2)
    const sow = (slot: number, plant: string, plantedAt: string | null, status: 'empty' | 'seeded' | 'growing') => ctx.store.pods.update(slot, { plant, plantedAt, status }, '2025-12-20T00:00:00Z')
    sow(3, 'Basil', '2025-12-20', 'growing')
    sow(4, 'Kale', '2026-01-02', 'seeded')
    // Planned by the planner, not sown: a plant but no date, or a date on a pod still empty.
    sow(5, 'Mint', null, 'seeded')
    sow(6, 'Thyme', '2025-12-25', 'empty')
    for (const slot of [3, 4, 5, 6, 7]) await c.vision.setLabel({ captureId: 'upper-0', slot, label: 'seeded' })
    await c.vision.setLabel({ captureId: 'upper-1', slot: 4, label: 'seeded' })
    expect((await c.vision.labels({ captureId: 'upper-0' })).map(l => [l.slot, l.plant, l.plantedAt])).toEqual([[3, 'Basil', '2025-12-20'], [4, null, null], [5, null, null], [6, null, null], [7, null, null]])
    // Sown the day the photo was taken counts as in it.
    expect(await c.vision.labels({ captureId: 'upper-1' })).toMatchObject([{ slot: 4, plant: 'Kale', plantedAt: '2026-01-02' }])
    // The photo's day is the unit's: 00:00 UTC on the 2nd is still the 1st in Los Angeles.
    ctx.store.settings.update({ timezone: 'America/Los_Angeles' })
    await c.vision.setLabel({ captureId: 'upper-1', slot: 4, label: null })
    await c.vision.setLabel({ captureId: 'upper-1', slot: 4, label: 'seeded' })
    expect(await c.vision.labels({ captureId: 'upper-1' })).toMatchObject([{ slot: 4, plant: null, plantedAt: null }])
    ctx.store.settings.update({ timezone: 'UTC' })
    await c.vision.setLabel({ captureId: 'upper-1', slot: 4, label: 'growing' })
    // A replant later doesn't rewrite what was in the photo.
    sow(3, 'Dill', '2026-02-01', 'seeded')
    await c.vision.setLabel({ captureId: 'upper-0', slot: 3, label: 'sprouted' })
    const { labels } = await c.vision.labelList({ camera: 'upper', limit: 10 })
    expect(labels.find(l => l.captureId === 'upper-0' && l.slot === 3)).toMatchObject({ label: 'sprouted', plant: 'Basil', daysSinceSowing: 12, url: '/api/captures/upper-0.jpg' })
    expect(labels.find(l => l.captureId === 'upper-1' && l.slot === 4)).toMatchObject({ plant: 'Kale', daysSinceSowing: 0 })
    expect(labels.find(l => l.slot === 5)?.daysSinceSowing).toBeNull()
  })

  it('lists every label newest first, filtered by label and camera, a page at a time', async () => {
    const { c, ctx } = await scored(3)
    ctx.store.captures.add({ id: 'lower-0', camera: 'lower', ts: '2026-01-02T00:00:00Z', path: 'data:image/svg+xml;utf8,<svg/>', bytes: 1 })
    await c.vision.setLabel({ captureId: 'upper-0', slot: 1, label: 'empty' })
    await c.vision.setLabel({ captureId: 'upper-2', slot: 2, label: 'seeded' })
    await c.vision.setLabel({ captureId: 'upper-2', slot: 1, label: 'seeded' })
    await c.vision.setLabel({ captureId: 'lower-0', slot: 20, label: 'seeded' })
    // A label outlives its photo.
    ctx.store.podLabels.set({ captureId: 'upper-gone', ts: '2025-12-01T00:00:00Z', camera: 'upper', slot: 7, label: 'ready', labelledAt: '2026-01-05T00:00:00Z', plant: null, plantedAt: null })
    const key = (r: { labels: Array<{ captureId: string, slot: number }> }) => r.labels.map(l => `${l.captureId}:${l.slot}`)

    const all = await c.vision.labelList({ limit: 60 })
    expect(key(all)).toEqual(['upper-2:1', 'upper-2:2', 'lower-0:20', 'upper-0:1', 'upper-gone:7'])
    expect(all.next).toBeNull()
    expect(all.labels.map(l => l.url)).toEqual(['/api/captures/upper-2.jpg', '/api/captures/upper-2.jpg', 'data:image/svg+xml;utf8,<svg/>', '/api/captures/upper-0.jpg', null])
    expect(key(await c.vision.labelList({ label: 'seeded', limit: 60 }))).toEqual(['upper-2:1', 'upper-2:2', 'lower-0:20'])
    expect(key(await c.vision.labelList({ label: 'seeded', camera: 'lower', limit: 60 }))).toEqual(['lower-0:20'])

    const one = await c.vision.labelList({ limit: 2 })
    expect(key(one)).toEqual(['upper-2:1', 'upper-2:2'])
    expect(one.next).toBe('2026-01-03T00:00:00Z|upper-2|2')
    const two = await c.vision.labelList({ limit: 2, cursor: one.next as string })
    expect(key(two)).toEqual(['lower-0:20', 'upper-0:1'])
    const three = await c.vision.labelList({ limit: 2, cursor: two.next as string })
    expect(key(three)).toEqual(['upper-gone:7'])
    expect(three.next).toBeNull()
    // A full last page says there is no more.
    expect((await c.vision.labelList({ limit: 5 })).next).toBeNull()
    await expect(c.vision.labelList({ limit: 2, cursor: 'nonsense' })).rejects.toThrow(/bad cursor/)
    await expect(c.vision.labelList({ limit: 2, cursor: '2026-01-01|x|y' })).rejects.toThrow(/bad cursor/)

    // A pruned photo's label can still be changed, and removed.
    await c.vision.setLabel({ captureId: 'upper-gone', slot: 7, label: 'unhealthy' })
    expect(await c.vision.labels({ captureId: 'upper-gone' })).toMatchObject([{ slot: 7, label: 'unhealthy', ts: '2025-12-01T00:00:00Z', camera: 'upper' }])
    await expect(c.vision.setLabel({ captureId: 'upper-gone', slot: 20, label: 'ready' })).rejects.toThrow(/pod 20 is not on the upper camera/)
    await c.vision.setLabel({ captureId: 'upper-gone', slot: 7, label: null })
    await expect(c.vision.setLabel({ captureId: 'upper-gone', slot: 7, label: 'ready' })).rejects.toThrow(/no capture upper-gone/)
  })
})

describe('pod codes (#224)', () => {
  function codesCore(reader: CodeReader | null) {
    const events: string[] = []
    const core = createCore({ hal: new SimHal({ tickMs: 0 }), store: new MemoryStore(), version: 'test', captureMinBytes: 1, codeReader: reader, now: () => new Date('2026-11-11T21:00:00.000Z') })
    core.ctx.events.subscribe(e => void (e.kind === 'mutation' && events.push(e.path)))
    return { ctx: core.ctx, events, c: createCallerFactory(appRouter)(core.ctx) }
  }
  const answer = (pods: Array<{ slot: number, code: string | null }>) => ({ width: 2592, height: 1944, brightness: 0.4, damaged: false, pods: pods.map(p => ({ ...p, confidence: p.code ? 0.9 : 0.1, dots: [] })), ms: { decode: 1, read: 1 } })

  it('reads on demand, then shows only the pods a code was read under', async () => {
    const { c, ctx, events } = codesCore(async (_b, regions) => (regions[6] ? answer([{ slot: 6, code: 'oo||' }, { slot: 9, code: null }]) : answer([])))
    ctx.store.pods.update(6, { plant: 'Green Bok Choy', plantedAt: '2026-11-01', status: 'growing' }, 't')
    expect(await c.vision.podCodes()).toEqual({ available: true, pods: [], pairs: [] })
    expect(await c.vision.readPodCodes()).toEqual([
      { camera: 'upper', ts: '2026-11-11T21:00:00.000Z', read: 1, error: null },
      { camera: 'lower', ts: '2026-11-11T21:00:00.000Z', read: 0, error: null },
    ])
    expect(events).toContain('podCodes')
    const got = await c.vision.podCodes()
    expect(got.pods).toEqual([{ slot: 6, camera: 'upper', code: 'oo||', confidence: 0.9, ts: '2026-11-11T21:00:00.000Z', confirmed: null, recorded: 'Green Bok Choy' }])
    // No capture was added, and nothing was confirmed by reading.
    expect(await c.camera.list({ limit: 10 })).toEqual([])
    expect(ctx.store.podCodes.pairs()).toEqual([])
  })

  it('confirms and corrects a pair without touching the pod records', async () => {
    const { c, ctx } = codesCore(async () => answer([{ slot: 6, code: 'oo||' }]))
    ctx.store.pods.update(6, { plant: 'Basil', plantedAt: '2026-11-01', status: 'growing' }, 't')
    const before = ctx.store.pods.list()
    expect(await c.vision.confirmPodCode({ code: 'oo||', plant: 'Basil' })).toEqual({ code: 'oo||', plant: 'Basil', confirmedAt: '2026-11-11T21:00:00.000Z' })
    expect(await c.vision.confirmPodCode({ code: 'oo||', plant: ' Green Bok Choy ' })).toMatchObject({ plant: 'Green Bok Choy' })
    expect((await c.vision.podCodes()).pairs).toEqual([{ code: 'oo||', plant: 'Green Bok Choy', confirmedAt: '2026-11-11T21:00:00.000Z' }])
    expect(ctx.store.pods.list()).toEqual(before)
    expect(await c.vision.forgetPodCode({ code: 'oo||' })).toEqual({ forgotten: true })
    expect(await c.vision.forgetPodCode({ code: 'oo||' })).toEqual({ forgotten: false })
    await expect(c.vision.confirmPodCode({ code: 'xx', plant: 'Basil' })).rejects.toThrow(/four of/)
    await expect(c.vision.confirmPodCode({ code: 'oooo', plant: '  ' })).rejects.toThrow()
  })

  it('says when podvision isn\'t there to read', async () => {
    const { c } = codesCore(null)
    expect((await c.vision.podCodes()).available).toBe(false)
    await expect(c.vision.readPodCodes()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
})

describe('pods out of order (#224)', () => {
  function swapped() {
    const core = createCore({ hal: new SimHal({ tickMs: 0 }), store: new MemoryStore(), version: 'test', now: () => new Date('2026-11-11T21:00:00.000Z') })
    const { store } = core.ctx
    // Basil and Thyme were swapped by hand: the codes say so, the records and the plan don't.
    store.pods.update(2, { plant: 'Thyme', plantedAt: '2026-11-01', status: 'growing', notes: 'thyme notes' }, 't')
    store.pods.update(7, { plant: 'Basil', plantedAt: '2026-11-05', status: 'seeded', notes: 'basil notes' }, 't')
    store.podCodes.confirm('oo||', 'Basil', 't')
    store.podCodes.confirm('o|hh', 'Thyme', 't')
    store.podCodes.setReads('upper', [{ slot: 2, camera: 'upper', code: 'oo||', confidence: 0.9, ts: 't' }, { slot: 7, camera: 'upper', code: 'o|hh', confidence: 0.9, ts: 't' }, { slot: 9, camera: 'upper', code: null, confidence: 0.1, ts: 't' }])
    const events: string[] = []
    core.ctx.events.subscribe(e => void (e.kind === 'mutation' && events.push(e.path)))
    return { store, events, c: createCallerFactory(appRouter)(core.ctx) }
  }

  it('says which pods and both fixes, and changes nothing by looking', async () => {
    const { c, store } = swapped()
    const before = store.pods.list()
    const o = await c.vision.podOrder()
    expect(o).toMatchObject({
      slots: [{ slot: 2, tower: 'Basil', record: 'Thyme', plan: null }, { slot: 7, tower: 'Thyme', record: 'Basil', plan: null }],
      recordSwaps: [[2, 7]],
      moves: [],
      plan: null,
    })
    expect(store.pods.list()).toEqual(before)
  })

  it('updates the records to match the tower only when asked, keeping each plant\'s sowing date and status', async () => {
    const { c, store, events } = swapped()
    const o = await c.vision.podOrder()
    expect(await c.vision.fixPodOrder({ key: o?.key as string })).toEqual({ swapped: [[2, 7]], unresolved: [] })
    const pods = store.pods.list()
    expect(pods[1]).toMatchObject({ slot: 2, plant: 'Basil', plantedAt: '2026-11-05', status: 'seeded', notes: 'basil notes' })
    expect(pods[6]).toMatchObject({ slot: 7, plant: 'Thyme', plantedAt: '2026-11-01', status: 'growing', notes: 'thyme notes' })
    expect(events).toContain('pods')
    expect(await c.vision.podOrder()).toBeNull()
    // Nothing left to fix, or a fix for something no longer shown, is refused.
    await expect(c.vision.fixPodOrder({ key: o?.key as string })).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('refuses a fix for a mismatch that changed since it was shown', async () => {
    const { c, store } = swapped()
    const o = await c.vision.podOrder()
    store.pods.update(7, { plant: 'Mint' }, 't')
    await expect(c.vision.fixPodOrder({ key: o?.key as string })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(store.pods.list()[1]?.plant).toBe('Thyme')
  })
})
