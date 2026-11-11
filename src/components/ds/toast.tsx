'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { NOTICE_BAR, NOTICE_TEXT, type Notice } from './notice'

/**
 * A toast says something just happened: a success / info notice, with an X and
 * at most one optional action ("View", "Undo"). `urgent` (a fault that stopped
 * hardware) is announced as an alert instead of politely.
 */
export type ToastNotice = Pick<Notice, 'id' | 'tone' | 'icon' | 'title' | 'detail'> & {
  kind: 'success' | 'info'
  action?: { label: string, onClick: () => void }
  urgent?: boolean
}

export const TOAST_DURATION_MS = 6000
/** Enter and leave both take this long (globals.css sp-toast-in / sp-toast-out). */
export const TOAST_ANIMATION_MS = 250

interface Entry {
  notice: ToastNotice
  /** Bumped on every show so a same-id replacement restarts the countdown. */
  key: number
}

interface State {
  current: Entry | null
  queue: Entry[]
  leaving: boolean
}

type Action = { type: 'show', entry: Entry } | { type: 'expire' } | { type: 'next' }

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'show': {
      const { entry } = action
      if (state.current?.notice.id === entry.notice.id) return { ...state, current: entry, leaving: false }
      if (state.queue.some(e => e.notice.id === entry.notice.id)) {
        return { ...state, queue: state.queue.map(e => (e.notice.id === entry.notice.id ? entry : e)) }
      }
      if (!state.current) return { ...state, current: entry, leaving: false }
      return { ...state, queue: [...state.queue, entry] }
    }
    case 'expire':
      return state.current ? { ...state, leaving: true } : state
    case 'next':
      return { current: state.queue[0] ?? null, queue: state.queue.slice(1), leaving: false }
  }
}

const ToastContext = createContext<{ show: (notice: ToastNotice) => void } | null>(null)

const noop = { show: () => {} }

/** `show(notice)` queues a toast. Outside a ToastProvider it does nothing. */
export function useToast(): { show: (notice: ToastNotice) => void } {
  return useContext(ToastContext) ?? noop
}

/**
 * One toast at a time; later toasts wait in a queue, and showing the id that is
 * already up replaces it. Each lasts `duration` (6s), paused while hovered or
 * focused; its action or X ends it early. The region overlays the page: centred
 * on the content column on desktop (past the 244px sidebar), above the tab bar
 * on phones.
 */
export function ToastProvider({ children, duration = TOAST_DURATION_MS }: { children: ReactNode, duration?: number }) {
  const [state, dispatch] = useReducer(reducer, { current: null, queue: [], leaving: false })
  // Paused for one toast only: the next one starts running even if the pointer never left.
  const [pausedKey, setPausedKey] = useState<number | null>(null)
  const counter = useRef(0)
  const remaining = useRef(duration)
  const shownKey = useRef<number | null>(null)
  const box = useRef<HTMLDivElement>(null)
  // Focus inside the toast, and where it came from: a toast that goes takes its focus with it.
  const focused = useRef(false)
  const returnTo = useRef<HTMLElement | null>(null)
  // The toast whose action has run: once only, even during its exit.
  const acted = useRef<number | null>(null)

  const show = useCallback((notice: ToastNotice) => {
    counter.current += 1
    dispatch({ type: 'show', entry: { notice, key: counter.current } })
  }, [])

  const key = state.current?.key ?? null
  const paused = key !== null && pausedKey === key
  useEffect(() => {
    if (key === null) return
    if (state.leaving) {
      // Whether it has focus as it goes, in case its removal blurs it first.
      if (box.current?.contains(document.activeElement)) focused.current = true
      const t = setTimeout(() => {
        if (box.current?.contains(document.activeElement)) focused.current = true
        dispatch({ type: 'next' })
      }, TOAST_ANIMATION_MS)
      return () => clearTimeout(t)
    }
    if (shownKey.current !== key) {
      shownKey.current = key
      remaining.current = duration
    }
    if (paused) return
    const started = Date.now()
    const t = setTimeout(() => dispatch({ type: 'expire' }), remaining.current)
    return () => {
      clearTimeout(t)
      remaining.current = Math.max(0, remaining.current - (Date.now() - started))
    }
  }, [key, state.leaving, paused, duration])

  // The toast that had focus went (dismissed, or replaced): focus moves to the next one's button, else back where it was.
  useEffect(() => {
    if (!focused.current || box.current?.contains(document.activeElement)) return
    const next = box.current?.querySelector<HTMLElement>('[data-toast-focus]')
    if (next) {
      next.focus()
      return
    }
    focused.current = false
    if (returnTo.current?.isConnected) returnTo.current.focus()
    returnTo.current = null
  }, [key])

  const value = useMemo(() => ({ show }), [show])
  const entry = state.current
  const close = () => dispatch({ type: 'expire' })
  const urgent = !!entry?.notice.urgent
  const toast = entry && (
    <div
      key={entry.key}
      ref={box}
      data-testid="toast"
      data-toast={entry.notice.id}
      data-leaving={state.leaving || undefined}
      onMouseEnter={() => setPausedKey(entry.key)}
      onMouseLeave={() => setPausedKey(null)}
      onFocus={(e) => {
        if (!focused.current && e.relatedTarget instanceof HTMLElement && !box.current?.contains(e.relatedTarget)) returnTo.current = e.relatedTarget
        focused.current = true
        setPausedKey(entry.key)
      }}
      onBlur={(e) => {
        // Moving within the toast keeps it paused; leaving it for the page lets it run.
        if (box.current?.contains(e.relatedTarget as Node | null)) return
        focused.current = false
        returnTo.current = null
        setPausedKey(null)
      }}
      tabIndex={-1}
      className={cn(
        'pointer-events-auto relative flex max-w-[440px] items-center gap-2.5 overflow-hidden rounded-[10px] border border-line-2 bg-active px-4 py-3 text-[14px] text-fg shadow-[var(--shadow-dialog)] outline-none',
        state.leaving ? 'lp-toast-out' : 'lp-toast-in',
      )}
    >
      <entry.notice.icon size={17} className={cn('shrink-0', NOTICE_TEXT[entry.notice.tone])} />
      <div className="min-w-0 flex-1">
        <p>{entry.notice.title}</p>
        {entry.notice.detail && <p className="text-[13px] text-fg-2">{entry.notice.detail}</p>}
      </div>
      {entry.notice.action && (
        <button
          type="button"
          data-testid="toast-action"
          data-toast-focus
          onClick={() => {
            if (state.leaving || acted.current === entry.key) return
            acted.current = entry.key
            entry.notice.action?.onClick()
            close()
          }}
          className="shrink-0 cursor-pointer rounded-ctl border-0 bg-transparent px-2 py-1 text-[13px] font-medium text-fg underline underline-offset-2 hover:bg-line"
        >
          {entry.notice.action.label}
        </button>
      )}
      <button type="button" aria-label="Dismiss" data-toast-focus={entry.notice.action ? undefined : true} onClick={close} className="-mr-1.5 shrink-0 cursor-pointer rounded-ctl border-0 bg-transparent p-1 text-fg-3 hover:bg-line hover:text-fg">
        <X size={15} />
      </button>
      <span
        aria-hidden
        data-testid="toast-countdown"
        className={cn('lp-toast-countdown absolute inset-x-0 bottom-0 h-[2px] origin-left', NOTICE_BAR[entry.notice.tone])}
        style={{ animationDuration: `${duration}ms`, animationPlayState: paused || state.leaving ? 'paused' : 'running' }}
      />
    </div>
  )

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        data-testid="toast-region"
        className="pointer-events-none fixed inset-x-0 bottom-[calc(76px+env(safe-area-inset-bottom,0px))] z-50 flex flex-col px-4 min-[900px]:bottom-6 min-[900px]:left-[244px]"
      >
        {/* Both live regions stay mounted, so a toast lands in one that is already listening at its politeness. */}
        <div role="status" aria-live="polite" className="flex w-full justify-center">{!urgent && toast}</div>
        <div role="alert" aria-live="assertive" className="flex w-full justify-center">{urgent && toast}</div>
      </div>
    </ToastContext.Provider>
  )
}
