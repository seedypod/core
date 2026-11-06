import { observable } from '@trpc/server/observable'
import { describe, expect, it, vi } from 'vitest'
import { lazyDemoLink } from '../lazyLink'

const { demo } = vi.hoisted(() => ({
  demo: { fail: false, subscribed: 0, unsubscribed: 0 },
}))

vi.mock('../link', () => ({
  demoLink: () => {
    if (demo.fail) throw new Error('chunk gone')
    return () => () => observable<unknown, never>((observer) => {
      demo.subscribed += 1
      observer.next({ result: { data: 'answer' } })
      return () => {
        demo.unsubscribed += 1
      }
    })
  },
}))

const run = () => lazyDemoLink()({} as never)({ op: {} } as never)
const tick = () => new Promise(r => setTimeout(r))

describe('lazyDemoLink', () => {
  it('answers through the demo link once it has loaded', async () => {
    const next = vi.fn()
    const sub = run().subscribe({ next })
    await vi.waitFor(() => expect(next).toHaveBeenCalledWith({ result: { data: 'answer' } }))
    sub.unsubscribe()
    expect(demo.unsubscribed).toBe(1)
  })

  it('never starts an operation dropped before the link arrived', async () => {
    const before = demo.subscribed
    run().subscribe({}).unsubscribe()
    await tick()
    expect(demo.subscribed).toBe(before)
  })

  it('fails the operation when the demo chunk won\'t load', async () => {
    demo.fail = true
    const error = vi.fn()
    run().subscribe({ error })
    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce())
    demo.fail = false
  })
})
