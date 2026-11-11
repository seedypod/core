import { useEffect, useRef, useState } from 'react'
import { trpc } from '@/src/utils/trpc'

/** How long a requested level stands in for one the light never reports reaching. */
export const HOLD_MS = 30_000

/**
 * The light and what a person has asked of it. `level` is the requested level
 * from the first touch until the light reports it, so the slider stays where it
 * was put through the command's round trip, overlapping commands and any fade,
 * rather than following the light there.
 */
export function useLightControl() {
  const utils = trpc.useUtils()
  const light = trpc.light.get.useQuery()
  const [held, setHeld] = useState<number | null>(null)
  const expiry = useRef<ReturnType<typeof setTimeout>>(undefined)
  const hold = (level: number | null) => {
    clearTimeout(expiry.current)
    setHeld(level)
    if (level !== null) expiry.current = setTimeout(() => setHeld(null), HOLD_MS)
  }
  useEffect(() => () => clearTimeout(expiry.current), [])
  const newest = useRef(0)
  // On the hook, not on mutate: a later mutate or an unmount silently drops mutate's own callbacks.
  const setLight = trpc.light.set.useMutation({
    onMutate: () => ({ command: ++newest.current }),
    // Only the newest command's answer: an older one arriving late would put the old level back. The live event still refreshes the rest.
    onSuccess: (state, _, { command }) => {
      if (command === newest.current) utils.light.get.setData(undefined, state)
    },
    // Only the level still on show: a refused older command mustn't undo a newer one.
    onError: (_, sent) => setHeld(h => (h === sent.level ? null : h)),
  })
  const l = light.data
  if (held !== null && held === l?.level) setHeld(null)
  return {
    light: l,
    /** The light's query itself, for its loading and error state and to retry it. */
    query: light,
    level: held ?? l?.level ?? 0,
    /** Whether a requested level is on show, which turns the light on if it's off. */
    requested: held !== null,
    // The switch follows the tap; a refused command puts it back when the mutation ends.
    lightOn: (setLight.isPending ? setLight.variables.on : undefined) ?? !!l?.on,
    /** Shows a level without sending it, for the ticks of a drag. */
    preview: hold,
    commit: (level: number) => setLight.mutate({ level }),
    power: (on: boolean) => {
      hold(null)
      setLight.mutate({ on })
    },
  }
}
