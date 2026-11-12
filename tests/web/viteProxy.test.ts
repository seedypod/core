import { afterEach, describe, expect, it, vi } from 'vitest'

interface Proxied { target: string, changeOrigin: boolean, headers?: Record<string, string> }
const proxy = async () => {
  vi.resetModules()
  const config = (await import('../../web/vite.config')).default as { server: { proxy: Record<string, Proxied> } }
  return config.server.proxy['/api'] as Proxied
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the web dev server\'s API proxy', () => {
  it('goes to a local core by default, with no key', async () => {
    vi.stubEnv('API_TARGET', '')
    vi.stubEnv('API_KEY', '')
    const p = await proxy()
    expect(p.target).toBe('http://127.0.0.1:3000')
    expect(p.headers).toBeUndefined()
  })

  it('points at a unit and sends its API key from the server side', async () => {
    vi.stubEnv('API_TARGET', 'http://seedypod.local:3000')
    vi.stubEnv('API_KEY', 'sekrit')
    const p = await proxy()
    expect(p).toMatchObject({ target: 'http://seedypod.local:3000', changeOrigin: true, headers: { 'x-api-key': 'sekrit' } })
  })
})
