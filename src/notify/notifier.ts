/**
 * Sends pod events to the owner's ntfy topic or webhook (ADR-0032). Alerts are
 * seen where every alert is written, the store, so each one notifies once when
 * it's raised and, for problems, once when it clears. Pump runs and light
 * changes come from the HAL. Delivery is one request at a time, off the caller's path, with a few
 * retries; a failure is kept for Settings and logged without the URL.
 */
import type { LightSource } from '../control/light'
import type { ActuatorState, PumpRun } from '../hardware/contract'
import type { EventBus } from '../lib/eventBus'
import { UNREADABLE } from '../lib/waterLow'
import type { AlertRow, Store } from '../store/types'
import { alertTitle, buildRequest, enabledGroups, groupOf, type NotifyConfig, type NotifyEvent } from './targets'

export interface DeliveryStatus {
  at: string
  ok: boolean
  title: string
  /** `HTTP 200`, or why it failed. */
  detail: string
}

/** Waits before the 2nd, 3rd and 4th try. */
const RETRY_MS = [10_000, 60_000, 300_000]
const TIMEOUT_MS = 10_000
const MAX_QUEUE = 20
/** The same alert raising or clearing again within this long doesn't notify again. */
const REPEAT_MS = 15 * 60_000
/** A pump run that ended longer ago than this is the broker's retained copy, not a new run. */
const STALE_RUN_MS = 5 * 60_000
/**
 * An unreadable tank level waits this long before it notifies: a camera capture
 * or a busy minute can starve the ranger, and that clears by itself.
 */
const UNREADABLE_HOLD_MS = 10 * 60_000
/** A light change waits this long for the next one, so a fade or a curve's ramp (a step a minute) sends one message. */
const LIGHT_SETTLE_MS = 3 * 60_000
/** A smaller move while the light stays on isn't worth a message. */
const LIGHT_STEP = 5
const LIGHT_WHY: Record<Exclude<LightSource, null>, string> = { schedule: 'on schedule', autopilot: 'by Autopilot', manual: 'by hand' }

export interface NotifierOptions {
  store: Store
  events: EventBus
  now?: () => Date
  fetch?: typeof fetch
  log?: (m: string) => void
  /** Who's driving the light now, to say why it changed. */
  lightSource?: () => LightSource
}

export class Notifier {
  private queue: Array<{ e: NotifyEvent, tries: number }> = []
  private busy = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private last: DeliveryStatus | null = null
  private active = new Set<number>()
  private sentAt = new Map<string, number>()
  private lastRunStart: string | null = null
  /** The light level last reported (0 is off); null until the first state, which is the baseline. */
  private lightSent: number | null = null
  private lightNow = 0
  private lightTimer: ReturnType<typeof setTimeout> | null = null
  /** Alerts raised but not yet sent, by row id: an unreadable tank level waiting out its hold. */
  private held = new Map<number, ReturnType<typeof setTimeout>>()
  private undo: Array<() => void> = []

  constructor(private o: NotifierOptions) {}

  private now() {
    return this.o.now?.() ?? new Date()
  }

  start(): void {
    if (this.undo.length) return
    const a = this.o.store.alerts
    const { raise, clear, dismiss } = a
    for (const r of a.list({ activeOnly: true })) this.active.add(r.id)
    a.raise = (kind, detail, ts, opts) => {
      const row = raise(kind, detail, ts, opts)
      if (!this.active.has(row.id)) {
        this.active.add(row.id)
        if (unreadable(row)) this.hold(row)
        else this.alert(row, 'raised')
      }
      else if (this.held.has(row.id) && !unreadable(row)) {
        this.release(row.id)
        this.alert(row, 'raised')
      }
      return row
    }
    a.clear = (kind, ts) => {
      const row = clear(kind, ts)
      // One still on hold was never sent, so its clearing isn't either.
      if (row && this.active.delete(row.id) && !this.release(row.id) && !row.acknowledgedAt) this.alert(row, 'cleared')
      return row
    }
    a.dismiss = (id, ts) => {
      const row = dismiss(id, ts)
      if (row) {
        this.active.delete(row.id)
        this.release(row.id)
      }
      return row
    }
    const unsub = this.o.events.subscribe((e) => {
      if (e.kind === 'hal' && e.event.type === 'pumpRun') this.pumpRun(e.event.run)
      if (e.kind === 'hal' && e.event.type === 'actuator' && e.event.id === 'light') this.light(e.event.state)
    })
    this.undo.push(() => Object.assign(a, { raise, clear, dismiss }), unsub)
  }

  stop(): void {
    for (const u of this.undo.splice(0)) u()
    if (this.timer) clearTimeout(this.timer)
    if (this.lightTimer) clearTimeout(this.lightTimer)
    for (const id of [...this.held.keys()]) this.release(id)
    this.timer = null
    this.lightTimer = null
    this.queue = []
  }

  status(): { last: DeliveryStatus | null, pending: number } {
    return { last: this.last, pending: this.queue.length }
  }

  /** Sends a test now, past the event groups and without retries. */
  async test(): Promise<DeliveryStatus> {
    const c = this.config()
    if (!c) throw new Error('Pick where to send notifications first.')
    const e: NotifyEvent = { group: 'test', type: 'test', title: 'Test notification', message: 'Notifications from your seedypod work.', priority: 'default', at: this.now().toISOString(), data: {} }
    return (await this.deliver(c, e)).status
  }

  private config(): NotifyConfig | null {
    const s = this.o.store.settings.get()
    if (s.notifyTarget === 'ntfy' && s.ntfyTopic) return { target: 'ntfy', server: s.ntfyServer, topic: s.ntfyTopic, unitName: s.unitName }
    if (s.notifyTarget === 'webhook' && s.webhookUrl) return { target: 'webhook', url: s.webhookUrl, format: s.webhookFormat, secret: s.webhookSecret, unitName: s.unitName }
    return null
  }

  private alert(row: AlertRow, type: 'raised' | 'cleared'): void {
    const group = groupOf(row.kind)
    if (type === 'cleared' && group !== 'alerts') return
    const key = `${row.kind}:${type}`
    const now = this.now().getTime()
    const prev = this.sentAt.get(key)
    if (prev !== undefined && now - prev < REPEAT_MS) return
    const lost = unreadable(row)
    const title = group === 'autopilot' ? 'Autopilot' : lost ? 'Tank level unreadable' : alertTitle(row.kind)
    const message = type === 'cleared'
      ? lost ? 'The tank reads again.' : 'Cleared by itself.'
      : lost ? `No trusted tank reading for ${UNREADABLE_HOLD_MS / 60_000} minutes. Check the sensor under the lid.` : row.detail
    const sent = this.send({
      group,
      type,
      title: type === 'cleared' ? `${title}: resolved` : title,
      message,
      priority: type === 'cleared' ? 'low' : group === 'alerts' ? 'high' : 'default',
      at: (type === 'cleared' ? row.clearedAt : row.raisedAt) ?? this.now().toISOString(),
      data: { kind: row.kind, id: row.id, detail: row.detail },
    })
    if (sent) this.sentAt.set(key, now)
  }

  /** Sends `row` once it has stayed up through the hold, unless it clears first. */
  private hold(row: AlertRow): void {
    this.held.set(row.id, setTimeout(() => {
      this.held.delete(row.id)
      this.alert(row, 'raised')
    }, UNREADABLE_HOLD_MS))
  }

  /** Drops a held alert; false when `id` wasn't held. */
  private release(id: number): boolean {
    const t = this.held.get(id)
    if (t === undefined) return false
    clearTimeout(t)
    this.held.delete(id)
    return true
  }

  private pumpRun(run: PumpRun): void {
    const ended = Date.parse(run.endedAt)
    if (run.startedAt === this.lastRunStart || this.now().getTime() - ended > STALE_RUN_MS) return
    this.lastRunStart = run.startedAt
    const took = fmtDuration(ended - Date.parse(run.startedAt))
    const tank = run.levelPct === null ? '' : `, tank ${Math.round(run.levelPct)}% full`
    const message = run.endedBy === 'fault'
      ? `Watering stopped after ${took}: ${run.fault ?? 'pump fault'}${tank}.`
      : `Watered for ${took}${run.endedBy === 'stop' ? ' (stopped early)' : ''}${tank}.`
    this.send({ group: 'watering', type: 'ran', title: 'Watering', message, priority: run.endedBy === 'fault' ? 'high' : 'low', at: run.endedAt, data: { startedAt: run.startedAt, endedAt: run.endedAt, endedBy: run.endedBy, fault: run.fault, levelPct: run.levelPct } })
  }

  private light(state: ActuatorState): void {
    const level = state.on ? Math.round(state.level) : 0
    if (this.lightSent === null) {
      this.lightSent = level
      return
    }
    this.lightNow = level
    if (this.lightTimer) clearTimeout(this.lightTimer)
    this.lightTimer = setTimeout(() => {
      this.lightTimer = null
      this.lightSettled()
    }, LIGHT_SETTLE_MS)
  }

  private lightSettled(): void {
    const from = this.lightSent ?? 0
    const to = this.lightNow
    if (from === to || (from > 0 && to > 0 && Math.abs(to - from) < LIGHT_STEP)) return
    this.lightSent = to
    const source = this.o.lightSource?.() ?? null
    const why = source ? LIGHT_WHY[source] : null
    const title = to === 0 ? 'Light off' : from === 0 ? 'Light on' : to < from ? 'Light dimmed' : 'Light brightened'
    const message = to === 0 ? `Turned off${why ? ` ${why}` : ''}.` : `${from === 0 ? 'On at' : 'Now'} ${to}%${why ? `, ${why}` : ''}.`
    this.send({ group: 'lights', type: 'changed', title, message, priority: 'low', at: this.now().toISOString(), data: { from, to, source } })
  }

  /** Queues an event the owner opted into; false when it isn't sent anywhere. */
  private send(e: NotifyEvent): boolean {
    const s = this.o.store.settings.get()
    if (!this.config() || e.group === 'test' || !enabledGroups(s.notifyGroups).has(e.group)) return false
    this.queue.push({ e, tries: 0 })
    if (this.queue.length > MAX_QUEUE) this.queue.shift()
    void this.drain()
    return true
  }

  private async drain(): Promise<void> {
    if (this.busy || this.timer) return
    this.busy = true
    try {
      while (this.queue.length) {
        const job = this.queue[0]
        const c = this.config()
        if (!c) {
          this.queue = []
          break
        }
        const r = await this.deliver(c, job.e)
        if (r.status.ok || !r.retry || job.tries >= RETRY_MS.length) {
          this.queue.shift()
          continue
        }
        this.timer = setTimeout(() => {
          this.timer = null
          void this.drain()
        }, RETRY_MS[job.tries])
        job.tries++
        break
      }
    }
    finally {
      this.busy = false
    }
  }

  private async deliver(c: NotifyConfig, e: NotifyEvent): Promise<{ status: DeliveryStatus, retry: boolean }> {
    const req = await buildRequest(c, e)
    let ok = false
    let retry = true
    let detail: string
    try {
      const res = await (this.o.fetch ?? fetch)(req.url, { method: 'POST', headers: req.headers, body: req.body, signal: AbortSignal.timeout(TIMEOUT_MS) })
      ok = res.ok
      retry = res.status >= 500 || res.status === 429
      detail = `HTTP ${res.status}`
    }
    catch (err) {
      detail = failure(err).split(req.url).join('the server')
    }
    this.last = { at: this.now().toISOString(), ok, title: e.title, detail }
    if (!ok) this.o.log?.(`notify: ${e.title}: ${detail}`)
    this.o.events.emit({ kind: 'mutation', path: 'notifications' })
    return { status: this.last, retry }
  }
}

function failure(err: unknown): string {
  const e = err as Error & { cause?: { code?: string } }
  if (e.name === 'TimeoutError') return `no answer in ${TIMEOUT_MS / 1000} s`
  return e.cause?.code ? `couldn't connect (${e.cause.code})` : e.message
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  return s % 60 ? `${m} min ${s % 60} s` : `${m} min`
}

/** hald's `water_low` for a ranger that didn't answer, rather than low water. */
const unreadable = (row: AlertRow): boolean => row.kind === 'water_low' && row.detail === UNREADABLE
