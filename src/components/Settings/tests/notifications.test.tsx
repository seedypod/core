// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotificationsSection } from '../NotificationsSection'

const { state, calls } = vi.hoisted(() => ({
  state: { status: undefined as unknown, error: null as null | { message: string }, pending: false },
  calls: { configure: vi.fn(), newTopic: vi.fn(), test: vi.fn(), invalidate: vi.fn() },
}))

vi.mock('@/src/utils/trpc', () => {
  const mutation = (name: 'configure' | 'newTopic' | 'test', withError = false) => ({
    useMutation: (o: { onSuccess: () => void }) => ({
      isPending: state.pending,
      error: withError ? state.error : null,
      mutate: (i?: unknown) => {
        calls[name](i)
        o.onSuccess()
      },
    }),
  })
  return {
    trpc: {
      useUtils: () => ({ notifications: { invalidate: calls.invalidate } }),
      notifications: {
        status: { useQuery: () => ({ data: state.status }) },
        configure: mutation('configure', true),
        newTopic: mutation('newTopic'),
        test: mutation('test'),
      },
    },
  }
})

const off = {
  target: 'off', ntfyServer: 'https://ntfy.sh', ntfyTopic: null, ntfyLink: null, qrSvg: null, webhookUrl: null, webhookFormat: 'json',
  hasWebhookSecret: false, groups: ['alerts', 'reminders', 'autopilot'], defaultGroups: ['alerts', 'reminders', 'autopilot'], last: null, pending: 0,
}
const ntfy = { ...off, target: 'ntfy', ntfyTopic: 'seedypod-abcdefghjkmn', ntfyLink: 'ntfy://ntfy.sh/seedypod-abcdefghjkmn?display=Gardyn', qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' }

beforeEach(() => {
  state.status = off
  state.error = null
  state.pending = false
  for (const f of Object.values(calls)) f.mockReset()
})
afterEach(cleanup)

const seg = (name: string) => screen.getByRole('tab', { name })

describe('Settings → Notifications', () => {
  it('keeps its anchor while loading, and shows only the picker when off', () => {
    state.status = undefined
    render(<NotificationsSection />)
    expect(document.getElementById('notifications')).toBeTruthy()
    expect(screen.queryByRole('tablist')).toBeNull()
    cleanup()
    state.status = off
    render(<NotificationsSection />)
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByText('Send test')).toBeNull()
  })

  it('turns on the phone path at once and shows the topic, QR and Android link', () => {
    render(<NotificationsSection />)
    fireEvent.click(seg('Phone'))
    expect(calls.configure).toHaveBeenCalledWith({ target: 'ntfy' })
    cleanup()
    state.status = ntfy
    render(<NotificationsSection />)
    expect(screen.getByTestId('ntfy-topic').textContent).toBe('seedypod-abcdefghjkmn')
    expect(screen.getByAltText('ntfy topic QR')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'open it on the phone' }).getAttribute('href')).toBe(ntfy.ntfyLink)
    expect(screen.getByText(/pass through ntfy\.sh/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'New topic' }))
    expect(calls.newTopic).toHaveBeenCalled()
  })

  it('names the owner\'s own ntfy server in the steps', () => {
    state.status = { ...ntfy, ntfyServer: 'https://ntfy.example.org' }
    render(<NotificationsSection />)
    expect(screen.getByText(/Pick https:\/\/ntfy\.example\.org as the server/)).toBeTruthy()
  })

  it('toggles event groups and sends a test, showing how the last one went', () => {
    state.status = { ...ntfy, last: { at: new Date().toISOString(), ok: false, title: 'Water low', detail: 'HTTP 503' } }
    render(<NotificationsSection />)
    expect(screen.getByText('last send failed')).toBeTruthy()
    expect(screen.getByText(/Failed just now: Water low · HTTP 503/)).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: 'Watering' }))
    expect(calls.configure).toHaveBeenLastCalledWith({ groups: ['alerts', 'reminders', 'autopilot', 'watering'] })
    fireEvent.click(screen.getByRole('switch', { name: 'Problems' }))
    expect(calls.configure).toHaveBeenLastCalledWith({ groups: ['reminders', 'autopilot'] })
    fireEvent.click(screen.getByRole('button', { name: 'Send test' }))
    expect(calls.test).toHaveBeenCalled()
  })

  it('asks for a webhook URL before switching to it, then saves URL, format and secret together', () => {
    render(<NotificationsSection />)
    fireEvent.click(seg('Webhook'))
    expect(calls.configure).not.toHaveBeenCalled()
    const save = screen.getByRole('button', { name: 'Save webhook' })
    expect((save as HTMLButtonElement).disabled).toBe(true)
    const [url, secret] = document.querySelectorAll('input[type=password]')
    fireEvent.change(url as Element, { target: { value: 'https://hooks.example.com/abc' } })
    fireEvent.change(secret as Element, { target: { value: 'k' } })
    fireEvent.click(save)
    expect(calls.configure).toHaveBeenCalledWith({ target: 'webhook', webhookFormat: 'json', webhookUrl: 'https://hooks.example.com/abc', webhookSecret: 'k' })
    fireEvent.change(url as Element, { target: { value: 'https://discord.com/api/webhooks/1/tok' } })
    expect(screen.queryByText('Signing secret')).toBeNull()
    fireEvent.click(save)
    expect(calls.configure).toHaveBeenLastCalledWith({ target: 'webhook', webhookFormat: 'discord', webhookUrl: 'https://discord.com/api/webhooks/1/tok', webhookSecret: 'k' })
  })

  it('shows a saved webhook masked, hides the secret for Discord, and switches to it at once', () => {
    state.status = { ...off, webhookUrl: 'https://discord.com/…abc1', webhookFormat: 'discord' }
    render(<NotificationsSection />)
    fireEvent.click(seg('Webhook'))
    expect(calls.configure).toHaveBeenCalledWith({ target: 'webhook' })
    expect(screen.getByText('Saved: https://discord.com/…abc1')).toBeTruthy()
    expect(screen.queryByText('Signing secret')).toBeNull()
    fireEvent.click(seg('JSON'))
    expect(screen.getByText('Signing secret')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save webhook' }))
    expect(calls.configure).toHaveBeenLastCalledWith({ target: 'webhook', webhookFormat: 'json' })
  })

  it('shows the server\'s refusal', () => {
    state.error = { message: 'Use https:// for a server off your network' }
    render(<NotificationsSection />)
    expect(screen.getByText(/Use https:\/\//)).toBeTruthy()
  })
})
