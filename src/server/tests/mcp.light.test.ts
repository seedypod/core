import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { SimHal } from '../../hardware/sim'
import { createMcpServer } from '../../mcp/server'
import { MemoryStore } from '../../store/memory'
import { createCore } from '../bootstrap'

async function mcp(o: { now?: () => Date, timezone?: string } = {}) {
  const store = new MemoryStore(30)
  if (o.timezone) store.settings.update({ timezone: o.timezone })
  const core = createCore({ hal: new SimHal({ tickMs: 0 }), store, version: 'test', now: o.now })
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
    const got = await call<{ timezone: string, guide: string, light: { on: number, off: number } | null, recommended: { id: string, why: string } | null, applied: string | null, tips: string[], presets: Array<{ id: string, runs: number[], minutesADay: number, note: string, citation: string, schedules: Array<{ id: string, name: string }> }> }>('pump_presets')
    expect(got.timezone).toBe('UTC')
    expect(got.guide).toBe('https://help.mygardyn.com/en/articles/4435265')
    expect(got.light).toEqual({ on: 421, off: 1260 })
    // An empty tower has no sowing date to go by, and no pump cycle yet.
    expect(got.recommended).toBeNull()
    expect(got.applied).toBeNull()
    expect(got.tips).toHaveLength(3)
    expect(got.presets.map(p => [p.id, p.runs.length, p.minutesADay])).toEqual([['seedlings', 1, 10], ['young', 2, 12], ['mature', 3, 18], ['fruiting', 3, 15]])
    expect(got.presets[0]?.citation).toMatch(/knowledge\/watering\/schedules\.md#seedlings$/)
    for (const s of got.presets[2]?.schedules ?? []) await call('upsert_schedule', s)
    const listed = await call<{ schedules: Array<{ id: string, name: string }> }>('list_schedules')
    expect(listed.schedules.map(s => s.id)).toEqual(expect.arrayContaining(['water-mature-0800', 'water-mature-1400', 'water-mature-2000']))
    expect((await call<{ applied: string | null }>('pump_presets')).applied).toBe('mature')
    // A cycle started today: the soak, under Seedlings.
    await call('grow_cycle', { action: 'start' })
    expect((await call<{ recommended: { id: string, why: string, soak?: boolean } | null }>('pump_presets')).recommended).toMatchObject({ id: 'seedlings', soak: true })
    await client.close()
  })

  it('reads today on the unit\'s clock, as the scheduler does, not the server\'s', async () => {
    // 12:00 UTC on Sunday 15 Nov is already Monday 02:00 on Kiritimati (UTC+14); a curve that runs only on Mondays is today's there.
    const { client, call } = await mcp({ now: () => new Date('2026-11-15T12:00:00Z'), timezone: 'Pacific/Kiritimati' })
    await call('upsert_schedule', { id: 'mon', kind: 'light', name: 'Mondays', days: 1, spec: { setpoints: [{ minute: 0, level: 0 }, { minute: 600, level: 100 }, { minute: 1200, level: 0 }] } })
    const got = await call<{ timezone: string, light: { on: number, off: number } | null }>('pump_presets')
    expect(got.timezone).toBe('Pacific/Kiritimati')
    // Lit from minute 3 (levels round to whole percent) to 19:58.
    expect(got.light).toEqual({ on: 3, off: 1198 })
    await client.close()
  })
})
