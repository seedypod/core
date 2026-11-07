import { encode } from 'jpeg-js'
import { describe, expect, it } from 'vitest'
import { createWorkerExecutor } from '../workerExecutor'
import { jpeg } from './fixtures'

// Runs the real worker entry through tsx, the way `node server/dist/visionWorker.js` runs it on a unit.
const script = new URL('../visionWorker.ts', import.meta.url)

describe('worker executor', () => {
  it('scores stills off the main thread and leaves the caller\'s buffer intact', async () => {
    const w = createWorkerExecutor(script, { execArgv: ['--import', 'tsx'] })
    try {
      const bytes = jpeg(90, 75, true)
      const out = await w.run({ bytes, camera: 'upper', analyzers: ['green-threshold', 'exg-otsu'], opts: { artifacts: true } })
      if (!Array.isArray(out)) throw new Error('should have scored it')
      expect(out.map(o => o.analyzer)).toEqual(['green-threshold', 'exg-otsu'])
      expect(out[1]?.artifacts?.[0]?.bytes.byteLength).toBeGreaterThan(0)
      expect(bytes.byteLength).toBeGreaterThan(0)
      expect(await w.run({ bytes: new Uint8Array([1]), camera: 'lower', analyzers: ['exg-otsu'], opts: { artifacts: false } })).toBeNull()
      const data = new Uint8Array(64 * 64 * 4)
      for (let i = 0; i < data.length; i += 4) data.set([0, 135, 0, 255], i)
      const torn = new Uint8Array(encode({ data, width: 64, height: 64 }, 85).data)
      expect(await w.run({ bytes: torn, camera: 'upper', analyzers: ['exg-otsu'], opts: { artifacts: false } })).toBe('damaged')
    }
    finally {
      await w.close()
    }
  }, 20_000)

  it('fails in-flight jobs when the worker cannot start', async () => {
    const broken = createWorkerExecutor(new URL('./does-not-exist.js', import.meta.url))
    await expect(broken.run({ bytes: jpeg(10, 10, false), camera: 'upper', analyzers: [], opts: { artifacts: false } })).rejects.toThrow()
    await broken.close()
  }, 20_000)
})
