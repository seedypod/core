import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { DEFAULT_GROUPS, enabledGroups, maskUrl, newTopic, NOTIFY_GROUPS, ntfyLink, urlProblem } from '../../notify/targets'
import type { DeviceSettings } from '../../store/types'
import type { Context } from '../context'
import { publicProcedure, router } from '../trpc'

const Target = z.enum(['off', 'ntfy', 'webhook'])
const Format = z.enum(['json', 'discord', 'slack'])
const Group = z.enum(NOTIFY_GROUPS)
const Delivery = z.object({ at: z.string(), ok: z.boolean(), title: z.string(), detail: z.string() })

const Status = z.object({
  target: Target,
  ntfyServer: z.string(),
  /** Shown: the owner types it into the ntfy app. Anyone on the LAN can read it, like the HomeKit code (ADR-0012). */
  ntfyTopic: z.string().nullable(),
  /** `ntfy://…`, which the Android app subscribes from. */
  ntfyLink: z.string().nullable(),
  qrSvg: z.string().nullable(),
  /** Masked: the full URL is the secret and never leaves the unit. */
  webhookUrl: z.string().nullable(),
  webhookFormat: Format,
  hasWebhookSecret: z.boolean(),
  groups: z.array(Group),
  defaultGroups: z.array(Group),
  last: Delivery.nullable(),
  pending: z.number().int(),
})

async function svgQr(uri: string): Promise<string> {
  const { default: QRCode } = await import('qrcode')
  return QRCode.toString(uri, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 })
}

async function status(ctx: Context): Promise<z.infer<typeof Status>> {
  const s = ctx.store.settings.get()
  const link = s.ntfyTopic ? ntfyLink(s.ntfyServer, s.ntfyTopic, s.unitName) : null
  return {
    target: s.notifyTarget,
    ntfyServer: s.ntfyServer,
    ntfyTopic: s.ntfyTopic,
    ntfyLink: link,
    qrSvg: link && s.notifyTarget === 'ntfy' ? await svgQr(link) : null,
    webhookUrl: s.webhookUrl ? maskUrl(s.webhookUrl) : null,
    webhookFormat: s.webhookFormat,
    hasWebhookSecret: !!s.webhookSecret,
    groups: [...enabledGroups(s.notifyGroups)],
    defaultGroups: [...DEFAULT_GROUPS],
    ...ctx.notifier.status(),
  }
}

function checkUrl(url: string) {
  const problem = urlProblem(url)
  if (problem) throw new TRPCError({ code: 'BAD_REQUEST', message: problem })
}

/** Outbound notifications (ADR-0032): ntfy for most owners, a webhook for the rest. */
export const notificationsRouter = router({
  status: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/notifications', tags: ['notifications'], summary: 'Where pod events are sent, which ones, and how the last one went; the webhook URL comes back masked' } })
    .output(Status)
    .query(({ ctx }) => status(ctx)),
  configure: publicProcedure
    .meta({ openapi: { method: 'PATCH', path: '/notifications', tags: ['notifications'], summary: 'Pick ntfy, a webhook or off, and the event groups; turning ntfy on makes a random topic if there isn\'t one' } })
    .input(z.object({
      target: Target.optional(),
      ntfyServer: z.string().url().optional(),
      webhookUrl: z.string().url().nullable().optional(),
      webhookFormat: Format.optional(),
      webhookSecret: z.string().max(200).nullable().optional(),
      groups: z.array(Group).optional(),
    }))
    .output(Status)
    .mutation(async ({ ctx, input }) => {
      if (input.ntfyServer) checkUrl(input.ntfyServer)
      if (input.webhookUrl) checkUrl(input.webhookUrl)
      const s = ctx.store.settings.get()
      const patch: Partial<DeviceSettings> = {}
      if (input.target !== undefined) patch.notifyTarget = input.target
      if (input.ntfyServer !== undefined) patch.ntfyServer = input.ntfyServer.replace(/\/$/, '')
      if (input.webhookUrl !== undefined) patch.webhookUrl = input.webhookUrl
      if (input.webhookFormat !== undefined) patch.webhookFormat = input.webhookFormat
      if (input.webhookSecret !== undefined) patch.webhookSecret = input.webhookSecret || null
      if (input.groups !== undefined) patch.notifyGroups = [...new Set(input.groups)]
      const target = patch.notifyTarget ?? s.notifyTarget
      if (target === 'webhook' && !(patch.webhookUrl ?? s.webhookUrl)) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Paste the webhook URL first.' })
      if (target === 'ntfy' && !s.ntfyTopic) patch.ntfyTopic = newTopic()
      ctx.store.settings.update(patch)
      ctx.events.emit({ kind: 'mutation', path: 'notifications' })
      return status(ctx)
    }),
  newTopic: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/notifications/topic', tags: ['notifications'], summary: 'Replace the ntfy topic with a new random one; phones subscribed to the old one stop getting notifications' } })
    .output(Status)
    .mutation(({ ctx }) => {
      ctx.store.settings.update({ ntfyTopic: newTopic() })
      ctx.events.emit({ kind: 'mutation', path: 'notifications' })
      return status(ctx)
    }),
  test: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/notifications/test', tags: ['notifications'], summary: 'Send a test notification now and report how it went' } })
    .output(Delivery)
    .mutation(async ({ ctx }) => {
      try {
        return await ctx.notifier.test()
      }
      catch (e) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: (e as Error).message })
      }
    }),
})
