/**
 * ⌘K / Ctrl K search (ported from sleepypod's CommandPalette): a sidebar box
 * that opens a dialog with a combobox over every page, the Settings cards,
 * the unit's pods and rules, and the docs site's guides.
 */
import { Search } from 'lucide-react'
import { Component, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Modal } from '@/src/components/ds/feedback'

/**
 * The index and its docs snapshot wait for the first search, off the first page
 * load. A fresh `lazy` per attempt, since one remembers its rejection for good.
 */
const loadBody = () => lazy(() => import('./PaletteBody').then(m => ({ default: m.PaletteBody })))

/** A failed load stops here, in the dialog, rather than at the router's boundary, which would take the whole page with it. */
class LoadFailure extends Component<{ children: ReactNode, onRetry: () => void }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div role="alert" className="flex flex-col items-start gap-3 py-2 text-sm text-fg-2">
        Search didn&apos;t load. Check the connection to the unit.
        <button type="button" className="lp-btn" onClick={this.props.onRetry}>Try again</button>
      </div>
    )
  }
}

const noopSubscribe = () => () => {}
const isMacSnapshot = () => /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)

/** ⌘K on Apple platforms, Ctrl K elsewhere; either modifier opens it. */
function isPaletteShortcut(e: globalThis.KeyboardEvent) {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k'
}

/** True while a modal dialog other than the palette is open; the shortcut must not stack over it. */
function anotherModalOpen() {
  return [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
    .some(dialog => !dialog.querySelector('[data-command-palette]'))
}

/**
 * Sidebar search box. Opens the palette on click or ⌘K / Ctrl K from anywhere;
 * the sidebar stays mounted (CSS-hidden) on phones, so a keyboard works there too.
 */
export function SidebarSearch({ className }: { className?: string }) {
  const [open, setOpen] = useState(false)
  const isMac = useSyncExternalStore(noopSubscribe, isMacSnapshot, () => false)

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!isPaletteShortcut(e) || e.isComposing || anotherModalOpen()) return
      e.preventDefault()
      setOpen(o => !o)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const close = useCallback(() => setOpen(false), [])

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-keyshortcuts={isMac ? 'Meta+K' : 'Control+K'}
        className={cn('flex shrink-0 items-center gap-3 rounded-ctl border border-line px-2.5 py-[7px] text-sm text-fg-2 transition-colors hover:bg-active hover:text-fg', className)}
      >
        <Search size={16} aria-hidden />
        <span className="flex-1 text-left">Search</span>
        <kbd aria-hidden className="rounded-[4px] border border-line px-1.5 font-mono text-[11px] leading-[18px] text-fg-3">
          {isMac ? '⌘K' : 'Ctrl K'}
        </kbd>
      </button>
      <CommandPalette open={open} onClose={close} />
    </>
  )
}

/** Dialog with a combobox over the search entries. Focus returns to the opener on close. */
export function CommandPalette({ open, onClose }: { open: boolean, onClose: () => void }) {
  const [load, setLoad] = useState(() => ({ Body: loadBody(), attempt: 0 }))
  // Layout effect: runs before the body's passive effect moves focus into the input.
  useLayoutEffect(() => {
    if (!open) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => opener?.focus()
  }, [open])

  return (
    <Modal open={open} onClose={onClose} title="Search" icon={Search} iconClassName="text-icon" width={560}>
      <LoadFailure key={load.attempt} onRetry={() => setLoad({ Body: loadBody(), attempt: load.attempt + 1 })}>
        <Suspense>
          <load.Body onClose={onClose} />
        </Suspense>
      </LoadFailure>
    </Modal>
  )
}
