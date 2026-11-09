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
})
