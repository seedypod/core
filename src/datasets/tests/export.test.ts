import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../../../server/app'
import { MemorySink } from '../../camera/captures'
import { SimHal } from '../../hardware/sim'
import { createCore } from '../../server/bootstrap'
import { appRouter } from '../../server/routers/app'
import { createCallerFactory } from '../../server/trpc'
import { MemoryStore } from '../../store/memory'
import { jpeg } from '../../vision/tests/fixtures'
import { datasetName, resolveWindow } from '../export'
import { entryChunks, header, tarStream } from '../tar'

const now = new Date('2026-10-31T12:00:00Z')
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function unit() {
  const sink = new MemorySink()
  const store = new MemoryStore()
  const core = createCore({ hal: new SimHal({ tickMs: 0 }), store, version: 'test', sink, now: () => now })
  store.settings.update({ unitName: 'Kitchen Gardyn' })
  for (const [i, ts] of ['2026-09-01T00:00:00Z', '2026-10-20T00:00:00Z', '2026-10-30T00:00:00Z'].entries()) {
    const c = { id: `upper-${i}`, camera: 'upper' as const, ts, path: `upper-${i}.jpg`, bytes: 0 }
    const bytes = jpeg(80, 60, true)
    c.bytes = bytes.byteLength
    store.captures.add(c)
    await sink.put(c.path, bytes)
    core.ctx.analysis.enqueue(c, bytes)
    await core.ctx.analysis.idle()
  }
  store.captures.add({ id: 'demo-svg', camera: 'lower', ts: '2026-10-29T00:00:00Z', path: 'data:image/svg+xml;utf8,<svg/>', bytes: 10 })
  store.telemetry.add([{ ts: '2026-10-25T00:00:00Z', sensor: 'air_temp', value: 22.5 }, { ts: '2026-08-01T00:00:00Z', sensor: 'ph', value: 6 }])
  return core.ctx
}

function untar(bytes: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), 'dataset-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'a.tar'), bytes)
  const r = spawnSync('tar', ['-xf', 'a.tar'], { cwd: dir, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr)
  return dir
}

describe('tar writer', () => {
  it('writes headers the system tar accepts, padded to 512-byte blocks', async () => {
    const chunks = entryChunks({ name: 'x/hello.txt', bytes: new TextEncoder().encode('hi\n'), mtime: 0 })
    expect(chunks.reduce((n, c) => n + c.length, 0) % 512).toBe(0)
    expect(() => header('n'.repeat(101), 0, 0)).toThrow(/over 100 bytes/)
    const stream = tarStream((async function* () {
      yield { name: 'x/hello.txt', bytes: new TextEncoder().encode('hi\n') }
      yield { name: 'x/empty', bytes: new Uint8Array(0) }
    })())
    const dir = untar(new Uint8Array(await new Response(stream).arrayBuffer()))
    expect(readFileSync(join(dir, 'x/hello.txt'), 'utf8')).toBe('hi\n')
    expect(readFileSync(join(dir, 'x/empty'), 'utf8')).toBe('')
  })
})

describe('dataset export', () => {
  it('defaults to the last 30 days and validates the window', () => {
    expect(resolveWindow(now, {})).toEqual({ from: '2026-10-01T12:00:00.000Z', to: '2026-10-31T12:00:00.000Z', images: true })
    expect(() => resolveWindow(now, { from: 'yesterday' })).toThrow(/ISO/)
    expect(() => resolveWindow(now, { from: '2026-10-31T00:00:00Z', to: '2026-10-01T00:00:00Z' })).toThrow(/after/)
    expect(datasetName('Kitchen Gardyn!', resolveWindow(now, {}))).toBe('seedypod-kitchen-gardyn-20261001-20261031')
    expect(datasetName('***', resolveWindow(now, {}))).toBe('seedypod-unit-20261001-20261031')
  })

  it('summarises what an export would contain', async () => {
    const c = createCallerFactory(appRouter)(await unit())
    expect(await c.datasets.summary()).toMatchObject({ captures: 3, analyses: 60, telemetry: 1, images: true })
    expect((await c.datasets.summary({ from: '2026-01-01T00:00:00Z' })).captures).toBe(4)
    await expect(c.datasets.summary({ from: 'nope' })).rejects.toThrow(/ISO/)
  })

  it('streams a tar of manifest, JSONL tables, metadata and stills over HTTP', async () => {
    const { app } = createApp({ ctx: await unit() })
    const res = await app.request('/api/datasets/export')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/x-tar')
    expect(res.headers.get('content-disposition')).toContain('seedypod-kitchen-gardyn-20261001-20261031.tar')
    const root = join(untar(new Uint8Array(await res.arrayBuffer())), 'seedypod-kitchen-gardyn-20261001-20261031')
    expect(readdirSync(root).sort()).toEqual(['README.md', 'analyses.jsonl', 'captures.jsonl', 'grow_cycles.json', 'images', 'manifest.json', 'pods.json', 'telemetry.jsonl'])
    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as Record<string, unknown>
    expect(manifest).toMatchObject({ format: { name: 'seedypod-dataset', version: 1 }, unit: { name: 'Kitchen Gardyn' }, core: 'test', primaryAnalyzer: 'green-threshold', counts: { captures: 3, analyses: 60, telemetry: 1 } })
    const captures = readFileSync(join(root, 'captures.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as { id: string, image: string | null })
    expect(captures.map(c => [c.id, c.image])).toEqual([['upper-1', 'images/upper-1.jpg'], ['demo-svg', null], ['upper-2', 'images/upper-2.jpg']])
    expect(readdirSync(join(root, 'images')).sort()).toEqual(['upper-1.jpg', 'upper-2.jpg'])
    expect(readFileSync(join(root, 'images/upper-1.jpg'))[0]).toBe(0xFF)
    const rows = readFileSync(join(root, 'analyses.jsonl'), 'utf8').trim().split('\n')
    expect(rows).toHaveLength(60)
    expect(JSON.parse(rows[0] ?? '{}')).toMatchObject({ captureId: 'upper-1', source: 'device', metric: 'green_fraction' })
    expect(readFileSync(join(root, 'telemetry.jsonl'), 'utf8')).toContain('"air_temp"')
    expect(JSON.parse(readFileSync(join(root, 'pods.json'), 'utf8'))).toHaveLength(30)
  })

  it('leaves the stills out on request and rejects a bad window', async () => {
    const { app } = createApp({ ctx: await unit() })
    const res = await app.request('/api/datasets/export?images=0&from=2026-01-01T00:00:00Z')
    const dir = untar(new Uint8Array(await res.arrayBuffer()))
    const [root] = readdirSync(dir).filter(d => d.startsWith('seedypod-'))
    expect(readdirSync(join(dir, root ?? ''))).not.toContain('images')
    const captures = readFileSync(join(dir, root ?? '', 'captures.jsonl'), 'utf8')
    expect(captures).toContain('upper-0')
    expect(captures).not.toContain('images/')
    expect((await app.request('/api/datasets/export?from=bad')).status).toBe(400)
  })
})
