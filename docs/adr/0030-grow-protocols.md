---
type: "Decision record"
title: "ADR 0030: Grow protocols"
description: "The watering presets become one grow protocol per tower: an ordered sequence of stages, each setting water, light, feed and checks with citations, run from the sowing day with Hold and Advance, and ending in an ongoing maintenance stage. What comes after is a person's choice (stay, switch to one of your schedules now or when maintenance begins, or a reminder at first harvest), never a date. A small library of your own schedules sits beside it, one active at a time. The runner generalises Follow the grow cycle and keeps its rules: forward only, and never over a schedule someone edited."
status: "draft"
generated: {"by": "claude/opus-5.5", "at": "2026-11-11T12:00:00+00:00"}
sources: [{"resource": "/adr/0029-care-engine-and-agent-boundary.md", "title": "ADR 0029: Care engine and agent boundary"}, {"resource": "/adr/0024-pod-planner.md", "title": "ADR 0024: Pod planner and Gardyn plant catalog"}, {"resource": "/adr/0015-event-bus.md", "title": "ADR 0015: Event bus and mutation broadcast"}, {"resource": "https://github.com/seedypod/core/blob/dev/knowledge/watering/schedules.md", "title": "Knowledge: Watering schedules"}, {"resource": "https://github.com/seedypod/core/blob/dev/knowledge/nutrients/gardyn-feeding-guidance.md", "title": "Knowledge: Gardyn feeding guidance"}, {"resource": "https://github.com/seedypod/core/blob/dev/knowledge/plants/germination.md", "title": "Knowledge: Germination"}]
---

# ADR 0030: Grow protocols

**Status:** Proposed
**Date:** 2026-11-11

## Context

The Water page offers five watering presets: germination, seedlings, young
plants, mature greens and herbs, and large or fruiting
(`src/scheduler/pumpPlan.ts`, sourced from `knowledge/watering/schedules.md`).
With Settings → `followGrowCycle` on, the care engine moves the pump cycles
forward through them as the plants age (`src/care/follow.ts`).

That works, but it reads as five options and a hidden mode. Four of the five
are stages of one grow, in a fixed order, and the fifth is a different track
after germination. Nothing on screen says what comes next, when, or what
happens once the last stage is reached. Feeding and checks change with the
stage too, and live elsewhere (chores, grow reminders). An owner who wants a
"summer" or "away" schedule after the grow has nowhere to keep it.

## Decision

### 1. One protocol per tower, as stages

A **protocol** is an ordered list of stages. It is code data, like the
presets, not a user setting:

| Field | Meaning |
|---|---|
| `id`, `name` | `greens-herbs`, "Greens & herbs" |
| `stages[]` | In order; see below |

Each **stage**:

| Field | Meaning |
|---|---|
| `id`, `name` | `seedlings`, "Seedlings" |
| `from`, `to` | Protocol days, inclusive. The last stage's `to` is `null`: ongoing |
| `water` | A pump preset id (`PumpPresetId`) |
| `light` | A light preset id (`LIGHT_PRESETS`) or `unchanged` |
| `feed` | Guidance text with its `Citation` |
| `checks[]` | Items to look at, each with its `Citation` |
| `rationale`, `citation` | Why this stage, and the note it comes from |

Two built-in protocols in v1:

- **Greens & herbs**: germination 0–7 → seedlings 8–13 → young 14–21 →
  maintenance 22 on (the mature preset, 3 × 6 min daily).
- **Fruiting**: germination 0–7 → maintenance 8 on (the fruiting preset).

The last stage of each is **maintenance** and is ongoing: the knowledge note
gives mature and fruiting watering no end ("Day 22 on"), so neither does the
protocol. Nothing ends a grow on a date.

**Which protocol.** One per tower in v1, by the planted crops, as
`recommendedPreset` chooses today: any planted fruiting crop picks Fruiting,
otherwise Greens & herbs. The choice is fixed once germination ends (below).

Every stage's `light` is `unchanged` in v1: Gardyn's 14–16 h guidance doesn't
change with the stage, so the protocol leaves the light curves alone. Feed
comes from the Plant food table (`CITE.plantFood`): plain water in
germination, the sprout dose once most yCubes have sprouted, ½ tsp per gallon
in early growth, 1 tsp in maintenance. Checks come from cited notes only, as
ADR 0029 requires for doses:

- germination: cardboard covers off; check daily for sprouts, some take up to
  21 days (`knowledge/plants/germination.md`, new);
- seedlings: thin, and put yCovers on only after thinning (same note);
- young and maintenance: roots ("Judging a schedule"), tank at least half
  full, top off weekly and refresh every 4 weeks (`CITE.tankHalfFull`,
  `CITE.tankCadence`).

Gardyn's help says nothing about domes for germinating in the tower (only a
vented lid over a Sprout Nursery), so there is no dome check; the note records
that gap. The existing citation test covers protocols too.

### 2. The grow cycle carries the protocol's state

`grow_cycles` gains:

| Column | Meaning |
|---|---|
| `protocolId` | `null` until germination ends: chosen by the planted crops (custom catalog plants included) on each tick. Fixed when the runner applies or recognises a stage after germination as written, or on Advance, so a tomato planted on day 30 doesn't move a greens tower to the fruiting track; while the watering is edited, paused or absent it stays open |
| `shiftDays` | Days added to days-since-sowing to get the protocol day. Advance and Release change it; `0` by default |
| `holdStageId`, `holdSince` | The held stage, or both `null` |
| `thenKind` | `stay`, `schedule` or `remind`; `stay` by default |
| `thenScheduleId` | The library schedule for `schedule` |
| `thenDoneAt` | When the chosen Then fired; a new choice clears it |
| `stageStarts` | JSON `{ stageId: date }`: the day each begun stage began, recorded when Advance or Release moves the clock; cleared when the sowing day moves (`grow.setStart`) |

**Protocol day** = days since the grow cycle's sowing date (on the unit's
calendar, as today) + `shiftDays`. The stage is the one whose `from`–`to`
holds that day, or the held stage while held. Stages not yet begun start on
the sowing date + `from` − `shiftDays` (plus the days held so far). Begun
stages keep the day they began: Advance and Release record those days in
`stageStarts` before they move the clock, so history never moves.

**Mixed sowing dates.** The protocol counts from the grow cycle, not from each
pod. `protocol.current` lists each planted pod sown later than that with its
`daysBehind`, so the Grow page can say "6 days younger than the protocol".
Watering is per tower, so those pods get the tower's stage.

An open cycle counts from its start even before any pod is marked planted, so
germination started today reads as day 0; the runner moves watering only for a
tower with something planted, as Follow always did. With no open grow cycle,
the runner still runs as today: protocol by crops,
counted from the earliest pod's date, no hold, Then `stay`. Hold, Advance and
Then need an open cycle, and say so.

### 3. Then: what comes after, chosen by a person

Maintenance is ongoing, so Then is never forced. It is a choice, and it takes
effect when it is made:

- **Stay in maintenance** (default): nothing fires.
- **Switch to my schedule**: one of your own (a built-in preset is the
  protocol's, not what comes after it), now, or queued to start when
  maintenance begins.
  Queued is the only switch the runner makes on its own, and only because
  someone chose it. Picking "when maintenance begins" while already in
  maintenance switches now.
- **Remind me at first harvest**: a Needs-you item (alert `reminder_first_harvest`)
  on the crops' first-harvest day, from the catalog (`harvestMonths[0]` at the
  planner's 30 days a month, ADR 0024), the latest across planted pods. With no
  catalog crop planted there is no day, and the option says so.

Each fires once, recorded in `thenDoneAt` once its write has gone through, so a
failed switch tries again on the next tick. Choosing a Then again clears it,
so a switch queued after going back to the protocol fires too; choosing the
reminder again doesn't repeat one that fired. A queued switch applies only
over a built-in preset as written (either track's); over cycles changed by
hand, another of your schedules or none, it raises `reminder_schedule_switch`
in Needs you instead, saying which. Both alerts are `reminder_` kinds, so they
get Done and Skip and no toast. Deleting the Then schedule resets Then to
`stay`.

### 4. Your schedules

A small library, table `schedule_library`: `id`, `name`, `cycles` (JSON
`{ minute, durationS, days }[]`), optional `lightPresetId`, `createdAt`,
`updatedAt`, `lastUsedAt`. The built-in water presets are listed beside them,
read-only, so "back to what the protocol did" is always one click; to change
one, duplicate it.

Activating a schedule writes its cycles as pump schedules `water-own-<id>-HHMM`
and removes the other pump cycles. If it names a light preset, it writes that
curve as `light-own-<id>` and turns the other enabled curves off (not
deleted), recording which in `device_settings.libraryLightsOff`. Activating one
without a light preset, a built-in preset included, or clearing the active
one's light preset, removes the `light-own-` curve and turns exactly those
curves back on. Activation is an explicit choice by a person, so unlike the
runner it may replace what is there.

**Active** is derived, not stored: the library entry or preset the live pump
cycles are, as written (the same matching as `appliedPreset` and
`followedPreset`). One is active, or none if the cycles were edited by hand
("Edited", with "Save as schedule").

**The protocol's end** is a person switching to one of their schedules, now or
queued. Nothing records it: once the live cycles are a library schedule, they
aren't the protocol's writing, so the runner leaves them be. Activating the
current stage's preset hands watering back to the protocol.

### 5. The runner

`src/care/protocol.ts` generalises `followGrowCycle` and replaces it in the
care engine's tick. Its rules are the ones that already hold:

- **Forward only.** Water moves from a stage to a later one (`advances`), never
  back. The stage reported is the later of the clock's stage and the stage
  whose water is on the pump, so the track never steps back after a later
  start date.
- **Only over its own writing.** A stage's water is applied only when the live
  pump cycles are still an earlier stage's preset as written: all on, the
  preset's days and length (`followedPreset`). It never creates cycles where
  there are none. `protocol.current` reports water as `preset` (a built-in
  preset as written, either track's), `schedule` (a library entry), `edited`
  (changed by hand) or `none`; only `preset` cycles are ever moved. Light,
  when a stage sets it, follows the same rule against the curve the protocol
  wrote.
- **Germination's weekly run keeps to the sowing weekday**, as today.
- **Then**, as section 3: a queued switch at maintenance's start, a reminder on
  the harvest day, each once.

Each move raises the existing `watering_followed` notice with the new cycles
and why (from `stageDiff`), and emits `schedule` `changed` (ADR 0015), as
today.

**`followGrowCycle`** keeps its column and now means "run the protocol". Off,
the schedules stay as they are: no stage moves and no queued switch. The
first-harvest reminder still fires, as it changes no watering. The library
still works by hand.

**Hold and Advance:**

- **Hold** pins the current stage: `holdStageId` = it, `holdSince` = now. The
  clock keeps counting but the stage doesn't move.
- **Release** subtracts the whole days held from `shiftDays` and clears the
  hold, so the stage resumes where it was held and later stages start that
  many days later.
- **Advance now** adds to `shiftDays` whatever brings the protocol day to the
  next stage's `from`, clears any hold, and lets the runner apply it on the
  same tick. In maintenance there is no next stage: `protocol.current` reports
  `canAdvance: false`, and the call is refused.

Neither can bring back an earlier stage.

### 6. API and MCP

- `protocol.current`: the protocol, each stage with resolved water (runs,
  length, days), light, feed, checks and its start date on the unit calendar;
  the current stage and day in it; hold; `canAdvance`; Then, with the
  first-harvest day; water `preset`, `schedule`, `edited` or `none`; the
  pods sown later, with `daysBehind`.
- `protocol.hold`, `protocol.release`, `protocol.advance`, `protocol.setThen`.
- `schedules.library.list|create|update|delete|activate`.
- `stageDiff(from, to)` in `src/care/protocol.ts`, shared by the UI and
  notices: "Watering goes from once a week to once a day, 15 → 10 min".
- MCP: `grow_protocol` (read), `hold_protocol`, `advance_protocol`,
  `set_protocol_then`, `list_schedule_library`, `activate_schedule`. These
  change watering the way `upsert_schedule` already does; none drives the pump
  directly (ADR 0029).

## Alternatives considered

- **Keep five presets plus the toggle.** Rejected: it hides the order, the
  next step and the end.
- **User-authored protocols now.** Deferred. The model allows them (stages are
  data), but each stage's feed and checks must cite `knowledge/`, and a person
  can't cite one in an editor yet.
- **Per-pod protocols.** Deferred. One pump waters every pod, so watering is
  per tower anyway; per-pod would only change feed and checks. The same model
  applies per pod later.
- **Store the active schedule.** Rejected: it would drift from the live
  cycles the moment someone edits one. Deriving it can't be wrong.
- **A fixed protocol length, then an automatic switch.** Rejected: the
  knowledge note gives mature no end, greens and fruiting crops reach harvest
  weeks apart, and a schedule change nobody chose on day 43 is the hidden mode
  this ADR removes.
- **Per-pod sowing days in v1.** Deferred with per-pod protocols: one pump
  can't water two ages differently, so v1 shows the gap (`daysBehind`)
  instead.

## Consequences

- Upgrading needs no data rewrite. A tower on a preset as written is on the
  protocol at that stage; one on its own cycles is on the protocol with water
  `edited`, untouched, exactly as `followGrowCycle` treats it today.
- Then defaults to `stay`: a grow stays in maintenance until someone chooses
  otherwise.
- One new table (`schedule_library`), eight columns on `grow_cycles` and one
  on `device_settings` (migration 0018). Backups carry them (ADR 0021).
- A new knowledge note, `knowledge/plants/germination.md`, from Gardyn's
  germination tips.
- The Water page's preset picker becomes the Grow page's protocol track and
  Your schedules (UI in its own PR).

## Implementation

- Protocols, the runner (`runProtocol`), Hold, Advance, Then and `stageDiff`:
  `src/care/protocol.ts`, called from `CareEngine.tick` in place of
  `followGrowCycle`. The engine also reruns on a `grow` mutation, so Advance
  takes effect at once. The preset moves themselves stay in
  `src/care/follow.ts`.
- Your schedules, activation and the derived active entry:
  `src/care/library.ts`. Both read the store once per request or tick
  through `src/care/tower.ts`.
- Store: `GrowCycle` protocol fields, `store.grow.setProtocol`,
  `store.scheduleLibrary.*`, in MemoryStore and SqliteStore with conformance
  tests; migration 0018 (`grow_protocols`).
- API: `src/server/routers/protocol.ts` (`/protocol`, `/protocol/hold`,
  `/protocol/release`, `/protocol/advance`, `/protocol/then`); `library` under
  `src/server/routers/schedules.ts` (`/schedules/library`).
- MCP tools in `src/mcp/server.ts`.
- Tests: `src/care/tests/protocol.test.ts`; `follow.test.ts` keeps the
  watering-move cases, now through the runner.
