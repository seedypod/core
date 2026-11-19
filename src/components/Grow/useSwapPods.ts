import { trpc } from '@/src/utils/trpc'

/** What pods `a` and `b` hold, traded as grow.swapPods trades them; each keeps its slot. */
export function swappedPods<P extends { slot: number }>(pods: P[], a: number, b: number): P[] {
  const pa = pods.find(p => p.slot === a)
  const pb = pods.find(p => p.slot === b)
  if (!pa || !pb || a === b) return pods
  return pods.map(p => (p.slot === a ? { ...pb, slot: a } : p.slot === b ? { ...pa, slot: b } : p))
}

/**
 * grow.swapPods, shown at once: the pods query trades the two records before
 * the unit answers, takes its answer after, and goes back on an error. What a
 * swap changes besides (the harvest outlook, the plan, the protocol) refreshes
 * from the `pods` event it raises, so the grid waits on none of it.
 */
export function useSwapPods() {
  const utils = trpc.useUtils()
  return trpc.grow.swapPods.useMutation({
    onMutate: async ({ a, b }) => {
      await utils.grow.pods.cancel()
      const before = utils.grow.pods.getData()
      if (before) utils.grow.pods.setData(undefined, swappedPods(before, a, b))
      return { before }
    },
    onError: (_e, _i, ctx) => {
      if (ctx?.before) utils.grow.pods.setData(undefined, ctx.before)
    },
    onSuccess: (out) => {
      utils.grow.pods.setData(undefined, pods => pods?.map(p => out.find(o => o.slot === p.slot) ?? p))
    },
  })
}
