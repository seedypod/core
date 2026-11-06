import { observable } from '@trpc/server/observable'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { lazyDemoLink } from '../lazyLink'

const { demo } = vi.hoisted(() => ({
  demo: { fail: false, subscribed: 0, unsubscribed: 0, made: 0 },
}))

vi.mock('../link', () => ({
  demoLink: () => {
    if (demo.fail) throw new Error('chunk gone')
    demo.made += 1
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
  beforeEach(() => {
    demo.made = 0
  })

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

  it('loads nothing until an operation asks', async () => {
    const link = lazyDemoLink()
    demo.fail = true
    link({} as never)
    await tick()
    demo.fail = false
    const next = vi.fn()
    link({} as never)({ op: {} } as never).subscribe({ next })
    await vi.waitFor(() => expect(next).toHaveBeenCalledOnce())
  })

  it('fails an operation when the demo chunk won\'t load, and the next one tries again', async () => {
    const link = lazyDemoLink()({} as never)
    demo.fail = true
    const error = vi.fn()
    link({ op: {} } as never).subscribe({ error })
    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce())
    demo.fail = false
    const next = vi.fn()
    link({ op: {} } as never).subscribe({ next })
    await vi.waitFor(() => expect(next).toHaveBeenCalledOnce())
  })

  it('loads once for operations in flight together', async () => {
    const link = lazyDemoLink()({} as never)
    const a = vi.fn()
    const b = vi.fn()
    link({ op: {} } as never).subscribe({ next: a })
    link({ op: {} } as never).subscribe({ next: b })
    await vi.waitFor(() => expect(b).toHaveBeenCalledOnce())
    expect(a).toHaveBeenCalledOnce()
    expect(demo.made).toBe(1)
  })
})
