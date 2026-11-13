import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { SimHal } from '../../hardware/sim'
import { createMcpServer } from '../../mcp/server'
import { LIGHT_PRESETS } from '../../scheduler/lightPlan'
import { MemoryStore } from '../../store/memory'
import { createCore } from '../bootstrap'

async function mcp() {
  const store = new MemoryStore(30)
  store.settings.update({ timezone: 'America/Los_Angeles' })
  const core = createCore({ hal: new SimHal({ tickMs: 0 }), store, version: 'test', now: () => new Date('2026-11-12T18:00:00Z') })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await createMcpServer(core.ctx).connect(a)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(b)
  const raw = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<{ isError?: boolean, content: Array<{ text: string }> }>
  const call = async <T>(name: string, args: Record<string, unknown> = {}) => JSON.parse((await raw(name, args)).content[0]?.text ?? '') as T
  return { client, call, raw }
}

interface Listed { schedules: Array<{ id: string, kind: string, name: string, enabled: boolean, spec: { setpoints?: Array<{ minute: number }>, minute?: number } }> }

describe('the unit\'s location over MCP', () => {
  it('sets it, moves Auto to the new sun, and clears it back to the timezone\'s city', async () => {
    const { client, call, raw } = await mcp()
    await call('light_auto', { on: true })
    const auto = async () => (await call<Listed>('list_schedules')).schedules.find(s => s.id === 'auto')?.spec.setpoints?.map(p => p.minute)
    const nearLA = await auto()
    // Seattle's day is shorter and its noon later than Los Angeles'.
    expect(await call('set_location', { latitude: 47.61, longitude: -122.33 })).toEqual({ latitude: 47.61, longitude: -122.33, timezone: 'America/Los_Angeles' })
    expect(await auto()).not.toEqual(nearLA)
    expect(await call('set_location', { latitude: null, longitude: null })).toMatchObject({ latitude: null, longitude: null })
    expect(await auto()).toEqual(nearLA)
    const half = await raw('set_location', { latitude: 47.61, longitude: null })
    expect(half.isError).toBe(true)
    expect(half.content[0]?.text).toMatch(/both latitude and longitude, or neither/)
    await client.close()
  })
})

describe('saving light and water together over MCP', () => {
  it('saves one of Your schedules with a light preset, uses it at once, and changes it by id', async () => {
    const { client, call, raw } = await mcp()
    const preset = LIGHT_PRESETS[0]
    const saved = await call<{ id: string, name: string, active: boolean, lightPresetId: string | null }>('save_schedule', {
      name: 'Short days',
      cycles: [{ minute: 480, durationS: 300, days: 127 }, { minute: 1080, durationS: 300, days: 127 }],
      light_preset_id: preset?.id,
      activate: true,
    })
    expect(saved).toMatchObject({ id: 'short-days', name: 'Short days', active: true, lightPresetId: preset?.id })
    const after = (await call<Listed>('list_schedules')).schedules
    expect(after.filter(s => s.kind === 'pump').map(s => s.spec.minute)).toEqual([480, 1080])
    expect(after.filter(s => s.kind === 'light' && s.enabled).map(s => s.name)).toEqual([preset?.name])

    // In use, a change by id moves the pump with it; the light preset stays unless given.
    const changed = await call<{ id: string, lightPresetId: string | null }>('save_schedule', { id: 'short-days', cycles: [{ minute: 540, durationS: 600, days: 127 }] })
    expect(changed.lightPresetId).toBe(preset?.id)
    expect((await call<Listed>('list_schedules')).schedules.filter(s => s.kind === 'pump').map(s => s.spec.minute)).toEqual([540])

    // Saved without activate, it waits in the library.
    expect(await call('save_schedule', { name: 'Later', cycles: [{ minute: 600, durationS: 300, days: 1 }] })).toMatchObject({ id: 'later', active: false, lightPresetId: null })
    const bare = await raw('save_schedule', { name: 'No cycles' })
    expect(bare.isError).toBe(true)
    expect(bare.content[0]?.text).toMatch(/needs a name and its cycles/)
    await client.close()
  })
})
