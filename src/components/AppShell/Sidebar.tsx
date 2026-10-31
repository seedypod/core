import { Link, useLocation } from '@tanstack/react-router'
import { cn } from '@/lib/utils'
import { navItems } from './navItems'

export function Sidebar({ status }: { status: string }) {
  const { pathname } = useLocation()
  return (
    <aside className="hidden min-[900px]:flex w-[220px] shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex items-center gap-2 px-5 py-5">
        <img src="/favicon.svg" alt="" width={28} height={28} />
        <span className="font-semibold tracking-tight">seedypod</span>
      </div>
      <nav className="flex flex-col gap-0.5 px-3">
        {navItems.map(({ to, label, icon: Icon }) => {
          const active = to === '/' ? pathname === '/' : pathname.startsWith(to)
          return (
            <Link
              key={to}
              to={to}
              className={cn(
                'flex items-center gap-3 rounded-[var(--radius-ctl)] px-3 py-2 text-[14px] text-fg-2 hover:bg-active hover:text-fg',
                active && 'bg-active text-fg',
              )}
            >
              <Icon size={16} className="text-icon" />
              {label}
            </Link>
          )
        })}
      </nav>
      <div className="mt-auto px-5 py-4 font-mono text-[11px] text-fg-3">{status}</div>
    </aside>
  )
}
