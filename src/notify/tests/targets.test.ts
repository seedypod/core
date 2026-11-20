import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { alertTitle, buildRequest, enabledGroups, groupOf, maskUrl, newTopic, ntfyLink, urlProblem, type NotifyEvent } from '../targets'

const event: NotifyEvent = { group: 'alerts', type: 'raised', title: 'Water low', message: 'Tank at 8%', priority: 'high', at: '2026-11-20T10:00:00.000Z', data: { kind: 'water_low' } }

describe('notification targets', () => {
  it('sorts alert kinds into groups and names them', () => {
    expect(groupOf('water_low')).toBe('alerts')
    expect(groupOf('pump_schedule_missed')).toBe('alerts')
    expect(groupOf('reminder_harvest')).toBe('reminders')
    expect(groupOf('chore_top_off')).toBe('reminders')
    expect(groupOf('autopilot_4')).toBe('autopilot')
    expect(alertTitle('water_low')).toBe('Water low')
    expect(alertTitle('backup_stale')).toBe('Backup stale')
  })

  it('uses the default groups until the owner saves some, and drops unknown ones', () => {
    expect([...enabledGroups(null)]).toEqual(['alerts', 'reminders', 'autopilot'])
    expect([...enabledGroups(['watering', 'nope'])]).toEqual(['watering'])
    expect([...enabledGroups([])]).toEqual([])
  })

  it('makes long random topics without characters people misread', () => {
    const a = newTopic()
    expect(a).toMatch(/^seedypod-[a-hjkmnp-z2-9]{12}$/)
    expect(newTopic()).not.toBe(a)
    expect(newTopic(n => new Uint8Array(n))).toBe('seedypod-aaaaaaaaaaaa')
  })

  it('takes https anywhere and plain http only on the LAN', () => {
    expect(urlProblem('https://ntfy.sh')).toBeNull()
    for (const lan of ['http://homeassistant.local:8123/api/webhook/x', 'http://192.168.1.20/hook', 'http://10.0.0.5', 'http://172.20.1.1', 'http://localhost:9000', 'http://[::1]:80', 'http://box.lan', 'http://[fd12:3456::1]/']) expect(urlProblem(lan), lan).toBeNull()
    expect(urlProblem('http://example.com/hook')).toMatch(/https/)
    expect(urlProblem('http://172.32.0.1')).toMatch(/https/)
    expect(urlProblem('ftp://example.com')).toMatch(/https:\/\//)
    expect(urlProblem('not a url')).toMatch(/isn't a URL/)
  })

  it('masks all but the end of a webhook URL', () => {
    expect(maskUrl('https://discord.com/api/webhooks/123/secrettokenabc1')).toBe('https://discord.com/…abc1')
    expect(maskUrl('https://hooks.example.com/')).toBe('https://hooks.example.com')
    expect(maskUrl('garbage')).toBe('…')
  })

  it('links the Android app to the topic, over http when the server is', () => {
    expect(ntfyLink('https://ntfy.sh', 'seedypod-abc', 'Kitchen tower')).toBe('ntfy://ntfy.sh/seedypod-abc?display=Kitchen%20tower')
    expect(ntfyLink('http://ntfy.local:8080/', 'seedypod-abc', 'G')).toBe('ntfy://ntfy.local:8080/seedypod-abc?display=G&secure=false')
  })

  it('publishes to ntfy as JSON at the server root', async () => {
    const r = await buildRequest({ target: 'ntfy', server: 'https://ntfy.sh/', topic: 'seedypod-abc', unitName: 'Gardyn' }, event)
    expect(r.url).toBe('https://ntfy.sh/')
    expect(JSON.parse(r.body)).toEqual({ topic: 'seedypod-abc', title: 'Gardyn: Water low', message: 'Tank at 8%', priority: 4, tags: ['warning'] })
    const cleared = await buildRequest({ target: 'ntfy', server: 'https://ntfy.sh', topic: 't', unitName: 'G' }, { ...event, type: 'cleared', priority: 'low', message: '' })
    expect(JSON.parse(cleared.body)).toMatchObject({ message: 'Water low', priority: 2, tags: ['white_check_mark'] })
  })

  it('shapes the webhook body for each format', async () => {
    const hook = { target: 'webhook' as const, url: 'https://x.test/h', secret: null, unitName: 'Gardyn' }
    expect(JSON.parse((await buildRequest({ ...hook, format: 'discord' }, event)).body)).toEqual({ username: 'Gardyn', content: '**Gardyn** · Water low: Tank at 8%' })
    expect(JSON.parse((await buildRequest({ ...hook, format: 'slack' }, { ...event, message: '' })).body)).toEqual({ text: '*Gardyn* · Water low' })
    const json = await buildRequest({ ...hook, format: 'json' }, event)
    expect(JSON.parse(json.body)).toEqual({ event: 'alerts.raised', at: event.at, unit: 'Gardyn', title: 'Water low', message: 'Tank at 8%', priority: 'high', data: { kind: 'water_low' } })
    expect(json.headers['x-seedypod-signature']).toBeUndefined()
    expect(JSON.parse((await buildRequest({ ...hook, format: 'json' }, { ...event, group: 'test', type: 'test' })).body).event).toBe('test')
  })

  it('signs the exact body with HMAC-SHA256 when there is a secret', async () => {
    const r = await buildRequest({ target: 'webhook', url: 'https://x.test/h', format: 'json', secret: 's3cret', unitName: 'G' }, event)
    expect(r.headers['x-seedypod-signature']).toBe(`sha256=${createHmac('sha256', 's3cret').update(r.body).digest('hex')}`)
  })
})
