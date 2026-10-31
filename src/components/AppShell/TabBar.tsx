import { Link, useLocation } from '@tanstack/react-router'
import { cn } from '@/lib/utils'
import { navItems } from './navItems'

export function TabBar() {
  const { pathname } = useLocation()
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] min-[900px]:hidden">
      {navItems.filter(i => i.tab).map(({ to, label, icon: Icon }) => {
        const active = to === '/' ? pathname === '/' : pathname.startsWith(to)
        return (
          <Link key={to} to={to} className={cn('flex flex-1 flex-col items-center gap-1 py-2 text-[11px] text-fg-3', active && 'text-fg')}>
            <Icon size={20} />
            {label}
          </Link>
        )
      })}
    </nav>
  )
}
