import { Link } from '@tanstack/react-router'
import { Archive, CloudUpload, Download, HardDrive, Settings } from 'lucide-react'
import { useState } from 'react'
import { RestorePanel, RestoreProgress } from '@/src/components/Backup/RestorePanel'
import { Button, Card, CardHeader, KeyValue, SectionLabel } from '@/src/components/ds/core'
import { Alert } from '@/src/components/ds/feedback'
import { SegmentedControl, Stepper, TextField, Toggle } from '@/src/components/ds/forms'
import { PageHeader, SettingRow } from '@/src/components/ds/layout'
import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '@/src/server/routers/app'
import { apiBase, trpc } from '@/src/utils/trpc'

type SettingsView = inferRouterOutputs<AppRouter>['settings']['get']

export function SettingsPage() {
  const utils = trpc.useUtils()
  const q = trpc.settings.get.useQuery()
  const info = trpc.system.info.useQuery()
  const update = trpc.settings.update.useMutation({ onSuccess: () => utils.settings.invalidate() })
  if (!q.data) return null
  return <SettingsForm key={q.data.updatedAt} s={q.data} coreVersion={info.data?.coreVersion} system={info.data?.system ?? null} onSave={patch => update.mutate(patch)} saving={update.isPending} />
}

function SettingsForm({ s, coreVersion, system, onSave, saving }: {
  s: SettingsView
  coreVersion?: string
  system: { halVersion: string, model: string, unitId: string } | null
  onSave: (patch: Record<string, unknown>) => void
  saving: boolean
}) {
  // Keyed on updatedAt by the parent, so a fresh server value resets the draft without an effect.
  const [d, setD] = useState<Record<string, unknown>>({ ...s })
  const num = (k: string, fallback: number) => Number(d[k] ?? fallback)
  const str = (k: string) => String(d[k] ?? '')
  const save = () => {
    const rest: Record<string, unknown> = { ...d }
    delete rest.hasApiKey
    delete rest.hasMqttPassword
    delete rest.hasAnalysisIngestToken
    delete rest.hasMirrorSecret
    delete rest.updatedAt
    onSave(rest)
  }
  const dirty = JSON.stringify(d) !== JSON.stringify(s)
  const [generated, setGenerated] = useState(false)

  return (
    <div className="mx-auto flex max-w-[960px] flex-col gap-4">
      <PageHeader title="Settings" right={<Button variant="primary" disabled={!dirty || saving} onClick={save}>Save</Button>} />
      <Card>
        <CardHeader title="Unit" icon={Settings} />
        <SettingRow label="Name"><TextField mono={false} value={str('unitName')} onChange={v => setD({ ...d, unitName: v })} /></SettingRow>
        <SettingRow label="Timezone" sub="Schedules run in this zone"><TextField value={str('timezone')} onChange={v => setD({ ...d, timezone: v })} placeholder="America/Los_Angeles" /></SettingRow>
        <SettingRow label="Temperature unit" divider={false}><SegmentedControl size="sm" value={str('temperatureUnit') as 'C' | 'F'} options={[{ value: 'C', label: '°C' }, { value: 'F', label: '°F' }]} onChange={v => setD({ ...d, temperatureUnit: v })} /></SettingRow>
      </Card>

      <Card>
        <CardHeader title="Tank calibration" subtitle="Ultrasonic distance from the sensor to the water surface" />
        <SettingRow label="Full" sub="cm when just filled"><Stepper value={num('waterFullCm', 5)} min={1} max={30} step={0.5} onChange={v => setD({ ...d, waterFullCm: v })} format={v => `${v} cm`} /></SettingRow>
        <SettingRow label="Empty" sub="cm when the pump would run dry"><Stepper value={num('waterEmptyCm', 20)} min={5} max={40} step={0.5} onChange={v => setD({ ...d, waterEmptyCm: v })} format={v => `${v} cm`} /></SettingRow>
        <SettingRow label="Capacity" divider={false}><Stepper value={num('tankCapacityL', 19)} min={1} max={60} step={1} onChange={v => setD({ ...d, tankCapacityL: v })} format={v => `${v} L`} /></SettingRow>
      </Card>

      <Card>
        <CardHeader title="Grow reminders" subtitle="Days after a cycle starts; 0 disables" />
        <SettingRow label="Thinning"><Stepper value={num('thinningReminderDays', 14)} min={0} max={60} onChange={v => setD({ ...d, thinningReminderDays: v })} format={v => `${v} d`} /></SettingRow>
        <SettingRow label="Root check"><Stepper value={num('rootCheckReminderDays', 21)} min={0} max={90} onChange={v => setD({ ...d, rootCheckReminderDays: v })} format={v => `${v} d`} /></SettingRow>
        <SettingRow label="Harvest"><Stepper value={num('harvestReminderDays', 35)} min={0} max={120} onChange={v => setD({ ...d, harvestReminderDays: v })} format={v => `${v} d`} /></SettingRow>
        <SettingRow label="Nutrients" sub="recurring" divider={false}><Stepper value={num('nutrientReminderDays', 7)} min={0} max={30} onChange={v => setD({ ...d, nutrientReminderDays: v })} format={v => `every ${v} d`} /></SettingRow>
      </Card>

      <Card>
        <CardHeader title="Cameras" />
        <SettingRow label="Capture interval" sub="0 disables timelapse"><Stepper value={num('captureIntervalMin', 60)} min={0} max={720} step={15} onChange={v => setD({ ...d, captureIntervalMin: v })} format={v => `${v} min`} /></SettingRow>
        <SettingRow label="Keep analysis masks" sub="About 115 kB per photo; off spares the SD card" divider={false}><Toggle label="Keep analysis masks" on={!!d.analysisArtifacts} onChange={v => setD({ ...d, analysisArtifacts: v })} /></SettingRow>
      </Card>

      <StorageCard />

      <BackupCard />

      <Card>
        <CardHeader title="Home Assistant bridge" subtitle="Core-level MQTT bridge for grow events and services. The hardware daemon already publishes discovery for lights, pump and sensors." />
        <SettingRow label="Broker URL"><TextField value={str('mqttUrl')} onChange={v => setD({ ...d, mqttUrl: v || null })} placeholder="mqtt://homeassistant.local:1883" /></SettingRow>
        <SettingRow label="Username"><TextField value={str('mqttUsername')} onChange={v => setD({ ...d, mqttUsername: v || null })} /></SettingRow>
        <SettingRow label="Password" sub={s.hasMqttPassword ? 'set' : 'not set'}><TextField type="password" value={str('mqttPassword')} onChange={v => setD({ ...d, mqttPassword: v || null })} placeholder="••••••" /></SettingRow>
        <SettingRow label="TLS"><Toggle on={!!d.mqttTlsEnabled} onChange={v => setD({ ...d, mqttTlsEnabled: v })} /></SettingRow>
        <SettingRow label="Allow self-signed" sub="Off by default (ADR-0013)" divider={false}><Toggle on={!!d.mqttTlsInsecure} onChange={v => setD({ ...d, mqttTlsInsecure: v })} /></SettingRow>
      </Card>

      <Card>
        <CardHeader title="API access" subtitle="Optional key for non-localhost REST/MCP clients" />
        <SettingRow label="API key" sub={s.hasApiKey ? 'set' : 'not set — LAN-only trust'} divider={false}><TextField type="password" value={str('apiKey')} onChange={v => setD({ ...d, apiKey: v })} placeholder="leave empty to disable" /></SettingRow>
      </Card>

      <Card>
        <CardHeader title="Off-device storage and analysis" subtitle="Opt-in. Off unless you fill these in; nothing leaves the unit otherwise." icon={CloudUpload} />
        <SettingRow label="Mirror endpoint" sub="Any S3-compatible service: R2, MinIO, a NAS"><TextField value={str('mirrorEndpoint')} onChange={v => setD({ ...d, mirrorEndpoint: v || null })} placeholder="https://<account>.r2.cloudflarestorage.com" /></SettingRow>
        <SettingRow label="Bucket"><TextField value={str('mirrorBucket')} onChange={v => setD({ ...d, mirrorBucket: v || null })} placeholder="seedypod" /></SettingRow>
        <SettingRow label="Region"><TextField value={str('mirrorRegion')} onChange={v => setD({ ...d, mirrorRegion: v || 'auto' })} placeholder="auto" /></SettingRow>
        <SettingRow label="Key prefix" sub="Folder inside the bucket, e.g. kitchen/"><TextField value={str('mirrorPrefix')} onChange={v => setD({ ...d, mirrorPrefix: v })} /></SettingRow>
        <SettingRow label="Access key id"><TextField value={str('mirrorAccessKeyId')} onChange={v => setD({ ...d, mirrorAccessKeyId: v || null })} /></SettingRow>
        <SettingRow label="Secret access key" sub={s.hasMirrorSecret ? 'set' : 'not set'}><TextField type="password" value={str('mirrorSecretAccessKey')} onChange={v => setD({ ...d, mirrorSecretAccessKey: v || null })} placeholder="••••••" /></SettingRow>
        <MirrorControls />
        <SettingRow
          label="Result ingest token"
          sub={generated ? 'Copy it now: it is hidden once saved' : s.hasAnalysisIngestToken ? 'set — remote workers can post results' : 'not set — POST /api/analyses/results is off'}
          divider={false}
        >
          <div className="flex items-center gap-2">
            <TextField type={generated ? 'text' : 'password'} value={str('analysisIngestToken')} onChange={v => setD({ ...d, analysisIngestToken: v })} placeholder="leave empty to disable" />
            <Button
              size="sm"
              onClick={() => {
                setGenerated(true)
                setD({ ...d, analysisIngestToken: randomToken() })
              }}
            >
              Generate
            </Button>
          </div>
        </SettingRow>
      </Card>

      <Card>
        <CardHeader title="Wi-Fi" subtitle="Change networks, or hold the unit's button for 10 s to open a setup hotspot" />
        <SettingRow label="Network" divider={false}><Link to="/wifi" className="text-sm text-fg underline-offset-2 hover:underline">Open Wi-Fi settings</Link></SettingRow>
      </Card>

      <SectionLabel>About</SectionLabel>
      <Card>
        <KeyValue label="Core" value={coreVersion ?? '…'} />
        <KeyValue label="Hardware daemon" value={system ? `${system.halVersion} · ${system.model}` : 'offline'} />
        <KeyValue label="Unit id" value={system?.unitId ?? '—'} />
      </Card>
    </div>
  )
}

function randomToken(): string {
  const b = new Uint8Array(24)
  crypto.getRandomValues(b)
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
}

const size = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(b < 1e10 ? 2 : 1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(b < 1e7 ? 1 : 0)} MB` : `${Math.round(b / 1e3)} kB`)

function since(s: number): string {
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`
  if (s < 2 * 86400) return `${Math.round(s / 3600)} h`
  return `${Math.round(s / 86400)} days`
}

/** SD card writes (ADR-0021): how fast this unit wears its card. */
function StorageCard() {
  const q = trpc.storage.flash.useQuery(undefined, { refetchInterval: 60_000 })
  return (
    <Card>
      <CardHeader title="Storage" subtitle="How much this unit writes to its SD card. Logs and swap stay in RAM to keep it low." icon={HardDrive} />
      {q.data && <FlashRows f={q.data} />}
    </Card>
  )
}

function FlashRows({ f }: { f: inferRouterOutputs<AppRouter>['storage']['flash'] }) {
  if (!f.available) return <SettingRow label="Flash writes" sub="No SD card counter on this machine" divider={false}><span className="text-sm text-fg-2">—</span></SettingRow>
  return (
    <>
      <SettingRow label="Flash writes" sub={f.basis === 'history' ? `${Math.round(f.windowDays ?? 0)}-day average` : `average since boot (${since(f.uptimeS ?? 0)} ago)`}>
        <span className="font-mono text-sm" data-testid="flash-rate">{f.bytesPerDay === null ? '—' : `${size(f.bytesPerDay)}/day`}</span>
      </SettingRow>
      <SettingRow label="Written since boot"><span className="font-mono text-sm">{size(f.sinceBootBytes ?? 0)}</span></SettingRow>
      <SettingRow
        label="Card"
        sub={f.cardBytes && f.bytesPerDay !== null ? `At this rate, ${(f.bytesPerDay * 365 / f.cardBytes).toFixed(2)} full-card writes a year` : undefined}
        divider={false}
      >
        <span className="font-mono text-sm">{`${f.device}${f.cardBytes ? ` · ${size(f.cardBytes)}` : ''}`}</span>
      </SettingRow>
    </>
  )
}

const when = (ts: string) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** Off-card backups (ADR-0021): download any time, nightly to the mirror's bucket. */
function BackupCard() {
  const status = trpc.backup.status.useQuery(undefined, { refetchInterval: 30_000 })
  const run = trpc.backup.runNow.useMutation({ onSuccess: () => void status.refetch() })
  const info = trpc.backup.restoreInfo.useQuery()
  const [restoring, setRestoring] = useState<'restore' | 'undo' | null>(null)
  const undo = trpc.backup.undo.useMutation({ onSuccess: () => setRestoring('undo') })
  const [photos, setPhotos] = useState(false)
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [confirmUndo, setConfirmUndo] = useState(false)
  const st = status.data
  const undoInfo = info.data?.undo
  if (!st?.available) return null
  const last = st.lastSuccess
  const tried = st.lastBucketAttempt
  const nightlySub = st.nightly.enabled
    ? `After ${String(st.nightly.hour).padStart(2, '0')}:00, keeping the last ${st.nightly.keep}${tried && !tried.ok ? ` · last try failed: ${tried.detail}` : ''}`
    : 'Off. Set up the mirror under Off-device storage to back up every night.'
  return (
    <Card tone={st.stale ? 'warn' : undefined}>
      <CardHeader title="Backup" subtitle="A copy of this unit off its SD card, so a dead card is a quick swap: settings, schedules, grow cycle, pods, rules, probes, calibration and history." icon={Archive} />
      <SettingRow label="Last off-card backup" sub={st.stale ? `None for ${st.staleAfterDays} days or more` : last?.detail || undefined}>
        <span className="text-sm" data-testid="backup-last">{last ? `${when(last.ts)} · ${last.destination === 'bucket' ? 'bucket' : 'downloaded'}` : 'none yet'}</span>
      </SettingRow>
      <SettingRow label="Nightly to the bucket" sub={nightlySub}>
        <div className="flex flex-col items-end gap-1">
          <Button size="sm" disabled={!st.nightly.enabled || run.isPending} onClick={() => run.mutate()}>{run.isPending ? 'Backing up…' : 'Back up now'}</Button>
          {run.data && <span className={`text-xs ${run.data.ok ? 'text-fg-2' : 'text-danger'}`}>{run.data.ok ? `Uploaded ${size(run.data.bytes)}` : run.data.detail}</span>}
          {run.error && <span className="text-xs text-danger">{run.error.message}</span>}
        </div>
      </SettingRow>
      <SettingRow label="Include photos" sub="For downloads; the mirror already keeps them. Makes the file far larger."><Toggle label="Include photos in the download" on={photos} onChange={setPhotos} /></SettingRow>
      <SettingRow label="Download" sub="The file holds your bucket secret and MQTT password. Keep it somewhere private.">
        <a href={`${apiBase()}/api/backup/download${photos ? '?photos=1' : ''}`} download className="inline-flex"><Button size="sm" icon={Download} tabIndex={-1}>Download backup</Button></a>
      </SettingRow>
      <SettingRow label="Restore" sub={info.data?.available === false ? 'Not installed on this core: run scripts/install on the unit' : 'Replace this unit with a backup, from a file or the bucket'} divider={!!undoInfo || restoreOpen}>
        <Button size="sm" disabled={!info.data?.available || restoreOpen} onClick={() => setRestoreOpen(true)}>Restore from a backup…</Button>
      </SettingRow>
      {restoreOpen && !restoring && (
        <div className="py-3">
          <RestorePanel savedMirror={st.nightly.enabled} confirm onStarted={() => setRestoring('restore')} />
          <div className="mt-2"><Button size="sm" onClick={() => setRestoreOpen(false)}>Close</Button></div>
        </div>
      )}
      {undoInfo && (
        <SettingRow
          label={undoInfo.undoneAt ? 'Redo restore' : 'Undo restore'}
          sub={undoInfo.undoneAt
            ? `You undid the restore of the backup from ${when(undoInfo.bundle.createdAt ?? undoInfo.restoredAt)}. This puts it back.`
            : `Restored the backup from ${when(undoInfo.bundle.createdAt ?? undoInfo.restoredAt)} on ${when(undoInfo.restoredAt)}. Undo puts back what it replaced.`}
          divider={false}
        >
          <Button size="sm" disabled={undo.isPending || !!restoring} onClick={() => setConfirmUndo(true)}>{undoInfo.undoneAt ? 'Redo restore' : 'Undo restore'}</Button>
        </SettingRow>
      )}
      {confirmUndo && !restoring && (
        <Alert
          tone="warn"
          action={(
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  undo.mutate()
                  setConfirmUndo(false)
                }}
              >
                {undoInfo?.undoneAt ? 'Redo' : 'Undo'}
              </Button>
              <Button size="sm" onClick={() => setConfirmUndo(false)}>Cancel</Button>
            </div>
          )}
        >
          The unit restarts on the files it had before. Anything changed since is swapped out too, and comes back with another undo.
        </Alert>
      )}
      {undo.error && <span className="text-xs text-danger">{undo.error.message}</span>}
      {restoring && <div className="pt-3"><RestoreProgress undo={restoring === 'undo'} /></div>}
    </Card>
  )
}

/** Test and back-fill the mirror using the saved settings. */
function MirrorControls() {
  const status = trpc.storage.mirror.useQuery(undefined, { refetchInterval: 5000 })
  const test = trpc.storage.testMirror.useMutation()
  const sync = trpc.storage.syncMirror.useMutation({ onSuccess: () => void status.refetch() })
  const st = status.data
  if (!st?.available) return null
  return (
    <SettingRow label="Mirror" sub={st.enabled ? `${st.uploaded} copied · ${st.pending} pending · ${st.failed} failed${st.lastError ? ` · ${st.lastError}` : ''}` : 'off — save an endpoint, bucket and keys to turn it on'}>
      <div className="flex flex-col items-end gap-1">
        <div className="flex gap-2">
          <Button size="sm" disabled={!st.enabled || test.isPending} onClick={() => test.mutate()}>{test.isPending ? 'Testing…' : 'Test'}</Button>
          <Button size="sm" disabled={!st.enabled || sync.isPending} onClick={() => sync.mutate()}>Copy existing photos</Button>
        </div>
        {test.data && <span className={`text-xs ${test.data.ok ? 'text-fg-2' : 'text-danger'}`}>{test.data.detail}</span>}
        {sync.data && <span className="text-xs text-fg-2">{`Queued ${sync.data.queued} files`}</span>}
        {sync.error && <span className="text-xs text-danger">{sync.error.message}</span>}
      </div>
    </SettingRow>
  )
}
