import { Archive, Sprout } from 'lucide-react'
import { useState } from 'react'
import { RestorePanel, RestoreProgress } from '@/src/components/Backup/RestorePanel'
import { Button, Card, CardHeader, InlineError } from '@/src/components/ds/core'
import { trpc } from '@/src/utils/trpc'

/** First run on a fresh card (ADR-0021): start over, or bring a unit back from its backup. */
export function Welcome() {
  const utils = trpc.useUtils()
  const [view, setView] = useState<'choose' | 'restore' | 'restoring'>('choose')
  const restore = trpc.backup.restoreInfo.useQuery()
  const start = trpc.settings.update.useMutation({ onSuccess: () => utils.settings.invalidate() })
  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-4 pt-6">
      <h1 className="text-2xl font-medium">Welcome to seedypod</h1>
      <p className="text-sm text-fg-2">This unit has nothing on it yet. Start fresh, or restore a backup from the card it replaces.</p>
      {view === 'choose' && (
        <div className="grid grid-cols-1 gap-3 min-[600px]:grid-cols-2">
          <Card>
            <CardHeader title="Set up a new garden" subtitle="Start with the defaults. Settings, schedules and pods are yours to fill in." icon={Sprout} />
            <div className="mt-3"><Button variant="primary" disabled={start.isPending} onClick={() => start.mutate({ setupComplete: true })}>Set up a new garden</Button></div>
            {start.error && <InlineError>{start.error.message}</InlineError>}
          </Card>
          <Card>
            <CardHeader title="Restore from a backup" subtitle="Bring back settings, schedules, the grow cycle, pods, Autopilot rules, probes, calibration and history." icon={Archive} />
            <div className="mt-3"><Button onClick={() => setView('restore')}>Restore from a backup</Button></div>
          </Card>
        </div>
      )}
      {view === 'restore' && (
        <Card>
          <CardHeader title="Restore from a backup" right={<Button size="sm" onClick={() => setView('choose')}>Back</Button>} icon={Archive} />
          <div className="mt-3">
            {restore.data && !restore.data.available
              ? <InlineError>Restore isn&apos;t installed on this core. Run scripts/install on the unit, or use scripts/install --restore.</InlineError>
              : <RestorePanel savedMirror={false} confirm={false} onStarted={() => setView('restoring')} />}
          </div>
        </Card>
      )}
      {view === 'restoring' && <Card><RestoreProgress /></Card>}
    </div>
  )
}
