---
type: "Decision record"
title: "ADR 0030: Grow protocols"
description: "The watering presets become one grow protocol per tower: an ordered sequence of stages, each setting water, light, feed and checks with citations, run from the sowing day with Hold and Advance, and ending in a Then chosen up front (keep the last stage, switch to one of your schedules, or ask). A small library of your own schedules sits beside it, one active once the protocol is done. The runner generalises Follow the grow cycle and keeps its rules: forward only, and never over a schedule someone edited."
status: "draft"
generated: {"by": "claude/opus-5.5", "at": "2026-11-11T12:00:00+00:00"}
sources: [{"resource": "/adr/0029-care-engine-and-agent-boundary.md", "title": "ADR 0029: Care engine and agent boundary"}, {"resource": "/adr/0024-pod-planner.md", "title": "ADR 0024: Pod planner and Gardyn plant catalog"}, {"resource": "/adr/0015-event-bus.md", "title": "ADR 0015: Event bus and mutation broadcast"}, {"resource": "https://github.com/seedypod/core/blob/dev/knowledge/watering/schedules.md", "title": "Knowledge: Watering schedules"}, {"resource": "https://github.com/seedypod/core/blob/dev/knowledge/nutrients/gardyn-feeding-guidance.md", "title": "Knowledge: Gardyn feeding guidance"}]
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
| `from`, `to` | Protocol days, inclusive. The last stage's `to` is `null`: open-ended |
| `water` | A pump preset id (`PumpPresetId`) |
| `light` | A light preset id (`LIGHT_PRESETS`) or `unchanged` |
| `feed` | Guidance text with its `Citation` |
| `checks[]` | Items to look at, each with its `Citation` |
| `rationale`, `citation` | Why this stage, and the note it comes from |

Two built-in protocols in v1, chosen by the planted crops the way
`recommendedPreset` chooses today:

- **Greens & herbs**: germination 0–7 → seedlings 8–13 → young 14–21 →
  mature 22 on.
- **Fruiting**: germination 0–7 → fruiting 8 on. Any planted fruiting crop
  picks it.

Every stage's `light` is `unchanged` in v1: Gardyn's 14–16 h guidance doesn't
change with the stage, so the protocol leaves the light curves alone. Feed
comes from the Plant food table (`CITE.plantFood`): plain water in
germination, the sprout dose once most yCubes have sprouted, ½ tsp per gallon
in early growth, 1 tsp mature and fruiting. Checks come from cited notes only
(roots, from "Judging a schedule"; tank at least half full; thinning and the
root check, as the grow reminders time them). A check with no note, such as
"domes on until sprouts", needs a `knowledge/` PR first, as ADR 0029 requires
for doses. The existing citation test covers protocols too.

**Where the protocol ends.** The knowledge note gives the last stage no end
("Day 22 on"), so neither does the code. The protocol's end for a tower is the
first-harvest day of its planted crops, from the catalog (`harvestMonths[0]`
at the planner's 30 days a month, ADR 0024), the latest across pods. With no
catalog crop planted there is no end day, and the track shows "ongoing".

### 2. The grow cycle carries the protocol's state

`grow_cycles` gains:

| Column | Meaning |
|---|---|
| `protocolId` | `null` until germination ends: chosen by the planted crops on each tick. Fixed when the first stage after germination is applied, so a tomato planted on day 30 doesn't move a greens tower to the fruiting track |
| `shiftDays` | Days added to days-since-sowing to get the protocol day. Advance and Release change it; `0` by default |
| `holdStageId`, `holdSince` | The held stage, or both `null` |
| `thenKind` | `keep`, `schedule` or `ask`; `ask` by default |
| `thenScheduleId` | The library schedule for `schedule` |
| `protocolEndedAt` | When Then was applied, or the protocol ended early. Set once |

**Protocol day** = days since sowing (on the unit's calendar, as today) +
`shiftDays`. The stage is the one whose `from`–`to` holds that day, or the held
stage while held. Stage start dates shown on the track are the sowing date +
`from` − `shiftDays`.

With no open grow cycle, the runner still runs as today: protocol by crops,
sown on the earliest pod's date, no hold, Then `ask`. Hold, Advance and Then
need an open cycle, and say so.

### 3. Your schedules

A small library, table `schedule_library`: `id`, `name`, `cycles` (JSON
`{ minute, durationS, days }[]`), optional `lightPresetId`, `createdAt`,
`updatedAt`, `lastUsedAt`. The built-in water presets are listed beside them,
read-only, so "go back to what the protocol did" is always one click; to change
one, duplicate it.

Activating a schedule writes its cycles as pump schedules `water-own-<id>-HHMM`
and removes the other pump cycles. If it names a light preset, it writes that
curve as `light-own-<id>` and turns the other enabled curves off (not deleted).
Activation is an explicit choice by a person, so unlike the runner it may
replace what is there.

**Active** is derived, not stored: the library entry or preset the live pump
cycles are, as written (the same matching as `appliedPreset` and
`followedPreset`). Once the protocol is done there is one active schedule, or
none if the cycles were edited by hand ("Edited", with "Save as schedule").
Activating while the protocol runs ends it early (`protocolEndedAt`), and the
UI says so before it does.

### 4. The runner

`src/care/protocol.ts` generalises `followGrowCycle` and replaces it in the
care engine's tick. Its rules are the ones that already hold:

- **Forward only.** Water moves from a stage to a later one (`advances`), never
  back. The stage reported is the later of the clock's stage and the stage
  whose water is on the pump, so the track never steps back after a later
  start date.
- **Only over its own writing.** A stage's water is applied only when the live
  pump cycles are still the previous stage's preset as written: all on, the
  preset's days and length (`followedPreset`). It never creates cycles where
  there are none. Edited cycles are left alone, and `protocol.current` reports
  water as `edited`. Light, when a stage sets it, follows the same rule
  against the curve the protocol wrote.
- **Germination's weekly run keeps to the sowing weekday**, as today.
- **At the end** (protocol day past the end day, once): `keep` leaves the last
  stage on; `schedule` activates the chosen schedule, but only over the last
  stage as written, else falls back to `ask`; `ask` keeps the last stage and
  raises alert `protocol_ended` in Needs you ("Greens & herbs finished on day
  43: keep Mature, or choose one of your schedules"). A deleted Then schedule
  also falls back to `ask`. `protocolEndedAt` is set either way.

Each move raises the existing `watering_followed` notice with the new cycles
and why, and emits `schedule` `changed` (ADR 0015), as today.

**`followGrowCycle`** keeps its column and now means "run the protocol". Off,
the schedules stay as they are: no stage moves, no Then. The library still
works by hand.

### 5. Hold and Advance

- **Hold** pins the current stage: `holdStageId` = it, `holdSince` = now. The
  clock keeps counting but the stage doesn't move.
- **Release** subtracts the whole days held from `shiftDays` and clears the
  hold, so the stage resumes where it was held and later stages start that
  many days later.
- **Advance now** adds to `shiftDays` whatever brings the protocol day to the
  next stage's `from`, clears any hold, and lets the runner apply it on the
  same tick. On the last stage it ends the protocol: Then applies now.

Both are forward-only by construction: neither can bring back an earlier
stage.

### 6. API and MCP

- `protocol.current`: the protocol, each stage with resolved water (runs,
  length, days), light, feed, checks and its start date on the unit calendar;
  the current stage and day in it; the end day; hold; Then; water `protocol`
  or `edited`; whether it has ended.
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
- **A fixed protocol length.** Rejected: the knowledge note gives mature no
  end, and greens and fruiting crops reach harvest weeks apart.

## Consequences

- Upgrading needs no data rewrite. A tower on a preset as written is on the
  protocol at that stage; one on its own cycles is on the protocol with water
  `edited`, untouched, exactly as `followGrowCycle` treats it today.
- Then defaults to `ask`, so no grow ends in a schedule change nobody chose.
- One new table (`schedule_library`) and six columns on `grow_cycles`
  (migration 0018). Backups carry both (ADR 0021).
- The Water page's preset picker becomes the Grow page's protocol track and
  Your schedules (UI in its own PR).

## Implementation

- Protocols and `stageDiff`: `src/care/protocol.ts`; runner in the same file,
  called from `CareEngine.tick` in place of `followGrowCycle`.
- Store: `GrowCycle` protocol fields, `store.grow.setProtocol`,
  `store.scheduleLibrary.*`, in MemoryStore and SqliteStore with conformance
  tests; migration 0018.
- API: `src/server/routers/protocol.ts`; `library` under
  `src/server/routers/schedules.ts`.
- Tests: `src/care/tests/protocol.test.ts`; the follow tests move there.
