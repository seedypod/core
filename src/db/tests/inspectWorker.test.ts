import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { post, job } = vi.hoisted(() => ({ post: vi.fn(), job: { value: {} as unknown } }))

vi.mock('node:worker_threads', () => ({
  parentPort: { postMessage: post },
  get workerData() {
    return job.value
  },
}))
vi.mock('../scan', () => ({
  yieldToEventLoop: vi.fn(),
  runJob: (j: { fail?: boolean }) => {
    if (j.fail) throw new Error('boom')
    return { done: true }
  },
}))

beforeEach(() => {
  post.mockReset()
  vi.resetModules()
})
afterEach(() => vi.clearAllMocks())

describe('inspectWorker', () => {
  it('posts the result of its one job', async () => {
    job.value = {}
    await import('../inspectWorker')
    expect(post).toHaveBeenCalledWith({ result: { done: true } })
  })

  it('posts the error when the job throws', async () => {
    job.value = { fail: true }
    await import('../inspectWorker')
    expect(post).toHaveBeenCalledWith({ error: 'boom' })
  })
})
