---
type: "Decision record"
title: "ADR 0020: Autopilot — reactive automations"
description: "WHEN/IF/THEN rules over live sensor and analysis signals, ported from sleepypod's Autopilot, with a light arbiter that ranks manual > Autopilot > schedule, an audit log, dry-run and backtests; hald's guards still bound every action."
status: "stable"
generated: {"by": "claude/opus-5.5", "at": "2026-10-31T14:00:00+00:00"}
sources: [{"resource": "https://github.com/sleepypod/core/blob/dev/docs/adr/0023-autopilot-reactive-automations.md", "title": "sleepypod ADR 0023: Reactive automations engine (Autopilot)"}, {"resource": "/adr/0004-two-tier-hal-core.md", "title": "ADR 0004: Two tiers — hardware daemon and core"}, {"resource": "/adr/0009-pump-safety-guard.md", "title": "ADR 0009: Pump safety guard"}, {"resource": "/adr/0014-auto-dosing-safety.md", "title": "ADR 0014: Auto-dosing safety"}, {"resource": "/adr/0015-event-bus.md", "title": "ADR 0015: Event bus and mutation broadcast"}, {"resource": "/adr/0019-pluggable-capture-analysis.md", "title": "ADR 0019: Pluggable capture analysis"}]
---

# ADR 0020: Autopilot — reactive automations

**Status:** Accepted
**Date:** 2026-10-31

## Context

Everything seedypod does on its own is **time-triggered**:

- Light curves and pump cycles fire from the scheduler.
- Grow reminders fire from the grow engine.

Nothing reacts to a reading. Owners want rules like these:

- "pH above 6.5 for an hour → run doser 1 for 5 s."
- "Air above 30 °C → dim the light to 60 %."
- "Water below 25 % → notify me."
- "Pod 7's green area hasn't grown in 3 days → mark it for attention."

The signals already exist: sensor telemetry, actuator state, alerts, and since
ADR 0019, per-pod analysis results.

sleepypod solved the same problem for the Pod with **Autopilot** (its ADR 0023):

- WHEN/IF/THEN rules over live signals.
- Windowed aggregates (`avg(ph, 60m)`).
- Three-valued logic, so a missing signal skips instead of firing.
- Cooldowns and a runaway guard.
- A per-rule dry-run and a global kill switch.
- An audit log of every evaluation, and a backtest against recorded history.

Its transparency is the point: the owner can see why a rule fired, and what it
would have done, before handing it the hardware.

Both projects are AGPL-3.0 and share an owner (ADR 0002), so the evaluation
core can be ported directly.

What doesn't port is the output side:

- sleepypod arbitrates bed-temperature "leases" per side.
- seedypod has one light, one pump, up to four dosers, and pods.

Of these, only the light is a **continuous** setpoint that a rule, a schedule and
a person could fight over. Pump runs and doses are bounded one-shots, already
refused or clamped by `hald` (ADR 0009, ADR 0014).

## Decision

### Rules: the sleepypod model, ported

The AST is ported from sleepypod `src/automation/types.ts`.

- **Trigger (WHEN):**
  - `tick` every N minutes;
  - `signalChange` of one signal;
  - `timeOfDay` at HH:MM on chosen days, with a 10-minute grace so a late tick
    still fires, at most once per local day.
- **Conditions (IF):**
  - an AND / OR / NOT tree over `compare`, `between`, `timeBetween` (wraps
    midnight) and `onDays`;
  - plus `sustained`: the condition held for the last N minutes, which
    debounces a reading sitting on a threshold.
- **Three-valued logic:** an operand whose signal has no value makes the
  condition *unknown*, and unknown never fires.
- **Expressions:**
  - literals and signals;
  - `avg | min | max | sum | count(signal, last N min)` over ring buffers sampled
    each tick;
  - `+ − × ÷` and `clamp`.

  Division by zero is unknown. Action parameters are expressions too.
- **Evaluator:** `expressions.ts`, `evaluator.ts` and `windows.ts` are ported
  near-verbatim, with their tests.

### Signals: a typed catalog

| Key | Value |
|---|---|
| `sensor.<SensorId>` | Latest reading in canonical units: `sensor.ph`, `sensor.air_temp`, `sensor.water_level_pct`, … |
| `light.level`, `pump.on`, `pump.level`, `dose_N.on` | Actuator state (`on` is 1/0) |
| `alert.<kind>` | 1 while that alert is active, else 0 |
| `pod.<slot>.green` | Latest green fraction from the primary analyser (ADR 0019) |
| `pod.<slot>.trend` | Slope of the last 12 points of that series, per capture |
| `grow.day` | Days since the current cycle started; unknown with no cycle |

- Signals with no current value are unknown.
- The catalog is served by the router, so the rule builder only offers keys that
  exist and the units each one uses.

### Actions: seedypod's verbs, through the normal paths

| Action | Goes through | Bounded by |
|---|---|---|
| `notify(message)` | An `autopilot` alert with the rule name. It shows in the app's alerts and in MCP `status`. The Home Assistant bridge only carries grow reminders today. | Nothing touches hardware. This is the safe default. |
| `setLight(level, clamp?)` | The **light arbiter** (below) | Per-action clamp, then 0–100. Anti-thrash: re-sent only when it moves ≥ 2 points. |
| `runPump(durationS, level?)` | `hal.setActuator('pump')` | `hald`'s pump guard: dry-run interlock, max run, max duty (ADR 0009) |
| `stopPump` | `hal.setActuator('pump', off)` | — |
| `dose(id, durationS)` | `hal.setActuator('dose_N')` | `hald`'s dose guard: disabled by default, per-dose max, daily cap, lockout (ADR 0014) |
| `setPodStatus(slot, status)` | The store, like the Grow screen | — |

The engine has no hardware path of its own. A refusal from `hald` is recorded
as the run's outcome and never retried by the engine.

### The light arbiter: manual > Autopilot > schedule

`src/control/light.ts` owns the light. It is the only writer.

1. **Manual hold.** A level set from the app, REST, MCP, or anything outside
   core (the button, Home Assistant) holds for 30 minutes. Manual changes are
   recognised by the light's reported state differing from what the arbiter
   last wrote. Resume releases the hold early.
2. **Autopilot.** The engine holds per-rule leases. The highest `priority` wins,
   then the most recent. A *policy* lease (re-asserted every tick while its
   condition holds) lapses two ticks after the condition stops holding. A
   *one-shot* lease holds for its `holdMinutes`.
3. **Schedule.** The scheduler hands its current curve point to the arbiter
   instead of writing the light.
4. **Nothing.** The last applied level stays.

The arbiter writes only when the resolved level changes. While a higher source
is in charge, the schedule's clock keeps running. That way, when a hold
expires, the light resolves to the current curve point and doesn't replay old
ones. This is the precedence sleepypod reached in its revision of ADR 0023,
minus run-once sessions, which seedypod doesn't have.

### Safety

These are copied from sleepypod and kept on by default. The hardware guards in
`hald` sit underneath all of them.

- **Kill switch.** `device_settings.autopilotEnabled` stops evaluation and
  drops every lease at once. It persists across restarts.
- **Dry-run per rule.** The rule evaluates and logs `dry_run` with what it
  would have done. No action runs, notify included. New rules start in
  dry-run.
- **Runaway guard.** A rule that acts more than 12 times in a rolling hour is
  disabled and logs `error: runaway-disabled`. Doses and pump runs count
  against the same budget.
- **Cooldown per rule.** Repeated triggers inside the cooldown log
  `skipped: cooldown`.
- **No retries.** A `hald` refusal is logged and left. The guard's reason, such
  as the dry-run interlock, is the information the owner needs.

### Transparency

- **`automation_runs`.** One row per evaluation where the trigger was active:
  outcome `fired | skipped | clamped | dry_run | refused | error`, plus a JSON
  detail (condition values, each action's raw and clamped value, the refusal
  reason). This answers "why did the light dim at 3 pm".
- **Backtest.** Replays one rule over recorded history at a 1–5 minute step,
  with no hardware. Inputs:
  - `telemetry` for sensors;
  - `analysis_results` for pods;
  - alert history for `alert.*`;
  - grow cycles for `grow.day`.

  It returns the compared signal's trace, fire and suppressed markers, and
  action values. It reuses the same evaluator and window code. Actuator state
  isn't recorded historically, so `light.*` and `pump.*` read unknown in a
  backtest. That's a stated limit, not a silent zero.

### Where it lives

- **Code.**
  - `src/autopilot/`: `types`, `expressions`, `evaluator`, `windows`,
    `signals`, `engine`, `backtest`.
  - `src/control/light.ts`.
  - Tables `automations` and `automation_runs`.
  - Router `automations.*`: list, get, create, update, delete, setEnabled,
    setDryRun, runs, status, catalog, backtest, kill switch.
- **Live updates.** Every write hot-reloads the engine and broadcasts a
  mutation (ADR 0015).
- **Tick.** A 60 s evaluator tick. Telemetry arrives at roughly that rate, and
  plant processes are slower still.
- **Not in `hald`.** Rules are app logic (ADR 0004). `hald` keeps the guards.

### Agents

The MCP server gets read-only tools:

- `list_automations`: rules, live status, the last runs.
- `backtest_automation`: replay a rule, by id or as an inline draft, without
  saving it.

Creating, enabling or arming a rule changes what the unit does on its own, so
those stay in the app.

### UI

An **Autopilot** screen in the sidebar:

- The kill switch.
- Rules with their enabled and dry-run state, and the last outcome.
- A structured WHEN / IF / THEN builder with a plain-English preview. It offers
  only catalog signals and the operators that fit them.
- The run log.
- A backtest panel: the signal trace with fire markers over a chosen 1, 3 or 7
  days.

It uses forms, not a node graph, for the reasons sleepypod gives.

## Alternatives considered

- **Extend the scheduler.**
  - Rejected for the same reason as sleepypod. Cron-style fire-once is a
    different lifecycle from a continuous evaluator with windows and per-rule
    state.
  - The scheduler does change, though: it stops writing the light directly,
    so the arbiter can rank it.
- **Home Assistant automations instead.**
  - HA already sees every entity and can automate them.
  - Not every owner runs HA. HA can't see analysis signals or backtest against
    seedypod's history. And HA cutting out would stop the garden's own rules.
  - The two coexist: HA commands count as manual through the arbiter.
- **Rules in `hald`.**
  - Rejected. `hald` is the safety floor and stays small (ADR 0004).
- **Arbitrate the pump too.**
  - Not needed. Pump runs are bounded one-shots that `hald` refuses while
    another run is active. A rule can't hold the pump on.

## Consequences

- A second long-lived component beside the scheduler. The run log and the
  status endpoint are how you see what it's doing.
- The light gains a manual hold everywhere, not only for Autopilot. Turning the
  light on from the app at 22:00 now survives the curve's next step for 30
  minutes, which is the behaviour people expect.
- New migrations add the two tables and `autopilotEnabled` (default on, with
  every rule in dry-run until armed).
- Backtests can't replay actuator-state signals. The builder marks those
  signals "live only".

## Implementation

[Autopilot](../AUTOPILOT.md) is the user and integrator guide. Two deviations
from the plan above, both found while building it:

- **REST paths.** The kill switch lives at `PUT /autopilot/enabled`, because
  `PUT /automations/enabled` would collide with `PUT /automations/{id}`.
- **Backtest.** It drives the real engine with a simulated clock instead of a
  separate replay model, so its result can't drift from live behaviour.

Code:

- Engine: `src/autopilot/` (`engine.ts`, `evaluator.ts`, `expressions.ts`,
  `windows.ts`, `signals.ts`, `backtest.ts`, `instance.ts`).
- Arbiter: `src/control/light.ts`.
- API: `src/server/routers/automations.ts`.
- UI: `src/components/Autopilot/`.
- Tests: `tests/sim/bringup.mjs` and `tests/browser/autopilot.e2e.ts` check it
  end to end.
