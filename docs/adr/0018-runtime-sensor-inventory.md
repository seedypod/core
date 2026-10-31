---
type: "Decision record"
title: "ADR 0018: Runtime sensor inventory"
description: "Probes are added from the app through SensorKind descriptors; app-added sensors live in a state-dir overlay and go live without restarting hald."
status: "stable"
generated: {"by": "claude/opus-5.5", "at": "2026-10-31T08:30:00+00:00"}
sources: [{"resource": "/adr/0004-two-tier-hal-core.md", "title": "ADR 0004: Two tiers — hardware daemon and core"}, {"resource": "/adr/0007-hal-contract.md", "title": "ADR 0007: HAL contract v1"}, {"resource": "/hardware/hal.md", "title": "hald reference"}]
---

# ADR 0018: Runtime sensor inventory

**Status:** Accepted
**Date:** 2026-10-31

## Context

Adding a probe such as an Atlas EZO pH circuit meant hand-editing
`/etc/seedypod/hal.toml` and restarting `hald`. That edit has a trap: any
`[[sensor]]` table replaces the whole stock list, including the water ranger
the dry-run interlock depends on. `hald` cannot write `/etc/seedypod` under
`ProtectSystem=strict`, it read its config once, a sensor that failed to probe
silently vanished, and the UI hard-coded which quantities it showed. Future
probes (dissolved oxygen, ORP, other vendors) should not need UI work.

## Decision

- **Sensor kinds are an interface.** `hald::kinds::SensorKind` describes a kind:
  label, description, the quantities it reports, its bus and default address,
  and its calibration steps. It also builds the simulated or real driver,
  already probed. Its serialised form, `DeviceKindInfo`, is published, so the
  UI, the MCP server and the simulator render any kind without per-kind code.
  Today: EZO pH (0x63), EC (0x64) and RTD (0x66).
  `hal/contract/fixtures/device_kinds.json` is checked against the
  implementations, and core's simulator imports it.
- **Two sources.** `hal.toml` defines the built-in (`config`) sensors. Sensors
  added from the app (`user`) live in `<state_dir>/sensors.json`, which is
  appended to the configured list, so it never trips the replace-stock rule. A
  bad overlay is ignored with a warning and never stops `hald` from starting.
- **Live apply.** `devices/set` adds or removes a user sensor in the running
  registry and republishes `system`, Home Assistant discovery and the retained
  `devices` inventory. A removed sensor's HA entity is deleted with an empty
  retained config. `devices/result` answers each request by `requestId`.
- **Guard rails.** An add is refused when:
  - the kind isn't addable;
  - the address is outside 0x08–0x77 or already in use;
  - the quantity is already installed;
  - the probe doesn't answer.

  Removing a built-in sensor is always refused. The inventory reports sensors
  that failed to probe at boot as `absent`, with the reason.
- **Human-only.** Agents get `list_devices` and `seedypod://devices`
  (read-only). Adding, removing and calibrating probes need a person at the
  unit, so they're available only in the app and the REST API.

## Consequences

- A new probe type needs one `SensorKind` implementation, a `SensorId` if it
  measures a new quantity, and a regenerated fixture
  (`SEEDYPOD_WRITE_FIXTURES=1 cargo test`). The add dialog and the calibration
  wizard pick it up automatically.
- `hal.toml` stays the place for built-in parts. Explicit `[[sensor]]` tables
  still replace the stock list; that behaviour is documented, not changed.
