import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'
import type { Reading } from '../../hardware/contract'
import { SimHal } from '../../hardware/sim'
import type { HalSnapshot } from '../../hardware/types'
import { createEventBus } from '../../lib/eventBus'
import { createMcpServer } from '../../mcp/server'
import { createCore } from '../../server/bootstrap'
import { openApiDocument } from '../../server/openapi'
import { appRouter } from '../../server/routers/app'
import { createCallerFactory } from '../../server/trpc'
import { MemoryStore } from '../../store/memory'
import { CareEngine, CHORE_ALERTS, choreDoneKind } from '../engine'

const NOW = new Date('2026-11-09T12:00:00Z')
const T = NOW.toISOString()
const level = (value: number, quality: Reading['quality'] = 'good'): Reading => ({ ts: T, value, unit: '%', quality })

function rig(initial: Partial<HalSnapshot['sensors']> = {}, fedAt = '2026-11-07T12:00:00Z') {
  const hal = new SimHal({ tickMs: 0, now: () => NOW })
  const base = hal.snapshot.bind(hal)
  let sensors = initial
  hal.snapshot = () => ({ ...base(), sensors: { ...base().sensors, ...sensors } })
  const store = new MemoryStore()
  store.pods.update(1, { plant: 'Arugula', status: 'growing', plantedAt: '2026-10-20T12:00:00Z' }, T)
  // Fed two days ago by default, so Feed's calendar keeps out of what a reading raises.
  store.tankActions.add({ ts: fedAt, kind: 'feed', amount: null, unit: null, product: null, note: '', source: 'user' }, T)
  store.schedules.upsert({ id: 'day', kind: 'light', name: 'Day', enabled: true, days: 127, spec: { setpoints: [{ minute: 360, level: 80 }] } })
  store.schedules.upsert({ id: 'cycle', kind: 'pump', name: 'Cycle', enabled: true, days: 127, spec: { minute: 480, durationS: 300 } })
  const events = createEventBus()
  const care = new CareEngine({ store, hal, events, now: () => NOW })
  const set = (s: Partial<HalSnapshot['sensors']>) => {
    sensors = s
  }
  return { hal, store, events, care, set }
}
const active = (store: MemoryStore) => store.alerts.list({ activeOnly: true }).map(a => a.kind).sort()

describe('chore alerts (ADR-0029)', () => {
  it('raises an alert only when a reading makes a chore due, and clears it when the reading recovers', () => {
    const { store, care, set } = rig({ water_level_pct: level(40), ec: { ts: T, value: 0.8, unit: 'mS/cm', quality: 'good' } })
    const out = care.tick()
    expect(out.chores.map(c => c.id)).toContain('top_off')
    expect(active(store)).toEqual(['chore_feed', 'chore_top_off'])
    expect(store.alerts.list({ activeOnly: true }).find(a => a.kind === 'chore_top_off')?.detail).toBe('Tank at 40%: below half. Add about 11.4 L of water to fill it, and keep it at least half full.')
    // A new reading refreshes the detail in place; it doesn't raise another.
    set({ water_level_pct: level(38), ec: { ts: T, value: 1.5, unit: 'mS/cm', quality: 'good' } })
    const raise = vi.spyOn(store.alerts, 'raise')
    care.tick()
    expect(raise).toHaveBeenCalledWith('chore_top_off', 'Tank at 38%: below half. Add about 11.8 L of water to fill it, and keep it at least half full.', T, { live: true })
    expect(active(store)).toEqual(['chore_top_off'])
    set({ water_level_pct: level(90) })
    care.tick()
    expect(active(store)).toEqual([])
  })

  it('never raises a top-off from a suspect level, nor for a chore other than Feed that is due only on the calendar', () => {
    const { store, care } = rig({ water_level_pct: level(10, 'suspect') })
    store.grow.start('2026-09-01T12:00:00Z')
    care.tick()
    // The suspect level warns about the sensor, not the tank; the calendar chores (refresh, roots) stay off Alerts.
    expect(active(store)).toEqual(['setup_water_sensor'])
  })

  it('keeps a dismissed chore alert dismissed while the reading keeps it due, and raises it again once it recovered', () => {
    const { store, care, set } = rig({ water_level_pct: level(40) })
    care.tick()
    store.alerts.dismiss(store.alerts.list({ activeOnly: true })[0]?.id ?? 0, T)
    set({ water_level_pct: level(35) })
    care.tick()
    expect(active(store)).toEqual([])
    set({ water_level_pct: level(80) })
    care.tick()
    set({ water_level_pct: level(45) })
    care.tick()
    expect(active(store)).toEqual(['chore_top_off'])
  })

  it('raises Feed on its calendar too, as the one feed reminder, and clears it once a feed is logged', () => {
    const { store, care, events } = rig({}, '2026-11-01T12:00:00Z')
    care.start()
    expect(active(store)).toEqual(['chore_feed'])
    expect(store.alerts.list({ activeOnly: true })[0]?.detail).toMatch(/^Calendar guess, no EC probe: 8 d since the last feed\./)
    store.tankActions.add({ ts: T, kind: 'feed', amount: 1, unit: 'tsp', product: 'MaxiGro', note: '', source: 'user' }, T)
    events.emit({ kind: 'mutation', path: 'tank' })
    care.stop()
    expect(active(store)).toEqual([])
  })

  it('maps each chore alert to the tank action that does it', () => {
    expect(Object.values(CHORE_ALERTS).map(choreDoneKind)).toEqual(['top_off', 'feed', 'thin'])
    expect(choreDoneKind('setup_light_schedule')).toBeNull()
  })
})

describe('chores over the API and MCP', () => {
  function core() {
    const hal = new SimHal({ tickMs: 0, now: () => NOW })
    const c = createCore({ hal, store: new MemoryStore(), events: createEventBus(), version: 'test', now: () => NOW })
    return { ...c, hal, caller: createCallerFactory(appRouter)(c.ctx) }
  }

  it('serves chores over tRPC and REST', async () => {
    const { caller, ctx } = core()
    ctx.store.pods.update(1, { plant: 'Kale', status: 'growing', plantedAt: '2026-11-01T12:00:00Z' }, T)
    const list = await caller.care.chores()
    expect(list.map(c => c.id)).toEqual(['thin', 'trim_roots', 'top_off', 'refresh', 'feed', 'clean'])
    expect(list.find(c => c.id === 'top_off')).toMatchObject({ basis: 'reading' })
    expect(Object.keys(openApiDocument('http://x/api').paths ?? {})).toContain('/care/chores')
  })

  it('logs the chore in the tank log when its alert is marked done, and only then', async () => {
    const { caller, ctx } = core()
    ctx.store.pods.update(1, { plant: 'Kale', status: 'growing', plantedAt: '2026-11-01T12:00:00Z' }, T)
    const row = ctx.store.alerts.raise('chore_top_off', 'Tank at 40%', T)
    const events: string[] = []
    ctx.events.subscribe((e) => {
      if (e.kind === 'mutation') events.push(e.path)
    })
    await caller.alerts.acknowledge({ id: row.id })
    expect(ctx.store.tankActions.list()).toMatchObject([{ kind: 'top_off', ts: T, note: 'Marked done in Alerts', source: 'user' }])
    expect(events).toEqual(['tank', 'alerts.chore_top_off'])
    // Acknowledging it again, or any other alert, logs nothing more.
    await caller.alerts.acknowledge({ id: row.id })
    const other = ctx.store.alerts.raise('reminder_nutrients', 'Add nutrients', T)
    await caller.alerts.acknowledge({ id: other.id })
    expect(ctx.store.tankActions.list()).toHaveLength(1)
  })

  it('logs a feed when Feed\'s calendar alert is marked done in Alerts, and the engine keeps it cleared', async () => {
    const { caller, ctx, care } = core()
    ctx.store.pods.update(1, { plant: 'Kale', status: 'growing', plantedAt: '2026-10-20T12:00:00Z' }, T)
    care.tick()
    const row = ctx.store.alerts.list({ activeOnly: true }).find(a => a.kind === 'chore_feed')
    expect(row?.detail).toMatch(/sprout dose/)
    await caller.alerts.acknowledge({ id: row?.id ?? 0 })
    expect(ctx.store.tankActions.list()).toMatchObject([{ kind: 'feed', ts: T, note: 'Marked done in Alerts' }])
    care.tick()
    expect(ctx.store.alerts.list({ activeOnly: true }).map(a => a.kind)).not.toContain('chore_feed')
  })

  it('lets an agent read chores with their basis and citations', async () => {
    const { ctx } = core()
    ctx.store.pods.update(1, { plant: 'Kale', status: 'growing', plantedAt: '2026-11-01T12:00:00Z' }, T)
    const server = createMcpServer(ctx)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(b)
    const res = await client.callTool({ name: 'list_chores', arguments: {} })
    const body = JSON.parse((res.content as Array<{ text: string }>)[0]?.text ?? '[]') as Array<{ id: string, basis: string, citations: Array<{ note: string }> }>
    const feed = body.find(c => c.id === 'feed')
    expect(feed?.basis).toBe('timeline')
    expect(feed?.citations.map(c => c.note)).toEqual(['knowledge/nutrients/gardyn-feeding-guidance.md', 'knowledge/nutrients/community-nutrients.md'])
  })
})
