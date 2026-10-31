import { CloudDownload, FileUp, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button, InlineError } from '@/src/components/ds/core'
import { Alert } from '@/src/components/ds/feedback'
import { TextField } from '@/src/components/ds/forms'
import { apiBase, trpc } from '@/src/utils/trpc'

interface BucketConfig { endpoint: string, bucket: string, region: string, prefix: string, accessKeyId: string, secretAccessKey: string }

const size = (b: number) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} kB`)
const when = (ts: string) => new Date(ts).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/**
 * Restore from an uploaded bundle or from the bucket (ADR-0021). On Welcome the
 * bucket settings are typed in here; in Settings the saved mirror is used. The
 * helper checks the bundle first, so a refusal shows here; otherwise the unit
 * restarts and `RestoreProgress` takes over.
 */
export function RestorePanel({ savedMirror, confirm, onStarted }: {
  /** List the saved mirror's bucket instead of asking for its settings. */
  savedMirror: boolean
  /** Ask before replacing a unit that is already set up. */
  confirm: boolean
  onStarted: () => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<{ label: string, run: () => void } | null>(null)
  const [cfg, setCfg] = useState<BucketConfig>({ endpoint: '', bucket: '', region: 'auto', prefix: '', accessKeyId: '', secretAccessKey: '' })
  const saved = trpc.backup.list.useQuery(undefined, { enabled: savedMirror })
  const browse = trpc.backup.browse.useMutation()
  const fromBucket = trpc.backup.restoreFromBucket.useMutation({ onSuccess: onStarted, onError: e => setError(e.message) })
  const backups = savedMirror ? saved.data : browse.data
  const listError = savedMirror ? saved.error?.message : browse.error?.message

  const ask = (label: string, run: () => void) => {
    setError(null)
    if (confirm) setPending({ label, run })
    else run()
  }

  const upload = async () => {
    if (!file) return
    setUploading(true)
    try {
      const r = await fetch(`${apiBase()}/api/backup/restore`, { method: 'POST', headers: { 'content-type': 'application/gzip' }, body: file })
      if (r.status === 202) return onStarted()
      setError(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? `restore failed (${r.status})`)
    }
    catch (e) {
      setError((e as Error).message)
    }
    finally {
      setUploading(false)
    }
  }

  const ready = !!(cfg.endpoint && cfg.bucket && cfg.accessKeyId && cfg.secretAccessKey)
  const config = savedMirror ? undefined : cfg
  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <FileUp size={15} />
          {' '}
          From a file
        </h3>
        <p className="text-[13px] text-fg-2">
          A
          <span className="font-mono">seedypod-backup-….tar.gz</span>
          {' '}
          you downloaded from Settings → Backup.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input type="file" aria-label="Backup file" accept=".gz,.tgz,application/gzip" className="text-[13px]" onChange={e => setFile(e.target.files?.[0] ?? null)} />
          <Button size="sm" variant="primary" disabled={!file || uploading} onClick={() => ask(file?.name ?? 'this file', () => void upload())}>{uploading ? 'Checking…' : 'Restore this file'}</Button>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <CloudDownload size={15} />
          {' '}
          From your bucket
        </h3>
        {!savedMirror && (
          <>
            <p className="text-[13px] text-fg-2">
              The off-device mirror&apos;s settings from the old card. Nightly backups are in
              <span className="font-mono">backups/</span>
              {' '}
              under its prefix.
            </p>
            <div className="grid grid-cols-1 gap-2 min-[600px]:grid-cols-2">
              <TextField label="Endpoint" value={cfg.endpoint} onChange={v => setCfg({ ...cfg, endpoint: v })} placeholder="https://<account>.r2.cloudflarestorage.com" />
              <TextField label="Bucket" value={cfg.bucket} onChange={v => setCfg({ ...cfg, bucket: v })} placeholder="seedypod" />
              <TextField label="Region" value={cfg.region} onChange={v => setCfg({ ...cfg, region: v || 'auto' })} />
              <TextField label="Key prefix" value={cfg.prefix} onChange={v => setCfg({ ...cfg, prefix: v })} placeholder="kitchen/" />
              <TextField label="Access key id" value={cfg.accessKeyId} onChange={v => setCfg({ ...cfg, accessKeyId: v })} />
              <TextField label="Secret access key" type="password" value={cfg.secretAccessKey} onChange={v => setCfg({ ...cfg, secretAccessKey: v })} />
            </div>
            <div><Button size="sm" disabled={!ready || browse.isPending} onClick={() => browse.mutate({ config: cfg })}>{browse.isPending ? 'Listing…' : 'List backups'}</Button></div>
          </>
        )}
        {listError && <InlineError>{listError}</InlineError>}
        {backups && backups.length === 0 && <p className="text-[13px] text-fg-2">No backups in this bucket yet.</p>}
        {backups && backups.length > 0 && (
          <ul className="flex flex-col divide-y divide-line rounded-ctl border border-line" aria-label="Backups in the bucket">
            {backups.map(b => (
              <li key={b.key} className="flex items-center gap-3 px-3 py-2">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm">{when(b.createdAt)}</span>
                  <span className="truncate font-mono text-[12px] text-fg-3">{`${b.unit ?? 'unknown unit'} · ${size(b.size)}`}</span>
                </div>
                <Button size="sm" disabled={fromBucket.isPending} onClick={() => ask(`the backup from ${when(b.createdAt)}`, () => fromBucket.mutate({ key: b.key, config }))}>Restore</Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {pending && (
        <Alert
          tone="warn"
          action={(
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  pending.run()
                  setPending(null)
                }}
              >
                Replace this unit
              </Button>
              <Button size="sm" onClick={() => setPending(null)}>Cancel</Button>
            </div>
          )}
        >
          {`Restore ${pending.label}? It replaces this unit's settings, schedules, rules and history, then restarts. You can undo it afterwards.`}
        </Alert>
      )}
      {error && <InlineError>{error}</InlineError>}
    </div>
  )
}

const STEPS: Record<string, string> = {
  checking: 'Checking the backup…',
  queued: 'Starting…',
  stopping: 'Stopping the unit…',
  restoring: 'Putting the backup in place…',
  starting: 'Starting the unit again…',
}

/** Waits out the restart: the helper's status file says how far it got, and core answers again once it's back. */
export function RestoreProgress({ undo }: { undo?: boolean }) {
  const [since] = useState(() => new Date(Date.now() - 5_000).toISOString())
  const info = trpc.backup.restoreInfo.useQuery(undefined, { refetchInterval: 1000, retry: true, retryDelay: 1000 })
  const st = info.data?.status
  const fresh = st && st.at >= since
  const done = fresh && st.state === 'done'
  useEffect(() => {
    if (done) window.location.assign('/')
  }, [done])
  if (fresh && (st.state === 'failed' || st.state === 'refused')) return <InlineError>{`${undo ? 'Undo' : 'Restore'} failed: ${st.error ?? 'unknown error'}. The unit is back on what it had before.`}</InlineError>
  return (
    <div className="flex items-center gap-2 text-sm text-fg-2" role="status">
      <RotateCcw size={15} className="animate-spin" />
      {done ? 'Done. Reloading…' : (fresh && STEPS[st.state]) || (info.isError ? 'The unit is restarting…' : 'Starting…')}
    </div>
  )
}
