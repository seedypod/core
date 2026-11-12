import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHal } from '../../hardware/factory'
import { createEventBus } from '../../lib/eventBus'
import { MemoryStore } from '../../store/memory'
import { SimHal } from '../../hardware/sim'
import { connectBridge } from '../bridge'
import { connectAsync } from '../connect'

const fake = { on: vi.fn(), subscribe: vi.fn(), publish: vi.fn(), end: vi.fn() }

vi.mock('mqtt', () => ({ connectAsync: vi.fn(async () => fake) }))

afterEach(() => vi.clearAllMocks())

describe('the mqtt entry point', () => {
  it('names connectAsync, which a dynamic import of mqtt itself only has as default.connectAsync in the bundle', () => {
    expect(connectAsync).toBeTypeOf('function')
  })

  it('is what the hardware client connects through', async () => {
    const hal = await createHal({ events: createEventBus(), mqttUrl: 'mqtt://127.0.0.1:1883', unitId: 'u1' })
    expect(connectAsync).toHaveBeenCalledWith('mqtt://127.0.0.1:1883', expect.objectContaining({ reconnectPeriod: 5000 }))
    await hal.close().catch(() => undefined)
  })

  it('is what the Home Assistant bridge connects through', async () => {
    const store = new MemoryStore()
    store.settings.update({ mqttUrl: 'mqtt://ha.local:1883' })
    const bridge = await connectBridge({ store, hal: new SimHal({ tickMs: 0 }), events: createEventBus(), unitId: 'u1' })
    expect(connectAsync).toHaveBeenCalledWith('mqtt://ha.local:1883', expect.objectContaining({ clientId: 'seedypod-core-bridge-u1' }))
    bridge?.stop()
  })
})
