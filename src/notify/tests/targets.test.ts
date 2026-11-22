import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { alertTitle, buildRequest, emojiFor, enabledGroups, formatFor, formatProblem, groupOf, maskUrl, newTopic, ntfyLink, urlProblem, type NotifyEvent } from '../targets'

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
  })

  it('knows the format Discord and Slack webhooks take', () => {
    expect(formatFor('https://discord.com/api/webhooks/1/tok')).toBe('discord')
    expect(formatFor('https://ptb.discordapp.com/api/webhooks/1/tok')).toBe('discord')
    expect(formatFor('https://discord.com/api/webhooks/1/tok/slack')).toBe('slack')
    expect(formatFor('https://hooks.slack.com/services/T/B/x')).toBe('slack')
    expect(formatFor('https://discord.com/channels/1')).toBeNull()
    expect(formatFor('http://homeassistant.local:8123/api/webhook/x')).toBeNull()
    expect(formatFor('nope')).toBeNull()
    expect(formatProblem('https://discord.com/api/webhooks/1/tok', 'slack')).toBe('That URL only takes Discord messages: pick Discord as the format.')
    expect(formatProblem('https://discord.com/api/webhooks/1/tok', 'discord')).toBeNull()
    expect(formatProblem('https://hooks.example.com/x', 'slack')).toBeNull()
    expect(maskUrl('garbage')).toBe('…')
  })

  it('links the Android app to the topic, over http when the server is', () => {
    expect(ntfyLink('https://ntfy.sh', 'seedypod-abc', 'Kitchen tower')).toBe('ntfy://ntfy.sh/seedypod-abc?display=Kitchen%20tower')
    expect(ntfyLink('http://ntfy.local:8080/', 'seedypod-abc', 'G')).toBe('ntfy://ntfy.local:8080/seedypod-abc?display=G&secure=false')
  })

  it('leads each event with one emoji', () => {
    const of = (e: Partial<NotifyEvent>) => emojiFor({ ...event, ...e })[0]
    expect(of({})).toBe('🚱')
    expect(of({ data: { kind: 'camera_link_lower' } })).toBe('📷')
    expect(of({ data: { kind: 'backup_stale' } })).toBe('⚠️')
    expect(of({ group: 'reminders', data: { kind: 'reminder_harvest' } })).toBe('🧺')
    expect(of({ group: 'reminders', data: { kind: 'reminder_new' } })).toBe('🌱')
    expect(of({ group: 'autopilot', data: { kind: 'autopilot_4' } })).toBe('🤖')
    expect(of({ type: 'cleared' })).toBe('✅')
    expect(of({ group: 'test', type: 'test' })).toBe('🔔')
    expect(of({ group: 'watering', type: 'ran', data: { endedBy: 'schedule' } })).toBe('💧')
    expect(of({ group: 'watering', type: 'ran', data: { endedBy: 'fault' } })).toBe('⚠️')
    expect(['0>80', '40>80', '80>40', '80>0'].map(m => of({ group: 'lights', type: 'changed', data: { from: Number(m.split('>')[0]), to: Number(m.split('>')[1]) } }))).toEqual(['💡', '💡', '🔅', '🌙'])
    expect(emojiFor({ ...event, type: 'cleared' })[1]).toBe('white_check_mark')
  })

  it('publishes to ntfy as JSON at the server root', async () => {
    const r = await buildRequest({ target: 'ntfy', server: 'https://ntfy.sh/', topic: 'seedypod-abc', unitName: 'Gardyn' }, event)
    expect(r.url).toBe('https://ntfy.sh/')
    expect(JSON.parse(r.body)).toEqual({ topic: 'seedypod-abc', title: 'Gardyn: Water low', message: 'Tank at 8%', priority: 4, tags: ['non-potable_water'] })
    const cleared = await buildRequest({ target: 'ntfy', server: 'https://ntfy.sh', topic: 't', unitName: 'G' }, { ...event, type: 'cleared', priority: 'low', message: '' })
    expect(JSON.parse(cleared.body)).toMatchObject({ message: 'Water low', priority: 2, tags: ['white_check_mark'] })
  })

  it('shapes the webhook body for each format', async () => {
    const hook = { target: 'webhook' as const, url: 'https://x.test/h', secret: null, unitName: 'Gardyn' }
    expect(JSON.parse((await buildRequest({ ...hook, format: 'discord' }, event)).body)).toEqual({ username: 'Gardyn', content: '**Gardyn** · 🚱 Water low: Tank at 8%' })
    expect(JSON.parse((await buildRequest({ ...hook, format: 'slack' }, { ...event, message: '' })).body)).toEqual({ text: '*Gardyn* · 🚱 Water low' })
    const json = await buildRequest({ ...hook, format: 'json' }, event)
    expect(JSON.parse(json.body)).toEqual({ event: 'alerts.raised', at: event.at, unit: 'Gardyn', title: 'Water low', emoji: '🚱', message: 'Tank at 8%', priority: 'high', data: { kind: 'water_low' } })
    expect(json.headers['x-seedypod-signature']).toBeUndefined()
    expect(JSON.parse((await buildRequest({ ...hook, format: 'json' }, { ...event, group: 'test', type: 'test' })).body).event).toBe('test')
  })

  it('signs the exact body with HMAC-SHA256 when there is a secret', async () => {
    const r = await buildRequest({ target: 'webhook', url: 'https://x.test/h', format: 'json', secret: 's3cret', unitName: 'G' }, event)
    expect(r.headers['x-seedypod-signature']).toBe(`sha256=${createHmac('sha256', 's3cret').update(r.body).digest('hex')}`)
  })
})
