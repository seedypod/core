import { Link } from '@tanstack/react-router'
import { Bot, CircleCheck, Copy, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { Button, Card, SectionLabel } from '@/src/components/ds/core'
import type { Draft } from '@/src/components/Autopilot/builderModel'
import { RuleEditor } from '@/src/components/Autopilot/RuleEditor'
import { StarterRules } from '@/src/components/Autopilot/StarterRules'
import { Chores } from '@/src/components/Water/Chores'
import { TankLog } from '@/src/components/Water/TankLog'
import { trpc } from '@/src/utils/trpc'

const ADR = 'https://github.com/seedypod/core/blob/dev/docs/adr/0029-care-engine-and-agent-boundary.md'
const MCP_DOCS = 'https://seedypod.github.io/core/mcp/'

/**
 * Care (ADR-0029) in one place: what a planted unit is missing, the chores with
 * the reading or calendar guess and the notes behind each, the tank log they
 * count from, starter rules, and how to put an AI assistant on top over MCP.
 * Home shows what's due now (CareSummary); this is the context.
 */
export function CarePage() {
  const [draft, setDraft] = useState<Draft | null>(null)
  return (
    <div className="mx-auto flex max-w-[1000px] flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Care</h1>
        <p className="text-[13px] text-fg-2 text-pretty">
          What the tower needs, worked out from readings the unit trusts, or a calendar guess that says so when there’s no sensor. It runs on the unit with no AI model;
          {' '}
          <a href={ADR} target="_blank" rel="noopener noreferrer" className="underline decoration-line-2 underline-offset-2 hover:text-fg">an assistant can sit on top</a>
          .
        </p>
      </div>
      <SetupIssues />
      <Chores />
      <TankLog />
      <StarterRules onOpen={setDraft} />
      <Assistant />
      {draft && <RuleEditor id={null} initial={draft} onClose={() => setDraft(null)} />}
    </div>
  )
}

/** The setup check: pods planted with nothing to light or water them, and a tank sensor chores can't trust. */
function SetupIssues() {
  const setup = trpc.care.setup.useQuery(undefined, { refetchInterval: 5 * 60_000 })
  const issues = setup.data?.issues ?? []
  return (
    <section className="flex flex-col gap-2.5" aria-label="Setup">
      <SectionLabel>Setup</SectionLabel>
      <Card className="gap-0 p-0" data-testid="setup">
        {!setup.data && <p className="px-5 py-3 text-[13px] text-fg-3">Checking the setup…</p>}
        {setup.data && issues.length === 0 && (
          <p className="flex items-center gap-2 px-5 py-3 text-[13px] text-fg-2">
            <CircleCheck size={16} className="text-pod-ok" />
            {setup.data.summary}
          </p>
        )}
        {issues.map(i => (
          <div key={i.id} data-testid={`setup-${i.id}`} className="flex gap-3 border-b border-line px-5 py-3.5 last:border-0">
            <TriangleAlert size={16} className="mt-0.5 shrink-0 text-pod-attention" />
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">{i.title}</span>
              <span className="text-[13px] leading-snug text-fg-2 text-pretty">{i.detail}</span>
              <span className="text-[12px] text-fg-3">{i.fix}</span>
            </div>
          </div>
        ))}
      </Card>
    </section>
  )
}

/** Bring your own model: the unit's MCP endpoint, and what an assistant may and may not do there. */
function Assistant() {
  const url = `${window.location.origin}/api/mcp`
  const command = `claude mcp add --transport http seedypod ${url}`
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard?.writeText(command).then(() => setCopied(true), () => {})
  }
  return (
    <section className="flex flex-col gap-2.5" aria-label="AI assistant">
      <SectionLabel>AI assistant</SectionLabel>
      <Card className="gap-3" data-testid="assistant">
        <div className="flex gap-3">
          <Bot size={18} className="mt-0.5 shrink-0 text-fg-2" />
          <p className="text-[13px] leading-snug text-fg-2 text-pretty">
            The Pi can’t run a model, so you bring one: Claude, a local model or any MCP client, pointed at the unit. It reads the same chores, readings, photos and knowledge notes as this page, explains them, logs tank actions, plans pods and drafts rules. It can run the pump or set the light when you ask, within the same limits as the app, but it can’t arm a rule or run anything in a loop: that stays with you.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 rounded-[10px] bg-field px-3.5 py-2.5">
          <code className="min-w-0 flex-1 break-all font-mono text-xs text-fg" data-testid="mcp-command">{command}</code>
          <Button icon={Copy} className="px-3 py-[7px]" onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
        </div>
        <p className="text-[12px] text-fg-3">
          {'With no key under '}
          <Link to="/settings" hash="api" className="underline decoration-line-2 underline-offset-2 hover:text-fg">Settings → API access</Link>
          {', any device on your network can connect; with one, send it as '}
          <code className="font-mono">Authorization: Bearer</code>
          {'. '}
          <a href={MCP_DOCS} target="_blank" rel="noopener noreferrer" className="underline decoration-line-2 underline-offset-2 hover:text-fg">The tools it gets</a>
          .
        </p>
      </Card>
    </section>
  )
}
