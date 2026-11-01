/**
 * MCP server over the tRPC caller (sleepypod pattern, ADR-0011).
 *
 * Every tool is a named read/write primitive with units and declared limits so
 * it maps onto the Model Hardware Standard's read/write shape when that spec
 * opens. Tools never bypass the HAL safety guard: a refusal comes back as an
 * error the agent can read, never as silent success.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { RuleInput } from '../autopilot/schema'
import { SensorId } from '../hardware/contract'
import type { Context } from '../server/context'
import { appRouter } from '../server/routers/app'
import { createCallerFactory } from '../server/trpc'

const createCaller = createCallerFactory(appRouter)

function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] }
}

export function createMcpServer(ctx: Context): McpServer {
  const caller = createCaller(ctx)
  const server = new McpServer({ name: 'seedypod', version: ctx.version })

  // ── Read ─────────────────────────────────────────────────────────────────
  server.registerTool('status', {
    description: 'Current state of the tower: HAL identity and enforced limits, every sensor reading with units, light/pump state (including any latched fault), active alerts, and the grow cycle day/stage.',
    inputSchema: {},
  }, async () => {
    const snap = ctx.hal.snapshot()
    const grow = await caller.grow.current()
    const alerts = await caller.alerts.list({ activeOnly: true })
    return text({ system: snap.system, online: snap.online, sensors: snap.sensors, actuators: snap.actuators, alerts, grow })
  })

  server.registerTool('history', {
    description: 'Downsampled sensor history. sensor is one of air_temp, humidity, pcb_temp, water_distance, water_level_pct, pump_w, ph, ec, water_temp. hours defaults to 24.',
    inputSchema: { sensor: SensorId, hours: z.number().min(1).max(2160).optional(), max_points: z.number().int().min(10).max(500).optional() },
  }, async i => text(await caller.telemetry.history({ sensor: i.sensor, hours: i.hours ?? 24, maxPoints: i.max_points ?? 100 })))

  server.registerTool('list_devices', {
    description: 'Sensor hardware on the unit: every configured device (kind, label, I²C address, the quantities it reports, source config|user, status ready|absent with the probe error) and the kinds that can be added, each with its calibration procedure (ordered steps: point, instruction, suggested reference value, optional). Adding, removing and calibrating probes need a person at the unit, so they are done in the app, not by agents.',
    inputSchema: {},
  }, async () => text(await caller.devices.list()))

  server.registerTool('list_schedules', { description: 'Light curves (interpolated setpoints by minute-of-day) and pump cycles, with day masks (Mon=1 … Sun=64).', inputSchema: {} }, async () => text(await caller.schedules.list()))

  server.registerTool('pods', { description: 'The 30 plant pods: slot, plant, planted date, status (empty, seeded, growing, harvest, attention) and notes.', inputSchema: {} }, async () => text(await caller.grow.pods()))

  server.registerTool('captures', {
    description: 'Recent camera stills (newest first) with URLs relative to the core host. camera: upper or lower.',
    inputSchema: { camera: z.enum(['upper', 'lower']).optional(), limit: z.number().int().min(1).max(50).optional() },
  }, async i => text(await caller.camera.list({ camera: i.camera, limit: i.limit ?? 10 })))

  server.registerTool('list_analyses', {
    description: 'Camera analysers and what they have produced: every on-device analyser (id, version, metrics it emits, which one is primary for pod_health) plus any off-device worker that posted results, with row and capture counts and time span, and the analysis queue status. Pass slot to also get that pod\'s series from every analyser@version side by side, to see which ones agree. Read-only: choosing the primary analyser and re-running analysers are done in the app.',
    inputSchema: { slot: z.number().int().min(1).max(30).optional(), metric: z.string().optional() },
  }, async (i) => {
    const analyzers = await caller.vision.analyzers()
    const status = await caller.vision.status()
    const compare = i.slot ? await caller.vision.compare({ slot: i.slot, metric: i.metric ?? 'green_fraction', limit: 48 }) : undefined
    return text({ analyzers, status, compare })
  })

  server.registerTool('list_automations', {
    description: 'Autopilot rules (WHEN trigger / IF conditions / THEN actions, as JSON), whether each is enabled or in dry-run, its last run, the kill switch, which source owns the light (manual hold, Autopilot or schedule), and the latest audit-log entries. Read-only: creating, arming or disabling rules changes what the unit does unattended, so that is done in the app.',
    inputSchema: { runs: z.number().int().min(0).max(100).optional() },
  }, async i => text({ rules: await caller.automations.list(), status: await caller.automations.status(), runs: await caller.automations.runs({ limit: i.runs ?? 20 }) }))

  server.registerTool('backtest_automation', {
    description: 'Replay an Autopilot rule over recorded history without touching hardware: by id, or a draft rule (same JSON shape as list_automations returns, without id). Returns the traces of every signal it reads, when it would have fired and what each action would have done (raw and clamped values), cooldown suppressions, and signals that are live-only (unknown in a backtest). Signal keys come from the catalog: sensor.<id>, light.level, pump.on, alert.<kind>, pod.<slot>.green, pod.<slot>.trend, grow.day.',
    inputSchema: { id: z.number().int().optional(), rule: z.unknown().optional(), hours: z.number().int().min(1).max(336).optional(), step_min: z.number().int().min(1).max(60).optional() },
  }, async (i) => {
    const rule = i.rule === undefined ? undefined : RuleInput.parse(i.rule)
    return text(await caller.automations.backtest({ id: i.id, rule, hours: i.hours ?? 24, stepMin: i.step_min ?? 5 }))
  })

  server.registerTool('pod_health', {
    description: 'Per-pod growth verdicts from camera stills: green-area fraction and trend (growing / stalled / declining / unknown), from the primary analyser (see list_analyses). Use with `pods` to decide which slots need attention.',
    inputSchema: {},
  }, async () => text(await caller.vision.podTrends()))

  server.registerTool('harvest_outlook', {
    description: 'Per planted pod: state (ready | soon | growing | unknown), age in days, leaf cover (0–1 green fraction of the pod in camera stills) against its target, cover gained per day, the harvest window in days from planting (from a plant profile, else estimated from the camera), days to ready / days left, the matched profile, and a one-sentence reason. The camera leads; profiles (see plant_profiles) add windows and targets.',
    inputSchema: {},
  }, async () => text(await caller.grow.harvest()))

  server.registerTool('plant_profiles', {
    description: 'Per-crop harvest knowledge the unit holds: name, harvest window (harvestMinDays–harvestMaxDays from planting), targetCover (leaf cover 0–1 at which it is worth cutting), notes, and whether a person or an agent set it. Pods match a profile by exact name, else by the longest profile name whose words all appear in the pod\'s plant name ("Kale" covers "Red Russian Kale").',
    inputSchema: {},
  }, async () => text(await caller.plants.list()))

  // ── Write (all go through the HAL guard) ─────────────────────────────────
  server.registerTool('set_light', {
    description: 'Set the grow light. level is brightness 0–100 (%). Omit on to infer from level. Note a light schedule will override this at its next setpoint change.',
    inputSchema: { on: z.boolean().optional(), level: z.number().min(0).max(100).optional() },
  }, async i => text(await caller.light.set(i)))

  server.registerTool('run_pump', {
    description: 'Run the water pump for duration_s seconds at level (% of the HAL-enforced max duty, default max). The HAL clamps duration to its max-run limit and refuses when the tank is low or a fault is latched; a refusal returns an error.',
    inputSchema: { duration_s: z.number().int().positive().max(3600), level: z.number().min(1).max(100).optional() },
  }, async i => text(await caller.pump.runOnce({ durationS: i.duration_s, level: i.level })))

  server.registerTool('stop_pump', { description: 'Stop the pump immediately.', inputSchema: {} }, async () => text(await caller.pump.stop()))

  server.registerTool('acknowledge_alert', {
    description: 'Acknowledge an alert by id (from status). For latched hardware faults (pump_fault, dose_fault) this re-enables the actuator — only do it after the cause is fixed (e.g. tank refilled, dosing checked). For reminders it marks the chore done.',
    inputSchema: { id: z.number().int() },
  }, async i => text(await caller.alerts.acknowledge({ id: i.id })))

  server.registerTool('upsert_schedule', {
    description: 'Create or replace a schedule. Light: {id, kind:"light", name, enabled, days, spec:{setpoints:[{minute, level}]}} — levels are interpolated between setpoints and wrap past midnight. Pump: {id, kind:"pump", name, enabled, days, spec:{minute, durationS, level?}}. days is a bitmask Mon=1 … Sun=64 (127 = daily).',
    inputSchema: {
      id: z.string().min(1), kind: z.enum(['light', 'pump']), name: z.string().min(1), enabled: z.boolean().default(true), days: z.number().int().min(0).max(127).default(127),
      spec: z.union([
        z.object({ setpoints: z.array(z.object({ minute: z.number().int().min(0).max(1439), level: z.number().min(0).max(100) })) }),
        z.object({ minute: z.number().int().min(0).max(1439), durationS: z.number().int().positive().max(3600), level: z.number().min(1).max(100).optional() }),
      ]),
    },
  }, async i => text(await caller.schedules.upsert(i)))

  server.registerTool('delete_schedule', { description: 'Delete a schedule by id.', inputSchema: { id: z.string() } }, async i => text(await caller.schedules.remove(i)))

  server.registerTool('update_pod', {
    description: 'Update a plant pod: what is planted, when, its status and notes.',
    inputSchema: { slot: z.number().int().min(1).max(60), plant: z.string().nullable().optional(), planted_at: z.string().nullable().optional(), status: z.enum(['empty', 'seeded', 'growing', 'harvest', 'attention']).optional(), notes: z.string().optional() },
  }, async i => text(await caller.grow.updatePod({ slot: i.slot, plant: i.plant, plantedAt: i.planted_at, status: i.status, notes: i.notes })))

  server.registerTool('set_plant_profiles', {
    description: 'Create or replace plant profiles by name, to sharpen harvest_outlook. A good workflow: read `pods`, then for each distinct plant give its typical days from planting (seeding the pod) to first harvest in an indoor hydroponic tower under grow lights as harvest_min_days–harvest_max_days, and the leaf cover (0–1; the share of the pod\'s camera crop that is plant, ~0.3 for a compact herb, ~0.4–0.5 for a full lettuce) at which it is worth cutting. Use the plant names as the pods spell them, or a shorter common name ("Kale"). Leave a field null when unsure; say what you assumed in notes.',
    inputSchema: {
      profiles: z.array(z.object({
        name: z.string().min(1),
        harvest_min_days: z.number().int().min(1).max(365).nullable().optional(),
        harvest_max_days: z.number().int().min(1).max(365).nullable().optional(),
        target_cover: z.number().min(0.05).max(1).nullable().optional(),
        notes: z.string().optional(),
      })).min(1).max(100),
    },
  }, async i => text(await caller.plants.upsert({
    profiles: i.profiles.map(p => ({ name: p.name, harvestMinDays: p.harvest_min_days ?? null, harvestMaxDays: p.harvest_max_days ?? null, targetCover: p.target_cover ?? null, notes: p.notes ?? '', source: 'agent' as const })),
  })))

  server.registerTool('remove_plant_profile', { description: 'Delete a plant profile by name.', inputSchema: { name: z.string().min(1) } }, async i => text(await caller.plants.remove(i)))

  server.registerTool('mark_harvested', {
    description: 'Record that a pod was cut: its status goes back to growing and the camera counts only regrowth from now on. For a final harvest, use update_pod to empty it instead.',
    inputSchema: { slot: z.number().int().min(1).max(60) },
  }, async i => text(await caller.grow.markHarvested(i)))

  server.registerTool('grow_cycle', {
    description: 'Manage the grow cycle: action start (optionally with notes), stage (germination|seedling|vegetative|harvest), or end.',
    inputSchema: { action: z.enum(['start', 'stage', 'end']), stage: z.enum(['germination', 'seedling', 'vegetative', 'harvest']).optional(), notes: z.string().optional() },
  }, async (i) => {
    if (i.action === 'start') return text(await caller.grow.start({ notes: i.notes ?? '' }))
    if (i.action === 'stage') return text(await caller.grow.setStage({ stage: i.stage ?? 'germination' }))
    return text(await caller.grow.end())
  })

  server.registerTool('capture_still', { description: 'Take a still from a camera now and return its record (URL relative to the core host).', inputSchema: { camera: z.enum(['upper', 'lower']) } }, async i => text(await caller.camera.capture(i)))

  // ── Resources ────────────────────────────────────────────────────────────
  server.registerResource('sensors', 'seedypod://sensors', { description: 'Latest sensor readings', mimeType: 'application/json' }, async uri => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(ctx.hal.snapshot().sensors) }],
  }))
  server.registerResource('devices', 'seedypod://devices', { description: 'Sensor devices (with probe status) and addable kinds with their calibration steps', mimeType: 'application/json' }, async uri => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(ctx.hal.snapshot().devices) }],
  }))
  server.registerResource('limits', 'seedypod://limits', { description: 'Hardware limits the HAL enforces (pump max run, max duty, dry-run threshold)', mimeType: 'application/json' }, async uri => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(ctx.hal.snapshot().system?.limits ?? null) }],
  }))

  return server
}
