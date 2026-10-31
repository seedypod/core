import { serve } from '@hono/node-server'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../server/app'
import { authorize, isLoopback } from '../../server/auth'
import { SimHal } from '../../src/hardware/sim'
import { createCore } from '../../src/server/bootstrap'
import { MemoryStore } from '../../src/store/memory'

let base = ''
let close: () => void = () => undefined
const store = new MemoryStore()

beforeAll(async () => {
  const core = createCore({ hal: new SimHal({ tickMs: 0 }), store, version: 'test' })
  const { app } = createApp({ ctx: core.ctx })
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
  await new Promise<void>(r => server.once('listening', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  close = () => server.close()
})
afterAll(() => close())

describe('API key guard', () => {
  it('loopback is always exempt; classification helper', async () => {
    store.settings.update({ apiKey: 'sekret' })
    expect((await fetch(`${base}/api/healthcheck`)).status).toBe(200)
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopback('192.168.1.20')).toBe(false)
  })

  it('non-loopback requests need the exact key when one is configured', () => {
    expect(authorize('', '192.168.1.20', undefined)).toBe(true)
    expect(authorize('sekret', '192.168.1.20', undefined)).toBe(false)
    expect(authorize('sekret', '192.168.1.20', 'wrong!')).toBe(false)
    expect(authorize('sekret', '192.168.1.20', 'sekret')).toBe(true)
    expect(authorize('sekret', '127.0.0.1', undefined)).toBe(true)
  })
})
