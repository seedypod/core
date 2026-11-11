import { useLocation, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useToast, type ToastNotice } from '@/src/components/ds/toast'
import type { CoreEvent } from '@/src/lib/eventBus'
import { trpc } from '@/src/utils/trpc'
import { followSnack, newAlertSnacks, pumpWatch, type Snack } from './snacks'

/** A snack as the toast shows it here: nothing on the kiosk or on the page that already shows it, and no View on the page it would open. */
export function present(s: Snack, pathname: string, go: (to: string) => void): ToastNotice | null {
  // The kiosk is a wall display with no shell: it never shows a toast.
  if (pathname.startsWith('/kiosk') || (s.shownOn && pathname.startsWith(s.shownOn))) return null
  const view = s.view && !pathname.startsWith(s.view.to) ? s.view : undefined
  return {
    id: s.id,
    kind: s.tone === 'ok' ? 'success' : 'info',
    tone: s.tone,
    icon: s.icon,
    title: s.title,
    detail: s.detail,
    urgent: s.urgent,
    action: view && { label: view.label, onClick: () => go(view.to) },
  }
}

/**
 * Snackbars for what the care engine and the hardware just did: Follow moving
 * the watering on, a manual run finishing (both from the live events, through
 * the returned handler), and a newly raised fault or notice (from the open
 * alerts list, which those events refresh).
 */
export function useSnackbars(): (e: CoreEvent) => void {
  const { show } = useToast()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const here = useRef(pathname)
  useEffect(() => {
    here.current = pathname
  }, [pathname])
  const [pump] = useState(() => pumpWatch())
  const open = trpc.alerts.list.useQuery({ activeOnly: true })
  const last = useRef<ReadonlyArray<{ id: number }> | undefined>(undefined)

  const emit = useCallback((s: Snack | null) => {
    const notice = s && present(s, here.current, to => void navigate({ to }))
    if (notice) show(notice)
  }, [navigate, show])

  useEffect(() => {
    if (!open.data) return
    for (const s of newAlertSnacks(last.current, open.data)) emit(s)
    last.current = open.data
  }, [open.data, emit])

  return useCallback((e: CoreEvent) => emit(followSnack(e) ?? pump(e)), [emit, pump])
}
