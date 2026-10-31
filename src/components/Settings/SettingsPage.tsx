import { Settings } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { Button, Card, CardHeader, KeyValue, SectionLabel } from '@/src/components/ds/core'
import { SegmentedControl, Stepper, TextField, Toggle } from '@/src/components/ds/forms'
import { PageHeader, SettingRow } from '@/src/components/ds/layout'
import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '@/src/server/routers/app'
import { trpc } from '@/src/utils/trpc'

type SettingsView = inferRouterOutputs<AppRouter>['settings']['get']

export function SettingsPage() {
  const utils = trpc.useUtils()
  const q = trpc.settings.get.useQuery()
  const info = trpc.system.info.useQuery()
  const update = trpc.settings.update.useMutation({ onSuccess: () => utils.settings.invalidate() })
  if (!q.data) return null
  return <SettingsForm key={q.data.updatedAt} s={q.data} coreVersion={info.data?.coreVersion} system={info.data?.system ?? null} onSave={patch => update.mutate(patch)} saving={update.isPending} />
}

function SettingsForm({ s, coreVersion, system, onSave, saving }: {
  s: SettingsView
  coreVersion?: string
  system: { halVersion: string, model: string, unitId: string } | null
  onSave: (patch: Record<string, unknown>) => void
  saving: boolean
}) {
  // Keyed on updatedAt by the parent, so a fresh server value resets the draft without an effect.
  const [d, setD] = useState<Record<string, unknown>>({ ...s })
  const num = (k: string, fallback: number) => Number(d[k] ?? fallback)
  const str = (k: string) => String(d[k] ?? '')
  const save = () => {
    const rest: Record<string, unknown> = { ...d }
    delete rest.hasApiKey
    delete rest.hasMqttPassword
    delete rest.updatedAt
    onSave(rest)
  }
  const dirty = JSON.stringify(d) !== JSON.stringify(s)

  return (
    <div className="mx-auto flex max-w-[960px] flex-col gap-4">
      <PageHeader title="Settings" right={<Button variant="primary" disabled={!dirty || saving} onClick={save}>Save</Button>} />
      <Card>
        <CardHeader title="Unit" icon={Settings} />
        <SettingRow label="Name"><TextField mono={false} value={str('unitName')} onChange={v => setD({ ...d, unitName: v })} /></SettingRow>
        <SettingRow label="Timezone" sub="Schedules run in this zone"><TextField value={str('timezone')} onChange={v => setD({ ...d, timezone: v })} placeholder="America/Los_Angeles" /></SettingRow>
        <SettingRow label="Temperature unit" divider={false}><SegmentedControl size="sm" value={str('temperatureUnit') as 'C' | 'F'} options={[{ value: 'C', label: '°C' }, { value: 'F', label: '°F' }]} onChange={v => setD({ ...d, temperatureUnit: v })} /></SettingRow>
      </Card>

      <Card>
        <CardHeader title="Tank calibration" subtitle="Ultrasonic distance from the sensor to the water surface" />
        <SettingRow label="Full" sub="cm when just filled"><Stepper value={num('waterFullCm', 5)} min={1} max={30} step={0.5} onChange={v => setD({ ...d, waterFullCm: v })} format={v => `${v} cm`} /></SettingRow>
        <SettingRow label="Empty" sub="cm when the pump would run dry"><Stepper value={num('waterEmptyCm', 20)} min={5} max={40} step={0.5} onChange={v => setD({ ...d, waterEmptyCm: v })} format={v => `${v} cm`} /></SettingRow>
        <SettingRow label="Capacity" divider={false}><Stepper value={num('tankCapacityL', 19)} min={1} max={60} step={1} onChange={v => setD({ ...d, tankCapacityL: v })} format={v => `${v} L`} /></SettingRow>
      </Card>

      <Card>
        <CardHeader title="Grow reminders" subtitle="Days after a cycle starts; 0 disables" />
        <SettingRow label="Thinning"><Stepper value={num('thinningReminderDays', 14)} min={0} max={60} onChange={v => setD({ ...d, thinningReminderDays: v })} format={v => `${v} d`} /></SettingRow>
        <SettingRow label="Root check"><Stepper value={num('rootCheckReminderDays', 21)} min={0} max={90} onChange={v => setD({ ...d, rootCheckReminderDays: v })} format={v => `${v} d`} /></SettingRow>
        <SettingRow label="Harvest"><Stepper value={num('harvestReminderDays', 35)} min={0} max={120} onChange={v => setD({ ...d, harvestReminderDays: v })} format={v => `${v} d`} /></SettingRow>
        <SettingRow label="Nutrients" sub="recurring" divider={false}><Stepper value={num('nutrientReminderDays', 7)} min={0} max={30} onChange={v => setD({ ...d, nutrientReminderDays: v })} format={v => `every ${v} d`} /></SettingRow>
      </Card>

      <Card>
        <CardHeader title="Cameras" />
        <SettingRow label="Capture interval" sub="0 disables timelapse" divider={false}><Stepper value={num('captureIntervalMin', 60)} min={0} max={720} step={15} onChange={v => setD({ ...d, captureIntervalMin: v })} format={v => `${v} min`} /></SettingRow>
      </Card>

      <Card>
        <CardHeader title="Home Assistant bridge" subtitle="Core-level MQTT bridge for grow events and services. The hardware daemon already publishes discovery for lights, pump and sensors." />
        <SettingRow label="Broker URL"><TextField value={str('mqttUrl')} onChange={v => setD({ ...d, mqttUrl: v || null })} placeholder="mqtt://homeassistant.local:1883" /></SettingRow>
        <SettingRow label="Username"><TextField value={str('mqttUsername')} onChange={v => setD({ ...d, mqttUsername: v || null })} /></SettingRow>
        <SettingRow label="Password" sub={s.hasMqttPassword ? 'set' : 'not set'}><TextField type="password" value={str('mqttPassword')} onChange={v => setD({ ...d, mqttPassword: v || null })} placeholder="••••••" /></SettingRow>
        <SettingRow label="TLS"><Toggle on={!!d.mqttTlsEnabled} onChange={v => setD({ ...d, mqttTlsEnabled: v })} /></SettingRow>
        <SettingRow label="Allow self-signed" sub="Off by default (ADR-0013)" divider={false}><Toggle on={!!d.mqttTlsInsecure} onChange={v => setD({ ...d, mqttTlsInsecure: v })} /></SettingRow>
      </Card>

      <Card>
        <CardHeader title="API access" subtitle="Optional key for non-localhost REST/MCP clients" />
        <SettingRow label="API key" sub={s.hasApiKey ? 'set' : 'not set — LAN-only trust'} divider={false}><TextField type="password" value={str('apiKey')} onChange={v => setD({ ...d, apiKey: v })} placeholder="leave empty to disable" /></SettingRow>
      </Card>

      <Card>
        <CardHeader title="Wi-Fi" subtitle="Change networks, or hold the unit's button for 10 s to open a setup hotspot" />
        <SettingRow label="Network" divider={false}><Link to="/wifi" className="text-sm text-fg underline-offset-2 hover:underline">Open Wi-Fi settings</Link></SettingRow>
      </Card>

      <SectionLabel>About</SectionLabel>
      <Card>
        <KeyValue label="Core" value={coreVersion ?? '…'} />
        <KeyValue label="Hardware daemon" value={system ? `${system.halVersion} · ${system.model}` : 'offline'} />
        <KeyValue label="Unit id" value={system?.unitId ?? '—'} />
      </Card>
    </div>
  )
}
