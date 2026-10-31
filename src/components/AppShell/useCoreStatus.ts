import { trpc } from '@/src/utils/trpc'

/** One-line footer status: core version + HAL identity, like sleepypod's footerStatus. */
export function useCoreStatus(): string {
  const info = trpc.system.info.useQuery(undefined, { refetchInterval: 30_000 })
  if (!info.data) return info.isError ? 'core unreachable' : '…'
  const { coreVersion, halOnline, system } = info.data
  return `${coreVersion} · ${system?.model ?? 'no HAL'} · ${halOnline ? 'online' : 'offline'}`
}
