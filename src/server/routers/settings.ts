import { z } from 'zod'
import { autoLight } from '../../care/lightAuto'
import { refollowSun } from '../../scheduler/scheduler'
import { AUTO_SUN, followSun } from '../../scheduler/sun'
import { publicProcedure, router } from '../trpc'

export const SettingsSchema = z.object({
  unitName: z.string().min(1).max(40),
  timezone: z.string().min(1),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  temperatureUnit: z.enum(['C', 'F']),
  waterFullCm: z.number().min(0).max(100),
  waterEmptyCm: z.number().min(0).max(100),
  tankCapacityL: z.number().positive(),
  thinningReminderDays: z.number().int().min(0),
  rootCheckReminderDays: z.number().int().min(0),
  harvestReminderDays: z.number().int().min(0),
  nutrientReminderDays: z.number().int().min(0),
  apiKey: z.string(),
  mqttUrl: z.string().nullable(),
  mqttUsername: z.string().nullable(),
  mqttPassword: z.string().nullable(),
  mqttTlsEnabled: z.boolean(),
  mqttTlsInsecure: z.boolean(),
  captureIntervalMin: z.number().int().min(0),
  telemetryFlushMin: z.number().int().min(1).max(60),
  primaryAnalyzer: z.string().min(1).max(64),
  analysisArtifacts: z.boolean(),
  followGrowCycle: z.boolean(),
  analysisIngestToken: z.string(),
  mirrorEndpoint: z.string().url().nullable(),
  mirrorBucket: z.string().min(1).max(63).nullable(),
  mirrorRegion: z.string().min(1),
  mirrorPrefix: z.string(),
  mirrorAccessKeyId: z.string().nullable(),
  mirrorSecretAccessKey: z.string().nullable(),
  autopilotEnabled: z.boolean(),
  setupComplete: z.boolean(),
  updatedAt: z.string(),
})

/** Secrets are never returned to clients. */
const Public = SettingsSchema.omit({ mqttPassword: true, apiKey: true, analysisIngestToken: true, mirrorSecretAccessKey: true })
  .extend({ hasApiKey: z.boolean(), hasMqttPassword: z.boolean(), hasAnalysisIngestToken: z.boolean(), hasMirrorSecret: z.boolean() })

function publicView(s: z.infer<typeof SettingsSchema>) {
  const { mqttPassword, apiKey, analysisIngestToken, mirrorSecretAccessKey, ...rest } = s
  return { ...rest, hasApiKey: apiKey.length > 0, hasMqttPassword: !!mqttPassword, hasAnalysisIngestToken: analysisIngestToken.length > 0, hasMirrorSecret: !!mirrorSecretAccessKey }
}

export const settingsRouter = router({
  get: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/settings', tags: ['settings'] } })
    .output(Public)
    .query(({ ctx }) => publicView(ctx.store.settings.get())),
  update: publicProcedure
    .meta({ openapi: { method: 'PATCH', path: '/settings', tags: ['settings'] } })
    .input(SettingsSchema.omit({ updatedAt: true }).partial())
    .output(Public)
    .mutation(({ ctx, input }) => {
      const now = (ctx.now ?? (() => new Date()))()
      const starting = input.setupComplete === true && !ctx.store.settings.get().setupComplete
      const s = ctx.store.settings.update(input)
      ctx.events.emit({ kind: 'mutation', path: 'settings' })
      // A new garden starts on Auto, unless it already has a light curve.
      if (starting && !ctx.store.schedules.list().some(x => x.kind === 'light')) {
        ctx.store.schedules.upsert({ id: 'auto', kind: 'light', name: 'Auto', enabled: true, days: 127, spec: followSun({ setpoints: [], sun: AUTO_SUN }, s, now, autoLight(ctx.store)) })
        ctx.events.emit({ kind: 'schedule', action: 'changed', id: 'auto' })
      }
      // A new place or zone moves today's sunrise and sunset.
      if ('latitude' in input || 'longitude' in input || 'timezone' in input) {
        for (const id of refollowSun(ctx.store, now, autoLight(ctx.store))) ctx.events.emit({ kind: 'schedule', action: 'changed', id })
      }
      return publicView(s)
    }),
})
