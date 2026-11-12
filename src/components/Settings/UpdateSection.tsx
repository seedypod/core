import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { Button, InlineError, StatusDot } from '@/src/components/ds/core'
import { Alert } from '@/src/components/ds/feedback'
import { SegmentedControl } from '@/src/components/ds/forms'
import { Row, Section } from '@/src/components/Settings/Section'
import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '@/src/server/routers/app'
import { trpc } from '@/src/utils/trpc'

type Channel = 'stable' | 'dev'
type Status = NonNullable<inferRouterOutputs<AppRouter>['update']['status']['status']>

const RUNNING = new Set(['queued', 'downloading', 'verifying', 'stopping', 'swapping', 'installing', 'starting', 'health', 'rolling-back'])

const STEPS: Record<string, string> = {
  'queued': 'Starting…',
  'downloading': 'Downloading the release…',
  'verifying': 'Checking the download…',
  'stopping': 'Stopping the unit…',
  'swapping': 'Putting the new version in place…',
  'installing': 'Installing dependencies…',
  'starting': 'Starting the unit again…',
  'health': 'Waiting for the new version to answer…',
  'rolling-back': 'Something went wrong. Putting the previous version back…',
}

const short = (commit: string | null | undefined) => (commit ? commit.slice(0, 7) : '')
const when = (ts: string) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/**
 * Settings → Updates (ADR-0026): the channel, what's installed against what
 * GitHub has, an Update button, and the run's progress and log. Asking GitHub
 * is always a button press: core never checks by itself. Live through
 * `update` events; while core itself restarts, it polls until core is back.
 */
export function UpdateSection({ version }: { version?: string }) {
  const utils = trpc.useUtils()
  const q = trpc.update.status.useQuery(undefined, {
    refetchInterval: query => (RUNNING.has(query.state.data?.status?.state ?? '') ? 1500 : false),
    retry: true,
    retryDelay: 1500,
  })
  const refresh = { onSuccess: () => void utils.update.invalidate() }
  const check = trpc.update.check.useMutation()
  const setChannel = trpc.update.setChannel.useMutation({ onSuccess: () => {
    check.reset()
    void utils.update.invalidate()
  } })
  const start = trpc.update.start.useMutation(refresh)
  const [confirm, setConfirm] = useState(false)
  const [started, setStarted] = useState(false)
  const info = q.data
  const title = 'Updates'
  const sub = 'Installs the newest release from GitHub when you ask. Nothing is built on the unit, and each download must match its checksum. This is the only time the unit goes online.'
  if (!info) return <Section id="update" title={title} sub={sub} />
  if (!info.available) return <Section id="update" title={title} sub="The update helper isn't installed on this core. Run scripts/install on the unit, or update over SSH." />

  const st = info.status
  const running = RUNNING.has(st?.state ?? '') || start.isPending
  const found = check.data
  const ready = !!found && found.updateAvailable && !found.problem
  const target = found ? (found.available.tag.startsWith('v') ? found.available.tag : `${found.available.tag} (${short(found.available.commit)})`) : ''
  const error = check.error?.message ?? setChannel.error?.message ?? start.error?.message
  return (
    <Section
      id="update"
      title={title}
      sub={sub}
      right={running ? <StatusDot tone="warn" label="updating" /> : undefined}
    >
      <Row label="Installed" sub={info.tag ? `Release ${info.tag}` : undefined}>
        <span className="font-mono text-sm" data-testid="update-installed">{version ?? '…'}</span>
      </Row>
      <Row label="Channel" sub="Stable is the latest release. Dev is rebuilt on every change and may break.">
        <SegmentedControl
          size="sm"
          ariaLabel="Update channel"
          value={info.channel}
          options={[{ value: 'stable', label: 'Stable' }, { value: 'dev', label: 'Dev' }]}
          onChange={(c: Channel) => {
            if (!running && c !== info.channel) setChannel.mutate({ channel: c })
          }}
        />
      </Row>
      <Row
        label="Available"
        sub={found
          ? found.problem
            ? `Can't update from it: ${found.problem}`
            : found.updateAvailable
              ? `${found.available.name}${found.available.publishedAt ? `, published ${when(found.available.publishedAt)}` : ''}`
              : 'Up to date'
          : 'Asks GitHub for the newest release on this channel'}
      >
        <div className="flex items-center gap-2">
          {found && <span className="font-mono text-sm" data-testid="update-available">{target}</span>}
          <Button size="sm" icon={RefreshCw} disabled={check.isPending || running} onClick={() => check.mutate()}>{check.isPending ? 'Checking…' : 'Check for updates'}</Button>
        </div>
      </Row>
      {ready && !running && (
        <Row label="Update" sub="The unit stops while it updates, for a few minutes on a Pi Zero">
          <Button size="sm" variant="primary" disabled={confirm} onClick={() => setConfirm(true)}>{`Update to ${target}`}</Button>
        </Row>
      )}
      {confirm && !running && (
        <Alert
          tone="warn"
          className="mb-3"
          action={(
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  setConfirm(false)
                  setStarted(true)
                  start.mutate()
                }}
              >
                Update
              </Button>
              <Button size="sm" onClick={() => setConfirm(false)}>Cancel</Button>
            </div>
          )}
        >
          Schedules and the pump pause while the unit restarts. If the new version doesn&apos;t come up healthy, the previous one is put back by itself.
        </Alert>
      )}
      {error && <InlineError className="mb-3">{error}</InlineError>}
      {st && <Outcome status={st} started={started} />}
      {st && info.log.length > 0 && (running || st.state !== 'done') && (
        <pre aria-label="Update log" data-testid="update-log" className="mb-3 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-ctl border border-line bg-field p-2.5 font-mono text-[11px] leading-[1.5] text-fg-2">
          {info.log.slice(-40).join('\n')}
        </pre>
      )}
    </Section>
  )
}

function Outcome({ status: st, started }: { status: Status, started: boolean }) {
  const to = st.to ? (st.to.tag.startsWith('v') ? st.to.tag : `${st.to.tag} (${short(st.to.commit)})`) : 'the new version'
  if (RUNNING.has(st.state)) {
    return (
      <div className="flex items-center gap-2 pb-3 text-sm text-fg-2" role="status" data-testid="update-progress">
        <RefreshCw size={15} className="animate-spin" />
        {STEPS[st.state] ?? 'Updating…'}
      </div>
    )
  }
  if (st.state === 'done') {
    return (
      <div className="flex flex-wrap items-center gap-3 pb-3 text-[13px] text-fg-2" role="status" data-testid="update-result">
        <span>{`Updated to ${to} on ${when(st.at)}.`}</span>
        {started && <Button size="sm" onClick={() => window.location.reload()}>Reload the page</Button>}
      </div>
    )
  }
  if (st.state === 'rolled-back') {
    return <Alert tone="warn" className="mb-3">{`The update to ${to} failed, so the previous version was put back: ${st.error ?? 'unknown error'}`}</Alert>
  }
  if (st.state === 'rollback-failed') {
    return <Alert tone="danger" className="mb-3">{`The update to ${to} failed and the previous version didn't come back: ${st.error ?? 'unknown error'}. Over SSH, run sudo seedypod-update --rollback.`}</Alert>
  }
  return <InlineError className="mb-3">{`The update didn't start, and nothing changed: ${st.error ?? 'unknown error'}`}</InlineError>
}
