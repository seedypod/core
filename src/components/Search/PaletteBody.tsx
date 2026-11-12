import { useNavigate } from '@tanstack/react-router'
import { ExternalLink } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'
import { trpc } from '@/src/utils/trpc'
import { loadLiveDocsIndex, type DocsIndex } from './docsIndex'
import docsSnapshot from './docsIndex.json'
import { buildDocsEntries, buildSearchEntries, createSearch, type SearchEntry } from './searchIndex'

const MAX_RESULTS = 12

/** Bundled copy of the docs index; `pnpm docs:sync-index` refreshes it. */
const DOCS_SNAPSHOT = docsSnapshot as DocsIndex

/** Mounted only while open, so the query and selection reset each time. */
export function PaletteBody({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const pods = trpc.grow.pods.useQuery()
  const rules = trpc.automations.list.useQuery()
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [docsIndex, setDocsIndex] = useState(DOCS_SNAPSHOT)

  // Units often have no internet: prefer the live docs index when the browser can reach the docs site, keep the snapshot otherwise.
  useEffect(() => {
    let alive = true
    void loadLiveDocsIndex().then((index) => {
      if (alive && index) setDocsIndex(index)
    })
    return () => {
      alive = false
    }
  }, [])

  const { pages, search } = useMemo(() => {
    const entries = buildSearchEntries({ pods: pods.data, rules: rules.data })
    return {
      pages: entries.filter(e => e.id.startsWith('page:') && e.crumbs.length === 0 && !e.boost),
      search: createSearch([...entries, ...buildDocsEntries(docsIndex)]),
    }
  }, [pods.data, rules.data, docsIndex])

  const q = query.trim()
  const results = useMemo(() => (q ? search(q, MAX_RESULTS) : pages), [q, search, pages])
  const current = Math.min(active, results.length - 1)
  const optionId = (i: number) => `${listId}-option-${i}`

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Keep Tab inside the dialog (input and close button).
  useEffect(() => {
    const dialog = inputRef.current?.closest<HTMLElement>('[role="dialog"]')
    if (!dialog) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const focusable = [...dialog.querySelectorAll<HTMLElement>('input, button:not([disabled]), a[href]')]
      if (focusable.length === 0) return
      const i = focusable.indexOf(document.activeElement as HTMLElement)
      const next = e.shiftKey ? (i <= 0 ? focusable.length - 1 : i - 1) : (i + 1) % focusable.length
      e.preventDefault()
      focusable[next]?.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (current >= 0) document.getElementById(`${listId}-option-${current}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [current, listId])

  const go = (entry: SearchEntry) => {
    onClose()
    if (entry.external) {
      window.open(entry.href, '_blank', 'noopener,noreferrer')
      return
    }
    void navigate({ href: entry.href })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (results.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((current + 1) % results.length)
    }
    else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((current - 1 + results.length) % results.length)
    }
    else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      const r = results[current]
      if (r) go(r)
    }
  }

  const label = 'Search pages, settings, plants and rules'

  return (
    <>
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        data-command-palette
        aria-label={label}
        aria-expanded={results.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={current >= 0 ? optionId(current) : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder={label}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setActive(0)
        }}
        onKeyDown={onKeyDown}
        className="w-full rounded-ctl border border-line-2 bg-field px-3 py-2.5 text-[15px] text-fg outline-none placeholder:text-fg-3 focus:border-fg-3"
      />
      <ul
        id={listId}
        role="listbox"
        aria-label={q ? 'Results' : 'Pages'}
        className={cn('-mx-1 flex max-h-[min(360px,50dvh)] flex-col gap-0.5 overflow-y-auto', results.length === 0 && 'hidden')}
      >
        {results.map((r, i) => (
          <li
            key={r.id}
            id={optionId(i)}
            role="option"
            aria-selected={i === current}
            onMouseMove={() => setActive(i)}
            onClick={() => go(r)}
            className={cn('flex cursor-pointer items-center gap-3 rounded-ctl px-2.5 py-2', i === current ? 'bg-active' : 'hover:bg-active')}
          >
            <r.icon size={16} className="shrink-0 text-icon" aria-hidden />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm text-fg">{r.title}</span>
              <span className="truncate text-xs text-fg-3">{r.crumbs.length > 0 ? r.crumbs.join(' › ') : r.description}</span>
            </span>
            {r.external && (
              <>
                <ExternalLink size={14} className="ml-auto shrink-0 text-fg-3" aria-hidden />
                <span className="sr-only">Opens the docs in a new tab</span>
              </>
            )}
          </li>
        ))}
      </ul>
      {results.length === 0 && (
        <p role="status" className="py-6 text-center text-sm text-fg-2">{`No matches for “${q}”`}</p>
      )}
      <p className="hidden text-xs text-fg-3 min-[900px]:block">↑ ↓ to move · Enter to open · Esc to close</p>
    </>
  )
}
