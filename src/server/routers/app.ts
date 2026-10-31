import { router } from '../trpc'
import { lightRouter, pumpRouter } from './actuators'
import { alertsRouter } from './alerts'
import { cameraRouter } from './camera'
import { datasetsRouter } from './datasets'
import { devicesRouter } from './devices'
import { eventsRouter } from './events'
import { growRouter } from './grow'
import { networkRouter } from './network'
import { schedulesRouter } from './schedules'
import { sensorsRouter } from './sensors'
import { settingsRouter } from './settings'
import { storageRouter } from './storage'
import { systemRouter } from './system'
import { telemetryRouter } from './telemetry'
import { visionRouter } from './vision'

export const appRouter = router({
  system: systemRouter,
  settings: settingsRouter,
  network: networkRouter,
  sensors: sensorsRouter,
  devices: devicesRouter,
  telemetry: telemetryRouter,
  light: lightRouter,
  pump: pumpRouter,
  schedules: schedulesRouter,
  grow: growRouter,
  camera: cameraRouter,
  vision: visionRouter,
  datasets: datasetsRouter,
  storage: storageRouter,
  alerts: alertsRouter,
  events: eventsRouter,
})

export type AppRouter = typeof appRouter
