import { describe, expect, it, vi } from 'vitest'
import { SimHal } from '../../hardware/sim'
import { MemoryStore } from '../../store/memory'
import { createCore } from '../bootstrap'
import { openApiDocument } from '../openapi'
import { appRouter } from '../routers/app'
import { createCallerFactory } from '../trpc'

function unit() {
  const store = new MemoryStore()
  const fetch = vi.fn(async () => new Response('ok'))
  const core = createCore({ hal: new SimHal({ tickMs: 0 }), store, version: 'test', notifyFetch: fetch as unknown as typeof globalThis.fetch })
  return { store, fetch, c: createCallerFactory(appRouter)(core.ctx) }
}

describe('notifications router', () => {
  it('starts off with the default groups, and refuses a test until a target is picked', async () => {
    const { c } = unit()
    expect(await c.notifications.status()).toMatchObject({ target: 'off', ntfyTopic: null, ntfyLink: null, qrSvg: null, webhookUrl: null, groups: ['alerts', 'reminders', 'autopilot'], last: null, pending: 0 })
    await expect(c.notifications.test()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })

  it('makes a random topic and a QR when ntfy is picked, keeps it, and replaces it on request', async () => {
    const { c, fetch } = unit()
    const on = await c.notifications.configure({ target: 'ntfy' })
    expect(on.ntfyTopic).toMatch(/^seedypod-/)
    expect(on.ntfyLink).toBe(`ntfy://ntfy.sh/${on.ntfyTopic}?display=Gardyn`)
    expect(on.qrSvg).toMatch(/^<svg/)
    expect((await c.notifications.configure({ target: 'off' })).qrSvg).toBeNull()
    expect((await c.notifications.configure({ target: 'ntfy' })).ntfyTopic).toBe(on.ntfyTopic)
    expect((await c.notifications.newTopic()).ntfyTopic).not.toBe(on.ntfyTopic)
    expect(await c.notifications.test()).toMatchObject({ ok: true, detail: 'HTTP 200' })
    expect(fetch).toHaveBeenCalledWith('https://ntfy.sh/', expect.objectContaining({ method: 'POST' }))
    expect((await c.notifications.status()).last).toMatchObject({ ok: true, title: 'Test notification' })
  })

  it('stores a webhook but only ever returns it masked, with whether it is signed', async () => {
    const { c, store } = unit()
    const url = 'https://discord.com/api/webhooks/42/verysecrettoken'
    const s = await c.notifications.configure({ target: 'webhook', webhookUrl: url, webhookFormat: 'discord', webhookSecret: 'k', groups: ['watering', 'alerts', 'watering'] })
    expect(s).toMatchObject({ target: 'webhook', webhookUrl: 'https://discord.com/…oken', webhookFormat: 'discord', hasWebhookSecret: true, groups: ['watering', 'alerts'] })
    expect(JSON.stringify(await c.notifications.status())).not.toContain('verysecret')
    expect(JSON.stringify(await c.settings.get())).not.toContain('verysecret')
    expect(store.settings.get().webhookUrl).toBe(url)
    expect((await c.notifications.configure({ webhookSecret: '' })).hasWebhookSecret).toBe(false)
  })

  it('refuses plain http off the LAN and a webhook target with no URL', async () => {
    const { c } = unit()
    await expect(c.notifications.configure({ target: 'webhook' })).rejects.toThrow(/Paste the webhook URL/)
    await expect(c.notifications.configure({ target: 'webhook', webhookUrl: 'http://example.com/h' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(c.notifications.configure({ ntfyServer: 'http://ntfy.example.com' })).rejects.toThrow(/https/)
    expect((await c.notifications.configure({ target: 'webhook', webhookUrl: 'http://homeassistant.local:8123/api/webhook/abc' })).target).toBe('webhook')
    expect((await c.notifications.configure({ ntfyServer: 'http://192.168.1.5:8080/' })).ntfyServer).toBe('http://192.168.1.5:8080')
  })

  it('is in the OpenAPI document', () => {
    const paths = Object.keys(openApiDocument('http://localhost:3000/api').paths ?? {})
    expect(paths).toEqual(expect.arrayContaining(['/notifications', '/notifications/topic', '/notifications/test']))
  })
})
