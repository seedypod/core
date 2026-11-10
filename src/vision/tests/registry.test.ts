import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../../server/app'
import { SimHal } from '../../hardware/sim'
import { createMcpServer } from '../../mcp/server'
import { createCore } from '../../server/bootstrap'
import { appRouter } from '../../server/routers/app'
import { createCallerFactory } from '../../server/trpc'
import { MemoryStore } from '../../store/memory'
import { deviceAnalyzers, installLearned } from '../analyzer'
import { ingestResults } from '../ingest'
import { fetchLanModel, isLanAddress } from '../modelFetch'
import { FsModelFiles, sha256 } from '../modelFiles'
import { learnedAnalyzers, type LearnedSpec } from '../podState'
import { MAX_MODEL_BYTES, ModelRefused, ModelRegistry, type ModelFiles, type RegistryState } from '../registry'
import parity from './parity/pod-state-parity.json'

const shippedText = readFileSync(new URL('../../../models/pod-state.json', import.meta.url), 'utf8')
/** A different model: the parity fixture's seeded weights, under a revision name. */
const model = (revision: string, version = 2) => JSON.stringify({ ...parity.model, revision, version })

class MemFiles implements ModelFiles {
  files = new Map<string, string>()
  state: RegistryState | null = null
  constructor(private readonly ship: string | null = shippedText) {}
  shipped = () => (this.ship === null ? { text: null, missing: 'No weights file at models/pod-state.json, so this analyser is off.' } : { text: this.ship })
  list = () => [...this.files.keys()]
  read = (s: string) => this.files.get(s) ?? null
  write = (s: string, t: string) => void this.files.set(s, t)
  remove = (s: string) => void this.files.delete(s)
  readState = () => (this.state ? structuredClone(this.state) : null)
  writeState = (st: RegistryState) => void (this.state = structuredClone(st))
}

function registry(ship: string | null = shippedText) {
  const files = new MemFiles(ship)
  const changes: LearnedSpec[][] = []
  let t = 0
  const r = new ModelRegistry({ files, sha256, now: () => new Date(Date.UTC(2026, 10, 10, 0, 0, t++)), onChange: s => changes.push(s) })
  return { r, files, changes }
}

const refused = (f: () => unknown, status: number, msg: RegExp) => {
  try {
    f()
  }
  catch (e) {
    expect(e).toBeInstanceOf(ModelRefused)
    expect((e as ModelRefused).status).toBe(status)
    expect((e as Error).message).toMatch(msg)
    return
  }
  throw new Error('expected a refusal')
}

afterEach(() => installLearned([]))

describe('model registry', () => {
  it('starts with the shipped model running as pod-state, primary', () => {
    const { r } = registry()
    const [shipped] = r.list()
    expect(shipped).toMatchObject({ id: sha256(shippedText).slice(0, 12), source: 'shipped', analyzer: 'pod-state', version: 1, revision: 'bootstrap-2026-11', enabled: true, primary: true })
    expect(r.specs()).toEqual([{ id: 'pod-state', label: 'Pod state (learned)', text: shippedText }])
    expect(r.events()).toEqual([])
  })

  it('says where each running file is on disk, for podvision (#191), when the files have paths', () => {
    const { r, files } = registry()
    files.shipped = () => ({ text: shippedText, path: '/opt/seedypod/models/pod-state.json' })
    const paths = files as MemFiles & { path?: (sha: string) => string }
    const text = model('On disk')
    const id = r.upload(text, sha256(text), { enable: true }).id
    expect(r.specs().map(s => s.path)).toEqual(['/opt/seedypod/models/pod-state.json', undefined])
    paths.path = sha => `/data/models/${sha}.json`
    expect(r.specs().find(s => s.id === 'pod-state-on-disk')?.path).toBe(`/data/models/${sha256(text)}.json`)
    expect(id).toBe(sha256(text).slice(0, 12))
  })

  it('stores an upload disabled, bound by its hash, and runs it as its own analyser once enabled', () => {
    const { r, files, changes } = registry()
    const text = model('My model 2026-12')
    const up = r.upload(text, sha256(text).toUpperCase())
    expect(up).toMatchObject({ id: sha256(text).slice(0, 12), source: 'uploaded', analyzer: 'pod-state-my-model-2026-12', version: 2, enabled: false, primary: false, uploadedAt: '2026-11-10T00:00:00.000Z', bytes: text.length })
    expect(files.files.get(sha256(text))).toBe(text)
    // The same file again is the same revision.
    expect(r.upload(text, sha256(text)).id).toBe(up.id)
    expect(r.set(up.id, { enabled: true }).enabled).toBe(true)
    expect(changes.at(-1)?.map(s => s.id)).toEqual(['pod-state', 'pod-state-my-model-2026-12'])
    installLearned(learnedAnalyzers(r.specs()))
    expect(deviceAnalyzers().map(a => `${a.id}@${a.version}`)).toEqual(['green-threshold@2', 'exg-otsu@2', 'pod-state@1', 'pod-state-my-model-2026-12@2'])
    expect(r.events().map(e => e.action)).toEqual(['enable', 'upload'])
  })

  it('refuses bad uploads with a clear reason, before anything is stored', () => {
    const { r, files } = registry()
    const text = model('x')
    refused(() => r.upload(text, 'abc'), 400, /64 hex/)
    refused(() => r.upload(text, sha256('other')), 400, /sha256 mismatch/)
    refused(() => r.upload('{"format":"onnx"}', sha256('{"format":"onnx"}')), 400, /invalid weights file: not a seedypod-cnn/)
    refused(() => r.upload('nope', sha256('nope')), 400, /not JSON/)
    const wrongClasses = JSON.stringify({ ...parity.model, classes: ['a', 'b', 'c', 'd', 'e'] })
    refused(() => r.upload(wrongClasses, sha256(wrongClasses)), 400, /classes must be/)
    const big = ' '.repeat(MAX_MODEL_BYTES + 1)
    refused(() => r.upload(big, sha256(big)), 400, /limit is 2000000/)
    r.upload(text, sha256(text))
    const clash = model('X', 3)
    refused(() => r.upload(clash, sha256(clash)), 409, /already runs as pod-state-x/)
    expect(files.files.size).toBe(1)
  })

  it('makes a revision primary, refuses to disable or delete the primary, and deletes uploads', () => {
    const { r, files } = registry()
    const text = model('candidate')
    const { id } = r.upload(text, sha256(text))
    const shipped = r.list()[0]?.id as string
    expect(r.set(id, { primary: true })).toMatchObject({ enabled: true, primary: true })
    expect(r.get(shipped).primary).toBe(false)
    refused(() => r.set(id, { enabled: false }), 409, /primary/)
    refused(() => r.set(id, { primary: false }), 400, /another revision primary/)
    refused(() => r.remove(id), 409, /primary/)
    refused(() => r.remove(shipped), 409, /can't be deleted/)
    refused(() => r.get('nope'), 404, /no model revision/)
    r.set(shipped, { primary: true })
    r.remove(id)
    expect(files.files.size).toBe(0)
    expect(r.list().map(x => x.id)).toEqual([shipped])
  })

  it('resets to the shipped model and rolls back one change at a time', () => {
    const { r } = registry()
    const a = model('a')
    const b = model('b')
    const A = r.upload(a, sha256(a), { enable: true }).id
    const B = r.upload(b, sha256(b)).id
    const shipped = r.list()[0]?.id as string
    r.set(B, { primary: true })
    expect(r.reset()).toEqual({ enabled: [shipped], primary: shipped })
    expect(r.list().filter(x => x.enabled).map(x => x.id)).toEqual([shipped])
    // Undo the reset, then the primary change; uploads aren't undone.
    expect(r.rollback()).toMatchObject({ action: 'rollback', after: { enabled: [shipped, A, B], primary: B } })
    expect(r.rollback().after).toEqual({ enabled: [shipped, A], primary: shipped })
    refused(() => r.rollback(), 409, /nothing to roll back/)
    expect(r.events(3).map(e => [e.action, e.rolledBack])).toEqual([['rollback', false], ['rollback', false], ['reset', true]])
  })

  it('lists the shipped model as off when the release has no file, and can\'t enable it', () => {
    const { r } = registry(null)
    const [shipped] = r.list()
    expect(shipped).toMatchObject({ id: 'shipped', enabled: false, primary: false, disabled: expect.stringMatching(/No weights file/) })
    expect(r.specs()).toEqual([{ id: 'pod-state', label: 'Pod state (learned)', text: null, missing: shipped?.disabled }])
    refused(() => r.set('shipped', { enabled: true }), 409, /can't run/)
  })

  it('keeps a broken upload listed but off', () => {
    const { r, files } = registry()
    files.files.set('a'.repeat(64), '{')
    expect(r.list()[1]).toMatchObject({ id: 'aaaaaaaaaaaa', enabled: false, disabled: expect.stringMatching(/could not be loaded/) })
  })
})

describe('model files on disk', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  it('keeps uploads and the registry state under the data folder, and survives a hand-broken state', () => {
    dir = mkdtempSync(join(tmpdir(), 'models-'))
    const files = new FsModelFiles(join(dir, 'models'), () => ({ text: shippedText }))
    expect(files.list()).toEqual([])
    expect(files.readState()).toBeNull()
    const r = new ModelRegistry({ files, sha256 })
    const text = model('disk')
    const { id } = r.upload(text, sha256(text), { enable: true })
    expect(files.list()).toEqual([sha256(text)])
    expect(files.shipped().text).toBe(shippedText)
    expect(readFileSync(files.path(sha256(text)), 'utf8')).toBe(text)
    // A new registry over the same folder, as after a restart or an update.
    expect(new ModelRegistry({ files, sha256 }).get(id)).toMatchObject({ enabled: true })
    writeFileSync(join(dir, 'models', 'registry.json'), '{')
    expect(files.readState()).toBeNull()
    files.remove(sha256(text))
    expect(files.read(sha256(text))).toBeNull()
  })
})

describe('fetching a model from the LAN', () => {
  it('knows private, loopback and link-local addresses', () => {
    for (const ip of ['10.1.2.3', '127.0.0.1', '172.16.0.1', '172.31.9.9', '192.168.2.10', '169.254.1.1', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.1.2']) expect(isLanAddress(ip)).toBe(true)
    for (const ip of ['8.8.8.8', '172.32.0.1', '1.1.1.1', '2606:4700::1', '::ffff:8.8.8.8']) expect(isLanAddress(ip)).toBe(false)
  })

  it('fetches from a LAN host and refuses the internet, bad URLs and big files', async () => {
    const ok = vi.fn(async () => new Response('{"x":1}'))
    expect(await fetchLanModel('http://laptop.local:8000/pod-state.json', { resolve: async () => ['192.168.2.20'], fetch: ok as never })).toBe('{"x":1}')
    const reject = async (url: string, msg: RegExp, o: Parameters<typeof fetchLanModel>[1] = {}) => {
      await expect(fetchLanModel(url, { resolve: async () => ['93.184.216.34'], fetch: ok as never, ...o })).rejects.toThrow(msg)
    }
    await reject('https://example.com/m.json', /not on the local network/)
    await reject('ftp://10.0.0.1/m.json', /only http/)
    await reject('not a url', /not a URL/)
    await reject('http://nowhere.local/m.json', /can't resolve/, { resolve: () => Promise.reject(new Error('ENOTFOUND')) })
    await reject('http://10.0.0.2/m.json', /HTTP 404/, { fetch: (async () => new Response('', { status: 404 })) as never })
    await reject('http://10.0.0.2/m.json', /over 2000000/, { fetch: (async () => new Response('x', { headers: { 'content-length': '3000000' } })) as never })
    await reject('http://10.0.0.2/m.json', /over 2000000/, { fetch: (async () => new Response('x'.repeat(MAX_MODEL_BYTES + 1))) as never })
    await reject('http://10.0.0.2/m.json', /failed: down/, { fetch: (() => Promise.reject(new Error('down'))) as never })
    expect(ok).toHaveBeenCalledTimes(1)
  })
})

function unit(opts: { token?: string, registry?: boolean } = {}) {
  const store = new MemoryStore()
  store.settings.update({ analysisIngestToken: opts.token ?? 'tok' })
  const { r: models } = registry()
  const core = createCore({ hal: new SimHal({ tickMs: 0 }), store, version: 'test', models: opts.registry === false ? undefined : models })
  const { app } = createApp({ ctx: core.ctx })
  return { ctx: core.ctx, app, models, caller: createCallerFactory(appRouter)(core.ctx) }
}

describe('model registry over REST, tRPC and MCP', () => {
  it('uploads with the ingest token and a matching hash, and lists, patches, rolls back and deletes', async () => {
    const { app, caller } = unit()
    const text = model('rest')
    const post = (body: string, headers: Record<string, string>, q = '') => app.request(`/api/models${q}`, { method: 'POST', headers: { 'x-forwarded-for': '10.0.0.9', ...headers }, body })
    expect((await post(text, {})).status).toBe(401)
    expect((await post(text, { authorization: 'Bearer tok' })).status).toBe(400)
    const bad = await post(text, { 'authorization': 'Bearer tok', 'x-content-sha256': sha256('x') })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: string }).error).toMatch(/mismatch/)
    expect((await post(text, { 'authorization': 'Bearer tok', 'content-length': String(MAX_MODEL_BYTES + 1) })).status).toBe(413)
    const ok = await post(text, { authorization: 'Bearer tok' }, `?sha256=${sha256(text)}&enable=1`)
    expect(ok.status).toBe(201)
    const id = ((await ok.json()) as { id: string }).id
    const listed = await app.request('/api/models')
    expect(((await listed.json()) as Array<{ id: string, enabled: boolean }>).map(x => [x.id, x.enabled])).toEqual([[expect.any(String), true], [id, true]])
    const patch = await app.request(`/api/models/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ primary: true }) })
    expect(((await patch.json()) as { primary: boolean }).primary).toBe(true)
    expect((await caller.models.rollback()).after.primary).not.toBe(id)
    expect((await app.request(`/api/models/${id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await app.request('/api/models/nope', { method: 'DELETE' })).status).toBe(404)
    expect((await caller.models.events({ limit: 5 })).map(e => e.action)).toEqual(['delete', 'rollback', 'primary', 'upload'])
  })

  it('is off without a token or a registry', async () => {
    const off = unit({ token: '' })
    expect((await off.app.request('/api/models', { method: 'POST', body: '{}', headers: { authorization: 'Bearer x' } })).status).toBe(404)
    const none = unit({ registry: false })
    expect((await none.app.request('/api/models', { method: 'POST', body: '{}', headers: { authorization: 'Bearer tok' } })).status).toBe(404)
    expect(await none.caller.models.list()).toEqual([])
    expect(await none.caller.models.events()).toEqual([])
    await expect(none.caller.models.reset()).rejects.toThrow(/only on a unit/)
  })

  it('keeps remote workers off every pod-state id, and says when a revision with results no longer runs', () => {
    const { ctx } = unit()
    ctx.store.analyses.add([{ captureId: 'upper-1', ts: '2026-11-01T00:00:00Z', camera: 'upper', analyzer: 'pod-state-old', version: 1, source: 'device', slot: 1, metric: 'pod_state', value: 0, detail: null, artifact: null }])
    expect(ctx.analysis.list().find(a => a.id === 'pod-state-old')?.description).toMatch(/no longer runs here/)
    expect(() => ingestResults(ctx.store, { analyzer: 'pod-state-mine', version: 1, results: [{ captureId: 'x', slot: 1, metric: 'm', value: 1 }] })).toThrow(/on-device analyser/)
  })

  it('MCP lists, uploads, sets and exports', async () => {
    const { ctx } = unit()
    const server = createMcpServer(ctx)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(b)
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await client.callTool({ name, arguments: args })
      const body = (res.content as Array<{ text: string }>)[0]?.text ?? ''
      return { error: !!res.isError, body: res.isError ? body : JSON.parse(body) as Record<string, unknown> }
    }
    const text = model('mcp')
    const up = await call('upload_model', { base64: Buffer.from(text).toString('base64'), sha256: sha256(text), enable: true })
    expect(up.body).toMatchObject({ analyzer: 'pod-state-mcp', enabled: true })
    expect((await call('upload_model', { sha256: sha256(text) })).error).toBe(true)
    const list = await call('list_models', {})
    expect((list.body as { revisions: unknown[] }).revisions).toHaveLength(2)
    const id = (up.body as { id: string }).id
    expect((await call('set_model', { action: 'disable', id })).body).toMatchObject({ enabled: false })
    expect((await call('set_model', { action: 'enable', id })).body).toMatchObject({ enabled: true })
    expect((await call('set_model', { action: 'primary', id })).body).toMatchObject({ primary: true })
    expect((await call('set_model', { action: 'enable' })).error).toBe(true)
    expect((await call('set_model', { action: 'rollback' })).body).toMatchObject({ action: 'rollback' })
    expect((await call('set_model', { action: 'reset' })).body).toMatchObject({ enabled: [expect.any(String)] })
    expect((await call('set_model', { action: 'delete', id })).body).toEqual({ removed: id })
    ctx.store.captures.add({ id: 'upper-1', camera: 'upper', ts: new Date().toISOString(), path: 'upper-1.jpg', bytes: 1 })
    ctx.store.podLabels.set({ captureId: 'upper-1', ts: new Date().toISOString(), camera: 'upper', slot: 2, label: 'sprouted', labelledAt: new Date().toISOString() })
    const exp = await call('export_dataset', { days: 7, images: false })
    expect(exp.body).toMatchObject({ captures: 1, images: false, labelsPerClass: { empty: 0, sprouted: 1, growing: 0, ready: 0, unhealthy: 0 } })
    expect((await call('list_labels', {})).body).toMatchObject({ counts: { sprouted: 1 }, pods: 1 })
    expect((await call('list_labels', { capture_id: 'upper-1' })).body).toMatchObject([{ slot: 2, label: 'sprouted' }])
    expect((exp.body as { path: string }).path).toMatch(/^\/api\/datasets\/export\?from=.*&images=0$/)
    await client.close()
  })
})
