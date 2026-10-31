import { Lock, Wifi as WifiIcon } from 'lucide-react'
import { useState } from 'react'
import { Button, Card, CardHeader, InlineError, KeyValue, SectionLabel, StatusDot } from '@/src/components/ds/core'
import { TextField } from '@/src/components/ds/forms'
import { PageHeader } from '@/src/components/ds/layout'
import { trpc } from '@/src/utils/trpc'

/**
 * Wi-Fi: which network the unit is on, and the setup flow. Hold the button
 * for 10 s to open the setup hotspot, join it from a phone, and pick the
 * home network here.
 */
export function WifiPage() {
  const utils = trpc.useUtils()
  const status = trpc.network.status.useQuery(undefined, { refetchInterval: 5000 })
  const scan = trpc.network.scan.useQuery(undefined, { enabled: !!status.data?.available })
  const startSetup = trpc.network.startSetup.useMutation({ onSuccess: () => utils.network.invalidate() })
  const stopSetup = trpc.network.stopSetup.useMutation({ onSuccess: () => utils.network.invalidate() })
  const [picked, setPicked] = useState<{ ssid: string, secure: boolean } | null>(null)
  const s = status.data

  if (s && !s.available) {
    return (
      <div className="mx-auto flex max-w-[720px] flex-col gap-4">
        <PageHeader title="Wi-Fi" />
        <Card dashed><p className="text-[13px] text-fg-2">This core isn&apos;t running on a unit with NetworkManager, so Wi-Fi is managed by the host.</p></Card>
      </div>
    )
  }

  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-4">
      <PageHeader title="Wi-Fi" />
      {s?.mode === 'setup' && s.setup && (
        <Card highlight>
          <CardHeader title="Setup hotspot is on" subtitle={`Open network ${s.setup.ssid} · closes at ${new Date(s.setup.until).toLocaleTimeString()}`} icon={WifiIcon} />
          <p className="mt-2 text-[13px] text-fg-2">Pick your home network below. The unit leaves the hotspot and joins it; then reconnect your phone to your home network and open http://seedypod.local:3000.</p>
          <div className="mt-3"><Button size="sm" disabled={stopSetup.isPending} onClick={() => stopSetup.mutate()}>Close the hotspot</Button></div>
        </Card>
      )}
      {s?.lastError && <InlineError>{s.lastError}</InlineError>}

      <Card>
        <CardHeader
          title="Connection"
          icon={WifiIcon}
          right={s && <StatusDot tone={s.mode === 'client' ? 'ok' : 'warn'} label={s.mode === 'client' ? 'connected' : s.mode === 'setup' ? 'setup hotspot' : 'offline'} />}
        />
        <KeyValue label="Network" value={s?.mode === 'client' ? s.ssid ?? '—' : '—'} />
        <KeyValue label="Address" value={s?.ip ?? '—'} />
        {s?.mode !== 'setup' && (
          <div className="mt-3 flex flex-col gap-1">
            <div><Button size="sm" disabled={startSetup.isPending} onClick={() => startSetup.mutate({ minutes: 15 })}>Open setup hotspot</Button></div>
            <p className="text-xs text-fg-3">Same as holding the unit&apos;s button for 10 seconds. This device will lose its connection to the unit until it joins the hotspot.</p>
          </div>
        )}
        {(startSetup.error ?? stopSetup.error) && <InlineError className="mt-2">{(startSetup.error ?? stopSetup.error)?.message}</InlineError>}
      </Card>

      <SectionLabel right={<Button size="sm" variant="ghost" onClick={() => void scan.refetch()}>Rescan</Button>}>Networks in range</SectionLabel>
      <Card>
        {scan.isLoading && <p className="text-[13px] text-fg-2">Scanning…</p>}
        {scan.error && <InlineError>{scan.error.message}</InlineError>}
        {scan.data?.length === 0 && <p className="text-[13px] text-fg-2">No networks found.</p>}
        <ul className="flex flex-col">
          {scan.data?.map(n => (
            <li key={n.ssid} className="border-t border-line first:border-t-0">
              <button
                type="button"
                onClick={() => setPicked({ ssid: n.ssid, secure: n.secure })}
                className="flex w-full cursor-pointer items-center gap-3 py-2.5 text-left hover:bg-active"
              >
                <span className="flex-1 text-sm text-fg">{n.ssid}</span>
                {n.inUse && <span className="text-xs text-fg-2">connected</span>}
                {n.secure && <Lock size={13} className="text-fg-3" aria-label="secured" />}
                <span className="w-10 text-right font-mono text-xs text-fg-3">{`${n.signal}%`}</span>
              </button>
            </li>
          ))}
        </ul>
      </Card>

      {picked && <JoinCard key={picked.ssid} ssid={picked.ssid} secure={picked.secure} onCancel={() => setPicked(null)} />}
    </div>
  )
}

function JoinCard({ ssid, secure, onCancel }: { ssid: string, secure: boolean, onCancel: () => void }) {
  const [password, setPassword] = useState('')
  const connect = trpc.network.connect.useMutation()
  const tooShort = secure && password.length < 8
  return (
    <Card>
      <CardHeader title={`Join ${ssid}`} icon={WifiIcon} />
      {secure && <div className="mt-2"><TextField label="Password" type="password" mono={false} value={password} onChange={setPassword} /></div>}
      {connect.data && <p className={`mt-2 text-[13px] ${connect.data.ok ? 'text-fg-2' : 'text-danger'}`}>{connect.data.detail}</p>}
      {connect.error && <InlineError className="mt-2">{connect.error.message}</InlineError>}
      <div className="mt-3 flex gap-2">
        <Button variant="primary" disabled={tooShort || connect.isPending || !!connect.data?.ok} onClick={() => connect.mutate({ ssid, password: secure ? password : undefined })}>Join</Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </Card>
  )
}
