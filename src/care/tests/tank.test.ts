import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { SimHal } from '../../hardware/sim'
import { createEventBus } from '../../lib/eventBus'
import { createMcpServer } from '../../mcp/server'
import { createCore } from '../../server/bootstrap'
import { openApiDocument } from '../../server/openapi'
import { appRouter } from '../../server/routers/app'
import { createCallerFactory } from '../../server/trpc'
import { MemoryStore } from '../../store/memory'

const NOW = new Date('2026-11-09T12:00:00Z')

function rig() {
  const core = createCore({ hal: new SimHal({ tickMs: 0, now: () => NOW }), store: new MemoryStore(), events: createEventBus(), version: 'test', now: () => NOW })
  const events: string[] = []
  core.ctx.events.subscribe((e) => {
    if (e.kind === 'mutation') events.push(e.path)
  })
  return { ctx: core.ctx, events, c: createCallerFactory(appRouter)(core.ctx) }
}

describe('tank action log (ADR-0029)', () => {
  it('logs an action now, or when it was done, and lists newest first', async () => {
    const { c, events } = rig()
    const fed = await c.tank.logAction({ kind: 'feed', amount: 1, unit: 'tsp', product: ' MaxiGro ', note: ' dissolved in a jug first ' })
    expect(fed).toMatchObject({ ts: NOW.toISOString(), createdAt: NOW.toISOString(), kind: 'feed', amount: 1, unit: 'tsp', product: 'MaxiGro', note: 'dissolved in a jug first', source: 'user' })
    await c.tank.logAction({ kind: 'top_off', ts: '2026-11-08T20:00:00-08:00' })
    const list = await c.tank.actions({})
    expect(list.map(a => [a.kind, a.ts])).toEqual([['feed', NOW.toISOString()], ['top_off', '2026-11-09T04:00:00.000Z']])
    expect(list.at(-1)).toMatchObject({ amount: null, unit: null, product: null, note: '' })
    expect((await c.tank.actions({ kind: 'top_off' })).map(a => a.kind)).toEqual(['top_off'])
    expect(events).toEqual(['tank', 'tank'])
  })

  it('refuses an amount without a unit, a unit without an amount, and a time in the future', async () => {
    const { c } = rig()
    await expect(c.tank.logAction({ kind: 'ph_down', amount: 2 })).rejects.toThrow('an amount needs a unit')
    await expect(c.tank.logAction({ kind: 'ph_down', unit: 'mL' })).rejects.toThrow('an amount needs a unit')
    await expect(c.tank.logAction({ kind: 'feed', ts: '2026-11-09T13:00:00Z' })).rejects.toThrow('is in the future')
    // A clock a minute or two apart is fine.
    await expect(c.tank.logAction({ kind: 'feed', ts: '2026-11-09T12:02:00Z' })).resolves.toMatchObject({ ts: '2026-11-09T12:02:00.000Z' })
    await expect(c.tank.logAction({ kind: 'feed', amount: -1, unit: 'tsp' })).rejects.toThrow()
  })

  it('removes an entry, saying whether there was one', async () => {
    const { c, events } = rig()
    const a = await c.tank.logAction({ kind: 'refresh' })
    expect(await c.tank.removeAction({ id: a.id })).toEqual({ removed: true })
    expect(await c.tank.removeAction({ id: a.id })).toEqual({ removed: false })
    expect(await c.tank.actions({})).toEqual([])
    expect(events).toEqual(['tank', 'tank'])
  })

  it('is in the REST API', () => {
    const paths = openApiDocument('http://x/api').paths ?? {}
    expect(paths['/tank/actions']?.get).toBeDefined()
    expect(paths['/tank/actions']?.post).toBeDefined()
    expect(paths['/tank/actions/{id}']?.delete).toBeDefined()
  })

  it('lets an agent log what a person reports and read the log back, marked as the agent\'s', async () => {
    const { ctx } = rig()
    const server = createMcpServer(ctx)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(b)
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = await client.callTool({ name, arguments: args })
      return { error: res.isError === true, body: (res.content as Array<{ text: string }>)[0]?.text ?? '' }
    }
    expect(JSON.parse((await call('log_tank_action', { kind: 'feed', amount: 1, unit: 'tsp', product: 'MaxiGro' })).body)).toMatchObject({ kind: 'feed', source: 'agent', ts: NOW.toISOString() })
    expect(JSON.parse((await call('log_tank_action', { kind: 'ph_down', amount: 2, unit: 'mL', note: 'pH was 6.9', at: '2026-11-09T11:00:00Z' })).body)).toMatchObject({ kind: 'ph_down', note: 'pH was 6.9', ts: '2026-11-09T11:00:00.000Z' })
    expect((await call('log_tank_action', { kind: 'feed', amount: 1 })).error).toBe(true)
    const list = JSON.parse((await call('list_tank_actions')).body) as Array<{ kind: string, source: string }>
    expect(list.map(x => [x.kind, x.source])).toEqual([['feed', 'agent'], ['ph_down', 'agent']])
    expect(JSON.parse((await call('list_tank_actions', { kind: 'ph_down', limit: 5 })).body)).toHaveLength(1)
  })
})
