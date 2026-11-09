import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { RuleInput } from '../../autopilot/schema'
import { liveSignals } from '../../autopilot/signals'
import type { SensorId } from '../../hardware/contract'
import { SimHal } from '../../hardware/sim'
import type { HalSnapshot } from '../../hardware/types'
import { createEventBus } from '../../lib/eventBus'
import { createMcpServer } from '../../mcp/server'
import { createCore } from '../../server/bootstrap'
import { openApiDocument } from '../../server/openapi'
import { appRouter } from '../../server/routers/app'
import { createCallerFactory } from '../../server/trpc'
import { MemoryStore } from '../../store/memory'
import { fromRule } from '../../components/Autopilot/builderModel'
import { CITE } from '../knowledge'
import { STARTER_IDS, starterRules } from '../starters'

const NOW = new Date('2026-11-09T12:00:00Z')
const T = NOW.toISOString()
const WITH_PROBES: SensorId[] = ['water_level_pct', 'ph', 'ec']

function rig(caps: SensorId[] = WITH_PROBES) {
  const hal = new SimHal({ tickMs: 0, now: () => NOW })
  const base = hal.snapshot.bind(hal)
  hal.snapshot = () => {
    const s = base()
    return { ...s, system: s.system && { ...s.system, caps: { ...s.system.caps, sensors: caps } } }
  }
  const core = createCore({ hal, store: new MemoryStore(), events: createEventBus(), version: 'test', now: () => NOW })
  return { ctx: core.ctx, hal, store: core.ctx.store, c: createCallerFactory(appRouter)(core.ctx) }
}

describe('starter rules (ADR-0029)', () => {
  it('offers pH, EC and tank rules, each notify-only, citing its note, and valid as a new rule', () => {
    const { store, hal } = rig()
    const list = starterRules(store, hal.snapshot())
    expect(list.map(s => s.id)).toEqual([...STARTER_IDS])
    expect(list.map(s => s.title)).toEqual(['pH outside 5.5–6.5', 'EC below 1.2 mS/cm', 'Tank below half'])
    expect(list.map(s => s.citations)).toEqual([[CITE.phEc, CITE.ownerTargets], [CITE.phEc, CITE.dosesByProduct], [CITE.tankHalfFull]])
    for (const s of list) {
      expect(s.rule.actions.every(a => a.kind === 'notify'), s.id).toBe(true)
      expect(s).toMatchObject({ unavailable: null, added: false })
      // It saves as any new rule does: in dry run.
      expect(RuleInput.parse(s.rule)).toMatchObject({ enabled: true, dryRun: true })
      // And the builder can open it.
      expect(fromRule(s.rule), s.id).not.toBeNull()
    }
  })

  it('sets the EC threshold from what the tower grows', () => {
    const { store, hal } = rig()
    store.pods.update(1, { plant: 'Banana Pepper', status: 'growing' }, T)
    store.pods.update(2, { plant: 'Black Pearl Pepper', status: 'growing' }, T)
    const ec = starterRules(store, hal.snapshot()).find(s => s.id === 'ec_low')
    expect(ec).toMatchObject({ title: 'EC below 2.0 mS/cm', rule: { name: 'EC below 2.0 mS/cm', conditions: { conditions: [{ right: { value: 2 } }] } } })
    expect(ec?.description).toContain('the low end for fruiting crops')
  })

  it('says which the unit can\'t run, and which are already added', () => {
    const { store, hal } = rig(['water_level_pct'])
    const tank = starterRules(store, hal.snapshot()).find(s => s.id === 'tank_half')
    if (!tank) throw new Error('no tank starter')
    store.automations.create({ ...tank.rule, name: ' tank BELOW half ', enabled: true, dryRun: true }, T)
    expect(starterRules(store, hal.snapshot()).map(s => [s.id, s.unavailable, s.added])).toEqual([['ph_range', 'no pH probe', false], ['ec_low', 'no EC probe', false], ['tank_half', null, true]])
    expect(starterRules(store, { ...hal.snapshot(), system: null }).every(s => s.unavailable !== null)).toBe(true)
  })

  it('is served over tRPC, REST and MCP, read-only', async () => {
    const { c, ctx } = rig()
    expect((await c.care.starterRules()).map(s => s.id)).toEqual([...STARTER_IDS])
    expect(Object.keys(openApiDocument('http://x/api').paths ?? {})).toContain('/care/starter-rules')
    const server = createMcpServer(ctx)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(b)
    const res = await client.callTool({ name: 'starter_rules', arguments: {} })
    expect(JSON.parse((res.content as Array<{ text: string }>)[0]?.text ?? '[]')).toHaveLength(3)
    // Nothing on MCP creates or arms a rule.
    const tools = (await client.listTools()).tools.map(t => t.name)
    expect(tools.filter(t => /automation|rule/.test(t)).sort()).toEqual(['backtest_automation', 'list_automations', 'starter_rules'])
    expect(ctx.store.automations.list()).toEqual([])
  })
})

describe('Autopilot signals and reading quality', () => {
  it('reads only good readings, so no rule acts on a stale or suspect one', () => {
    const snap = (quality: 'good' | 'stale' | 'suspect'): HalSnapshot => ({ online: true, system: null, sensors: { water_level_pct: { ts: T, value: 20, unit: '%', quality } }, actuators: {}, alerts: {}, devices: null })
    const store = new MemoryStore()
    expect(liveSignals(snap('good'), store, NOW, [])['sensor.water_level_pct']).toBe(20)
    expect(liveSignals(snap('suspect'), store, NOW, [])['sensor.water_level_pct']).toBeUndefined()
    expect(liveSignals(snap('stale'), store, NOW, [])['sensor.water_level_pct']).toBeUndefined()
  })
})
