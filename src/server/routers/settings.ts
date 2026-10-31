import { z } from 'zod'
import { publicProcedure, router } from '../trpc'

export const SettingsSchema = z.object({
  unitName: z.string().min(1).max(40),
  timezone: z.string().min(1),
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
  primaryAnalyzer: z.string().min(1).max(64),
  analysisArtifacts: z.boolean(),
  analysisIngestToken: z.string(),
  mirrorEndpoint: z.string().url().nullable(),
  mirrorBucket: z.string().min(1).max(63).nullable(),
  mirrorRegion: z.string().min(1),
  mirrorPrefix: z.string(),
  mirrorAccessKeyId: z.string().nullable(),
  mirrorSecretAccessKey: z.string().nullable(),
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
      const s = ctx.store.settings.update(input)
      ctx.events.emit({ kind: 'mutation', path: 'settings' })
      return publicView(s)
    }),
})
