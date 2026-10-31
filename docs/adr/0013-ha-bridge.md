---
type: "Decision record"
title: "ADR 0013: Core-level MQTT bridge for Home Assistant"
description: "An additive MQTT client for grow reminders, cycle state, light hours and a bounded water button; the daemon already publishes the physical entities."
status: "stable"
generated: {"by": "claude/fable-5.1", "at": "2026-10-31T06:30:00+00:00"}
sources: [{"resource": "https://github.com/sleepypod/core", "title": "sleepypod/core (conventions and ADR precedents)"}]
---

# ADR 0013: Core-level MQTT bridge for Home Assistant

**Status:** Accepted
**Date:** 2026-10-31

## Context

`hald` publishes Home Assistant discovery for everything physical (ADR-0007),
so HA works with no core at all. What HA cannot see from the daemon is what
only core knows: the grow cycle, reminders, light hours.

## Decision

`src/mqtt/bridge.ts` is an in-process MQTT client on the operator's broker
(sleepypod ADR 0019 shape): dormant until `settings.mqttUrl`, LWT on
`seedypod/<unit>/core/availability`, TLS opt-in with a separate
`mqttTlsInsecure` flag, reconnects on settings change. It publishes retained
discovery for reminder `binary_sensor`s with `button`s to mark them done,
grow day/stage and light-hour `sensor`s, and a "water now" `button` whose
press runs a bounded pump cycle through the HAL (refusals surface via the
daemon's own alert entities).

## Consequences

- Two discovery sources, one HA device (shared `identifiers`).
- Core never republishes the daemon's entities; no duplication, no drift.
