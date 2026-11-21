import type { inferRouterOutputs } from '@trpc/server'
import { useState } from 'react'
import { Button, InlineError, StatusDot } from '@/src/components/ds/core'
import { SegmentedControl, TextField, Toggle } from '@/src/components/ds/forms'
import { Row, Section } from '@/src/components/Settings/Section'
import { timeAgo } from '@/src/lib/timeAgo'
import { formatFor } from '@/src/notify/targets'
import type { AppRouter } from '@/src/server/routers/app'
import { trpc } from '@/src/utils/trpc'

type Status = inferRouterOutputs<AppRouter>['notifications']['status']
type Target = Status['target']
type Group = Status['groups'][number]

const TARGETS: ReadonlyArray<{ value: Target, label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'ntfy', label: 'Phone' },
  { value: 'webhook', label: 'Webhook' },
]

const GROUPS: ReadonlyArray<{ id: Group, label: string, sub: string }> = [
  { id: 'alerts', label: 'Problems', sub: 'Water low, pump faults, a camera or the hardware daemon down, and when they clear' },
  { id: 'reminders', label: 'Reminders', sub: 'Thin, feed, top off, check roots, harvest' },
  { id: 'autopilot', label: 'Autopilot', sub: 'When a rule\'s Notify fires' },
  { id: 'watering', label: 'Watering', sub: 'Every pump run. Several a day' },
  { id: 'lights', label: 'Lights', sub: 'On, off and dimming, and whether the schedule, Autopilot or a person did it' },
]

const FORMATS: ReadonlyArray<{ value: Status['webhookFormat'], label: string }> = [
  { value: 'json', label: 'JSON' },
  { value: 'discord', label: 'Discord' },
  { value: 'slack', label: 'Slack' },
]

/**
 * Settings → Notifications (ADR-0032): the ntfy app for most owners, with a
 * QR for Android and a topic to type on iPhone; a webhook for the rest.
 */
export function NotificationsSection() {
  const utils = trpc.useUtils()
  const q = trpc.notifications.status.useQuery()
  const refresh = { onSuccess: () => void utils.notifications.invalidate() }
  const configure = trpc.notifications.configure.useMutation(refresh)
  const newTopic = trpc.notifications.newTopic.useMutation(refresh)
  const test = trpc.notifications.test.useMutation(refresh)
  const [picked, setPicked] = useState<Target | null>(null)
  const s = q.data
  const title = 'Notifications'
  const sub = 'A message on your phone when the tower needs you.'
  if (!s) return <Section id="notifications" title={title} sub={sub} />
  const view = picked ?? s.target
  const pick = (t: Target) => {
    setPicked(t)
    // A webhook needs its URL first; the form below saves both.
    if (t !== 'webhook' || s.webhookUrl) configure.mutate({ target: t })
  }
  const setGroup = (g: Group, on: boolean) => configure.mutate({ groups: on ? [...s.groups, g] : s.groups.filter(x => x !== g) })
  const error = configure.error?.message ?? newTopic.error?.message ?? test.error?.message
  const last = s.last
  return (
    <Section
      id="notifications"
      title={title}
      sub={sub}
      right={s.target !== 'off' ? <StatusDot tone={last && !last.ok ? 'warn' : 'ok'} label={last && !last.ok ? 'last send failed' : 'on'} /> : undefined}
    >
      <Row label="Send to">
        <SegmentedControl ariaLabel="Send notifications to" size="sm" options={TARGETS} value={view} onChange={pick} />
      </Row>
      {view === 'ntfy' && s.ntfyTopic && <NtfySetup s={s} onNewTopic={() => newTopic.mutate()} busy={newTopic.isPending} />}
      {view === 'webhook' && <WebhookForm key={s.webhookUrl ?? ''} s={s} busy={configure.isPending} onSave={patch => configure.mutate({ ...patch, target: 'webhook' })} />}
      {error && <InlineError className="mb-3">{error}</InlineError>}
      {s.target !== 'off' && view === s.target && (
        <>
          {GROUPS.map(g => (
            <Row key={g.id} label={g.label} sub={g.sub}>
              <Toggle label={g.label} on={s.groups.includes(g.id)} disabled={configure.isPending} onChange={v => setGroup(g.id, v)} />
            </Row>
          ))}
          <Row
            label="Send a test"
            sub={last ? `${last.ok ? 'Sent' : 'Failed'} ${timeAgo(last.at)}: ${last.title} · ${last.detail}` : 'Nothing sent yet'}
          >
            <Button size="sm" disabled={test.isPending} onClick={() => test.mutate()}>{test.isPending ? 'Sending…' : 'Send test'}</Button>
          </Row>
        </>
      )}
    </Section>
  )
}

function NtfySetup({ s, onNewTopic, busy }: { s: Status, onNewTopic: () => void, busy: boolean }) {
  const [copied, setCopied] = useState(false)
  const topic = s.ntfyTopic ?? ''
  const ownServer = !/^https:\/\/ntfy\.sh$/.test(s.ntfyServer)
  return (
    <>
      <Row
        label="1. Get the ntfy app"
        sub="Free, on the App Store and Google Play. No account needed."
      />
      <Row
        label="2. Subscribe to this topic"
        sub={(
          <>
            Android: scan the code with the phone&apos;s camera, or
            {' '}
            <a className="underline underline-offset-2" href={s.ntfyLink ?? undefined}>open it on the phone</a>
            . iPhone: in ntfy tap +, and type the topic.
            {ownServer && ` Pick ${s.ntfyServer} as the server.`}
          </>
        )}
      >
        <div className="flex items-center gap-4">
          <div className="flex flex-col items-end gap-1.5">
            <span className="select-all font-mono text-[15px] tracking-[0.02em]" data-testid="ntfy-topic">{topic}</span>
            {typeof navigator !== 'undefined' && navigator.clipboard && (
              <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(topic).then(() => setCopied(true), () => {})}>{copied ? 'Copied' : 'Copy'}</Button>
            )}
          </div>
          {s.qrSvg && (
            <div className="shrink-0 rounded-ctl bg-white p-1.5">
              <img src={`data:image/svg+xml;utf8,${encodeURIComponent(s.qrSvg)}`} alt="ntfy topic QR" className="size-24" />
            </div>
          )}
        </div>
      </Row>
      <Row
        label="Keep the topic to yourself"
        sub={`Notifications pass through ${new URL(s.ntfyServer).host}, and anyone who knows the topic can read them. A new topic stops them on phones subscribed to this one.`}
      >
        <Button size="sm" disabled={busy} onClick={onNewTopic}>{busy ? 'Changing…' : 'New topic'}</Button>
      </Row>
    </>
  )
}

function WebhookForm({ s, busy, onSave }: { s: Status, busy: boolean, onSave: (patch: { webhookUrl?: string, webhookFormat: Status['webhookFormat'], webhookSecret?: string | null }) => void }) {
  const [url, setUrl] = useState('')
  const [format, setFormat] = useState(s.webhookFormat)
  const [secret, setSecret] = useState('')
  // Discord and Slack take only their own format, so their URL picks it.
  const fixed = url ? formatFor(url) : s.webhookFormatFixed ? s.webhookFormat : null
  const effective = fixed ?? format
  const changed = !!url || effective !== s.webhookFormat || !!secret
  return (
    <>
      <Row label="URL" sub={s.webhookUrl ? `Saved: ${s.webhookUrl}` : 'Discord, Slack, Home Assistant or your own server. https, or http on your network.'}>
        <TextField className="w-60" type="password" value={url} onChange={setUrl} placeholder={s.webhookUrl ? 'Paste a new one to replace it' : 'https://…'} />
      </Row>
      {fixed
        ? <Row label="Format" sub="Set by the URL"><span className="text-sm">{FORMATS.find(f => f.value === fixed)?.label}</span></Row>
        : (
            <Row label="Format">
              <SegmentedControl ariaLabel="Webhook format" size="sm" options={FORMATS} value={format} onChange={setFormat} />
            </Row>
          )}
      {effective === 'json' && (
        <Row label="Signing secret" sub={s.hasWebhookSecret ? 'set · signs each body in X-Seedypod-Signature' : 'Optional. Signs each body (HMAC-SHA256) in X-Seedypod-Signature'}>
          <TextField className="w-60" type="password" value={secret} onChange={setSecret} placeholder="••••••" />
        </Row>
      )}
      <div className="flex justify-end border-t border-line py-3">
        <Button
          size="sm"
          variant="primary"
          disabled={busy || (!changed && !!s.webhookUrl) || (!url && !s.webhookUrl)}
          onClick={() => onSave({ webhookFormat: effective, ...(url ? { webhookUrl: url } : {}), ...(secret ? { webhookSecret: secret } : {}) })}
        >
          {busy ? 'Saving…' : 'Save webhook'}
        </Button>
      </div>
    </>
  )
}
