/**
 * Starter Autopilot rules from the knowledge bundle (ADR-0029): pH outside its
 * range, EC below the crop's target, the tank below half. Offered, never
 * armed: a person opens one in the rule builder, it saves in dry-run like every
 * new rule (ADR-0020), and they arm it once its backtest and run log look
 * right. Each notifies only and links the note its threshold comes from.
 */
import type { SensorId } from '../hardware/contract'
import type { HalSnapshot } from '../hardware/types'
import type { AutomationRule, Expr } from '../autopilot/types'
import type { Store } from '../store/types'
import { cropGroup } from './chores'
import { CITE, type Citation, EC_TARGETS, PH_RANGE, TANK_MIN_PCT } from './knowledge'

export const STARTER_IDS = ['ph_range', 'ec_low', 'tank_half'] as const
export type StarterId = typeof STARTER_IDS[number]

export interface StarterRule {
  id: StarterId
  title: string
  description: string
  /** What the rule reads; it is only offered as usable when the unit has them. */
  sensors: Array<keyof typeof PROBE>
  /** Null when the unit can run it; else why not ("no pH probe"). */
  unavailable: string | null
  /** A rule with this name already exists. */
  added: boolean
  citations: Citation[]
  /** The rule as the builder opens it; it saves in dry-run. */
  rule: Omit<AutomationRule, 'id' | 'enabled' | 'dryRun'>
}

const lit = (value: number): Expr => ({ kind: 'literal', value })
const avg = (signal: string, lastMin: number): Expr => ({ kind: 'window', fn: 'avg', signal, lastMin })
const PROBE = { ph: 'no pH probe', ec: 'no EC probe', water_level_pct: 'no tank level sensor' } as const satisfies Partial<Record<SensorId, string>>

/** The starters for this unit: the EC target follows what the tower grows. */
export function starterRules(store: Store, snap: HalSnapshot): StarterRule[] {
  const planted = store.pods.list().filter(p => p.status !== 'empty')
  const { group } = cropGroup(store, planted)
  const ec = EC_TARGETS[group]
  const caps = new Set(snap.system?.caps.sensors ?? [])
  const names = new Set(store.automations.list().map(r => r.name.trim().toLowerCase()))
  const drafts: Array<Omit<StarterRule, 'unavailable' | 'added'>> = [
    {
      id: 'ph_range',
      title: `pH outside ${PH_RANGE.min}–${PH_RANGE.max}`,
      description: `Tell me when the hour's average pH leaves ${PH_RANGE.min}–${PH_RANGE.max}, the range for greens and herbs. Adjust slowly: 1 mL per gallon, then retest.`,
      sensors: ['ph'],
      citations: [CITE.phEc, CITE.ownerTargets],
      rule: {
        name: `pH outside ${PH_RANGE.min}–${PH_RANGE.max}`,
        priority: 50,
        cooldownMin: 360,
        trigger: { kind: 'tick', everyMin: 15 },
        conditions: { kind: 'or', conditions: [
          { kind: 'compare', op: '<', left: avg('sensor.ph', 60), right: lit(PH_RANGE.min) },
          { kind: 'compare', op: '>', left: avg('sensor.ph', 60), right: lit(PH_RANGE.max) },
        ] },
        actions: [{ kind: 'notify', message: `pH out of ${PH_RANGE.min}–${PH_RANGE.max}: adjust 1 mL per gallon at a time and retest after 15–30 min` }],
      },
    },
    {
      id: 'ec_low',
      title: `EC below ${ec.min.toFixed(1)} mS/cm`,
      description: `Tell me when the hour's average EC drops below ${ec.min.toFixed(1)} mS/cm, the low end for ${group}, so I feed to the reading.`,
      sensors: ['ec'],
      citations: [CITE.phEc, CITE.dosesByProduct],
      rule: {
        name: `EC below ${ec.min.toFixed(1)} mS/cm`,
        priority: 50,
        cooldownMin: 720,
        trigger: { kind: 'tick', everyMin: 30 },
        conditions: { kind: 'and', conditions: [{ kind: 'compare', op: '<', left: avg('sensor.ec', 60), right: lit(ec.min) }] },
        actions: [{ kind: 'notify', message: `EC below ${ec.min.toFixed(1)} mS/cm for ${group}: feed until it reads about ${ec.min.toFixed(1)}` }],
      },
    },
    {
      id: 'tank_half',
      title: 'Tank below half',
      description: `Tell me when the tank has been under ${TANK_MIN_PCT} % for half an hour. Gardyn says to keep it at least half full.`,
      sensors: ['water_level_pct'],
      citations: [CITE.tankHalfFull],
      rule: {
        name: 'Tank below half',
        priority: 50,
        cooldownMin: 240,
        trigger: { kind: 'tick', everyMin: 15 },
        conditions: { kind: 'sustained', forMin: 30, condition: { kind: 'and', conditions: [{ kind: 'compare', op: '<', left: { kind: 'signal', signal: 'sensor.water_level_pct' }, right: lit(TANK_MIN_PCT) }] } },
        actions: [{ kind: 'notify', message: 'Tank below half: top it off' }],
      },
    },
  ]
  return drafts.map((d) => {
    const missing = d.sensors.find(s => !caps.has(s))
    return { ...d, unavailable: missing ? PROBE[missing] : null, added: names.has(d.rule.name.toLowerCase()) }
  })
}
