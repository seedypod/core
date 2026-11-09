import { Sprout } from 'lucide-react'
import { useState } from 'react'
import { Button, InlineError } from '@/src/components/ds/core'
import { Modal } from '@/src/components/ds/feedback'
import { SegmentedControl, SelectValue, TextField } from '@/src/components/ds/forms'
import { trpc } from '@/src/utils/trpc'

type Zone = 'high' | 'medium' | 'low'
type Category = 'fruiting' | 'vegetable' | 'legume' | 'flower' | 'herb' | 'green' | 'lettuce'
type Care = 'beginner' | 'intermediate' | 'expert'

/** The custom plant being edited, as the catalog serves it. */
export interface EditablePlant {
  id: string
  name: string
  category: Category
  zone: Zone
  harvestMonths: [number, number]
  careLevel: Care | null
  size: 'large' | 'normal'
}

const CATEGORIES: { value: Category, label: string }[] = [
  { value: 'lettuce', label: 'Lettuce' }, { value: 'green', label: 'Greens' }, { value: 'herb', label: 'Herb' }, { value: 'fruiting', label: 'Fruiting' },
  { value: 'vegetable', label: 'Vegetable' }, { value: 'legume', label: 'Beans & peas' }, { value: 'flower', label: 'Flower' },
]
const CARE: { value: Care | 'none', label: string }[] = [{ value: 'none', label: '—' }, { value: 'beginner', label: 'Beginner' }, { value: 'intermediate', label: 'Intermediate' }, { value: 'expert', label: 'Expert' }]
const BLANK: Omit<EditablePlant, 'id'> = { name: '', category: 'herb', zone: 'medium', harvestMonths: [2, 3], careLevel: null, size: 'normal' }

/** Add, edit or delete a plant of your own; Gardyn's built-in plants are read-only. `plant` null adds one. */
export function CustomPlantDialog({ open, plant, onClose }: { open: boolean, plant: EditablePlant | null, onClose: () => void }) {
  return open ? <PlantForm key={plant?.id ?? 'new'} plant={plant} onClose={onClose} /> : null
}

function PlantForm({ plant, onClose }: { plant: EditablePlant | null, onClose: () => void }) {
  const utils = trpc.useUtils()
  const [form, setForm] = useState(() => plant ?? BLANK)
  const [from, setFrom] = useState(() => String((plant ?? BLANK).harvestMonths[0]))
  const [to, setTo] = useState(() => String((plant ?? BLANK).harvestMonths[1]))

  const done = () => {
    void utils.planner.invalidate()
    onClose()
  }
  const add = trpc.planner.addPlant.useMutation({ onSuccess: done })
  const update = trpc.planner.updatePlant.useMutation({ onSuccess: done })
  const remove = trpc.planner.removePlant.useMutation({ onSuccess: done })
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm(f => ({ ...f, [k]: v }))
  const months: [number, number] = [Number(from), Number(to)]
  const valid = form.name.trim().length > 0 && months.every(m => Number.isInteger(m) && m >= 0 && m <= 24) && months[0] <= months[1]
  const error = add.error ?? update.error ?? remove.error
  const save = () => {
    const body = { name: form.name, category: form.category, zone: form.zone, harvestMonths: months, careLevel: form.careLevel, size: form.size }
    if (plant) update.mutate({ id: plant.id, ...body })
    else add.mutate(body)
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={plant ? `Edit ${plant.name}` : 'Add a plant'}
      icon={Sprout}
      footer={(
        <div className="flex gap-2">
          <Button variant="primary" disabled={!valid || add.isPending || update.isPending} onClick={save}>{plant ? 'Save' : 'Add'}</Button>
          {plant && <Button onClick={() => remove.mutate({ id: plant.id })}>Delete</Button>}
          <Button onClick={onClose}>Cancel</Button>
        </div>
      )}
    >
      <div className="flex flex-col gap-3">
        <TextField label="Name" mono={false} value={form.name} onChange={v => set('name', v)} placeholder="Purple shiso" />
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-fg-2">
          <span>Category</span>
          <SelectValue label="Category" value={form.category} options={CATEGORIES} onChange={v => set('category', v)} />
          <span className="ml-2">Care</span>
          <SelectValue label="Care level" value={form.careLevel ?? 'none'} options={CARE} onChange={v => set('careLevel', v === 'none' ? null : v)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-fg-2">Light zone</span>
          <SegmentedControl<Zone> size="sm" ariaLabel="Light zone" value={form.zone} onChange={v => set('zone', v)} options={[{ value: 'high', label: 'High' }, { value: 'medium', label: 'Medium' }, { value: 'low', label: 'Low' }]} />
        </div>
        <div className="flex gap-2">
          <TextField label="First harvest from (months)" type="number" min={0} max={24} value={from} onChange={setFrom} />
          <TextField label="to (months)" type="number" min={0} max={24} value={to} onChange={setTo} />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-fg-2">Size</span>
          <SegmentedControl<'normal' | 'large'> size="sm" ariaLabel="Size" value={form.size} onChange={v => set('size', v)} options={[{ value: 'normal', label: 'Normal' }, { value: 'large', label: 'Large · spaced apart' }]} />
        </div>
        {error && <InlineError>{error.message}</InlineError>}
      </div>
    </Modal>
  )
}
