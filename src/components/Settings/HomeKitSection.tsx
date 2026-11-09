import { useState } from 'react'
import { Button, InlineError, StatusDot } from '@/src/components/ds/core'
import { Alert } from '@/src/components/ds/feedback'
import { Toggle } from '@/src/components/ds/forms'
import { Row, Section } from '@/src/components/Settings/Section'
import { trpc } from '@/src/utils/trpc'

/**
 * Settings → Apple Home (ADR 0023): the HomeKit switch, the setup code and its
 * QR, who's paired, and a pairing reset.
 */
export function HomeKitSection() {
  const utils = trpc.useUtils()
  const q = trpc.homekit.status.useQuery(undefined, {
    // Pairing happens in the Home app: check often while a code is on screen, and now
    // and then after, since controllers Home adds or removes later send core no event.
    refetchInterval: query => (!query.state.data?.running ? false : query.state.data.pairedControllers === 0 ? 5000 : 30_000),
  })
  const refresh = { onSuccess: () => void utils.homekit.invalidate() }
  const setEnabled = trpc.homekit.setEnabled.useMutation(refresh)
  const reset = trpc.homekit.resetPairing.useMutation(refresh)
  const [confirmReset, setConfirmReset] = useState(false)
  const s = q.data
  const title = 'Apple Home'
  const sub = 'Adds the grow light, pump and sensors to the Home app over HomeKit. Local only: nothing goes through Apple\'s servers.'
  if (!s) return <Section id="homekit" title={title} sub={sub} />
  if (!s.available) return <Section id="homekit" title={title} sub="HomeKit runs on the unit. It isn't available in this demo." />
  const busy = setEnabled.isPending || reset.isPending || s.transitioning
  const paired = s.pairedControllers
  const error = setEnabled.error?.message ?? reset.error?.message ?? (s.enabled && !s.running ? s.error : null)
  return (
    <Section
      id="homekit"
      title={title}
      sub={sub}
      right={s.enabled ? <StatusDot tone={s.running ? 'ok' : 'warn'} label={s.running ? 'on' : busy ? 'starting' : 'not running'} /> : undefined}
    >
      <Row label="HomeKit" sub="Off by default. Uses no memory until turned on.">
        <Toggle label="HomeKit" on={s.enabled} disabled={busy} onChange={v => setEnabled.mutate({ enabled: v })} />
      </Row>
      {error && <InlineError className="mb-3">{error}</InlineError>}
      {s.running && s.setupCode && (
        <Row
          label="Setup code"
          sub={paired === 0 ? 'In the Home app, tap + → Add Accessory and scan this code, or enter it.' : 'Already added to Home. To add this unit to another home, share it from the Home app.'}
        >
          <div className="flex items-center gap-4">
            <span className="font-mono text-[22px] tracking-[0.06em]" data-testid="homekit-code">{s.setupCode}</span>
            {s.qrSvg && (
              <div className="shrink-0 rounded-ctl bg-white p-1.5">
                <img src={`data:image/svg+xml;utf8,${encodeURIComponent(s.qrSvg)}`} alt="HomeKit setup code QR" className="size-24" />
              </div>
            )}
          </div>
        </Row>
      )}
      {s.enabled && (
        <Row label="Paired" sub={paired === 0 ? 'Not added to Home yet' : undefined}>
          <span className="font-mono text-sm" data-testid="homekit-paired">{paired === 0 ? 'no' : `${paired} controller${paired === 1 ? '' : 's'}`}</span>
        </Row>
      )}
      {s.enabled && (
        <Row label="Reset pairing" sub="Removes it from every Home and issues a new code and QR">
          <Button size="sm" variant="danger" disabled={busy || confirmReset} onClick={() => setConfirmReset(true)}>{reset.isPending ? 'Resetting…' : 'Reset pairing'}</Button>
        </Row>
      )}
      {confirmReset && (
        <Alert
          tone="warn"
          className="mb-3"
          action={(
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  reset.mutate()
                  setConfirmReset(false)
                }}
              >
                Reset
              </Button>
              <Button size="sm" onClick={() => setConfirmReset(false)}>Cancel</Button>
            </div>
          )}
        >
          Remove this unit from the Home app too: its tiles stay “No Response” until you do. Then add it again with the new code.
        </Alert>
      )}
    </Section>
  )
}
