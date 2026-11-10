import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { SimHal } from '../../hardware/sim'
import { createMcpServer } from '../../mcp/server'
import { MemoryStore } from '../../store/memory'
import { createCore } from '../bootstrap'

async function mcp() {
  const core = createCore({ hal: new SimHal({ tickMs: 0 }), store: new MemoryStore(30), version: 'test' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await createMcpServer(core.ctx).connect(a)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(b)
  const call = async <T>(name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args })
    return JSON.parse((r.content as Array<{ text: string }>)[0]?.text ?? '') as T
  }
  return { client, call }
}

describe('light schedules over MCP', () => {
  it('offers Gardyn presets with their rating, and rates the curves it lists', async () => {
    const { client, call } = await mcp()
    const presets = await call<{ timezone: string, presets: { id: string, boostHours: number, rating: string, setpoints: unknown[] }[] }>('light_presets')
    expect(presets.timezone).toBe('UTC')
    expect(presets.presets.map(p => [p.id, p.boostHours, p.rating])).toEqual([['day-15h', 15, 'great'], ['day-14h', 14, 'great'], ['day-16h', 16, 'great']])

    const day = presets.presets[0]
    await call('upsert_schedule', { id: 'day', kind: 'light', name: 'Day', spec: { setpoints: day?.setpoints } })
    await call('upsert_schedule', { id: 'water', kind: 'pump', name: 'Water', spec: { minute: 480, durationS: 300 } })
    const listed = await call<{ timezone: string, schedules: Array<{ id: string, boostHours?: number, rating?: string }> }>('list_schedules')
    expect(listed.schedules.find(s => s.id === 'day')).toMatchObject({ boostHours: 15, rating: 'great' })
    expect(listed.schedules.find(s => s.id === 'water')).not.toHaveProperty('rating')
    await client.close()
  })
})
