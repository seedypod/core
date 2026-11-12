/**
 * Node-only: fetch a weights file for `upload_model` (#186) from a machine on
 * the LAN, such as the laptop that trained it. The unit never reaches the
 * internet (AGENTS.md invariants), so a host must resolve only to private,
 * loopback or link-local addresses.
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { MAX_MODEL_BYTES, ModelRefused } from './registry'

/** Whether an IP address is private, loopback or link-local (never routed to the internet). */
export function isLanAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number)
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  }
  const v6 = ip.toLowerCase()
  if (v6.startsWith('::ffff:')) return isLanAddress(v6.slice(7))
  return v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6)
}

export type Resolve = (host: string) => Promise<string[]>

const resolveAll: Resolve = async host => (await lookup(host, { all: true })).map(a => a.address)

/** The file's text, or a refusal: not http(s), not on the LAN, too big, or the fetch failed. */
export async function fetchLanModel(url: string, opts: { resolve?: Resolve, fetch?: typeof fetch } = {}): Promise<string> {
  let u: URL
  try {
    u = new URL(url)
  }
  catch {
    throw new ModelRefused(400, `not a URL: ${url}`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ModelRefused(400, 'only http and https URLs')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(host) ? [host] : await (opts.resolve ?? resolveAll)(host).catch(() => [])
  if (addresses.length === 0) throw new ModelRefused(400, `can't resolve ${host}`)
  if (!addresses.every(isLanAddress)) throw new ModelRefused(400, `${host} is not on the local network; the unit only fetches models from the LAN`)
  const res = await (opts.fetch ?? fetch)(u, { redirect: 'error', signal: AbortSignal.timeout(60_000) }).catch((e: Error) => {
    throw new ModelRefused(400, `fetching ${url} failed: ${e.message}`)
  })
  if (!res.ok) throw new ModelRefused(400, `fetching ${url} failed: HTTP ${res.status}`)
  if (Number(res.headers.get('content-length') ?? 0) > MAX_MODEL_BYTES) throw new ModelRefused(400, `the weights file is over ${MAX_MODEL_BYTES} bytes`)
  const text = await res.text()
  if (text.length > MAX_MODEL_BYTES) throw new ModelRefused(400, `the weights file is over ${MAX_MODEL_BYTES} bytes`)
  return text
}
