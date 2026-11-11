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

describe('pump presets over MCP', () => {
  it('offers watering starting points with their schedules, the guide and the unit\'s timezone, and the schedules upsert as they are', async () => {
    const { client, call } = await mcp()
    const tools = await client.listTools()
    const tool = tools.tools.find(t => t.name === 'pump_presets')
    expect(tool?.description).toMatch(/Gardyn doesn't publish its watering cadence/)
    expect(tool?.description).toMatch(/Minutes are the unit's local time/)
    const got = await call<{ timezone: string, guide: string, presets: Array<{ id: string, schedules: Array<{ id: string, kind: string, name: string, spec: { minute: number, durationS: number } }> }> }>('pump_presets')
    expect(got.timezone).toBe('UTC')
    expect(got.guide).toBe('https://help.mygardyn.com/en/articles/4435265')
    expect(got.presets.map(p => [p.id, p.schedules.length])).toEqual([['twice-10', 2], ['thrice-5', 3], ['once-15', 1]])
    for (const s of got.presets[0]?.schedules ?? []) await call('upsert_schedule', s)
    const listed = await call<{ schedules: Array<{ id: string, name: string }> }>('list_schedules')
    expect(listed.schedules.map(s => s.name)).toEqual(expect.arrayContaining(['Twice a day · 10 min (08:00)', 'Twice a day · 10 min (17:00)']))
    await client.close()
  })
})
