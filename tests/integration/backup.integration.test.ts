import { serve } from '@hono/node-server'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../server/app'
import { BackupService } from '../../src/backup/service'
import { untar } from '../../src/backup/tests/untar'
import { SimHal } from '../../src/hardware/sim'
import { createEventBus } from '../../src/lib/eventBus'
import { createCore } from '../../src/server/bootstrap'
import { MemoryStore } from '../../src/store/memory'

let base = ''
let close: () => void = () => undefined
let store: MemoryStore

beforeAll(async () => {
  const hal = new SimHal({ tickMs: 0, unitId: 'bench' })
  const events = createEventBus()
  store = new MemoryStore()
  const backup = new BackupService({
    store, hal, events, version: 'test',
    sources: {
      paths: { etcDir: '/etc/seedypod', stateDir: '/var/lib/seedypod', mosquittoPasswd: '/nope', capturesDir: './data/captures' },
      database: async () => new TextEncoder().encode('db'),
      systemFiles: () => [{ name: 'etc/seedypod/hal.toml', path: '/etc/seedypod/hal.toml', optional: false }],
      read: async () => new TextEncoder().encode('unit_id = "bench"'),
      schema: () => ({ migrations: 1, tag: '0000' }),
    },
  })
  const core = createCore({ hal, store, events, version: 'test', backup })
  const { app } = createApp({ ctx: core.ctx })
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
  await new Promise<void>(r => server.once('listening', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  close = () => server.close()
})

afterAll(() => close())

describe('backup over HTTP', () => {
  it('downloads a named gzip bundle and records it', async () => {
    const r = await fetch(`${base}/api/backup/download`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('application/gzip')
    expect(r.headers.get('content-disposition')).toMatch(/^attachment; filename="seedypod-backup-bench-\d{8}-\d{6}\.tar\.gz"$/)
    const files = untar(new Uint8Array(await r.arrayBuffer()))
    expect([...files.keys()]).toEqual(['seedypod.db', 'etc/seedypod/hal.toml', 'manifest.json'])
    const status = await (await fetch(`${base}/api/backup`)).json() as { available: boolean, lastSuccess: { destination: string } | null, nightly: { enabled: boolean } }
    expect(status).toMatchObject({ available: true, lastSuccess: { destination: 'download' }, nightly: { enabled: false } })
  })

  it('refuses a bucket backup without a mirror, with the reason', async () => {
    const r = await fetch(`${base}/api/backup/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(r.status).toBe(412)
    expect(((await r.json()) as { message: string }).message).toMatch(/mirror is not configured/)
  })
})
