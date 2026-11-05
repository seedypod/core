---
type: "Decision record"
title: "ADR 0025: Accessory sensor nodes"
description: "Add-on probes live on a separate sensors-only hald outside the unit, which names its parent unit and which core merges into that unit behind HalClient. First use: an external pH probe."
status: "draft"
generated: {"by": "claude/opus-5.5", "at": "2026-11-05T00:00:00+00:00"}
sources: [{"resource": "/adr/0004-two-tier-hal-core.md", "title": "ADR 0004: Two tiers — a hardware daemon and a core"}, {"resource": "/adr/0007-hal-contract.md", "title": "ADR 0007: HAL contract v1"}, {"resource": "/adr/0012-deployment-and-trust.md", "title": "ADR 0012: Deployment and trust model"}, {"resource": "/adr/0014-auto-dosing-safety.md", "title": "ADR 0014: Auto-dosing safety"}, {"resource": "/adr/0018-runtime-sensor-inventory.md", "title": "ADR 0018: Runtime sensor inventory"}, {"resource": "/hardware/hal.md", "title": "hald reference"}]
---

# ADR 0025: Accessory sensor nodes

**Status:** Proposed
**Date:** 2026-11-05

## Context

Taking a Gardyn apart showed that its Pi Zero is soldered to the carrier board.
ADR-0018 and the [Adding a probe](../SENSORS.md) guide assume you can reach the
Pi's 3.3 V, GND, SDA and SCL. On this unit that means soldering onto a board
that sits next to the water, and then routing wires out through the housing.

The probes don't need to be on that Pi. Light, pump, water level, button and
cameras are wired to the carrier and stay there, but an EZO pH circuit only
needs a bus and a network. ADR-0004 already separates hardware from core, and
ADR-0007 is network-transparent. What's missing is a way for two daemons to
appear as one unit, and four things stand in the way today:

- `hald` can't run sensors-only. `Config::actuators()` falls back to light and
  pump when no `[[actuator]]` table is present, so a bare Pi would claim GPIO18
  and GPIO24 and advertise a pump it doesn't have.
- Core binds to one unit. `createHal` takes one `HAL_UNIT_ID`.
  [hald reference](../hardware/hal.md) says core discovers units over mDNS, but
  core has no `_seedypod-hal._tcp` browser.
- `MqttHalClient` keeps the last value of every sensor when a daemon goes
  offline. `sensor/<id>` isn't retained, so nothing replaces it. That's
  tolerable when the daemon and core share a Pi. It isn't for a box on Wi-Fi.
- The broker listens on 127.0.0.1:1883 by default. Only `--mqtt-lan` opens
  port 1884, and its single user is `homeassistant`.

## Decision

**An accessory is a second `hald` that has only sensors and names its parent
unit.** It speaks the existing contract to the parent's broker. Core merges it
into the parent behind `HalClient`, so nothing above that interface changes.
First use: one Atlas EZO-pH circuit.

### The node

- A new top-level `hal.toml` key, `role = "unit" | "accessory"`, defaulting to
  `unit`. A new key, `parent`, holds the parent's `unit-id` and is required
  when the role is `accessory`.
- `role = "accessory"` builds no stock devices: no stock sensors, actuators or
  cameras. `hald --check` rejects `[[actuator]]`, `[[camera]]` and
  `[dosing] enabled = true` under this role, and rejects an accessory with no
  `[[sensor]]`.
- Probes are declared in the accessory's `hal.toml`. They're built-in parts of
  that box, which is what ADR-0018 keeps `hal.toml` for.

```toml
role = "accessory"
parent = "gardyn-abc123"
mqtt_url = "mqtt://seedypod.local:1884"
mqtt_username = "accessory"
mqtt_password = "…"

[[sensor]]
kind = "ezo_ph"
addr = 0x63
```

### The contract

`SystemInfo` gains optional `role` and `parent`, the same additive way `board`
was added. The contract version stays 1: an older core ignores both fields and
an older `hald` omits them. No topics change. Fixtures come first, per
AGENTS.md.

### Core

- Core subscribes to `seedypod/+/system`. A retained `system` whose `parent`
  equals `HAL_UNIT_ID` creates an `MqttHalClient` for that unit on the existing
  connection. Accessories bind at runtime with no change to core's config, so
  this doesn't need the mDNS browser. Correct the line in the hald reference
  when this lands.
- `CompositeHal implements HalClient` wraps the parent and its accessories, and
  `createHal` returns it. `SimHal` stays as it is.

| `HalClient` surface | Behaviour |
|---|---|
| `snapshot().sensors`, `caps.sensors` | Union of the parent and online accessories |
| `snapshot().devices` | Concatenated; accessory probes are `source: config`, so the app offers no Remove |
| `snapshot().online`, `system`, `actuators`, `alerts` | The parent only |
| `calibrate(id)` | Routed to the node that owns `id` |
| `setActuator`, `acknowledgeAlert`, `captureStill`, `addSensor`, `removeSensor` | The parent |
| `availability` and `system` events from an accessory | Not forwarded; they update the merge |

- **`SensorId` stays unique per unit.** If two nodes report the same id, the
  parent wins and the accessory's copy is dropped with a warning. `addSensor`
  on the parent refuses a quantity an accessory already provides, extending the
  ADR-0018 guard across nodes.
- **An offline accessory leaves the snapshot.** When its `availability` goes
  `offline`, through the LWT or otherwise, its sensors are removed from the
  merge and its inventory rows report `absent`. A stale pH must not keep
  showing as current or feed Autopilot. Readings return with the next publish.

### The broker

The parent needs `--mqtt-lan`. Accessories get their own user in the password
file instead of reusing `homeassistant`, so one can be revoked alone. With
Home Assistant's broker (`--no-broker`), both daemons point at it and nothing
else changes. Port 1884 is plain TCP, so readings and that password travel the
LAN in the clear, which is the ADR-0012 trust model and the same exposure HA
has today.

### Safety

Accessories are sensors-only, enforced by `hald --check` rather than by
convention. No guard on the parent depends on one: `PumpGuard` and the dry-run
interlock use the parent's own water ranger, and nothing on the pump path reads
an accessory. Losing the node costs pH readings and nothing else.

Dosing is out of scope. ADR-0014 stays proposed, and dosing from a node would
need a new decision: its interlocks would have to cross the network and fail
safe when the parent is unreachable.

### Hardware

A Raspberry Pi Zero 2 W, with an EZO-pH on an Atlas electrically isolated
carrier, in a small enclosure outside the unit and above the water line, on its
own USB supply. Only the probe's lead goes into the reservoir. The Pi runs the
same `hald` build, so the EZO driver, the calibration flow and HA discovery are
reused with no new driver work. The isolated carrier isn't strictly needed for
pH alone, but EC later would need it (implementation plan 6.2).

## Alternatives considered

- **Wire the probe to the unit's Pi.** Rejected for the reasons in Context.
- **Have the box call core's tRPC API.** Rejected. tRPC is core's surface for
  clients. Writing through it would skip the contract, leave Home Assistant
  without the probe when core is down, and give core a second hardware path
  with its own calibration and inventory handling.
- **ESP32 firmware speaking the contract.** Sturdier (no SD card, instant boot)
  and cheaper, but it means rewriting the EZO driver, calibration and contract
  publishing in firmware for one probe. The contract is the seam, so an ESP32
  can replace the Pi later without changes to core, as long as it sets its own
  `unit-id` and publishes `role` and `parent`.
- **Arduino.** No network without an add-on board. Over USB or serial it needs
  a cable back into the unit, which is the problem being avoided.
- **ESPHome straight into Home Assistant.** Quick, but the reading never
  reaches core, so there's no history, calibration wizard or Autopilot signal.
- **Pair accessories in core's config** (`HAL_ACCESSORY_UNITS`). Simple, but it
  means editing a service file on the parent and restarting core. The accessory
  already has to be configured with the parent's broker, so `parent` goes in
  the same file.

## Consequences

### Positive

- Probes can be added to a unit without opening it, including units whose Pi
  can't be reached.
- pH appears on the home screen, in history, in Autopilot and in calibration
  through the existing paths, with no UI changes.
- The node works with Home Assistant alone, like any `hald`. It shows up as its
  own HA device; set `via_device` to link it to the parent.

### Negative

- A second Pi and SD card to install, update and power. `install-hal` covers
  the install, but nothing updates accessories from the parent.
- ADR-0021 backups run on the parent only. The EZO stores its own calibration,
  so rebuilding the box means reflashing and restoring one `hal.toml`.
- pH history has gaps whenever Wi-Fi or the parent's broker is down.
- App add and remove stay parent-only. Changing the accessory's probes means
  editing its `hal.toml`. `HalClient.addSensor` would need a target node to
  change that, which isn't worth it for one fixed probe.

### Not addressed

- **Temperature compensation.** The driver has
  `set_temperature_compensation`, but `hald` never calls it, so the circuit
  stays at its default temperature wherever it's mounted. It's a separate fix,
  and on an accessory the water temperature would have to come from an RTD on
  the same node.

## Unverified

Nothing here has run on real hardware:

- A route for the probe's lead into the reservoir, with the lid closed and the
  bulb clear of the pump inlet.
- Whether the running pump puts noise on the pH reading.
- Wi-Fi reliability at the box's location.

## Implementation order

1. Fixtures, then `role` and `parent` in `contract.rs` and `contract.ts`.
2. `hald`: the role, its `--check` rules, and no stock devices.
3. Core: `CompositeHal`, runtime binding, offline removal.
4. `pnpm test:sim-bringup` with a second `hald --sim` as the accessory: pH
   appears, calibrates, and leaves the snapshot when the process is killed.
5. `install-hal`: an accessory mode and a broker user. Update the Adding a
   probe guide and the hald reference.
6. Build the box, then mark this ADR accepted.
