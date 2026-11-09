import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SimHal } from '../../hardware/sim'
import { createEventBus, type CoreEvent } from '../../lib/eventBus'
import { MemoryStore } from '../../store/memory'
import { UpdateClient } from '../../update/client'
import { createCore } from '../bootstrap'
import { openApiDocument } from '../openapi'
import { appRouter } from '../routers/app'
import { createCallerFactory } from '../trpc'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'update-router-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** A helper that answers each command from `answers`, keyed by its first argument. */
function helper(answers: Record<string, object>) {
  const script = join(dir, 'helper.mjs')
  writeFileSync(script, `const a = ${JSON.stringify(answers)}[process.argv[2]] ?? { ok: false, code: 'usage', error: 'unknown' }
console.log(JSON.stringify(a))
process.exit(a.ok ? 0 : 4)
`)
  return [process.execPath, script]
}

function caller(answers?: Record<string, object>, version = 'dev@aaaaaaa') {
  const events = createEventBus()
  const seen: CoreEvent[] = []
  events.subscribe(e => seen.push(e))
  const update = answers ? new UpdateClient({ command: helper(answers), workDir: dir, version, events, pollMs: 60_000 }) : undefined
  const core = createCore({ hal: new SimHal({ tickMs: 0 }), store: new MemoryStore(), events, version, update })
  return { c: createCallerFactory(appRouter)(core.ctx), seen, update }
}

const CHECK = {
  ok: true,
  channel: 'stable',
  installed: { version: 'main@aaaaaaa', commit: 'aaaaaaa', branch: 'main', tag: 'v1.1.0' },
  available: { tag: 'v1.2.0', commit: 'b'.repeat(40), name: 'v1.2.0', publishedAt: null, url: 'https://github.com/seedypod/core/releases/tag/v1.2.0' },
  updateAvailable: true,
  problem: null,
}

describe('update router', () => {
  it('says updates aren\'t installed where core has no helper (demo, tests), and refuses to run one', async () => {
    const { c } = caller(undefined, 'main@aaaaaaa')
    expect(await c.update.status()).toEqual({ available: false, channel: 'stable', tag: null, status: null, log: [] })
    expect((await caller().c.update.status()).channel).toBe('dev')
    await expect(c.update.check()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(c.update.setChannel({ channel: 'dev' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(c.update.start()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })

  it('checks, switches channel and starts through the helper, and says so on the bus', async () => {
    const { c, seen, update } = caller({ '--check': CHECK, '--channel': { ok: true, channel: 'stable' }, '--start': { ok: true, detached: true } })
    expect(await c.update.check()).toMatchObject({ channel: 'stable', available: { tag: 'v1.2.0' }, updateAvailable: true })
    expect(await c.update.setChannel({ channel: 'stable' })).toEqual({ channel: 'stable' })
    writeFileSync(join(dir, 'status.json'), JSON.stringify({ op: 'update', state: 'queued', at: '2026-11-08T00:00:00.000Z' }))
    expect(await c.update.start()).toEqual({ started: true, status: { op: 'update', state: 'queued', at: '2026-11-08T00:00:00.000Z' } })
    update?.stop()
    expect(seen.filter(e => e.kind === 'mutation')).toEqual([{ kind: 'mutation', path: 'update' }, { kind: 'mutation', path: 'update' }])
    expect((await c.update.status()).status).toMatchObject({ state: 'queued' })
  })

  it('takes only stable or dev as a channel', async () => {
    const { c } = caller({ '--channel': { ok: true } })
    await expect(c.update.setChannel({ channel: 'nightly' as 'dev' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('maps the helper\'s refusals: busy is a conflict, a bad release a precondition', async () => {
    const busy = caller({ '--start': { ok: false, code: 'busy', error: 'an update is already running' } })
    await expect(busy.c.update.start()).rejects.toMatchObject({ code: 'CONFLICT', message: 'an update is already running' })
    const bad = caller({ '--start': { ok: false, code: 'checksum', error: 'seedypod-core.tar.gz doesn\'t match' }, '--check': { ok: false, code: 'no-release', error: 'there is no stable release yet' } })
    await expect(bad.c.update.start()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'seedypod-core.tar.gz doesn\'t match' })
    await expect(bad.c.update.check()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'there is no stable release yet' })
  })

  it('is on the REST facade', () => {
    const paths = Object.keys((openApiDocument('http://unit/api') as { paths: Record<string, unknown> }).paths)
    expect(paths).toEqual(expect.arrayContaining(['/update', '/update/check', '/update/channel', '/update/start']))
  })
})
