---
type: "Decision record"
title: "ADR 0014: Auto-dosing safety"
description: "Dosing pumps get their own guard with hard daily volume caps and lockouts; off by default."
status: "draft"
generated: {"by": "claude/fable-5.1", "at": "2026-10-31T06:30:00+00:00"}
sources: [{"resource": "https://github.com/sleepypod/core", "title": "sleepypod/core (conventions and ADR precedents)"}, {"resource": "https://github.com/iot-root/garden-of-eden", "title": "iot-root/garden-of-eden (reference implementation)"}]
---

# ADR 0014: Auto-dosing safety

**Status:** Proposed
**Date:** 2026-10-31

## Decision

Phase 6.3 adds peristaltic dosing (pH-down, nutrients A/B) as `dose_<n>`
actuators. Each passes through `hal_core::safety::DoseGuard`: per-dose volume
cap, hard daily volume cap, minimum interval between doses, lockout after N
doses without a measured response, and a latched fault on any sensor loss.
Dosing is disabled by default and enabled per pump in `hal.toml`; the core
controller (target bands with hysteresis) is a later phase and also defaults
off.

## Consequences

- No dosing ever happens from a schedule alone; a measured pH/EC is required.
