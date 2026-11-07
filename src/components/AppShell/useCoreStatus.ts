import { trpc } from '@/src/utils/trpc'

/** The unit's name and a one-line status under it: HAL model, core version, online. */
export function useCoreStatus(): { name: string, line: string, online: boolean } {
  const info = trpc.system.info.useQuery(undefined, { refetchInterval: 30_000 })
  const settings = trpc.settings.get.useQuery()
  const name = settings.data?.unitName ?? 'seedypod'
  if (!info.data) return { name, line: info.isError ? 'core unreachable' : '…', online: false }
  const { coreVersion, halOnline, system } = info.data
  return { name, line: `${system?.model ?? 'no HAL'} · core ${coreVersion} · ${halOnline ? 'online' : 'offline'}`, online: halOnline }
}
