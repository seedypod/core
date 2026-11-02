import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { SettingRow } from '@/src/components/ds/layout'

/** A settings card: title and sub on top, rows with a hairline between. */
export function Section({ id, title, sub, right, tone, className, children }: {
  /** The anchor the in-page nav and ⌘K search link to. */
  id: string
  title: ReactNode
  sub?: ReactNode
  right?: ReactNode
  tone?: 'warn'
  className?: string
  children?: ReactNode
}) {
  return (
    <section id={id} aria-label={typeof title === 'string' ? title : undefined} className={cn('flex scroll-mt-7 flex-col rounded-[14px] border bg-surface px-5', tone === 'warn' ? 'border-warn-line' : 'border-line', className)}>
      <div className={cn('flex flex-wrap items-center gap-3 pt-3.5', children ? 'pb-2.5' : 'pb-3.5')}>
        <div className="flex min-w-[200px] flex-1 flex-col gap-[3px]">
          <h2 className="text-[15px] font-medium">{title}</h2>
          {sub && <span className="text-xs leading-[1.4] text-fg-3 text-pretty">{sub}</span>}
        </div>
        {right}
      </div>
      {children}
      {children && <div className="h-0.5" />}
    </section>
  )
}

/** SettingRow with the card's 12px row rhythm. */
export function Row(props: Parameters<typeof SettingRow>[0]) {
  return <SettingRow {...props} className={cn('flex-wrap py-3', props.className)} />
}
