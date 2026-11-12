---
type: "Decision record"
title: "ADR 0029: Care engine and agent boundary"
description: "Chores, setup warnings and starter rules come from a deterministic care engine in core that works with no model; an optional LLM agent sits on top over MCP, where it reads, explains, logs tank actions and drafts rules, but never arms a rule or drives the pump or a doser in a loop. Advice is gated on reading quality and age, falls back to a stated calendar guess, and cites the knowledge bundle for every dose and target."
status: "draft"
generated: {"by": "claude/opus-5.5", "at": "2026-11-09T18:00:00+00:00"}
sources: [{"resource": "https://github.com/seedypod/core/issues/172", "title": "#172 Open care agent: reading-driven chores with an optional LLM layer"}, {"resource": "/adr/0011-mcp-and-mhs.md", "title": "ADR 0011: MCP tool design and MHS alignment"}, {"resource": "/adr/0014-auto-dosing-safety.md", "title": "ADR 0014: Auto-dosing safety"}, {"resource": "/adr/0015-event-bus.md", "title": "ADR 0015: Event bus and mutation broadcast"}, {"resource": "/adr/0020-autopilot-reactive-automations.md", "title": "ADR 0020: Autopilot — reactive automations"}, {"resource": "/adr/0022-harvest-outlook.md", "title": "ADR 0022: Harvest outlook"}, {"resource": "https://github.com/seedypod/core/blob/dev/knowledge/nutrients/index.md", "title": "Knowledge: Nutrients"}]
---

# ADR 0029: Care engine and agent boundary

**Status:** Proposed
**Date:** 2026-11-09

## Context

Gardyn's Kelby is sold as an "AI gardener", but owners describe a fixed
timeline. It never asks for food, or it asks for a top-off several days running
while the tank is full. seedypod already measures the tank, can read pH and EC
probes (EZO-pH 0x63, EZO-EC 0x64), and watches each pod on camera (ADR 0019).

Today the unit's own care is two things:

- **Grow reminders** (`src/grow/grow.ts`): thinning, root check, harvest and
  nutrients, a fixed number of days after the cycle starts.
- **Autopilot rules** (ADR 0020), which a person writes and arms.

Nothing turns a reading into a chore. Nothing warns that a unit has pods
planted but no light or pump schedule, or that its tank sensor reads `suspect`.
A planning session run entirely through MCP on 2026-11-09 found both on one
unit (#172).

An LLM can explain readings, diagnose from camera stills and build plans. It
can't run on the unit: a Pi Zero W has no room for one. A model can also invent
a dose, and a wrong dose kills a tower. So the question is what core decides
on its own, and what an agent may do on top.

## Decision

### 1. A deterministic care engine in core

`src/care/` holds plain rules with no model behind them. The unit gives the
same advice with no agent connected.

| Part | What it does |
|---|---|
| Setup check | Warns when pods are planted but no enabled light or pump schedule exists, and when the water-level sensor is absent or `suspect`. |
| Chores | Thin, trim roots, top off, refresh, feed and clean, each with a state (`due`, `soon`, `ok`, `unknown`), a reason, and the basis it used. |
| Tank action log | Records what was done to the tank (fed 1 tsp MaxiGro, refreshed, added 2 mL pH Down, topped off): time, kind, amount, product and note. A logged action resets the matching chore's clock, and lets readings be attributed to actions. |
| Starter rules | Autopilot rules sourced from the knowledge bundle (pH outside 5.5–6.5, EC below the crop target, tank below half), offered for a person to add. |

Rules here are functions of the store and the HAL snapshot. They are unit
tested like the harvest outlook (ADR 0022). Anything that acts on hardware
stays in Autopilot, behind its dry-run and kill switch (ADR 0020).

### 2. Readings first, an honest calendar second

Each chore has a `basis`:

- **`reading`**: derived from a sensor. Examples: the tank at 40 % and falling
  8 % a day; EC 0.9 mS/cm against a 1.2 target; 17 of 20 young pods showing
  leaf cover on camera, so thin now.
- **`timeline`**: a calendar guess from the cycle start or the last logged
  action. Its reason says why it is a guess ("calendar guess: no EC probe").

A reading counts only when its `quality` is `good` and it is no older than
`SENSOR_STALE_MS` (15 minutes, the Status page's threshold). A `stale` or
`suspect` reading is never used. The chore falls back to its timeline and says
which reading it couldn't trust. In particular, a top-off is never advised from
a `suspect` water level. hald marks a reading `suspect` when fewer than half
of its samples answered (`hal/crates/hal-core/src/derived.rs`).

Chores that no fitted sensor can see (trimming roots, cleaning) are always
`timeline`, and say so.

### 3. Every dose and target cites the knowledge bundle

Advice that names a dose or a target carries `citations`: the note's path in
`knowledge/` (an OKF note, see `knowledge/references/okf.md`), the section
heading, and a link to it on GitHub. Notes in use today:

- `knowledge/nutrients/gardyn-feeding-guidance.md`: plant-food doses, tank
  cadence, pH and EC by crop, keep the tank at least half full.
- `knowledge/nutrients/community-nutrients.md`: other products, why teaspoons
  don't carry over between them, owner-reported targets.

Rules:

- Core never states a dose or target that isn't in a cited note. A missing
  number is a knowledge gap, fixed by a PR to `knowledge/`, not by code.
- Teaspoon doses are given only for the product the note gives them for
  (Gardyn Plant Food). With an EC probe the advice is "dose to the EC target",
  which holds for any nutrient.
- A test checks that every cited note exists and has the cited heading, so a
  renamed note fails CI instead of linking nowhere.
- A chore with no published interval (cleaning) says its interval is
  seedypod's guess.

### 4. The agent sits on top, over MCP

The agent is any MCP client: Claude, a local model, anything else. It needs no
subscription, and the unit is the source of truth. The MCP surface for care:

| Tool | Kind | Notes |
|---|---|---|
| `setup_check` | read | Setup warnings, as the Status page shows them |
| `list_chores` | read | Each chore with `basis`, reason, the readings used, and `citations` |
| `list_tank_actions` | read | The tank action log, newest first |
| `log_tank_action` | write | Record an action the person reports ("I fed 1 tsp MaxiGro"). Marked `source: agent`. Touches no hardware. |
| `starter_rules` | read | The knowledge-sourced starter rules, with citations and whether each is already added |

The agent may:

- explain readings, chores and rules, citing the notes it was given;
- log tank actions a person reports;
- propose rules as drafts and backtest them (`backtest_automation` takes an
  inline draft);
- diagnose from camera stills and build plans (ADR 0024).

The agent may not:

- **Create, enable or arm an Autopilot rule.** Autopilot stays read-only over
  MCP, as ADR 0020 decided. A person adds a starter or a draft in the app. It
  starts in dry-run there, and the person arms it.
- **Drive the pump or a doser in a loop.** There is no doser tool on MCP.
  `run_pump` remains a single bounded run under `PumpGuard` (ADR 0009). It is
  for a person asking through their agent, never a control loop. Dosing
  happens only through an armed rule and `DoseGuard` (ADR 0014).
- **Invent a dose.** Tool descriptions tell the agent to quote cited doses and
  targets only.

### 5. Learning the tank

The action log is what makes learning possible. An `ec` series around a logged
`feed` gives this tank's EC rise per teaspoon of that product. A `ph` series
after `ph_down` gives its drift rate. A timeline can't know either. This ADR
only records the actions. Fitting those rates, and showing them, is later work
that builds on the log without changing it.

### 6. Event-driven, never a polling LLM

Core never calls a model. It re-evaluates the setup check on the mutations that
can change it (schedules, pods, devices) and on the grow engine's 15-minute
tick. That is cheap and local. An agent wakes on changes, not on a timer:

- alerts raised or cleared, including setup warnings;
- Autopilot rule fires;
- new captures.

All three already arrive on the event bus (ADR 0015) and its SSE
subscription, and alerts also reach MCP `status`. An agent harness that wants
to act on them subscribes there, so a quiet tank costs no tokens.

## Alternatives considered

- **Let the LLM run care.** Rejected. It can't run on the unit, it fails
  silently when the model or the network is down, and an invented dose can kill
  a tower. The rules would be unreviewable.
- **Arm rules from MCP.** Rejected for the same reason as ADR 0020. Arming
  changes what the unit does unattended, and a person should make that choice
  with the backtest in front of them.
- **Keep the fixed reminders only.** Rejected. That is the timeline Kelby is
  criticised for, and it ignores the tank sensor the unit already has.
- **Hard-code doses in code.** Rejected. Numbers in `knowledge/` carry their
  sources, are reviewed by PR, and are cited, so wrong advice can be traced
  and fixed.

## Consequences

- Without a pH or EC probe, feeding stays a calendar guess, and the unit says
  so. Fitting the probes is a hardware task. The software already reads
  EZO-pH 0x63 and EZO-EC 0x64.
- The fixed grow reminders stay as they are. Chores sit beside them, and can
  replace them once they have run on real units.
- One table, `tank_actions`. It is in the database, so backups carry it
  (ADR 0021).
- Advice is only as good as `knowledge/`. Its gaps, such as no published EC
  for Gardyn's food, show up as calendar guesses rather than invented numbers.
- Autopilot's signals now drop `suspect` readings as they already dropped
  `stale` ones, so no rule, starter or otherwise, acts on a reading hald
  doesn't trust.

## Implementation

- Setup check: `src/care/setup.ts`. Alerts `setup_light_schedule`,
  `setup_pump_schedule` and `setup_water_sensor`; a **Setup** line on Status.
- Tank action log: table `tank_actions` (migration 0014), `tank.*` router,
  **Care → Tank log** (first on Water).
- Chores: `src/care/chores.ts`, with citations from `src/care/knowledge.ts`.
  **Care → Chores** (first on Water) and **Needs you**. A reading that makes a chore due raises
  `chore_top_off`, `chore_feed` or `chore_thin`; marking one done logs the
  action.
- **Care** page (2026-11-10): chores, the tank log, the setup check, starter
  rules and how to connect an MCP client, in one place; Home and Water show
  one line of what's due and link to it.
- Starter rules: `src/care/starters.ts`, **Autopilot → Starter rules**.
- Engine: `src/care/engine.ts`, started with the other services in
  `src/server/bootstrap.ts`.
- API: `src/server/routers/care.ts` (`/care/setup`, `/care/chores`,
  `/care/starter-rules`) and `src/server/routers/tank.ts` (`/tank/actions`).
- Tests: `src/care/tests/`. `knowledge.test.ts` checks every cited note,
  heading and number.
