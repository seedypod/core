import { NotebookPen, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button, Card, GhostIcon, InlineError } from '@/src/components/ds/core'
import { Modal } from '@/src/components/ds/feedback'
import { SelectValue, TextField } from '@/src/components/ds/forms'
import { TANK_ACTION_KINDS, TANK_UNITS, type TankAction, type TankActionKind, type TankUnit } from '@/src/store/types'
import { trpc } from '@/src/utils/trpc'
import { fmtWhen } from './pumpCycles'

const EYEBROW = 'font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-fg-3'

export const KIND_LABEL: Record<TankActionKind, string> = {
  feed: 'Fed', top_off: 'Topped off', refresh: 'Refreshed', ph_down: 'Added pH Down', ph_up: 'Added pH Up',
  clean: 'Cleaned', trim_roots: 'Trimmed roots', thin: 'Thinned seedlings', other: 'Other',
}
/** What each kind usually comes in, to start the form with. */
const DEFAULT_UNIT: Partial<Record<TankActionKind, TankUnit>> = { feed: 'tsp', top_off: 'L', refresh: 'L', ph_down: 'mL', ph_up: 'mL' }

/** "Fed 1 tsp MaxiGro", "Added pH Down 2 mL · PHLO", "Topped off 3 L"; the note if it is an `other`. */
export function describeAction(a: Pick<TankAction, 'kind' | 'amount' | 'unit' | 'product' | 'note'>): string {
  const amount = a.amount !== null && a.unit ? `${a.amount} ${a.unit}` : ''
  if (a.kind === 'feed') return ['Fed', amount, a.product].filter(Boolean).join(' ')
  const head = a.kind === 'other' ? a.note.trim() || KIND_LABEL.other : KIND_LABEL[a.kind]
  return [[head, amount].filter(Boolean).join(' '), a.product].filter(Boolean).join(' · ')
}

interface Draft { kind: TankActionKind, amount: string, unit: TankUnit, product: string, note: string }
const blank = (kind: TankActionKind = 'feed'): Draft => ({ kind, amount: '', unit: DEFAULT_UNIT[kind] ?? 'mL', product: '', note: '' })

/** The tank action log (ADR-0029): what was fed, topped off, refreshed or pH-adjusted, so readings can be read against it. */
export function TankLog() {
  const utils = trpc.useUtils()
  const actions = trpc.tank.actions.useQuery({ limit: 10 })
  const done = { onSuccess: () => void utils.tank.invalidate() }
  const log = trpc.tank.logAction.useMutation(done)
  const remove = trpc.tank.removeAction.useMutation(done)
  const [draft, setDraft] = useState<Draft | null>(null)
  const rows = actions.data ?? []
  const now = new Date()
  const amount = draft ? Number(draft.amount.replace(',', '.')) : 0
  const badAmount = !!draft && draft.amount.trim() !== '' && !(amount > 0)

  const save = () => {
    if (!draft || badAmount) return
    const has = draft.amount.trim() !== ''
    log.mutate({ kind: draft.kind, amount: has ? amount : null, unit: has ? draft.unit : null, product: draft.product.trim() || null, note: draft.note })
    setDraft(null)
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-3">
        <h2 className={`${EYEBROW} flex-1`}>Tank log</h2>
        <Button icon={Plus} onClick={() => setDraft(blank())}>Log action</Button>
      </div>
      <Card className="gap-0 p-0" data-testid="tank-log">
        {rows.length === 0 && <p className="px-5 py-3 text-[13px] text-fg-3">Nothing logged yet. Log feeds, top-offs, refreshes and pH doses so the readings can be read against them.</p>}
        {rows.map(a => (
          <div key={a.id} className="flex flex-wrap items-center gap-4 border-b border-line px-5 py-3 text-[13px] last:border-0">
            <span className="flex min-w-[160px] flex-1 flex-col gap-0.5">
              <span>{describeAction(a)}</span>
              {a.note.trim() && a.kind !== 'other' && <span className="text-[12px] text-fg-3">{a.note}</span>}
            </span>
            {a.source === 'agent' && <span className="font-mono text-[10px] uppercase text-fg-3">agent</span>}
            <span className="min-w-[120px] text-right font-mono text-[12px] text-fg-3">{fmtWhen(new Date(a.ts), now)}</span>
            <GhostIcon icon={Trash2} label={`Remove ${describeAction(a)}`} className="text-fg-3" onClick={() => remove.mutate({ id: a.id })} />
          </div>
        ))}
      </Card>
      {(log.error ?? remove.error) && <InlineError>{(log.error ?? remove.error)?.message}</InlineError>}

      <Modal
        open={!!draft}
        onClose={() => setDraft(null)}
        title="Log a tank action"
        icon={NotebookPen}
        footer={(
          <div className="flex gap-2">
            <Button variant="primary" disabled={badAmount} onClick={save}>Save</Button>
            <Button onClick={() => setDraft(null)}>Cancel</Button>
          </div>
        )}
      >
        {draft && (
          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5 text-xs text-fg-2">
              What
              <SelectValue label="What was done" value={draft.kind} options={TANK_ACTION_KINDS.map(k => ({ value: k, label: KIND_LABEL[k] }))} onChange={kind => setDraft({ ...blank(kind), product: draft.product, note: draft.note })} />
            </label>
            <div className="flex items-end gap-2">
              <TextField label="Amount (optional)" inputMode="decimal" className="flex-1" value={draft.amount} onChange={v => setDraft({ ...draft, amount: v })} hint={badAmount ? 'A number above 0' : undefined} />
              <SelectValue label="Unit" value={draft.unit} options={TANK_UNITS.map(u => ({ value: u, label: u }))} onChange={unit => setDraft({ ...draft, unit })} className="mb-0.5" />
            </div>
            <TextField label="Product (optional)" mono={false} placeholder="MaxiGro, Gardyn Plant Food, pH Down…" value={draft.product} onChange={v => setDraft({ ...draft, product: v })} />
            <TextField label="Note (optional)" mono={false} value={draft.note} onChange={v => setDraft({ ...draft, note: v })} />
          </div>
        )}
      </Modal>
    </div>
  )
}
