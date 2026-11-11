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
  it('offers community starting points with their runs, notes and citations, the light window and a recommendation, and they upsert as they are', async () => {
    const { client, call } = await mcp()
    const tool = (await client.listTools()).tools.find(t => t.name === 'pump_presets')
    expect(tool?.description).toMatch(/community starting points from r\/Gardyn owners, not Gardyn's/)
    expect(tool?.description).toMatch(/Check the roots/)
    expect(tool?.description).toMatch(/Minutes are the unit's local time/)
    await call('upsert_schedule', { id: 'day', kind: 'light', name: 'Day', spec: { setpoints: [{ minute: 420, level: 0 }, { minute: 450, level: 100 }, { minute: 1230, level: 100 }, { minute: 1260, level: 0 }] } })
    const got = await call<{ timezone: string, guide: string, light: { on: number, off: number } | null, recommended: string | null, tips: string[], presets: Array<{ id: string, runs: number[], minutesADay: number, note: string, citation: string, schedules: Array<{ id: string, name: string }> }> }>('pump_presets')
    expect(got.timezone).toBe('UTC')
    expect(got.guide).toBe('https://help.mygardyn.com/en/articles/4435265')
    expect(got.light).toEqual({ on: 421, off: 1260 })
    // An empty tower has no sowing date to go by.
    expect(got.recommended).toBeNull()
    expect(got.tips).toHaveLength(3)
    expect(got.presets.map(p => [p.id, p.runs.length, p.minutesADay])).toEqual([['seedlings', 1, 10], ['young', 2, 12], ['mature', 3, 18], ['fruiting', 3, 15]])
    expect(got.presets[0]?.citation).toMatch(/knowledge\/watering\/schedules\.md#seedlings$/)
    for (const s of got.presets[2]?.schedules ?? []) await call('upsert_schedule', s)
    const listed = await call<{ schedules: Array<{ id: string, name: string }> }>('list_schedules')
    expect(listed.schedules.map(s => s.id)).toEqual(expect.arrayContaining(['water-mature-0800', 'water-mature-1400', 'water-mature-2000']))
    await client.close()
  })
})
