import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { SimHal } from '../../hardware/sim'
import { createApp } from '../../../server/app'
import { createMcpServer } from '../../mcp/server'
import { MemoryStore } from '../../store/memory'
import { createCore } from '../bootstrap'
import { appRouter } from '../routers/app'
import { createCallerFactory } from '../trpc'

const lit = (value: number) => ({ kind: 'literal' as const, value })
const hotRule = {
  name: 'Dim when hot',
  trigger: { kind: 'tick' as const, everyMin: 1 },
  conditions: { kind: 'compare' as const, op: '>' as const, left: { kind: 'signal' as const, signal: 'sensor.air_temp' }, right: lit(30) },
  actions: [{ kind: 'setLight' as const, level: lit(60) }],
}

function unit(now = new Date('2026-10-31T12:00:00Z')) {
  const hal = new SimHal({ tickMs: 0 })
  const store = new MemoryStore()
  const core = createCore({ hal, store, version: 'test', now: () => now })
  return { hal, store, core, c: createCallerFactory(appRouter)(core.ctx) }
}

describe('automations router', () => {
  it('creates rules in dry-run, lists them with their last run, and validates', async () => {
    const { c, core } = unit()
    const r = await c.automations.create(hotRule)
    expect(r).toMatchObject({ id: 1, dryRun: true, enabled: true, priority: 50 })
    await core.autopilot.tick()
    const [listed] = await c.automations.list()
    expect(listed?.lastRun).toMatchObject({ outcome: 'skipped' })
    await expect(c.automations.create({ ...hotRule, actions: [] })).rejects.toThrow()
    await expect(c.automations.get({ id: 99 })).rejects.toThrow(/no automation 99/)
    await expect(c.automations.update({ id: 99, name: 'x' })).rejects.toThrow(/no automation 99/)
    expect((await c.automations.catalog()).find(s => s.key === 'sensor.ph')).toMatchObject({ unit: 'pH', liveOnly: false })
  })

  it('arms a rule that takes the light, shows who owns it, and gives way to a manual change', async () => {
    const { c, hal, core } = unit()
    hal.setAirTemp(33)
    const r = await c.automations.create({ ...hotRule, dryRun: false })
    await core.autopilot.tick()
    await core.ctx.light.idle()
    expect(hal.snapshot().actuators.light).toMatchObject({ on: true, level: 60 })
    expect(await c.light.owner()).toMatchObject({ source: 'autopilot', leaseId: `rule:${r.id}:0` })
    const status = await c.automations.status()
    expect(status).toMatchObject({ enabled: true, leases: [{ level: 60 }], light: { source: 'autopilot' } })
    expect(status.rules[0]).toMatchObject({ condition: true })

    await c.light.set({ on: true, level: 90 })
    expect(await c.light.owner()).toMatchObject({ source: 'manual', level: 90 })
    await core.autopilot.tick()
    expect(hal.snapshot().actuators.light?.level).toBe(90)
    expect(await c.light.resume()).toMatchObject({ source: 'autopilot', level: 60 })
    expect((await c.automations.runs({ automationId: r.id, limit: 10 }))[0]).toMatchObject({ outcome: 'fired' })

    await c.automations.setGlobal({ enabled: false })
    await core.autopilot.tick()
    expect((await c.light.owner()).source).not.toBe('autopilot')
    expect((await c.settings.get()).autopilotEnabled).toBe(false)
  })

  it('updates and removes rules, clearing their notice', async () => {
    const { c, store, core } = unit()
    const r = await c.automations.create({ ...hotRule, dryRun: false, conditions: { kind: 'and', conditions: [] }, actions: [{ kind: 'notify', message: 'hello' }] })
    await core.autopilot.tick()
    expect(store.alerts.list({ activeOnly: true }).map(a => a.kind)).toContain(`autopilot_${r.id}`)
    expect((await c.automations.update({ id: r.id, name: 'renamed', priority: 80 }))).toMatchObject({ name: 'renamed', priority: 80 })
    expect(await c.automations.remove({ id: r.id })).toEqual({ removed: true })
    expect(store.alerts.list({ activeOnly: true }).map(a => a.kind)).not.toContain(`autopilot_${r.id}`)
    expect(await c.automations.runs({ limit: 10 })).toEqual([])
  })

  it('backtests a saved rule or a draft over recorded telemetry', async () => {
    const { c, store } = unit()
    const pts = Array.from({ length: 120 }, (_, i) => ({ ts: new Date(Date.parse('2026-10-31T10:00:00Z') + i * 60_000).toISOString(), sensor: 'air_temp' as const, value: i < 60 ? 25 : 32 }))
    store.telemetry.add(pts)
    const r = await c.automations.create({ ...hotRule, cooldownMin: 30, actions: [{ kind: 'setLight', level: lit(120), clamp: { min: 10, max: 70 } }] })
    const bt = await c.automations.backtest({ id: r.id, hours: 3, stepMin: 5 })
    expect(bt.times).toHaveLength(37)
    expect(bt.traces[0]?.key).toBe('sensor.air_temp')
    expect(bt.fires.length).toBeGreaterThan(0)
    expect(bt.fires[0]).toMatchObject({ actions: [{ kind: 'setLight', raw: 120, value: 70, clamped: true }] })
    expect(Date.parse(bt.fires[0]?.at ?? '')).toBeGreaterThanOrEqual(Date.parse('2026-10-31T11:00:00Z'))
    expect(bt.summary.unknownSteps).toBeGreaterThan(0)

    const draft = await c.automations.backtest({ rule: { ...hotRule, conditions: { kind: 'compare', op: '>', left: { kind: 'signal', signal: 'light.level' }, right: lit(0) } }, hours: 1, stepMin: 10 })
    expect(draft.liveOnly).toEqual(['light.level'])
    expect(draft.fires).toEqual([])
    await expect(c.automations.backtest({ hours: 1, stepMin: 5 })).rejects.toThrow(/rule id or a draft/)
  })

  it('exposes read-only MCP tools', async () => {
    const { core, c } = unit()
    await c.automations.create(hotRule)
    const server = createMcpServer(core.ctx)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(b)
    const textOf = async (name: string, args: Record<string, unknown>) => ((await client.callTool({ name, arguments: args })).content as Array<{ text: string }>)[0]?.text ?? '{}'
    const listed = JSON.parse(await textOf('list_automations', {})) as { rules: unknown[], status: { enabled: boolean } }
    expect(listed.rules).toHaveLength(1)
    expect(listed.status.enabled).toBe(true)
    const bt = JSON.parse(await textOf('backtest_automation', { rule: hotRule, hours: 1 })) as { times: unknown[] }
    expect(bt.times.length).toBeGreaterThan(0)
    const names = (await client.listTools()).tools.map(t => t.name)
    expect(names).not.toContain('create_automation')
    await client.close()
  })

  it('serves the REST paths without the static ones colliding with /automations/{id}', async () => {
    const { core, c } = unit()
    const r = await c.automations.create(hotRule)
    const { app } = createApp({ ctx: core.ctx })
    const runs = await app.request('/api/automations/runs')
    expect(runs.status).toBe(200)
    expect(await runs.json()).toMatchObject([{ automationId: r.id }])
    expect((await app.request('/api/automations/status')).status).toBe(200)
    expect((await app.request('/api/automations/signals')).status).toBe(200)
    expect(await (await app.request(`/api/automations/${r.id}`)).json()).toMatchObject({ name: 'Dim when hot' })
    expect((await app.request('/api/automations/42')).status).toBe(404)
    expect((await app.request('/api/light/owner')).status).toBe(200)
    const off = await app.request('/api/autopilot/enabled', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) })
    expect(await off.json()).toEqual({ enabled: false })
  })
})
