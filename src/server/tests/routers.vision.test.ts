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
import { unitFingerprint } from '../../vision/shareCodes'

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

  it('gives every scored pod\'s series from the primary analyser, newest last, up to the limit', async () => {
    const { c } = await scored()
    const all = await c.vision.allPodSeries()
    expect(all.map(s => s.slot)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1))
    expect(all[0]?.points.map(p => p.ts)).toEqual(['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z'])
    expect((await c.vision.allPodSeries({ limit: 2 }))[0]?.points.map(p => p.ts)).toEqual(['2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z'])
    const { c: none } = await scored(0)
    expect(await none.vision.allPodSeries()).toEqual([])
  })

  it('names planted pods the cameras see empty', async () => {
    const { c, ctx } = await scored(0)
    ctx.now = () => new Date('2026-01-02T06:00:00Z')
    ctx.store.pods.update(4, { plant: 'Kale', plantedAt: '2025-12-01', status: 'growing' }, '2025-12-01T00:00:00Z')
    ctx.store.analyses.add([{ captureId: 'upper-1', ts: '2026-01-02T00:00:00Z', camera: 'upper', analyzer: 'pod-state', version: 1, source: 'device', slot: 4, metric: 'pod_state', value: 0, detail: { state: 'empty', confidence: 0.91 }, artifact: null }])
    expect(await c.vision.seenEmpty()).toEqual([{ slot: 4, confidence: 0.91, ts: '2026-01-02T00:00:00Z' }])
    ctx.now = undefined
    expect(await c.vision.seenEmpty()).toEqual([])
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
    // Broken down by how each was saved (#261).
    expect(after.labels).toMatchObject({ sources: { picked: 1, accepted: 0, corrected: 0 }, suggesters: [] })
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
    await expect(c.vision.setRegions({ camera: 'upper', regions: [], removed: [28] })).rejects.toThrow(/pod 28 is not on the upper camera/)
    await c.vision.setRegions({ camera: 'lower', regions: null })
    await c.vision.setRegions({ camera: 'upper', regions: [] })
    expect(ctx.store.settings.get().podRegions).toBeNull()
    expect((await c.vision.regions()).every(r => !r.calibrated)).toBe(true)
  })

  it('removes a box the camera can\'t see its pod in, so the pod isn\'t scored there, and puts it back', async () => {
    const { c, ctx } = await scored(0)
    // A removed box wins over one sent for the same pod.
    const lower = await c.vision.setRegions({ camera: 'lower', regions: [{ slot: 28, x: 0.1, y: 0.1, w: 0.1, h: 0.1 }], removed: [28] })
    expect([lower.calibrated, lower.removed, lower.regions.length]).toEqual([true, [28], 14])
    expect(lower.regions.some(r => r.slot === 28)).toBe(false)
    expect(ctx.store.settings.get().podRegions).toEqual({ lower: { 28: null } })
    expect((await c.vision.regions()).map(r => r.removed)).toEqual([[], [28]])

    const capture = { id: 'lower-x', camera: 'lower' as const, ts: '2026-02-01T00:00:00Z', path: 'lower-x.jpg', bytes: 1 }
    ctx.analysis.enqueue(capture, jpeg(200, 100, true))
    await ctx.analysis.idle()
    const slots = new Set((await c.vision.capture({ captureId: 'lower-x' })).map(r => r.slot))
    expect([slots.has(27), slots.has(28)]).toEqual([true, false])

    await c.vision.setRegions({ camera: 'lower', regions: [] })
    expect(ctx.store.settings.get().podRegions).toBeNull()
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
      { captureId: 'upper-0', ts: '2026-01-01T00:00:00Z', camera: 'upper', slot: 1, label: 'empty', labelledAt: now.toISOString(), plant: null, plantedAt: null, source: 'picked', suggested: null, suggestedBy: null, suggestedConfidence: null },
      { captureId: 'upper-0', ts: '2026-01-01T00:00:00Z', camera: 'upper', slot: 3, label: 'growing', labelledAt: now.toISOString(), plant: null, plantedAt: null, source: 'picked', suggested: null, suggestedBy: null, suggestedConfidence: null },
    ])
    expect(await c.vision.labelStats()).toEqual({
      counts: { empty: 2, seeded: 0, sprouted: 0, growing: 1, ready: 0, unhealthy: 0 },
      pods: 3,
      // Pod 1 on the second photo matched the label it carried from the first.
      sources: { picked: 2, accepted: 1, corrected: 0 },
      suggesters: [{ by: 'carry', accepted: 1, corrected: 0, right: 1 }],
      captures: [{ captureId: 'upper-1', ts: '2026-01-02T00:00:00Z', camera: 'upper', pods: 1 }, { captureId: 'upper-0', ts: '2026-01-01T00:00:00Z', camera: 'upper', pods: 2 }],
    })
    expect((await c.vision.labelStats({ limit: 1 })).captures).toHaveLength(1)

    await c.vision.setLabel({ captureId: 'upper-0', slot: 1, label: null })
    expect((await c.vision.labels({ captureId: 'upper-0' })).map(l => l.slot)).toEqual([3])
    await expect(c.vision.setLabel({ captureId: 'nope', slot: 1, label: 'ready' })).rejects.toThrow(/no capture nope/)
    await expect(c.vision.setLabel({ captureId: 'upper-0', slot: 16, label: 'ready' })).rejects.toThrow(/pod 16 is not on the upper camera/)
  })

  it('scores each analyser against the labels on the same photo and pod', async () => {
    const { c, ctx } = await scored(2)
    expect(await c.vision.agreement()).toEqual({ pods: 0, analyzers: [] })
    const posted = (captureId: string, slot: number, metric: string, value: number, detail: Record<string, unknown> | null = null) => ({ captureId, ts: '2026-01-01T00:00:00Z', camera: 'upper' as const, analyzer: 'leaf-unet', version: 2, source: 'remote' as const, slot, metric, value, detail, artifact: null })
    ctx.store.analyses.add([
      posted('upper-0', 1, 'green_fraction', 0),
      posted('upper-0', 2, 'green_fraction', 0.01),
      posted('upper-1', 1, 'green_fraction', 0.3),
      posted('upper-0', 1, 'pod_state', 0, { state: 'empty', confidence: 0.9 }),
    ])
    await c.vision.setLabel({ captureId: 'upper-0', slot: 1, label: 'seeded' })
    await c.vision.setLabel({ captureId: 'upper-0', slot: 2, label: 'growing' })
    await c.vision.setLabel({ captureId: 'upper-1', slot: 1, label: 'sprouted' })
    await c.vision.setLabel({ captureId: 'upper-1', slot: 2, label: 'unhealthy' })
    const got = await c.vision.agreement()
    expect(got.pods).toBe(4)
    expect(got.analyzers.filter(a => a.analyzer === 'leaf-unet')).toEqual([
      { analyzer: 'leaf-unet', version: 2, metric: 'green_fraction', agree: 2, total: 3 },
      { analyzer: 'leaf-unet', version: 2, metric: 'pod_state', agree: 1, total: 1 },
    ])
    // The unit's own analysers scored every pod on both photos; the unhealthy one isn't counted.
    expect(got.analyzers.filter(a => a.analyzer !== 'leaf-unet').map(a => [a.analyzer, a.total]).sort()).toEqual([['exg-otsu', 3], ['green-threshold', 3]])
  })

  it('suggests each pod\'s label from its last one or a confident pod-state, and records how each was saved (#261)', async () => {
    const { c, ctx } = await scored(3)
    const seen: string[] = []
    ctx.events.subscribe(e => e.kind === 'mutation' && seen.push(e.path))
    const T1 = '2026-01-02T00:00:00Z'
    const state = (slot: number, version: number, detail: Record<string, unknown> | null, metric = 'pod_state') =>
      ctx.store.analyses.add([{ captureId: 'upper-1', ts: T1, camera: 'upper', analyzer: 'pod-state', version, source: 'device', slot, metric, value: 0, detail, artifact: null }])
    const sow = (slot: number, plant: string, plantedAt: string, status: 'seeded' | 'growing') => ctx.store.pods.update(slot, { plant, plantedAt, status }, '2025-12-20T00:00:00Z')
    expect(await c.vision.suggestions({ captureId: 'upper-1' })).toEqual([])

    await c.vision.setLabel({ captureId: 'upper-0', slot: 1, label: 'sprouted' })
    await c.vision.setLabel({ captureId: 'upper-0', slot: 2, label: 'growing' })
    // Only the newest version that scored the photo speaks.
    state(3, 1, { state: 'sprouted', confidence: 0.95 })
    state(2, 2, { state: 'ready', confidence: 0.86 })
    state(3, 2, { state: 'growing', confidence: 0.9 })
    state(4, 2, { state: 'growing', confidence: 0.6 })
    state(5, 2, null)
    state(7, 2, { state: 'ready' })
    state(5, 2, { state: 'ready', confidence: 0.99 }, 'pod_state_confidence')
    sow(6, 'Kale', '2026-01-01', 'seeded')
    state(6, 2, { state: 'empty', confidence: 0.9 })
    expect(await c.vision.suggestions({ captureId: 'upper-1' })).toEqual([
      { slot: 1, label: 'sprouted', by: 'carry', confidence: null, from: '2026-01-01T00:00:00Z' },
      { slot: 2, label: 'ready', by: 'pod-state@2', confidence: 0.86, from: null },
      { slot: 3, label: 'growing', by: 'pod-state@2', confidence: 0.9, from: null },
      { slot: 6, label: 'seeded', by: 'record', confidence: null, from: null },
    ])
    // Looking stores nothing.
    expect(await c.vision.labels({ captureId: 'upper-1' })).toEqual([])

    await c.vision.setLabel({ captureId: 'upper-1', slot: 1, label: 'sprouted' })
    await c.vision.setLabel({ captureId: 'upper-1', slot: 2, label: 'growing' })
    await c.vision.setLabel({ captureId: 'upper-1', slot: 4, label: 'growing' })
    const how = async () => (await c.vision.labels({ captureId: 'upper-1' })).map(l => [l.slot, l.label, l.source, l.suggested, l.suggestedBy, l.suggestedConfidence])
    expect(await how()).toEqual([
      [1, 'sprouted', 'accepted', 'sprouted', 'carry', null],
      [2, 'growing', 'corrected', 'ready', 'pod-state@2', 0.86],
      [4, 'growing', 'picked', null, null, null],
    ])

    // Accept the rest saves only the unlabelled pods that have a suggestion; the others stay untouched.
    seen.length = 0
    expect(await c.vision.acceptSuggestions({ captureId: 'upper-1' })).toEqual({ captureId: 'upper-1', slots: [3, 6] })
    expect(seen).toEqual(['labels'])
    expect(await how()).toEqual([
      [1, 'sprouted', 'accepted', 'sprouted', 'carry', null],
      [2, 'growing', 'corrected', 'ready', 'pod-state@2', 0.86],
      [3, 'growing', 'accepted', 'growing', 'pod-state@2', 0.9],
      [4, 'growing', 'picked', null, null, null],
      [6, 'seeded', 'accepted', 'seeded', 'record', null],
    ])
    expect((await c.vision.labels({ captureId: 'upper-1' })).find(l => l.slot === 6)).toMatchObject({ plant: 'Kale', plantedAt: '2026-01-01' })
    expect(await c.vision.acceptSuggestions({ captureId: 'upper-1' })).toEqual({ captureId: 'upper-1', slots: [] })
    expect(seen).toEqual(['labels'])

    // Only reviewed labels score a suggester.
    expect(await c.vision.labelStats()).toMatchObject({
      sources: { picked: 3, accepted: 3, corrected: 1 },
      suggesters: [{ by: 'carry', accepted: 1, corrected: 0, right: 1 }, { by: 'pod-state@2', accepted: 1, corrected: 1, right: 0.5 }, { by: 'record', accepted: 1, corrected: 0, right: 1 }],
    })

    // A replant stops a label carrying: pod 1 was sown again after its last label.
    sow(1, 'Dill', '2026-01-03', 'seeded')
    expect((await c.vision.suggestions({ captureId: 'upper-2' })).map(s => [s.slot, s.label, s.by])).toEqual([[2, 'growing', 'carry'], [3, 'growing', 'carry'], [4, 'growing', 'carry'], [6, 'seeded', 'carry']])
    await expect(c.vision.suggestions({ captureId: 'nope' })).rejects.toThrow(/no capture nope/)
    await expect(c.vision.acceptSuggestions({ captureId: 'nope' })).rejects.toThrow(/no capture nope/)
  })

  it('dismisses a pod\'s suggestion on one photo, leaves it out of suggestions and Accept the rest, and restores it (#261)', async () => {
    const { c, ctx } = await scored(3)
    const seen: string[] = []
    ctx.events.subscribe(e => e.kind === 'mutation' && seen.push(e.path))
    ctx.now = () => new Date('2026-01-05T08:00:00.000Z')
    for (const slot of [1, 2, 3]) await c.vision.setLabel({ captureId: 'upper-0', slot, label: 'seeded' })
    const slots = async (captureId = 'upper-1') => (await c.vision.suggestions({ captureId })).map(s => s.slot)
    expect(await slots()).toEqual([1, 2, 3])

    seen.length = 0
    expect(await c.vision.dismissSuggestion({ captureId: 'upper-1', slot: 2 })).toEqual({ captureId: 'upper-1', slot: 2, dismissedAt: '2026-01-05T08:00:00.000Z' })
    expect(seen).toEqual(['labels'])
    expect(await slots()).toEqual([1, 3])
    // Only on that photo.
    expect(await slots('upper-2')).toEqual([1, 2, 3])
    expect(await c.vision.dismissals({ captureId: 'upper-1' })).toEqual([{ slot: 2, dismissedAt: '2026-01-05T08:00:00.000Z' }])
    // Dismissing again keeps the first time.
    ctx.now = () => new Date('2026-01-06T00:00:00.000Z')
    expect(await c.vision.dismissSuggestion({ captureId: 'upper-1', slot: 2 })).toMatchObject({ dismissedAt: '2026-01-05T08:00:00.000Z' })

    // A dismissal is not a label: nothing counts it.
    expect(await c.vision.labels({ captureId: 'upper-1' })).toEqual([])
    expect(await c.vision.labelStats()).toMatchObject({ pods: 3, sources: { picked: 3, accepted: 0, corrected: 0 } })
    expect((await c.vision.labelList({ limit: 60 })).labels).toHaveLength(3)

    // The server skips it on Accept the rest, whatever the UI sent.
    expect(await c.vision.acceptSuggestions({ captureId: 'upper-1' })).toEqual({ captureId: 'upper-1', slots: [1, 3] })
    expect((await c.vision.labels({ captureId: 'upper-1' })).map(l => l.slot)).toEqual([1, 3])
    // A label picked on a dismissed pod had no suggestion.
    await c.vision.setLabel({ captureId: 'upper-1', slot: 2, label: 'empty' })
    expect((await c.vision.labels({ captureId: 'upper-1' })).find(l => l.slot === 2)).toMatchObject({ label: 'empty', source: 'picked', suggested: null })
    await c.vision.setLabel({ captureId: 'upper-1', slot: 2, label: null })

    seen.length = 0
    expect(await c.vision.restoreSuggestion({ captureId: 'upper-1', slot: 2 })).toEqual({ captureId: 'upper-1', slot: 2, restored: true })
    expect(seen).toEqual(['labels'])
    expect(await c.vision.dismissals({ captureId: 'upper-1' })).toEqual([])
    expect((await c.vision.suggestions({ captureId: 'upper-1' })).find(s => s.slot === 2)).toMatchObject({ label: 'seeded', by: 'carry' })
    // Restoring one that isn't dismissed changes nothing.
    expect(await c.vision.restoreSuggestion({ captureId: 'upper-1', slot: 2 })).toEqual({ captureId: 'upper-1', slot: 2, restored: false })
    expect(seen).toEqual(['labels'])

    // Without a clock of its own, the unit stamps it now.
    delete ctx.now
    const before = Date.now()
    const { dismissedAt } = await c.vision.dismissSuggestion({ captureId: 'upper-2', slot: 1 })
    expect(Date.parse(dismissedAt)).toBeGreaterThanOrEqual(before)

    await expect(c.vision.dismissSuggestion({ captureId: 'upper-1', slot: 16 })).rejects.toThrow(/pod 16 is not on the upper camera/)
    await expect(c.vision.dismissSuggestion({ captureId: 'nope', slot: 2 })).rejects.toThrow(/no capture nope/)
  })

  it('accepts only the pods Teach shows, and names a box dismissed on photo after photo until it moves', async () => {
    const { c, ctx } = await scored(3)
    ctx.now = () => new Date('2026-01-05T08:00:00.000Z')
    for (const slot of [1, 2, 3]) await c.vision.setLabel({ captureId: 'upper-0', slot, label: 'seeded' })
    expect(await c.vision.acceptSuggestions({ captureId: 'upper-1', slots: [1, 3] })).toEqual({ captureId: 'upper-1', slots: [1, 3] })
    expect((await c.vision.labels({ captureId: 'upper-1' })).map(l => l.slot)).toEqual([1, 3])
    await expect(c.vision.acceptSuggestions({ captureId: 'upper-1', slots: [31] })).rejects.toThrow()

    expect(await c.vision.boxesOff()).toEqual([])
    await c.vision.dismissSuggestion({ captureId: 'upper-1', slot: 2 })
    expect(await c.vision.boxesOff()).toEqual([])
    await c.vision.dismissSuggestion({ captureId: 'upper-2', slot: 2 })
    expect(await c.vision.boxesOff()).toEqual([{ camera: 'upper', slot: 2, photos: 2 }])
    await c.vision.setRegions({ camera: 'upper', regions: [], removed: [2] })
    expect(await c.vision.boxesOff()).toEqual([])
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
    // Whether or not the shipped table knows the code, the guess is the same here.
    expect(got.pods).toMatchObject([{ slot: 6, camera: 'upper', code: 'oo||', confidence: 0.9, ts: '2026-11-11T21:00:00.000Z', confirmed: null, recorded: 'Green Bok Choy', guess: 'Green Bok Choy', disagrees: false }])
    // No capture was added, and nothing was confirmed by reading.
    expect(await c.camera.list({ limit: 10 })).toEqual([])
    expect(ctx.store.podCodes.pairs()).toEqual([])
  })

  it('builds the Share pod codes link from the catalog pairs, for the browser to open (#259)', async () => {
    const { c, ctx } = codesCore(async () => answer([{ slot: 6, code: 'oo||' }, { slot: 7, code: 'o|hh' }, { slot: 8, code: null }]))
    expect(await c.vision.podCodeShare()).toEqual({ url: null, pairs: [], skipped: [], crops: [] })
    await c.vision.readPodCodes()
    ctx.store.podCodes.confirm('oo||', 'green bok choy', 't')
    ctx.store.podCodes.confirm('o|hh', 'Genovese Basil', 't')
    const got = await c.vision.podCodeShare()
    expect(got.pairs).toEqual([{ code: 'oo||', plant: 'Green Bok Choy' }])
    expect(got.skipped).toEqual([{ code: 'o|hh', plant: 'Genovese Basil' }])
    expect(got.crops).toEqual([{ slot: 6, code: 'oo||', plant: 'Green Bok Choy' }])
    const q = new URL(got.url as string).searchParams
    expect(q.get('pairs')).toBe('oo|| → Green Bok Choy')
    expect(q.get('version')).toBe('test')
    expect(q.get('fingerprint')).toBe(await unitFingerprint(ctx.hal.snapshot().system?.unitId as string))
    // Without a unit id there is no fingerprint, and nothing else stands in for it.
    const snapshot = ctx.hal.snapshot.bind(ctx.hal)
    ctx.hal.snapshot = () => ({ ...snapshot(), system: null })
    expect(new URL((await c.vision.podCodeShare()).url as string).searchParams.has('fingerprint')).toBe(false)
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
