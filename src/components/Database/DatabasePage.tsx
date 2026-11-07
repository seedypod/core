import { Link } from '@tanstack/react-router'
import { ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button, Card, CardHeader, InlineError, Skeleton, StatusDot } from '@/src/components/ds/core'
import { PageHeader } from '@/src/components/ds/layout'
import { useNow } from '@/src/components/System/useNow'
import type { DatabaseReport, IntegrityRun, TableReport } from '@/src/db/inspect'
import { timeAgo } from '@/src/lib/timeAgo'
import { trpc } from '@/src/utils/trpc'
import { barHeights, byWrites, migrationNote, rowBytes24h, size, topWriter, totalWrites } from './databaseView'

/** The server caches a scan for at least this long, so polling faster would only repeat the same answer. */
const REFRESH_MS = 5 * 60_000

const COLUMNS = 'grid grid-cols-[minmax(0,1fr)_72px_48px_56px] items-center gap-3 min-[600px]:grid-cols-[minmax(0,1fr)_144px_64px_72px]'

function Fact({ label, value, sub, tone }: { label: string, value: string, sub: string, tone?: 'ok' | 'warn' | 'danger' }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 bg-surface px-3 py-2.5">
      <span className="text-xs text-fg-2">{label}</span>
      <span className="flex items-center gap-1.5 font-mono text-sm">
        {tone && <StatusDot tone={tone} />}
        {value}
      </span>
      <span className="truncate font-mono text-[11px] leading-snug text-fg-3" title={sub}>{sub}</span>
    </div>
  )
}

function integrityFact(run: IntegrityRun | null, now: number) {
  if (!run) return { value: 'Not checked', sub: 'reads the whole file' }
  const when = `quick_check · ${timeAgo(run.checkedAt, now)} · ${(run.ms / 1000).toFixed(1)} s`
  return run.ok ? { value: 'OK', sub: when, tone: 'ok' as const } : { value: 'Failed', sub: run.detail, tone: 'danger' as const }
}

/** Rows per hour on the table's own scale; `changed` tables are fainter, since their counts are a floor. */
function WriteBars({ table: t, hourly }: { table: TableReport, hourly: number[] }) {
  return (
    <div className="flex h-6 items-end gap-px" role="img" aria-label={`${t.writes24h} rows in the last 24 hours`}>
      {barHeights(hourly).map((h, i) => (
        <span
          key={i}
          title={`${hourly[i]} rows, ${23 - i === 0 ? 'this hour' : `${23 - i} h ago`}`}
          className={cn('min-h-px flex-1 rounded-t-[1px]', h === 0 && 'bg-active')}
          style={h > 0 ? { height: `${Math.max(h * 100, 12)}%`, background: 'var(--chart-water)', opacity: t.basis === 'changed' ? 0.55 : 1 } : undefined}
        />
      ))}
    </div>
  )
}

function TableRow({ table: t, total, now }: { table: TableReport, total: number, now: number }) {
  const meta = [
    `${t.rows.toLocaleString()} ${t.rows === 1 ? 'row' : 'rows'}`,
    ...(t.lastWriteAt ? [`last ${timeAgo(t.lastWriteAt, now)}`] : []),
    ...(t.timeColumn ? [t.basis === 'inserted' ? `new rows by ${t.timeColumn}` : `last change by ${t.timeColumn}`] : []),
  ].join(' · ')
  const share = t.writes24h ? Math.round(t.writes24h / total * 100) : 0
  return (
    <div data-testid={`table-${t.name}`} className={cn(COLUMNS, 'border-t border-line py-2')}>
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-mono text-[13px]">{t.name}</span>
        <span className="font-mono text-[11px] leading-snug text-fg-3">{meta}</span>
      </div>
      {t.hourly
        ? <WriteBars table={t} hourly={t.hourly} />
        : <span className="font-mono text-[11px] text-fg-3">no time column</span>}
      <span className="flex flex-col text-right font-mono text-xs">
        {t.writes24h === null ? '—' : t.writes24h.toLocaleString()}
        {share > 0 && <span className="text-[11px] text-fg-3">{`${share}%`}</span>}
      </span>
      <span className="text-right font-mono text-xs text-fg-2">{t.bytes === null ? '—' : size(t.bytes)}</span>
    </div>
  )
}

function WritersCard({ d, now }: { d: DatabaseReport, now: number }) {
  const flash = trpc.storage.flash.useQuery(undefined, { refetchInterval: REFRESH_MS })
  const f = flash.data
  const tables = byWrites(d.tables)
  const total = totalWrites(d.tables)
  const data = rowBytes24h(d.tables)
  const top = topWriter(d.tables)
  return (
    <Card data-testid="writers">
      <CardHeader title="What's writing to the card" subtitle={`${total.toLocaleString()} rows in the last 24 h${data === null ? '' : `, about ${size(data)} of row data`}.${top ? ` ${top}` : ''}`} />
      <p className="text-[13px] leading-[1.45] text-fg-2 text-pretty" data-testid="card-writes">
        {f?.available && f.bytesPerDay !== null
          ? `The whole card takes ${size(f.bytesPerDay)}/day, ${f.basis === 'history' ? `averaged over ${Math.round(f.windowDays as number)} days` : 'averaged since boot'}, with the system included.`
          : 'This machine has no SD card counter to compare with.'}
        {` SQLite writes whole ${size(d.pageSize)} pages through the WAL and again at each checkpoint, so the database costs the card more than its row data.`}
      </p>
      <div>
        <div className={cn(COLUMNS, 'pb-1.5 font-mono text-[10px] uppercase tracking-[0.06em] text-fg-3')}>
          <span>{`Table · ${tables.length}`}</span>
          <span>Last 24 h</span>
          <span className="text-right">Writes</span>
          <span className="text-right">Size</span>
        </div>
        {tables.map(t => <TableRow key={t.name} table={t} total={total} now={now} />)}
      </div>
      {tables.some(t => t.bytes === null) && <p className="text-xs text-fg-3">This SQLite build has no dbstat, so per-table sizes aren&apos;t available.</p>}
      <p className="text-xs leading-[1.45] text-fg-3 text-pretty">
        Counts are rows by the time stored in them, not commits: a commit can write many rows, and each counts. Tables dated by updatedAt count rows changed, so a row changed twice counts once. Updates that move no time column, such as clearing an alert, don&apos;t show. Bars are rows per hour, each table on its own scale.
      </p>
    </Card>
  )
}

/**
 * Settings → SD card → Database: what's writing to the card, table by table.
 * Metadata only, read from a cached scan; it has no way to show a row.
 */
export function DatabasePage() {
  const now = useNow(60_000)
  const q = trpc.storage.database.useQuery(undefined, { refetchInterval: REFRESH_MS, staleTime: REFRESH_MS })
  const check = trpc.storage.checkDatabase.useMutation()
  const d = q.data
  const mig = d && migrationNote(d.migrations)

  return (
    <div className="mx-auto flex max-w-[1000px] flex-col gap-4 min-[900px]:pt-3">
      <PageHeader
        title="Database"
        right={(
          <>
            <Link to="/settings" hash="storage" className="text-[13px] text-fg underline-offset-2 hover:underline">SD card</Link>
            <Button size="sm" icon={ShieldCheck} disabled={!d || check.isPending} onClick={() => check.mutate()}>{check.isPending ? 'Checking…' : 'Check integrity'}</Button>
          </>
        )}
      />
      {q.error && <Card tone="danger"><InlineError>{q.error.message}</InlineError></Card>}
      {check.error && <Card tone="danger"><InlineError>{check.error.message}</InlineError></Card>}
      {!d && !q.error && (
        <>
          <p className="text-[13px] text-fg-2">Scanning the database. On a unit this reads the whole file and can take a minute.</p>
          <Skeleton className="h-[140px]" />
          <Skeleton className="h-[420px]" />
        </>
      )}
      {d && mig && (
        <>
          <span className="font-mono text-xs text-fg-2" data-testid="scanned">{`${d.path} · scanned ${timeAgo(d.at, now)} in ${(d.scanMs / 1000).toFixed(1)} s`}</span>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-card border border-line bg-line min-[600px]:grid-cols-3">
            <Fact label="Database" value={size(d.fileBytes)} sub={`${size(d.pageSize)} pages`} />
            <Fact label="WAL" value={size(d.walBytes)} sub="waiting to checkpoint" />
            <Fact label="Journal mode" value={d.journalMode.toUpperCase()} sub="sqlite journal_mode" />
            <Fact label="Free pages" value={size(d.freePages * d.pageSize)} sub={`${d.freePages.toLocaleString()} pages, reused first`} />
            <Fact label="Migrations" value={`${d.migrations.applied} / ${d.migrations.known}`} sub={mig.text} tone={mig.warn ? 'warn' : undefined} />
            <Fact label="Integrity" {...integrityFact(check.data ?? d.integrity, now)} />
          </div>
          <WritersCard d={d} now={now} />
        </>
      )}
    </div>
  )
}
