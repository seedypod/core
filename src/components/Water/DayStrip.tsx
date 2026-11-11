import { ArrowUpRight } from 'lucide-react'
import { cn } from '@/lib/utils'

/** A day in a line: the light's window as a faint amber band and each run a blue tick. */
export function DayStrip({ runs, light }: { runs: number[], light: { on: number, off: number } | null }) {
  return (
    <svg viewBox="0 0 1440 14" preserveAspectRatio="none" className="block h-3.5 w-full" aria-hidden>
      <rect x={0} y={6} width={1440} height={2} className="fill-line" />
      {light && <rect x={light.on} y={0} width={light.off - light.on} height={14} className="fill-light/20" />}
      {runs.map(m => <rect key={m} x={m - 6} y={1} width={12} height={12} rx={2} className="fill-tank" />)}
    </svg>
  )
}

/** A source, opened in a new tab, with the arrow that says so: the text wraps as text does, the arrow staying with its last word. */
export function SourceLink({ href, className, children }: { href: string, className?: string, children: string }) {
  // Everything up to and including the last space wraps as text; the last word keeps the arrow.
  const cut = children.lastIndexOf(' ') + 1
  const last = children.slice(cut)
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cn('w-fit underline decoration-line-2 underline-offset-2 hover:text-fg', className)}>
      {children.slice(0, cut)}
      <span className="whitespace-nowrap">
        {last}
        <ArrowUpRight size={12} aria-hidden className="ml-0.5 inline-block align-[-1px]" />
      </span>
    </a>
  )
}
