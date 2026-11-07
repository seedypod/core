import { createFileRoute, redirect } from '@tanstack/react-router'

/** Light curves now live on /light and pump cycles on /water; old links land on Light. */
export const Route = createFileRoute('/schedule')({
  beforeLoad: () => {
    throw redirect({ to: '/light', replace: true })
  },
})
