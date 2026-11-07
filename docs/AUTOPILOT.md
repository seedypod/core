---
type: "Guide"
title: "Autopilot"
description: "Rules that react to readings: build one, read it back in plain English, backtest it, arm it, and see why it acted; how the light decides between you, Autopilot and the schedule."
status: "draft"
generated: {"by": "claude/opus-5.5", "at": "2026-10-31T16:00:00+00:00"}
sources: [{"resource": "/adr/0020-autopilot-reactive-automations.md", "title": "ADR 0020: Autopilot — reactive automations"}, {"resource": "/adr/0009-pump-safety-guard.md", "title": "ADR 0009: Pump safety guard"}, {"resource": "/adr/0014-auto-dosing-safety.md", "title": "ADR 0014: Auto-dosing safety"}]
---

# Autopilot

Schedules act at set times. Autopilot rules act on what the unit **reads**:

- "If the average pH over the last hour is above 6.5, run doser 1 for 5 seconds."
- "If it's been above 29 °C for 10 minutes, dim the light to 60 %."
- "If the tank is below 30 %, tell me."
- "If pod 7 has stopped growing, mark it for attention."

Open **Autopilot** in the sidebar.

## A rule is WHEN, IF, THEN

| Part | Choices |
|---|---|
| **When** | Every N minutes; whenever a reading changes; or at a time of day (on chosen weekdays). |
| **If** | One or more comparisons on any reading, either its current value or its average, lowest or highest over the last N minutes. Combine them with *all* or *any*. Add **held for N minutes** to ride out a noisy reading, and **only between** two times. |
| **Then** | Notify you; set the light; run the pump; stop the pump; run a doser; mark a pod. |

Every rule also has:

- **Cooldown.** Once a rule fires, it won't fire again within this many minutes.
- **Priority.** When two rules both want the light, the higher priority wins.

The builder shows the rule as a sentence while you edit it. The list shows the
same sentence for each rule.

### What a rule can read

| Reading | Examples |
|---|---|
| Sensors | pH, EC, water and air temperature, humidity, tank level, pump power |
| Equipment | Light level; whether the pump or a doser is running |
| Alerts | Whether an alert such as *water low* is active (1 or 0) |
| Pods | Each pod's green area and its growth trend, from the primary analyser on the **Analysis** screen |
| Grow cycle | Days since the cycle started |

If a reading has no value (a sensor isn't fitted, or its reading is stale), the
rule **skips**. It never acts on missing data.

## Dry run, then arm

New rules start in **dry run**. A dry-run rule evaluates on schedule and logs
what it **would** have done, but touches nothing. Leave it for a few days,
check the activity log, then switch it to **Active**.

Each rule has an **Off / Dry-run / Active** control on its row, so going back
is always one click. The header shows the count (`3 rules · 2 active ·
1 dry-run`) next to the kill switch. With no rules yet, the screen offers three
starters (a low-tank notice, dimming when hot, a pH dose) that open in the
builder.

## Backtest before you arm

Every rule on the list carries a **standing 7-day backtest**, replayed in the
background: a line such as `7-day backtest · 3 would fire · peak 31 of 29 °C`
(how far the reading it watches went against its threshold), and a sparkline
of that reading with the threshold dashed and a mark where the rule would have
fired. You can see what arming a rule would mean without opening anything.

Click the summary, or open the builder, for the full replay over the last 1, 3
or 7 days of recorded readings. It shows:

- when it would have fired, and what each action would have done, including
  values that were clamped;
- how often the cooldown held it back, and whether the runaway guard would have
  switched it off;
- the readings it compared, as a chart.

Nothing is sent to the hardware during a backtest. Equipment state (the light
level, whether the pump is running) isn't recorded, so those readings count as
unknown in a backtest; the panel tells you when that applies.

## Why did it do that?

**Today**, at the top of the screen, says who holds the light right now and
draws the last 24 hours as one lane per rule, with a mark wherever it fired or
would have fired.

The **activity log** keeps one line every time a rule's *when* came round,
grouped by day. It shows what rules did by default; **All checks** adds the
skipped ones, and **Fired**, **Would fire** and **Refused** narrow it down:

| Outcome | Meaning |
|---|---|
| fired | The rule acted. |
| fired (clamped) | It acted, but a value was pulled back inside its limits. |
| would fire | A dry-run rule would have acted. |
| skipped | The condition was false or unknown, or the cooldown was running. |
| refused | The hardware guard said no, for example the pump's dry-run interlock or the dosing cap. The guard's reason is shown. Autopilot doesn't retry. |
| error | Something went wrong, including the runaway guard switching the rule off. |

The log keeps 30 days.

## Safety

- **Kill switch.** The switch at the top of the Autopilot screen stops every
  rule and hands the light back. It stays off across restarts until you turn
  it on again.
- **The hardware guards still apply.** A rule can ask for a pump run or a dose,
  but `hald` enforces the dry-run interlock, the maximum run time and duty,
  and the dosing caps and lockout exactly as it does for you
  ([pump](adr/0009-pump-safety-guard.md),
  [dosing](adr/0014-auto-dosing-safety.md)). Dosing is off until you enable it
  in `hal.toml`.
- **Runaway guard.** A rule that acts more than 12 times in an hour is switched
  off, and the run log says so.
- **Notifications clear themselves.** A rule's notification appears in
  **Alerts** and in the MCP `status` tool. It clears when the rule's condition
  stops holding. The Home Assistant bridge only publishes grow reminders, so
  these notifications don't reach Home Assistant yet.

## Who controls the light

Three things can set the light, and the highest one with an opinion wins:

1. **You.** Setting the light from the app, Home Assistant, an agent or the
   unit's button holds it for 30 minutes. **Light → Resume** hands it back
   early.
2. **Autopilot.** A rule that sets the light holds it while its condition is
   true. A rule that fires at a time of day holds it for the minutes you chose
   (60 by default).
3. **The schedule.** The light curve applies otherwise.

When a hold ends, the light goes to wherever the schedule is *now*. It doesn't
replay steps it missed. The top of the Autopilot screen says who controls the
light at the moment.

## For integrators

- **REST** (`/api`, see `GET /api/openapi.json`):
  - `GET /automations`, `POST /automations`, `PUT` and `DELETE /automations/{id}`
  - `GET /automations/runs`, `GET /automations/status`, `GET /automations/signals`
  - `POST /automations/backtest`, and `GET /automations/backtests` for every
    rule's 7-day summary at once
  - `PUT /autopilot/enabled` (the kill switch)
  - `GET /light/owner`, `POST /light/resume`

  Rules are JSON: `trigger`, `conditions` and `actions`, as described in
  [ADR 0020](adr/0020-autopilot-reactive-automations.md). The API accepts
  shapes the builder can't show, such as nested AND/OR, arithmetic in values,
  and per-action light limits. The app shows those rules read-only.
- **MCP:** `list_automations` and `backtest_automation` are read-only, so an
  agent can explain rules and test drafts. Creating, arming or disabling rules
  stays with a person in the app.
