import { serve } from '@hono/node-server'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../server/app'
import { SimHal } from '../../src/hardware/sim'
import { createEventBus } from '../../src/lib/eventBus'
import { createCore } from '../../src/server/bootstrap'
import { MemoryStore } from '../../src/store/memory'

let base = ''
let close: () => void = () => undefined
let hal: SimHal

beforeAll(async () => {
  hal = new SimHal({ tickMs: 0 })
  const events = createEventBus()
  const core = createCore({ hal, store: new MemoryStore(), events, version: 'test', captureMinBytes: 1 })
  const { app, injectWebSocket } = createApp({ ctx: core.ctx })
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
  injectWebSocket(server)
  await new Promise<void>(r => server.once('listening', () => r()))
  const { port } = server.address() as AddressInfo
  base = `http://127.0.0.1:${port}`
  close = () => server.close()
})

afterAll(async () => {
  close()
  await hal.close()
})

describe('core HTTP surface', () => {
  it('REST facade answers and clamps through the HAL', async () => {
    const r = await fetch(`${base}/api/pump/run-once`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ durationS: 30, level: 100 }) })
    expect(r.status).toBe(200)
    const s = await r.json() as { level: number, remainingS: number }
    expect(s.level).toBe(30)
    expect(s.remainingS).toBe(30)
  })

  it('serves each camera\'s newest stored still at a fixed URL, and nothing before the first', async () => {
    expect((await fetch(`${base}/api/camera/lower/latest.jpg`)).status).toBe(404)
    expect((await fetch(`${base}/api/camera/side/latest.jpg`)).status).toBe(404)
    const taken = await fetch(`${base}/api/camera/lower/capture`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(r => r.json()) as { url: string, ts: string }
    const r = await fetch(`${base}/api/camera/lower/latest.jpg`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('image/jpeg')
    expect(r.headers.get('cache-control')).toBe('no-cache')
    expect(r.headers.get('last-modified')).toBe(new Date(taken.ts).toUTCString())
    const byId = await fetch(`${base}${taken.url}`).then(x => x.arrayBuffer())
    expect(Buffer.compare(Buffer.from(await r.arrayBuffer()), Buffer.from(byId))).toBe(0)
  })

  it('serves the OpenAPI document', async () => {
    const doc = await fetch(`${base}/api/openapi.json`).then(r => r.json()) as { paths: Record<string, unknown> }
    expect(Object.keys(doc.paths)).toContain('/light')
  })

  it('MCP lists tools over stateless Streamable HTTP and rejects foreign origins', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const ok = await fetch(`${base}/api/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' }, body })
    expect(ok.status).toBe(200)
    const json = await ok.json() as { result: { tools: { name: string }[] } }
    expect(json.result.tools.map(t => t.name)).toEqual(expect.arrayContaining(['status', 'set_light', 'run_pump', 'acknowledge_alert', 'plant_catalog', 'plan_layout', 'best_spot', 'save_plan', 'apply_plan']))
    const bad = await fetch(`${base}/api/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'application/json', 'origin': 'https://evil.example' }, body })
    expect(bad.status).toBe(403)
  })

  it('WebSocket stream sends a hello snapshot then live events', async () => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/ws`)
    const frames: { kind: string }[] = []
    const got = new Promise<void>((resolve) => {
      ws.addEventListener('message', (m) => {
        frames.push(JSON.parse(String(m.data)) as { kind: string })
        if (frames.length >= 2) resolve()
      })
    })
    await new Promise<void>(r => ws.addEventListener('open', () => r()))
    await hal.setActuator('light', { level: 42 })
    await got
    ws.close()
    expect(frames[0]?.kind).toBe('hello')
    expect(frames[1]).toMatchObject({ kind: 'hal', event: { type: 'actuator', id: 'light' } })
  })
})
