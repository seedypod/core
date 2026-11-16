import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { PumpGuardCommand, topics } from '../../hardware/contract'
import { HalRefused, SimHal } from '../../hardware/sim'
import { createEventBus } from '../../lib/eventBus'
import { createMcpServer } from '../../mcp/server'
import { MemoryStore } from '../../store/memory'
import { createCore } from '../bootstrap'
import { openApiDocument } from '../openapi'
import { appRouter } from '../routers/app'
import { createCallerFactory } from '../trpc'

function caller(hal = new SimHal({ tickMs: 0 })) {
  const events = createEventBus()
  const core = createCore({ hal, store: new MemoryStore(), events, version: 'test' })
  return { hal, events, core, c: createCallerFactory(appRouter)(core.ctx) }
}

/** Every property name anywhere in a JSON schema. */
function keys(schema: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) {
    for (const s of schema) keys(s, out)
  }
  else if (schema && typeof schema === 'object') {
    for (const [k, v] of Object.entries(schema)) {
      if (k === 'properties' && v && typeof v === 'object') for (const p of Object.keys(v)) out.add(p)
      keys(v, out)
    }
  }
  return out
}

/** A name that would set which guard runs, or its current cutoff. */
const GUARD_OR_CUTOFF = /dry_?guard|dry_?current|cutoff/i

describe('the pump dry-run guard from core', () => {
  it('sets the grace through the unit, held to its bounds, and says so', async () => {
    const { c, events } = caller()
    const seen: string[] = []
    events.subscribe(e => seen.push(e.kind === 'mutation' ? e.path : e.kind))
    expect((await c.system.info()).system?.limits).toMatchObject({ pumpDryGuard: 'level', pumpDryGraceMs: 3000, pumpDryGraceMinMs: 300, pumpDryGraceMaxMs: 5000 })
    expect(await c.pump.setDryGrace({ ms: 1200 })).toMatchObject({ pumpDryGraceMs: 1200 })
    expect((await c.pump.setDryGrace({ ms: 0 })).pumpDryGraceMs).toBe(300)
    expect((await c.pump.setDryGrace({ ms: 10_000 })).pumpDryGraceMs).toBe(5000)
    expect((await c.system.info()).system?.limits.pumpDryGraceMs).toBe(5000)
    expect(seen.filter(p => p === 'pump.dryGrace')).toHaveLength(3)
    await expect(c.pump.setDryGrace({ ms: 10_001 })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('maps a hald that can\'t set it to PRECONDITION_FAILED, and passes other errors on', async () => {
    const refusing = new SimHal({ tickMs: 0 })
    refusing.setPumpDryGrace = async () => {
      throw new HalRefused('this hald can\'t set the dry-run grace; update it')
    }
    await expect(caller(refusing).c.pump.setDryGrace({ ms: 1000 })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: /update it/ })
    const broken = new SimHal({ tickMs: 0 })
    broken.setPumpDryGrace = async () => {
      throw new Error('hald did not report the dry-run grace within 5000 ms')
    }
    await expect(caller(broken).c.pump.setDryGrace({ ms: 1000 })).rejects.toThrow(/within 5000 ms/)
  })

  it('the simulator holds a grace to whatever bounds it has', async () => {
    const open = new SimHal({ tickMs: 0, limits: { pumpDryGraceMinMs: undefined, pumpDryGraceMaxMs: undefined } })
    expect((await open.setPumpDryGrace(12_345.4)).pumpDryGraceMs).toBe(12_345)
    expect((await open.setPumpDryGrace(-5)).pumpDryGraceMs).toBe(0)
  })

  it('is set over MCP too, as the grace and nothing more', async () => {
    const { core } = caller()
    const [a, b] = InMemoryTransport.createLinkedPair()
    await createMcpServer(core.ctx).connect(a)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(b)
    const tool = (await client.listTools()).tools.find(t => t.name === 'set_pump_dry_grace')
    expect(Object.keys((tool?.inputSchema as { properties: object }).properties)).toEqual(['ms'])
    expect(tool?.description).toMatch(/set on the unit only/)
    const r = await client.callTool({ name: 'set_pump_dry_grace', arguments: { ms: 2000 } })
    expect(JSON.parse((r.content as Array<{ text: string }>)[0]?.text ?? '')).toMatchObject({ pumpDryGraceMs: 2000 })
    await client.close()
  })

  /** Pump safety outranks the app (#220): hal.toml alone picks the guard and its cutoff. */
  it('has no route, tool or contract command that sets which guard runs or its cutoff', async () => {
    const inputs = Object.entries(appRouter._def.procedures as unknown as Record<string, { _def: { inputs: unknown[] } }>)
      .flatMap(([path, p]) => p._def.inputs.map(i => [path, z.toJSONSchema(i as z.ZodType, { unrepresentable: 'any', io: 'input' })] as const))
    expect(inputs.length).toBeGreaterThan(50)
    const offending = inputs.flatMap(([path, s]) => [...keys(s)].filter(k => GUARD_OR_CUTOFF.test(k)).map(k => `${path}: ${k}`))
    expect(offending).toEqual([])
    expect([...keys(openApiDocument('http://x/api'))].filter(k => GUARD_OR_CUTOFF.test(k) && !k.startsWith('pumpDryGrace'))).toEqual(['pumpDryGuard'])
    // That one is the read-only report in `limits`, never a request body.
    const bodies = Object.values(openApiDocument('http://x/api').paths ?? {}).flatMap(p => Object.values(p ?? {}).map(op => (op as { requestBody?: unknown }).requestBody))
    expect([...keys(bodies)].filter(k => GUARD_OR_CUTOFF.test(k))).toEqual([])

    const { core } = caller()
    const [a, b] = InMemoryTransport.createLinkedPair()
    await createMcpServer(core.ctx).connect(a)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(b)
    const tools = (await client.listTools()).tools
    expect(tools.flatMap(t => [...keys(t.inputSchema)].filter(k => GUARD_OR_CUTOFF.test(k)).map(k => `${t.name}: ${k}`))).toEqual([])
    await client.close()

    // The one guard command on the wire carries the grace alone.
    expect(Object.keys(PumpGuardCommand.shape)).toEqual(['dryGraceMs'])
    expect(PumpGuardCommand.safeParse({ dryGraceMs: 1000, pumpDryGuard: 'current' }).success).toBe(false)
    expect(Object.keys(topics).filter(t => /guard/i.test(t))).toEqual(['pumpGuardSet'])
  })
})
