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
import { boostHours, GARDYN_LIGHT_GUIDE, LIGHT_PRESETS, lightRating } from '../scheduler/lightPlan'
import { dailyMinutes, daysSinceSowing, GARDYN_WATERING_GUIDE, lightWindow, presetRuns, presetSchedules, PUMP_PRESETS, recommendPreset, TIPS_CITATION, WATERING_TIPS } from '../scheduler/pumpPlan'
import { SensorId } from '../hardware/contract'
import { dayOn, weekdayOf } from '../lib/days'
import type { Context } from '../server/context'
import { appRouter } from '../server/routers/app'
import { Overrides } from '../server/routers/planner'
import { TankActionKind, TankUnit } from '../server/routers/tank'
import { createCallerFactory } from '../server/trpc'
import { fetchLanModel } from '../vision/modelFetch'
import { POD_STATES } from '../vision/podState'

const createCaller = createCallerFactory(appRouter)

/** How the planner reads the tower, for the planner tools' descriptions. */
const ZONE_RULES = 'Light zones follow Gardyn\'s map: high light is the centre-most cluster of pods, medium encircles it, low is the top and bottom rows on a Home (lower-left and upper-right on a Studio); planner_zones lists every slot by row. Each plant goes in its ideal zone; only when that zone is full does it drop one zone lower (never two, never up); overrides.allowedZones can widen that. Cucumbers start at the bottom of the middle column; large plants are spaced apart.'
const OVERRIDES_HELP = 'Optional. pins: [{slot, plantId}] puts one pod of that plant in that exact slot (counts toward its count). allowedZones: {plantId: ["high","medium","low"]} replaces its ideal-or-one-lower zones, e.g. to allow two zones lower or keep it in one zone. replant: true lays out the whole tower as if nothing were planted (pins may then name planted pods); apply_plan then moves the planted pods, each plant keeping its sow date and status, and empties pods the plan leaves out.'

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

  server.registerTool('list_schedules', {
    description: `Light curves (interpolated setpoints by minute-of-day, the unit's local time) and pump cycles, with day masks (Mon=1 … Sun=64). Each light curve also has boostHours (hours a day at full brightness) and Gardyn's rating of them (low | ok | great | intense | too much; aim for great, 14–16 h). timezone is the unit's.`,
    inputSchema: {},
  }, async () => {
    const rows = await caller.schedules.list()
    const timezone = (await caller.settings.get()).timezone
    return text({ timezone, schedules: rows.map(s => ('setpoints' in s.spec ? { ...s, boostHours: boostHours(s.spec), rating: lightRating(boostHours(s.spec)) } : s)) })
  })

  server.registerTool('light_presets', {
    description: `Starting points for a light curve, and Gardyn's guidance to judge one by: 14–16 hours a day at full brightness (Boost); dimmed hours don't count towards them; 17 or more stress the plants (bitter leaves, bolting); nights need unbroken dark (${GARDYN_LIGHT_GUIDE}). Each preset has setpoints to pass to upsert_schedule as spec.setpoints, its boostHours and rating. To set a schedule from the tower: read pods and list_schedules, pick or adjust a preset, upsert it, and turn off any other enabled curve (enabled curves stack, highest level wins). Minutes are the unit's local time: check timezone first, and tell the person if it is still UTC.`,
    inputSchema: {},
  }, async () => text({ timezone: (await caller.settings.get()).timezone, presets: LIGHT_PRESETS.map(p => ({ ...p, boostHours: boostHours({ setpoints: p.setpoints }), rating: lightRating(boostHours({ setpoints: p.setpoints })) })) }))

  server.registerTool('pump_presets', {
    description: `Watering starting points by growth stage (seedlings, young plants, mature greens and herbs, large or fruiting), with each one's runs, run-length range, notes and a citation, the preset recommended for this tower (from days since sowing and whether anything planted is a fruiting crop), today's light window and the unit's timezone. These are community starting points from r/Gardyn owners, not Gardyn's: Gardyn doesn't publish a cadence (Smart Watering adjusts it) and waits a few days to a week after sowing before the second watering (${GARDYN_WATERING_GUIDE}). Check the roots and adjust: dry, brittle roots want more; roots in pooled water before the next cycle want less. Each preset lists the pump schedules to pass to upsert_schedule, one per run; applying a preset means replacing the existing pump cycles (remove_schedule them first), since cycles add up. Minutes are the unit's local time: check timezone first, and tell the person if it is still UTC.`,
    inputSchema: {},
  }, async () => {
    const [settings, schedules, cycle, pods] = await Promise.all([caller.settings.get(), caller.schedules.list(), caller.grow.current(), caller.grow.pods()])
    const now = (ctx.now ?? (() => new Date()))()
    const light = lightWindow(schedules.flatMap(s => (s.kind === 'light' && s.enabled && dayOn(s.days, weekdayOf(now)) && 'setpoints' in s.spec ? [s.spec] : [])))
    const planted = pods.filter(p => p.status !== 'empty')
    const days = daysSinceSowing(cycle.cycle?.startedAt, planted.map(p => p.plantedAt), now)
    return text({
      timezone: settings.timezone,
      guide: GARDYN_WATERING_GUIDE,
      light,
      daysSinceSowing: days,
      recommended: recommendPreset(days, planted.map(p => p.plant)),
      tips: WATERING_TIPS,
      tipsCitation: TIPS_CITATION.url,
      presets: PUMP_PRESETS.map((p) => {
        const runs = presetRuns(p, light)
        return { id: p.id, name: p.name, runs, durationS: p.durationS, range: p.range, minutesADay: dailyMinutes(runs.length, p.durationS), note: p.note, citation: p.citation.url, schedules: presetSchedules(p, { enabled: true, light }) }
      }),
    })
  })

  server.registerTool('pods', { description: 'The 30 plant pods: slot, plant, planted date, status (empty, seeded, growing, harvest, attention) and notes.', inputSchema: {} }, async () => text(await caller.grow.pods()))

  server.registerTool('swap_pods', {
    description: 'Swap what two pods hold — plant, sow date, status, notes and last cut — after the person has moved their yCubes between them. Camera history stays with each pod position. Confirm with the person that they moved the pods first.',
    inputSchema: { a: z.number().int().min(1).max(60), b: z.number().int().min(1).max(60) },
  }, async i => text(await caller.grow.swapPods(i)))

  server.registerTool('setup_check', {
    description: 'What a planted unit is missing (ADR-0029): pods planted with no light schedule or no pump schedule on, and a tank level sensor that is absent or reading suspect (a suspect level is never used to advise a top-off). Returns planted (pods not empty), issues (id, the alert kind it raises, title, detail, where it is fixed) and a one-line summary. Each issue is also an active alert in status until it is fixed.',
    inputSchema: {},
  }, async () => text(await caller.care.setup()))

  server.registerTool('list_chores', {
    description: 'Chores the tower needs (ADR-0029): thin, trim_roots, top_off, refresh, feed, clean, each with state due | soon | ok | unknown and basis: reading (derived from a sensor the unit trusts now: tank level and how fast it falls, an EC probe, camera leaf cover on young pods) or timeline (a calendar guess; the reason says why, e.g. "Calendar guess, no EC probe"). A reading counts only when its quality is good and it is under 15 min old, so a top-off is never advised from a suspect tank level. Also the readings used, when it falls due, when it was last done (from the tank log), citations (the knowledge note and section behind every dose and target; quote only those, never a dose of your own) and doneKind: log a tank action of that kind with log_tank_action once the person has done it.',
    inputSchema: {},
  }, async () => text(await caller.care.chores()))

  server.registerTool('list_tank_actions', {
    description: 'The tank action log, newest first: what was done to the tank and when (kind feed | top_off | refresh | ph_down | ph_up | clean | trim_roots | thin | other, amount and unit, product, note, and whether a person or an agent logged it). Read it beside history to attribute a change in ec, ph or water_level_pct to an action. kind filters; limit defaults to 20.',
    inputSchema: { kind: TankActionKind.optional(), limit: z.number().int().min(1).max(500).optional() },
  }, async i => text(await caller.tank.actions({ kind: i.kind, limit: i.limit ?? 20 })))

  server.registerTool('captures', {
    description: 'Recent camera stills (newest first) with URLs relative to the core host. camera: upper or lower.',
    inputSchema: { camera: z.enum(['upper', 'lower']).optional(), limit: z.number().int().min(1).max(50).optional() },
  }, async i => text(await caller.camera.list({ camera: i.camera, limit: i.limit ?? 10 })))

  server.registerTool('list_analyses', {
    description: 'Camera analysers and what they have produced: every on-device analyser (id, version, metrics it emits, which one is primary for pod_health) plus any off-device worker that posted results, with row and capture counts and time span, and the analysis queue status. labels: the grower\'s pod labels for training (empty, sprouted, growing, ready, unhealthy): how many pods carry each, and the labelled captures newest first with how many pods each has labelled. Pass slot to also get that pod\'s series from every analyser@version side by side, to see which ones agree. Read-only: choosing the primary analyser, re-running analysers and labelling pods are done in the app.',
    inputSchema: { slot: z.number().int().min(1).max(30).optional(), metric: z.string().optional() },
  }, async (i) => {
    const analyzers = await caller.vision.analyzers()
    const status = await caller.vision.status()
    const labels = await caller.vision.labelStats({ limit: 20 })
    const compare = i.slot ? await caller.vision.compare({ slot: i.slot, metric: i.metric ?? 'green_fraction', limit: 48 }) : undefined
    return text({ analyzers, status, labels, compare })
  })

  server.registerTool('list_models', {
    description: 'Pod-state model revisions (the learned pod-state analyser, #186): the shipped one and every upload, with id (sha256 prefix), the analyser id each runs as, version, revision name, trained/uploaded dates, notes, whether it runs (enabled) and which is primary, plus the newest uploads, activations, resets and rollbacks. Compare enabled revisions with list_analyses.',
    inputSchema: {},
  }, async () => text({ revisions: await caller.models.list(), events: await caller.models.events({ limit: 10 }) }))

  server.registerTool('export_dataset', {
    description: 'A dataset export for training off the unit: a download path (relative to the core host; GET it for a tar of photos, every analyser\'s results, pod labels, pods, grow cycles and sensor history) and what it holds: captures, results, readings, labels, labels per class, image bytes and the date range. days is the window back from now (default 30, the unit keeps 30 days of photos); images false leaves the photos out.',
    inputSchema: { days: z.number().int().min(1).max(365).optional(), images: z.boolean().optional() },
  }, async (i) => {
    const to = ctx.now?.() ?? new Date()
    const from = new Date(to.getTime() - (i.days ?? 30) * 86_400_000)
    const images = i.images ?? true
    const summary = await caller.datasets.summary({ from: from.toISOString(), to: to.toISOString(), images })
    const path = `/api/datasets/export?${new URLSearchParams({ from: summary.from, to: summary.to, images: images ? '1' : '0' }).toString()}`
    const labelsPerClass = Object.fromEntries(POD_STATES.map(c => [c, 0]))
    for (const l of ctx.store.podLabels.range(summary.from, summary.to)) labelsPerClass[l.label] = (labelsPerClass[l.label] ?? 0) + 1
    return text({ path, ...summary, labelsPerClass })
  })

  server.registerTool('list_labels', {
    description: 'The grower\'s pod labels (empty, sprouted, growing, ready, unhealthy), the training data for pod-state models: how many pods carry each label and the labelled captures, newest first. With capture_id, that capture\'s label for each pod. Labels are set in the app\'s Analysis screen.',
    inputSchema: { capture_id: z.string().optional(), limit: z.number().int().min(1).max(500).optional() },
  }, async i => text(i.capture_id ? await caller.vision.labels({ captureId: i.capture_id }) : await caller.vision.labelStats({ limit: i.limit ?? 50 })))

  server.registerTool('list_automations', {
    description: 'Autopilot rules (WHEN trigger / IF conditions / THEN actions, as JSON), whether each is enabled or in dry-run, its last run, the kill switch, which source owns the light (manual hold, Autopilot or schedule), and the latest audit-log entries. Read-only: creating, arming or disabling rules changes what the unit does unattended, so that is done in the app.',
    inputSchema: { runs: z.number().int().min(0).max(100).optional() },
  }, async i => text({ rules: await caller.automations.list(), status: await caller.automations.status(), runs: await caller.automations.runs({ limit: i.runs ?? 20 }) }))

  server.registerTool('starter_rules', {
    description: 'Starter Autopilot rules sourced from the knowledge bundle (ADR-0029): pH outside 5.5–6.5, EC below the crop target (seedlings, leafy greens, herbs or fruiting, from what is planted), tank below half. Each is notify-only and comes with its citations, the sensors it needs and whether the unit has them (unavailable says why not), whether a rule of that name is already added, and the rule JSON. Read-only: offer one to the person, backtest it with backtest_automation (pass rule), and let them add it in the app (Autopilot → Starter rules), where it starts in dry-run until they arm it.',
    inputSchema: {},
  }, async () => text(await caller.care.starterRules()))

  server.registerTool('backtest_automation', {
    description: 'Replay an Autopilot rule over recorded history without touching hardware: by id, or a draft rule (same JSON shape as list_automations returns, without id). Returns the traces of every signal it reads, when it would have fired and what each action would have done (raw and clamped values), cooldown suppressions, and signals that are live-only (unknown in a backtest). Signal keys come from the catalog: sensor.<id>, light.level, pump.on, alert.<kind>, pod.<slot>.green, pod.<slot>.trend, grow.day.',
    inputSchema: { id: z.number().int().optional(), rule: z.unknown().optional(), hours: z.number().int().min(1).max(336).optional(), step_min: z.number().int().min(1).max(60).optional() },
  }, async (i) => {
    const rule = i.rule === undefined ? undefined : RuleInput.parse(i.rule)
    return text(await caller.automations.backtest({ id: i.id, rule, hours: i.hours ?? 24, stepMin: i.step_min ?? 5 }))
  })

  server.registerTool('plant_catalog', {
    description: 'Search the plant catalog: Gardyn\'s built-in plants plus custom ones added on this unit (custom: true). Each has its light zone high/medium/low, first-harvest window in months, care level, size (large plants are spaced apart) and succession group. Filter by q (name), category (fruiting, vegetable, legume, flower, herb, green, lettuce), zone or custom. A crop missing from it can be added with add_plant.',
    inputSchema: { q: z.string().optional(), category: z.enum(['fruiting', 'vegetable', 'legume', 'flower', 'herb', 'green', 'lettuce']).optional(), zone: z.enum(['high', 'medium', 'low']).optional(), custom: z.boolean().optional() },
  }, async i => text((await caller.planner.catalog(i)).plants.map(p => ({ id: p.id, name: p.name, category: p.category, zone: p.zone, harvestMonths: p.harvestMonths, careLevel: p.careLevel, size: p.size, succession: p.succession, inStore: p.inStore, custom: p.custom }))))

  server.registerTool('add_plant', {
    description: 'Add a plant that is not in the catalog (check plant_catalog first), so plan_layout, best_spot and save_plan can use it. Its id is the name as a slug ("Purple Shiso" → purple-shiso). zone: the light it needs (high for fruiting crops, medium for most greens and herbs, low for shade-tolerant herbs like mint). harvest_months: [from, to] months from starting the yCube to first harvest. size large for plants that shade their neighbours. succession defaults from category. Fails if the name or id is already in the catalog.',
    inputSchema: {
      name: z.string().min(1).max(60),
      category: z.enum(['fruiting', 'vegetable', 'legume', 'flower', 'herb', 'green', 'lettuce']),
      zone: z.enum(['high', 'medium', 'low']),
      harvest_months: z.tuple([z.number().int().min(0).max(24), z.number().int().min(0).max(24)]),
      care_level: z.enum(['beginner', 'intermediate', 'expert']).nullable().optional(),
      size: z.enum(['large', 'normal']).optional(),
      succession: z.enum(['fast-greens', 'long-greens-herbs', 'fast-fruiting', 'long-fruiting', 'flowers']).optional(),
    },
  }, async i => text(await caller.planner.addPlant({ name: i.name, category: i.category, zone: i.zone, harvestMonths: i.harvest_months, careLevel: i.care_level ?? null, size: i.size ?? 'normal', succession: i.succession, source: 'agent' })))

  server.registerTool('update_plant', {
    description: 'Edit a custom plant by id (only the fields given change; the id stays). Built-in Gardyn plants are read-only.',
    inputSchema: {
      id: z.string(),
      name: z.string().min(1).max(60).optional(),
      category: z.enum(['fruiting', 'vegetable', 'legume', 'flower', 'herb', 'green', 'lettuce']).optional(),
      zone: z.enum(['high', 'medium', 'low']).optional(),
      harvest_months: z.tuple([z.number().int().min(0).max(24), z.number().int().min(0).max(24)]).optional(),
      care_level: z.enum(['beginner', 'intermediate', 'expert']).nullable().optional(),
      size: z.enum(['large', 'normal']).optional(),
      succession: z.enum(['fast-greens', 'long-greens-herbs', 'fast-fruiting', 'long-fruiting', 'flowers']).optional(),
    },
  }, async i => text(await caller.planner.updatePlant({ id: i.id, name: i.name, category: i.category, zone: i.zone, harvestMonths: i.harvest_months, careLevel: i.care_level, size: i.size, succession: i.succession, source: 'agent' })))

  server.registerTool('remove_plant', {
    description: 'Remove a custom plant by id. Built-in Gardyn plants are read-only. Saved plans keep their layout.',
    inputSchema: { id: z.string() },
  }, async i => text(await caller.planner.removePlant(i)))

  server.registerTool('planner_zones', {
    description: `Light-zone map of a Gardyn: every slot with its row, column and zone, and how many slots each zone has. ${ZONE_RULES}`,
    inputSchema: { model: z.enum(['home', 'studio']) },
  }, async i => text({ ...(await caller.planner.zones({ model: i.model })), rules: ZONE_RULES }))

  server.registerTool('plan_layout', {
    description: `Lay out plants on a Gardyn by light zone around pods already planted. model: home (30) or studio (16). ${ZONE_RULES} Returns slot assignments with reasons; zones (per zone: rows, slots, total, existing, planned, free); unplaced (code no_space | not_in_catalog | bad_pin, the zones it could use, and the pods blocking them); and suggestions, each with an overrides object to pass back as-is to carry it out: relocate (move another pod to a slot it tolerates), allow_lower (let it go one zone further down), or allow_higher (a herb, flower or legume whose zones are full may use the nearest brighter zone with free pods; e.g. oregano with low full gets overrides.allowedZones {"oregano": ["low", "medium"]}). Lettuces, leafy greens and vegetables never get allow_higher: more light makes them bolt. Read-only; use save_plan to keep it.`,
    inputSchema: { model: z.enum(['home', 'studio']), plants: z.array(z.object({ plantId: z.string(), count: z.number().int().min(1).max(30) })), overrides: Overrides.optional().describe(OVERRIDES_HELP) },
  }, async i => text(await caller.planner.layout({ model: i.model, plants: i.plants, respectExisting: true, overrides: i.overrides })))

  server.registerTool('best_spot', {
    description: 'Best free slots for adding one plant to the current tower, ranked by light-zone fit and shading.',
    inputSchema: { model: z.enum(['home', 'studio']), plantId: z.string() },
  }, async i => text(await caller.planner.bestSpots({ model: i.model, plantId: i.plantId, limit: 5 })))

  server.registerTool('save_plan', {
    description: 'Compute and save a layout plus a staggered sowing schedule (Gardyn succession guidance), with the same zone summary, unplaced reasons and suggestions as plan_layout. Pass the overrides you settled on with plan_layout. Saving to an existing id replaces that plan (update_plan changes only some fields). It opens in the web planner\'s saved plans. Does not touch the pods until apply_plan.',
    inputSchema: { id: z.string(), name: z.string(), model: z.enum(['home', 'studio']), plants: z.array(z.object({ plantId: z.string(), count: z.number().int().min(1).max(30) })), mode: z.enum(['staggered', 'batch']).optional(), start: z.string().optional().describe('First sow date, YYYY-MM-DD; defaults to today.'), overrides: Overrides.optional().describe(OVERRIDES_HELP) },
  }, async i => text(await caller.planner.savePlan({ id: i.id, name: i.name, model: i.model, plants: i.plants, mode: i.mode ?? 'staggered', start: i.start, overrides: i.overrides })))

  server.registerTool('match_order', {
    description: 'Match a pasted order to the plant catalog in one call. Give the order lines as they read ("Genovese Basil x2", "3 × Butterhead Lettuce yCube", "Mint (2)"); a single pasted block is split on new lines, commas and semicolons. Returns matched lines (plantId, count, confidence 0–1 and close alternatives — check any under ~0.8 with the user), unmatched lines with suggestions (pick one, or add the plant with add_plant). A line naming a colour or variety a catalog plant lacks ("Pink Swiss Chard" when the catalog has only Red and Yellow Swiss Chard, "Red Russian Kale" against Kale) is never matched to that plant: it comes back unmatched, and those plants are suggestions with confidence under 0.5 and a reason such as "colour differs (pink; catalog has red)" — ask the user, or add_plant the variant they ordered. Also returns skipped lines (no name), and plants: the matched counts summed per plantId, ready to pass to plan_layout or save_plan.',
    inputSchema: { lines: z.array(z.string().max(500)).min(1).max(200) },
  }, async i => text(await caller.planner.matchOrder(i)))

  server.registerTool('list_plans', {
    description: 'Saved plans, newest first: id, name, model, mode, the plants requested, pods placed, how many did not fit, the first sow date, and when it was applied (null if never).',
    inputSchema: {},
  }, async () => text((await caller.planner.plans()).map(p => ({ id: p.id, name: p.name, model: p.model, mode: p.mode, plants: p.request, placed: p.layout.assignments.length, unplaced: p.layout.unplaced.length, start: p.start, appliedAt: p.appliedAt, updatedAt: p.updatedAt }))))

  server.registerTool('get_plan', {
    description: 'One saved plan in full: request, layout (assignments, zone summary, unplaced reasons, suggestions, overrides), sowing schedule and start date — what the web planner shows when the plan is opened.',
    inputSchema: { id: z.string() },
  }, async i => text(await caller.planner.plan(i)))

  server.registerTool('update_plan', {
    description: 'Change a saved plan and recompute its layout and sowing around the pods planted now. Only the fields given change; its start date and overrides stay as saved unless given (overrides: null clears them). plants replaces the whole list. Does not touch the pods until apply_plan.',
    inputSchema: {
      id: z.string(),
      name: z.string().min(1).max(60).optional(),
      model: z.enum(['home', 'studio']).optional(),
      plants: z.array(z.object({ plantId: z.string(), count: z.number().int().min(1).max(30) })).optional(),
      mode: z.enum(['staggered', 'batch']).optional(),
      start: z.string().optional().describe('First sow date, YYYY-MM-DD.'),
      overrides: Overrides.nullable().optional().describe(OVERRIDES_HELP),
    },
  }, async i => text(await caller.planner.updatePlan(i)))

  server.registerTool('remove_plan', { description: 'Delete a saved plan by id. Pods it was applied to keep what was written on them.', inputSchema: { id: z.string() } }, async i => text(await caller.planner.removePlan(i)))

  server.registerTool('apply_plan', {
    description: 'Write a saved plan onto the pods: first-wave pods are marked seeded today, later waves get their sow date and a reminder fires when it arrives. A replant plan (overrides.replant) moves the planted pods instead: each plant keeps its sow date and status in its new pod, and pods it leaves out are emptied, so the person must move the pods to match. Overwrites the listed pods — confirm with the user first.',
    inputSchema: { id: z.string() },
  }, async i => text(await caller.planner.applyPlan(i)))

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
    description: 'Create or replace a schedule. Light: {id, kind:"light", name, enabled, days, spec:{setpoints:[{minute, level}]}} — levels are interpolated between setpoints and wrap past midnight; minutes are the unit\'s local time. Gardyn recommends 14–16 h a day at full brightness and no more than 16 (see light_presets); enabled light curves stack, highest wins, so turn off the one a new curve replaces. Pump: {id, kind:"pump", name, enabled, days, spec:{minute, durationS, level?}}. days is a bitmask Mon=1 … Sun=64 (127 = daily).',
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

  server.registerTool('log_tank_action', {
    description: 'Record something a person did to the tank, as they report it: "fed 1 tsp MaxiGro" is kind feed, amount 1, unit tsp, product MaxiGro; also top_off, refresh, ph_down, ph_up, clean, trim_roots, thin, other. Touches no hardware and is marked source agent. at is when it was done (ISO time, defaults to now; not in the future). Give an amount only with its unit (tsp, tbsp, mL, L, gal, g), and only the amount the person said: never fill in a dose yourself.',
    inputSchema: {
      kind: TankActionKind,
      amount: z.number().positive().max(100_000).optional(),
      unit: TankUnit.optional(),
      product: z.string().max(80).optional(),
      note: z.string().max(500).optional(),
      at: z.string().optional().describe('When it was done, ISO 8601 with an offset; defaults to now.'),
    },
  }, async i => text(await caller.tank.logAction({ kind: i.kind, amount: i.amount ?? null, unit: i.unit ?? null, product: i.product ?? null, note: i.note ?? '', ts: i.at, source: 'agent' })))

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

  server.registerTool('upload_model', {
    description: 'Add a pod-state weights file (seedypod-cnn v1, from seedypod/training) as a model revision. Give its contents as base64, or a URL on the local network (the laptop that trained it; the unit fetches nothing from the internet), and its SHA-256, which must match. Stored disabled unless enable is true; an enabled revision runs on every capture as its own analyser beside the others. Confirm with the user before enabling.',
    inputSchema: { base64: z.string().optional(), url: z.string().optional(), sha256: z.string().length(64), enable: z.boolean().optional() },
  }, async (i) => {
    if (!i.base64 === !i.url) throw new Error('give exactly one of base64 or url')
    const body = i.base64 ? Buffer.from(i.base64, 'base64').toString('utf8') : await fetchLanModel(i.url as string)
    return text(await caller.models.upload({ text: body, sha256: i.sha256, enable: i.enable }))
  })

  server.registerTool('set_model', {
    description: 'Change which pod-state model revisions run (ids from list_models): enable or disable one, make one primary (enables it), delete an uploaded one, reset (only the shipped model runs, as primary; uploads are kept), or rollback (undo the newest enable, disable, primary or reset). Every change is recorded. Confirm with the user first.',
    inputSchema: { action: z.enum(['enable', 'disable', 'primary', 'delete', 'reset', 'rollback']), id: z.string().optional() },
  }, async (i) => {
    if (i.action === 'reset') return text(await caller.models.reset())
    if (i.action === 'rollback') return text(await caller.models.rollback())
    if (!i.id) throw new Error(`${i.action} needs the revision id`)
    if (i.action === 'delete') return text(await caller.models.remove({ id: i.id }))
    if (i.action === 'primary') return text(await caller.models.set({ id: i.id, primary: true }))
    return text(await caller.models.set({ id: i.id, enabled: i.action === 'enable' }))
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
