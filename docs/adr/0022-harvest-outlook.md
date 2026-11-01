---
type: "Decision record"
title: "ADR 0022: Harvest outlook from the camera, with optional plant profiles"
description: "Each planted pod gets a harvest state (ready, soon, growing) led by camera leaf cover against a target and its rate of change; optional per-crop profiles add a window in days and their own target, and agents can fill them in over MCP."
status: "stable"
generated: {"by": "claude/opus-5.5", "at": "2026-11-01T06:54:02+00:00"}
sources: [{"resource": "/adr/0019-pluggable-capture-analysis.md", "title": "ADR 0019: Pluggable capture analysis"}, {"resource": "/adr/0011-mcp-and-mhs.md", "title": "ADR 0011: MCP and the Model Hardware Standard"}]
---

# ADR 0022: Harvest outlook from the camera, with optional plant profiles

**Status:** Accepted
**Date:** 2026-11-01

## Context

"Ready to harvest" was only ever a status someone set by hand on Grow. The
one timing signal was a cycle-wide reminder `harvestReminderDays` (default 35)
after the cycle starts, whatever is planted. The tower's 3D view sized plants
with a fixed 35-day curve. Nothing told you which pod to cut next, or when.

There are two sources of timing. The camera measures each pod's leaf cover
(the primary analyser's green fraction, ADR 0019) every capture, so it sees
the plant actually grow, but it says nothing about how big a given crop gets.
Horticultural knowledge says when a crop is usually ready (arugula 17–25 days,
kale 30–45), but it doesn't see this plant, and someone has to enter it for
74 kinds of yCube.

## Decision

1. **The camera leads.** For each planted pod, take its leaf cover since
   planting or since the last cut. Fit a least-squares rate over the last
   dozen photos (at least four, spanning a day). It's **ready** when cover
   reaches the target, or has levelled off (under 0.2 points a day for three
   days) within 75% of it; otherwise the rate gives days to the target, and
   **soon** means within a week. The default target is 40% cover.

2. **Profiles are optional.** A plant profile holds a harvest window in days
   from planting, a cover target and notes, keyed by the name in lower case.
   A pod matches by exact name, else the longest profile name whose words all
   appear in its plant name ("Kale" covers "Red Russian Kale"). The profile's
   target replaces the default; its window is shown on the timeline and decides
   the state only when there are no photos to go on.

3. **Agents can fill them in.** MCP gets `plant_profiles`,
   `set_plant_profiles` (marked `source: agent`), `remove_plant_profile`,
   `harvest_outlook` and `mark_harvested`. "Given my plants, fill in harvest
   windows" is one tool call after reading `pods`.

4. **A cut is recorded.** `mark_harvested` (and Home's Mark harvested button)
   sets the pod back to growing and stamps `lastHarvestAt`; only photos after
   it count, and the first window no longer applies, so a cut-and-come-again
   plant isn't called ready on the strength of the leaves just taken. Pods
   also stamp `statusSince` when their status changes, for "ready for 2 d".

5. **Read-only.** The outlook never changes a pod's status or raises alerts by
   itself. Autopilot rules (ADR 0020) can act on it later.

## Consequences

- Without photos and without a profile, a pod's outlook is honestly
  "unknown". The demo and any unit with a camera get estimates from day one.
- Leaf cover is a crude proxy: a trailing plant that leaves its crop, or a
  neighbour leaning in, skews it. The target is per crop for that reason, and
  a better analyser (ADR 0019) improves the outlook without changing it.
- One more table and two pod columns (migration 0008); existing pods get
  `statusSince` from `updatedAt`.
