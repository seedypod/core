import { describe, expect, it } from 'vitest'
import { connectAsync } from '../connect'

describe('the mqtt entry point', () => {
  it('names connectAsync, which a dynamic import of mqtt itself only has as default.connectAsync in the bundle', () => {
    expect(connectAsync).toBeTypeOf('function')
  })
})
