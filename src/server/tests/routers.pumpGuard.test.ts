import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { DryGuard, PumpGuardCommand, topics } from '../../hardware/contract'
import { HalRefused, SimHal } from '../../hardware/sim'
import { createEventBus } from '../../lib/eventBus'
import { createMcpServer } from '../../mcp/server'
import { MemoryStore } from '../../store/memory'
import { createCore } from '../bootstrap'
import { appRouter } from '../routers/app'
import { createCallerFactory } from '../trpc'

function caller(hal = new SimHal({ tickMs: 0 })) {
  const events = createEventBus()
  const core = createCore({ hal, store: new MemoryStore(), events, version: 'test' })
  return { hal, events, core, c: createCallerFactory(appRouter)(core.ctx) }
}

describe('the pump dry-run guard from core', () => {
  it('sets the grace, cutoff, guard, level cutoff and hold through the unit, held to its bounds, and says so', async () => {
    const { c, events } = caller()
    const seen: string[] = []
    events.subscribe(e => seen.push(e.kind === 'mutation' ? e.path : e.kind))
    // A stock unit: both asked, no cutoff yet, so the tank level guards alone, and says why.
    expect((await c.system.info()).system?.limits).toMatchObject({ pumpDryGuard: 'level', pumpDryGuardAsked: 'both', pumpDryGuardWhy: expect.stringMatching(/no pump current cutoff/), pumpDryCurrentA: null, pumpDryGraceMs: 3000 })
    const set = await c.pump.setGuard({ currentA: 0.8 })
    expect(set).toMatchObject({ pumpDryGuard: 'both', pumpDryCurrentA: 0.8 })
    expect(set.pumpDryGuardWhy).toBeUndefined()
    expect((await c.pump.setGuard({ currentA: 9 })).pumpDryCurrentA).toBe(3)
    expect((await c.pump.setGuard({ currentA: 0.01 })).pumpDryCurrentA).toBe(0.1)
    expect((await c.pump.setGuard({ guard: 'current', graceMs: 10_000 })).pumpDryGraceMs).toBe(5000)
    expect((await c.system.info()).system?.limits).toMatchObject({ pumpDryGuard: 'current', pumpDryGuardAsked: 'current' })
    expect(await c.pump.setGuard({ waterLowCm: 40, waterLowHoldMs: 99_999 }).catch(e => e.code)).toBe('BAD_REQUEST')
    expect(await c.pump.setGuard({ waterLowCm: 30, waterLowHoldMs: 10_000 })).toMatchObject({ waterLowCm: 19, waterLowHoldMs: 10_000 })
    expect(seen.filter(p => p === 'pump.guard')).toHaveLength(5)
    await expect(c.pump.setGuard({})).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    // The grace alone still has its own route.
    expect(await c.pump.setDryGrace({ ms: 1200 })).toMatchObject({ pumpDryGraceMs: 1200 })
  })

  it('refuses a guard change hal.toml locks, and maps a hald that can\'t to PRECONDITION_FAILED', async () => {
    const locked = caller(new SimHal({ tickMs: 0, limits: { pumpDryGuardApp: false, pumpDryGuardAsked: 'both' } })).c
    await expect(locked.pump.setGuard({ guard: 'current' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: /locked in hal.toml/ })
    // The numbers aren't locked, and asking for the guard it already has isn't a change.
    expect(await locked.pump.setGuard({ guard: 'both', currentA: 0.5 })).toMatchObject({ pumpDryCurrentA: 0.5 })
    const old = new SimHal({ tickMs: 0 })
    old.setPumpGuard = async () => {
      throw new HalRefused('this hald can\'t set the dry-run cutoff or guard; update it')
    }
    await expect(caller(old).c.pump.setGuard({ currentA: 1 })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: /update it/ })
    const broken = new SimHal({ tickMs: 0 })
    broken.setPumpGuard = async () => {
      throw new Error('hald did not report the dry-run guard within 5000 ms')
    }
    await expect(caller(broken).c.pump.setDryGrace({ ms: 1000 })).rejects.toThrow(/within 5000 ms/)
  })

  it('the simulator holds each number to whatever bounds it has', async () => {
    const open = new SimHal({ tickMs: 0, limits: { pumpDryGraceMinMs: undefined, pumpDryGraceMaxMs: undefined, pumpDryCurrentMinA: undefined, pumpDryCurrentMaxA: undefined } })
    expect((await open.setPumpGuard({ dryGraceMs: 12_345.4 })).pumpDryGraceMs).toBe(12_345)
    expect((await open.setPumpGuard({ dryCurrentA: 7.123 })).pumpDryCurrentA).toBe(7.12)
  })

  it('reports the last run, which the simulator records when one ends', async () => {
    const hal = new SimHal({ tickMs: 0 })
    const { c } = caller(hal)
    expect(await c.pump.lastRun()).toBeNull()
    await c.pump.runOnce({ durationS: 20 })
    hal.tick(25)
    const run = await c.pump.lastRun()
    expect(run).toMatchObject({ endedBy: 'deadline', fault: null, everyMs: 100 })
    expect(run?.samples.length).toBeLessThanOrEqual(121)
    expect(run?.samples.at(-1)?.[0]).toBe(12_000)
    expect(run?.wetA).toBeGreaterThan(0)
    expect((await caller(new SimHal({ tickMs: 0, seedRun: true })).c.pump.lastRun())?.endedBy).toBe('deadline')
  })

  it('in the simulator, current-only ignores the tank and stops on the current; level stops on the level after its hold', async () => {
    const hal = new SimHal({ tickMs: 0 })
    await hal.setPumpGuard({ dryGuard: 'current', dryCurrentA: 0.45, dryGraceMs: 300 })
    ;(hal as unknown as { waterDistanceCm: number }).waterDistanceCm = 19.6
    await hal.setActuator('pump', { on: true, durationS: 600 })
    hal.tick(1)
    expect(hal.snapshot().actuators.pump?.on).toBe(false)
    expect(hal.snapshot().lastRun?.fault).toMatch(/^dry-run: pump drew 0.3 A, below 0.45 A/)

    const level = new SimHal({ tickMs: 0 })
    await level.setPumpGuard({ dryGuard: 'level', waterLowHoldMs: 3000 })
    ;(level as unknown as { waterDistanceCm: number }).waterDistanceCm = 15.99
    await level.setActuator('pump', { on: true, durationS: 600 })
    level.tick(1)
    expect(level.snapshot().actuators.pump?.on).toBe(true)
    level.tick(1)
    level.tick(1)
    level.tick(1)
    expect(level.snapshot().actuators.pump?.on).toBe(false)
    expect(level.snapshot().lastRun?.fault).toMatch(/^dry-run: tank level read 16 cm, past 16 cm/)
  })

  it('is set over MCP too', async () => {
    const { core } = caller()
    const [a, b] = InMemoryTransport.createLinkedPair()
    await createMcpServer(core.ctx).connect(a)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(b)
    const tool = (await client.listTools()).tools.find(t => t.name === 'set_pump_guard')
    expect(Object.keys((tool?.inputSchema as { properties: object }).properties)).toEqual(['guard', 'current_a', 'grace_ms'])
    const r = await client.callTool({ name: 'set_pump_guard', arguments: { guard: 'both', current_a: 0.8, grace_ms: 2000 } })
    expect(JSON.parse((r.content as Array<{ text: string }>)[0]?.text ?? '')).toMatchObject({ pumpDryGuard: 'both', pumpDryCurrentA: 0.8, pumpDryGraceMs: 2000 })
    await client.close()
  })

  /** Pump safety outranks the app (#220): it may tune the guard, never turn it off. */
  it('has no way to turn the guard off: no off mode, and no cutoff that can be cleared', () => {
    expect(DryGuard.options).toEqual(['level', 'current', 'both'])
    for (const off of [{ dryGuard: 'off' }, { dryGuard: 'none' }, { dryCurrentA: null }, { dryCurrentA: 0 }, { waterLowCm: null }, { waterLowCm: 0 }, {}]) {
      expect(PumpGuardCommand.safeParse(off).success, JSON.stringify(off)).toBe(false)
    }
    expect(PumpGuardCommand.safeParse({ dryGraceMs: 1000, pumpDryGuard: 'current' }).success).toBe(false)
    expect(Object.keys(topics).filter(t => /guard/i.test(t))).toEqual(['pumpGuardSet'])
    const input = appRouter._def.procedures as unknown as Record<string, { _def: { inputs: z.ZodType[] } }>
    const setGuard = input['pump.setGuard']?._def.inputs[0]
    expect(setGuard).toBeDefined()
    for (const off of [{ guard: 'off' }, { currentA: null }, { currentA: 0 }, { waterLowCm: null }]) {
      expect(setGuard?.safeParse(off).success, JSON.stringify(off)).toBe(false)
    }
  })
})
