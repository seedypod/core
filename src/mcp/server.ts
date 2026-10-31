/**
 * MCP server over the tRPC caller (sleepypod pattern, ADR-0011).
 * Every tool is a named read/write primitive with units and declared limits
 * so it maps onto the Model Hardware Standard's read/write shape when that
 * spec opens.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { Context } from '../server/context'
import { createCallerFactory } from '../server/trpc'
import { appRouter } from '../server/routers/app'

const createCaller = createCallerFactory(appRouter)

export function createMcpServer(ctx: Context): McpServer {
  const caller = createCaller(ctx)
  const server = new McpServer({ name: 'leafypod', version: ctx.version })

  server.registerTool('status', {
    description: 'Current state of the tower: HAL identity and limits, every sensor reading with units, actuator states, and active alerts.',
    inputSchema: {},
  }, async () => {
    const snap = ctx.hal.snapshot()
    return { content: [{ type: 'text', text: JSON.stringify(snap, null, 2) }] }
  })

  server.registerTool('set_light', {
    description: 'Set the grow light. level is brightness 0–100 (%). Omit on to infer from level.',
    inputSchema: { on: z.boolean().optional(), level: z.number().min(0).max(100).optional() },
  }, async (input) => {
    const state = await caller.light.set(input)
    return { content: [{ type: 'text', text: JSON.stringify(state) }] }
  })

  server.registerTool('run_pump', {
    description: 'Run the water pump for duration_s seconds at level (% of the HAL-enforced max duty). The HAL clamps duration to its max-run limit and refuses when the tank is low; a refusal is returned as an error, not silently ignored.',
    inputSchema: { duration_s: z.number().int().positive().max(3600), level: z.number().min(1).max(100).optional() },
  }, async (input) => {
    const state = await caller.pump.runOnce({ durationS: input.duration_s, level: input.level })
    return { content: [{ type: 'text', text: JSON.stringify(state) }] }
  })

  server.registerTool('stop_pump', { description: 'Stop the pump immediately.', inputSchema: {} }, async () => {
    const state = await caller.pump.stop()
    return { content: [{ type: 'text', text: JSON.stringify(state) }] }
  })

  server.registerTool('acknowledge_alert', {
    description: 'Clear a latched alert/fault (e.g. pump_fault after a dry-run) so the actuator may be re-enabled. Only do this after the underlying cause is fixed (e.g. tank refilled).',
    inputSchema: { kind: z.enum(['water_low', 'pump_fault', 'over_temp', 'camera_missing', 'hal_offline']) },
  }, async (input) => {
    await caller.alerts.acknowledge({ kind: input.kind })
    return { content: [{ type: 'text', text: 'acknowledged' }] }
  })

  server.registerResource('sensors', 'leafypod://sensors', { description: 'Latest sensor readings', mimeType: 'application/json' }, async uri => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(ctx.hal.snapshot().sensors) }],
  }))

  return server
}
