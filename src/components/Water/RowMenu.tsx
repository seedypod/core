import { MoreHorizontal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { GhostIcon } from '@/src/components/ds/core'

/** A row's ⋯ menu: its items in a small list under the button, closed by picking one, Escape or a click elsewhere. */
export function RowMenu({ label, items }: { label: string, items: ReadonlyArray<{ label: string, onSelect: () => void, danger?: boolean }> }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', key)
    }
  }, [open])
  return (
    <div ref={box} className="relative">
      <GhostIcon icon={MoreHorizontal} label={label} aria-haspopup="menu" aria-expanded={open} className="text-fg-3" onClick={() => setOpen(o => !o)} />
      {open && (
        <div role="menu" aria-label={label} className="absolute right-0 top-full z-20 mt-1 flex min-w-[11rem] flex-col rounded-[10px] border border-line-2 bg-surface py-1 shadow-lg">
          {items.map(i => (
            <button
              key={i.label}
              type="button"
              role="menuitem"
              className={`cursor-pointer border-0 bg-transparent px-3 py-2 text-left text-[13px] hover:bg-active ${i.danger ? 'text-danger' : 'text-fg'}`}
              onClick={() => {
                setOpen(false)
                i.onSelect()
              }}
            >
              {i.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
