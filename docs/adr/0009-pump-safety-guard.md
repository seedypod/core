---
type: "Decision record"
title: "ADR 0009: Pump safety guard and latched faults"
description: "Pump duty clamp, bounded runs, dry-run interlock, over-temp cutoff and latched faults."
status: "stable"
generated: {"by": "claude/fable-5.1", "at": "2026-10-31T04:40:00+00:00"}
sources: [{"resource": "https://github.com/sleepypod/core", "title": "sleepypod/core (conventions and ADR precedents)"}, {"resource": "https://github.com/iot-root/garden-of-eden", "title": "iot-root/garden-of-eden (reference implementation, GPL-3; no code copied)"}, {"resource": "https://github.com/sleepypod/core/blob/dev/docs/adr/0022-pump-stall-safety.md", "title": "sleepypod ADR 0022 pump stall safety"}]
---

# ADR 0009: Pump safety guard and latched faults

**Status:** Accepted
**Date:** 2026-10-30

## Context

The pump is the one actuator that can damage the hardware: running dry burns
the pump, and Gardyn's board browns out above ~30 % duty. garden-of-eden's
issue tracker documents every way its scattered checks were bypassed (#108,
#109, #111, #114). sleepypod ADR-0022 established the model we want: detect,
fail safe by de-energising, stay off until a human acknowledges, auto-recovery
only as an explicit opt-in.

## Decision

`hal_core::safety::PumpGuard` is the only path to the pump driver.

1. **Duty clamp** to `limits.pump_max_duty` (default 30 %).
2. **Bounded runs** — every start has a deadline ≤ `pump_max_run_s` (default
   900 s). There is no unbounded "on".
3. **Dry-run interlock** — refuse to start when the median of N ultrasonic
   samples ≥ `water_low_cm`; **fail safe**: if the interlock is configured and
   the sensor is unavailable, refuse.
4. **Over-temperature** — refuse to start and stop a running pump at
   `over_temp_c` (PCB sensor, default 36 °C).
5. **Latched faults** — a stop caused by (3) or (4) while running latches the
   pump off. `acknowledge` clears it; nothing else does. No auto-recovery.
6. **Stop always works**, latched or not.

The guard is pure and clock-injected; every rule has a unit test. `SimHal`
mirrors the same rules so the demo never shows behaviour the unit would refuse.

## Consequences

- Core, MCP, HA and the button cannot start the pump outside these rules.
- A dry tank produces a `pump_fault` alert plus `water_low`, and the UI/HA/MCP
  must acknowledge after refilling; this is deliberate friction.
- Dosing pumps (Phase 6.3) get their own guard with daily volume caps
  (ADR-0014).

**Authors**: @ng
