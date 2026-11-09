---
type: "Decision record"
title: "ADR 0023: HomeKit bridge and per-unit identity"
description: "An embedded hap-nodejs bridge, off by default, exposes the grow light, the pump and the sensors to Apple Home through core's own tRPC caller, with a HomeKit identity derived per unit as in sleepypod ADR 0020."
status: "stable"
generated: {"by": "claude/opus-5.5", "at": "2026-11-01T19:00:00+00:00"}
sources: [{"resource": "https://github.com/sleepypod/core/blob/dev/docs/adr/0020-homekit-identity-derivation.md", "title": "sleepypod ADR 0020: Deterministic HomeKit identity derivation"}, {"resource": "https://github.com/sleepypod/core/pull/578", "title": "sleepypod PR #578: stranded-bridge rotation and the ciao advertiser"}, {"resource": "https://github.com/sleepypod/core/pull/718", "title": "sleepypod PR #718: unpublish, not destroy, on shutdown"}, {"resource": "https://github.com/homebridge/HAP-NodeJS", "title": "HAP-NodeJS"}, {"resource": "/adr/0012-deployment-and-trust.md", "title": "ADR 0012: Deployment and trust model"}, {"resource": "/adr/0020-autopilot-reactive-automations.md", "title": "ADR 0020: Autopilot (light arbiter)"}, {"resource": "/adr/0021-sd-card-wear-and-recovery.md", "title": "ADR 0021: SD card wear and fast recovery"}]
---

# ADR 0023: HomeKit bridge and per-unit identity

**Status:** Accepted
**Date:** 2026-11-01

## Context

Plan item 5.2 asks for HomeKit: the light as a Lightbulb, the pump as a
Switch, and the sensors, reusing [sleepypod](https://sleepypod.github.io/core/integrations/)'s identity derivation. sleepypod
embeds a hap-nodejs bridge in its server (`src/homekit/`). It took several PRs
of field fixes to get right, and those lessons carry over:

- **Identity is the durable part** (sleepypod ADR 0020). iOS keys accessories,
  rooms, scenes and automations on the bridge's MAC-style `username`. Losing it
  orphans all of them. Losing only the pairing files means scanning the QR
  again.
- **`destroy()` is a factory reset.** It deletes the pairing keys and
  accessory ids. Shutdown must call `unpublish()` (sleepypod PR #718).
- **iOS can remove the bridge without telling the app.** Home sends the
  removal straight to the HAP server. Republishing the same `username` then
  meets iOS's cached keys: every tile reads "No Response" and pairing again is
  refused (sleepypod PRs #566 and #578).
- **mDNS.** hap-nodejs's avahi-over-D-Bus advertiser registered but never
  published on the Pod's avahi build. sleepypod switched to ciao, which
  coexists with `avahi-daemon` on port 5353.

seedypod differs in four ways that matter here:

- The unit is a Pi Zero W: ARMv6, one core, 512 MB.
- Every actuator command must pass the safety layer (AGENTS.md), and the light
  has one owner, the arbiter (ADR 0020).
- Core can run on a LAN box instead of the unit's Pi.
- A backup restores a unit onto a new card (ADR 0021).

## Decision

### An embedded bridge, off by default

`src/homekit/` holds one HAP bridge with three accessories. It is off until the
owner turns it on under **Settings → Apple Home**. That switch is
`device_settings.homekitEnabled`, and only `homekit.setEnabled` changes it,
after the bridge has started. A failed start leaves it off. The generic
settings form can't set it.

Off costs nothing. hap-nodejs and `qrcode` are loaded with dynamic `import()`
on the first start. The accessory modules get the hap-nodejs module passed in
instead of importing it, because the server bundle (`esbuild
--packages=external`) hoists static imports of external packages to the top
and would load hap-nodejs at boot. Loaded, hap-nodejs adds about 19 MB RSS and
7 MB of heap (measured on macOS arm64).

All dependencies are pure JavaScript, so ARMv6 is fine: hap-nodejs 1.2.0
(engines `^18 || ^20 || ^22`), `@homebridge/ciao`, `@homebridge/dbus-native`,
`bonjour-hap`, `fast-srp-hap`, `tweetnacl`, `node-persist` and `qrcode`. None
has a `binding.gyp`, a prebuilt `.node` file or an install script.

### Accessories go through core's tRPC caller

The accessories write through `createCallerFactory(appRouter)(ctx)`, the same
procedures the app calls. They never touch the HAL client or MQTT directly.

| HomeKit | Characteristics | Core |
|---|---|---|
| **Grow light**: Lightbulb | On, Brightness 0–100 | `light.set`. A change from Home is a manual change, like one on the Light page. It holds over Autopilot and the schedule for 30 minutes, then the arbiter hands the light back. The tile follows actuator events, so it moves when the hold ends. Turning the light on with a brightness arrives as two writes, which are merged into one `light.set`. |
| **Pump**: Switch | On | On calls `pump.runOnce` with 300 s, the Water page's default, and hald clamps it to `pumpMaxRunS`. Off calls `pump.stop`. When the HAL refuses (dry tank, over-temperature, a latched fault), or returns a state that isn't running, the switch reads off and the write fails with HAP's "not allowed in current state". The switch flips off when the run ends. |
| **Sensors**: TemperatureSensor | CurrentTemperature, StatusFault | `air_temp` (°C). StatusFault is set when the reading isn't `good` quality. |
| **Sensors**: HumiditySensor | CurrentRelativeHumidity, StatusFault | `humidity`. |
| **Sensors**: Battery ("Water tank") | BatteryLevel, StatusLowBattery, ChargingState | BatteryLevel is `water_level_pct`. StatusLowBattery is hald's `water_low` alert. ChargingState is not chargeable. |
| **Sensors**: OccupancySensor ("Tank low") | OccupancyDetected | hald's `water_low` alert (amendment 2026-11-08). |

While hald is offline, reads answer "No Response" rather than a stale value.

**Why the tank is a Battery service.** Battery is the one HomeKit service
that carries a 0–100 level and a low flag, so the owner gets both the percent
full and the "refill" state. Home lists a low one in its status summary, with
no alarm. The alternatives were rejected:

- A **Leak sensor** raises a critical "Leak detected" alert that can break
  through Do Not Disturb. A low tank is the opposite of a leak.
- A **Contact sensor** reduces the tank to Open/Closed with labels that don't
  fit, and it loses the level.

The Battery service sits on the same accessory as the temperature and humidity
sensors, so Home always has a primary service to show.

The set is deliberately small. Dosing pumps and pH/EC have no HomeKit
service that doesn't misrepresent them, and dosing has its own safety design
(ADR 0014).

### Identity: sleepypod ADR 0020, with a seedypod seed chain

HKDF-SHA256 over a per-unit seed, with salt `seedypod-homekit-v1`, derives:

- `username`: 6 bytes, locally administered, unicast.
- The setup code: 8 digits. HAP's banned codes are rejected, with a bounded
  retry.
- The setup id: 4 characters.

All three come from the seed and a rotation counter. They are cached in
`$DATA_DIR/homekit/identity.json` (mode 0600, directory 0700). No unit uses a
shared default code.

| Order | Seed | Why |
|---|---|---|
| 1 | `hal-unit-id`: the `unitId` hald reports | Follows the tower even when core runs on a LAN box. By default it is `gardyn-<Pi serial>`, so it survives a reinstall and a new SD card. The simulators' ids and `gardyn-unknown` don't count, since they are the same on every machine. |
| 2 | `pi-serial`: `/proc/cpuinfo` `Serial`, written as `gardyn-<serial>` exactly as `hald/src/identity.rs` writes it | Core on the unit's Pi derives the same seed whether or not hald has reported yet. |
| 3 | `machine-id`: `/etc/machine-id` | A LAN box that isn't a Pi. It doesn't survive a reinstall. |
| 4 | `random` | Dev machines and the simulator. It is cached in `identity.json` like the others. |

sleepypod reads the eMMC CID first. On a Pi, `mmcblk0`'s CID is the SD card's
serial, so a card swap would re-key the unit. That is why the Pi serial
replaces it.

The first start waits up to 10 s for hald to report, so the preferred seed is
used. `GET /api/homekit/seed-probe` shows which seed the unit resolves to,
without the seed or any code.

**Confidentiality.** None of the seeds is secret: the unit id is in hald's
mDNS TXT record. The code isn't secret either: any LAN client can read it from
`GET /api/homekit`, under the LAN-only trust model (ADR 0012). The
derivation gives uniqueness and stability, not secrecy. What protects the
unit is that HAP accepts a new pairing only while the bridge is unpaired, and
it is unpaired only between the owner turning HomeKit on and adding it in
Home. Logs carry the `username` and the seed source, never the code or setup
id.

**Rotation.** Three things rotate the identity. Each one clears the old
pairing files first and bumps `rotation`, so the username, code and QR all
change:

- **Settings → Reset pairing.**
- **The last controller removes the bridge in Home.** hap-nodejs's `unpaired`
  event triggers it, a second after Home's request is answered.
- **A start that finds the bridge stranded.** `identity.json` says
  `wasPaired`, which is written on hap-nodejs's `paired` event or on a boot
  that finds pairings, but there are none on disk.

[sleepypod](https://sleepypod.github.io/core/settings/homekit/) polled every 30 s for the `wasPaired` marker. seedypod uses the
events instead. seedypod has no identities from before ADR 0020, so
sleepypod's legacy-migration branch isn't ported.

### mDNS: ciao, as in sleepypod

The default advertiser is **ciao**, hap-nodejs's in-process responder:

- It is sleepypod's final choice. Its avahi D-Bus path silently failed in the
  field.
- It needs no D-Bus access or daemon configuration.
- It runs the same under `pnpm dev:sim` on macOS and in CI.
- It follows hald's own pattern: hald's `mdns-sd` responder is also in-process
  and coexists with Raspberry Pi OS's `avahi-daemon` on 5353 through
  `SO_REUSEPORT`.

ciao's service hostname comes from the bridge name (`<unit name>-XXXX.local`),
so it doesn't fight avahi for the Pi's own hostname.

Overrides:

- `HOMEKIT_ADVERTISER=avahi|bonjour-hap|resolved` uses another advertiser.
  avahi offloads mDNS parsing to the daemon that's already running, which is
  worth trying if ciao's CPU use shows on a single-core Pi Zero.
- `HOMEKIT_BIND=wlan0` pins the bind interface. sleepypod needed this on its
  kernel, where ciao's multicast didn't leave `wlan0` unbound.
- `HOMEKIT_PORT` sets the HAP port. The default is 51827.

### Backups carry HomeKit

`$DATA_DIR/homekit/*.json` goes into the backup bundle as `homekit/` (ADR
0021): `identity.json`, plus hap-nodejs's `AccessoryInfo.<MAC>.json` and
`IdentifierCache.<MAC>.json`. The restore helper swaps the directory as one
item, so undo works, and only when the bundle has it. A restore onto the same
unit therefore comes back paired, with the same accessory ids, and Home's
automations keep working.

The bundle already holds secrets, the bucket keys and the MQTT password.
HomeKit's long-term keys join them under the same warning.

Restoring onto a *different* unit moves the HomeKit identity with it, the same
way a restored `hal.toml` moves `unit_id`. That is right when the old unit is
dead. Don't run both at once. **Reset pairing** gives the new one its own
identity.

## Consequences

- Home can switch the light and run the pump, under the same arbiter and HAL
  guard as the app. The HAL caps every pump run Home starts, and Home can't
  show a refused run as running.
- A unit that never turns HomeKit on loads nothing and writes nothing.
- A reinstall or card swap without a backup keeps the identity, so the owner
  scans the QR again and the automations stay. With a backup, the unit stays
  paired.
- Not verified on hardware in this change: discovery and pairing from an
  iPhone on a Pi Zero W, ciao's CPU use there, and whether `HOMEKIT_BIND`
  is needed on Raspberry Pi OS. The HAP flow itself was checked end to end on
  the simulator with a HAP controller: the wrong code is refused, the derived
  one pairs, writes reach the light and pump, pairings survive a restart, and
  a removal rotates the identity.

## Amendment (2026-11-08): a "Tank low" sensor next to the battery

Home shows a Battery service's level only in the accessory's details. A low
battery appears in the status summary as "Low battery". Owners couldn't find
the tank (#136). The Sensors accessory now also carries an **Occupancy
sensor**, "Tank low": OccupancyDetected follows hald's `water_low` alert, the
same flag as StatusLowBattery, and updates from the alert event. Home shows it
as its own row that reads "Detected" or "Not Detected", and the owner can turn
on its notifications. The Battery service stays, so the percent full is still
in the details.

Occupancy was chosen because it is the binary sensor whose words fit a yes/no
and that raises no alarm:

- A **Leak sensor** stays rejected for the reason above: a critical alert for
  something that isn't a leak.
- A **Contact sensor** would read "Open" for a low tank.
- A **Humidity sensor** carrying the tank percent would show the level on a
  tile. But Home averages every humidity sensor in a room into its climate
  summary, so a full tank would read as 100 % humidity.

Home Assistant already had both entities from hald's discovery (ADR 0007):
`sensor.<unit>_water_level` (`%`, `state_class: measurement`) on
`seedypod/<unit>/sensor/water_level_pct`, and `binary_sensor.<unit>_water_low`
(`device_class: problem`) on the `water_low` alert topic. Core doesn't publish
them again (ADR 0013).
