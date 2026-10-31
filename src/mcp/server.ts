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
import type { Context } from '../server/context'
import { appRouter } from '../server/routers/app'
import { createCallerFactory } from '../server/trpc'

const createCaller = createCallerFactory(appRouter)

function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] }
}

export function createMcpServer(ctx: Context): McpServer {
  const caller = createCaller(ctx)
  const server = new McpServer({ name: 'leafypod', version: ctx.version })

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
    inputSchema: { sensor: z.enum(['air_temp', 'humidity', 'pcb_temp', 'water_distance', 'water_level_pct', 'pump_v', 'pump_a', 'pump_w', 'ph', 'ec', 'water_temp']), hours: z.number().min(1).max(2160).optional(), max_points: z.number().int().min(10).max(500).optional() },
  }, async i => text(await caller.telemetry.history({ sensor: i.sensor, hours: i.hours ?? 24, maxPoints: i.max_points ?? 100 })))

  server.registerTool('list_schedules', { description: 'Light curves (interpolated setpoints by minute-of-day) and pump cycles, with day masks (Mon=1 … Sun=64).', inputSchema: {} }, async () => text(await caller.schedules.list()))

  server.registerTool('pods', { description: 'The 30 plant pods: slot, plant, planted date, status (empty, seeded, growing, harvest, attention) and notes.', inputSchema: {} }, async () => text(await caller.grow.pods()))

  server.registerTool('captures', {
    description: 'Recent camera stills (newest first) with URLs relative to the core host. camera: upper or lower.',
    inputSchema: { camera: z.enum(['upper', 'lower']).optional(), limit: z.number().int().min(1).max(50).optional() },
  }, async i => text(await caller.camera.list({ camera: i.camera, limit: i.limit ?? 10 })))

  server.registerTool('pod_health', {
    description: 'Per-pod growth verdicts from camera stills: green-area fraction and trend (growing / stalled / declining / unknown). Use with `pods` to decide which slots need attention.',
    inputSchema: {},
  }, async () => text(await caller.vision.podTrends()))

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
    description: 'Acknowledge an alert by id (from status). For latched hardware faults (pump_fault) this re-enables the actuator — only do it after the cause is fixed (e.g. tank refilled). For reminders it marks the chore done.',
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
  server.registerResource('sensors', 'leafypod://sensors', { description: 'Latest sensor readings', mimeType: 'application/json' }, async uri => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(ctx.hal.snapshot().sensors) }],
  }))
  server.registerResource('limits', 'leafypod://limits', { description: 'Hardware limits the HAL enforces (pump max run, max duty, dry-run threshold)', mimeType: 'application/json' }, async uri => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(ctx.hal.snapshot().system?.limits ?? null) }],
  }))

  return server
}
