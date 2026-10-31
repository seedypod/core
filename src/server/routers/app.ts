import { router } from '../trpc'
import { lightRouter, pumpRouter } from './actuators'
import { alertsRouter } from './alerts'
import { eventsRouter } from './events'
import { sensorsRouter } from './sensors'
import { systemRouter } from './system'

export const appRouter = router({
  system: systemRouter,
  sensors: sensorsRouter,
  light: lightRouter,
  pump: pumpRouter,
  alerts: alertsRouter,
  events: eventsRouter,
})

export type AppRouter = typeof appRouter
