import { router } from '../trpc'
import { lightRouter, pumpRouter } from './actuators'
import { alertsRouter } from './alerts'
import { cameraRouter } from './camera'
import { eventsRouter } from './events'
import { growRouter } from './grow'
import { schedulesRouter } from './schedules'
import { sensorsRouter } from './sensors'
import { settingsRouter } from './settings'
import { systemRouter } from './system'
import { telemetryRouter } from './telemetry'

export const appRouter = router({
  system: systemRouter,
  settings: settingsRouter,
  sensors: sensorsRouter,
  telemetry: telemetryRouter,
  light: lightRouter,
  pump: pumpRouter,
  schedules: schedulesRouter,
  grow: growRouter,
  camera: cameraRouter,
  alerts: alertsRouter,
  events: eventsRouter,
})

export type AppRouter = typeof appRouter
