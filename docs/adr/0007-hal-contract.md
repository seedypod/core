---
type: "Decision record"
title: "ADR 0007: HAL contract v1 — MQTT + HTTP, versioned JSON, HA discovery from the HAL"
description: "MQTT topic tree, payload schemas, HTTP endpoints and HA discovery published by hald."
status: "stable"
generated: {"by": "claude/fable-5.1", "at": "2026-10-31T04:40:00+00:00"}
sources: [{"resource": "https://github.com/sleepypod/core", "title": "sleepypod/core (conventions and ADR precedents)"}, {"resource": "https://github.com/iot-root/garden-of-eden", "title": "iot-root/garden-of-eden (reference implementation, GPL-3; no code copied)"}]
---

# ADR 0007: HAL contract v1 — MQTT + HTTP, versioned JSON, HA discovery from the HAL

**Status:** Accepted
**Date:** 2026-10-30

## Context

Core and `hald` are separate processes, possibly on separate machines
(ADR-0004). The interface between them must be small, stable, discoverable, and
usable by Home Assistant with no core present.

## Decision

Prefix `seedypod/<unit-id>/`. Payloads JSON, SI units, RFC 3339 timestamps.
`unit-id` is derived from the Pi serial (never a shared default).

| Topic | Dir | Retained | Payload |
|---|---|---|---|
| `availability` | hald→ | yes | `online` / `offline` (LWT) |
| `system` | hald→ | yes | `SystemInfo` — model, version, `caps`, `limits` |
| `sensor/<id>` | hald→ | no | `Reading {ts, value, unit, quality}` |
| `actuator/<id>/state` | hald→ | yes | `ActuatorState {on, level, since, fault, remainingS}` |
| `actuator/<id>/set` | →hald | — | `ActuatorCommand {on?, level?, durationS?}`; hald clamps or refuses |
| `event/button` | hald→ | no | `{press: single∣double∣long}` |
| `alert/<kind>` | hald→ | yes | `Alert {kind, active, ts, detail}` |
| `alert/<kind>/ack` | →hald | — | `{}` clears a latched fault |
| HTTP `GET /health`, `/system`, `/camera/{upper∣lower}.jpg` | | | |

Home Assistant discovery (`homeassistant/<component>/<unit-id>_<id>/config`,
retained) is published by `hald` itself: light, pump as `fan` with percentage,
sensors with `device_class`, `binary_sensor` water_low, `event` for the button.

The typed contract lives twice — `hal/crates/hal-core/src/contract.rs` and
`src/hardware/contract.ts` — and `hal/contract/fixtures/*.json` are golden
samples both test suites must parse. The version is a field in `system`.

## Consequences

- Core's `MqttHalClient` (Phase 3.1) and `SimHal` implement the same
  `HalClient` interface; nothing above it knows which is live.
- Adding a sensor (pH, EC, water temperature) is a new `SensorId`, a fixture,
  and a driver — no topic changes.

**Authors**: @ng
