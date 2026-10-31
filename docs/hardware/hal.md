---
type: "Reference"
title: "hald — the hardware daemon"
description: "Configuring, running and talking to hald: hal.toml, MQTT topics, Home Assistant entities, HTTP endpoints, state file, install and operations."
status: "draft"
generated: {"by": "claude/fable-5.1", "at": "2026-10-30T22:29:21-07:00"}
sources: [{"resource": "../adr/0007-hal-contract.md", "title": "ADR 0007: HAL contract v1 (topic table is authoritative)"}, {"resource": "../adr/0009-pump-safety-guard.md", "title": "ADR 0009: Pump safety guard and latched faults"}, {"resource": "./pin-map.md", "title": "Gardyn hardware map"}, {"resource": "https://www.home-assistant.io/integrations/mqtt/", "title": "Home Assistant MQTT integration (discovery payload keys)"}]
---

# hald — the hardware daemon

`hald` is the one process that owns the Gardyn's pins and buses (ADR-0004).
It publishes the HAL contract over MQTT, serves stills and a state snapshot
over HTTP, announces itself over mDNS, and advertises itself to Home Assistant
by MQTT discovery so HA works with no core at all. Every pump command, from
any surface, passes through `PumpGuard` (ADR-0009); every dosing command
through `DoseGuard`.

Source: `hal/` — `hal-core` (contract, traits, guards), `hal-drivers` (real
drivers behind the `hardware` cargo feature), `hal-sim` (fakes), `hald` (the
daemon).

## Running

```
hald [--config /etc/seedypod/hal.toml] [--sim] [--stdout] [--mqtt-url mqtt://host:1883]
hald --check                   # validate the config, print the planned capability set, exit 1 on errors
hald --print-default-config    # the commented hal.toml the installer writes
hald --sim --stdout --ticks 3  # smoke test: simulated hardware, publishes as JSON lines
```

| Flag / env | Meaning |
|---|---|
| `--config`, `HAL_CONFIG` | Path to `hal.toml`. Without it the stock Gardyn defaults apply. |
| `--sim`, `HAL_SIM` | Replace every driver with `hal-sim`; virtual time advances one telemetry interval per tick (`--time-scale` multiplies it). |
| `--stdout` | Print would-be publishes as `{"topic","payload","retain"}` lines instead of connecting to a broker. |
| `--mqtt-url`, `HAL_MQTT_URL` | Broker; overrides `mqtt_url` in the config. Default `mqtt://127.0.0.1:1883`. |
| `--ticks N` | Exit after N telemetry rounds (smoke tests). |
| `RUST_LOG` | Log filter (`info` default; logs go to stderr). |

Builds: `cargo build -p hald` is hardware-free (simulator only; what CI runs).
`cargo build -p hald --features hardware` links rppal and is what the release
binaries contain. A hardware build off a Pi starts, logs every device as
unavailable, and keeps serving MQTT/HTTP — it never panics on missing GPIO.

## Configuration (`hal.toml`)

Pins, addresses and limits live only here; drivers receive them as arguments
(AGENTS.md invariant). Unknown keys are rejected. `hald --print-default-config`
prints every key with its default; the important ones:

| Table | Key | Default | Notes |
|---|---|---|---|
| top | `unit_id` | Pi serial → `gardyn-<serial>` | Never a shared default (upstream #130). |
| top | `model` | detected | DHT20 answers ⇒ `gardyn 3.0`; AM2320 ⇒ `gardyn 1.0/2.0`. |
| top | `mqtt_url`, `mqtt_username`, `mqtt_password` | `mqtt://127.0.0.1:1883`, none | |
| top | `http_bind` | `0.0.0.0:3001` | |
| top | `telemetry_interval_s` | 10 | Sensors publish on change *and* at least this often. |
| top | `state_dir` | `/var/lib/seedypod` | `state.json` lives here (`--sim` uses a temp dir). |
| top | `mdns` | true | Advertise `_seedypod-hal._tcp`. |
| `[pins]` | `light_pwm`/`light_pwm_channel`/`light_hz` | 18 / 0 / 8000 | Hardware PWM. GPIO18 is channel 2 on a Pi 5. |
| `[pins]` | `pump_pwm`/`pump_hz` | 24 / 50 | Software PWM on a dedicated thread. |
| `[pins]` | `distance_trigger`/`distance_echo` | 26 / 19 | DYP-A01. |
| `[pins]` | `button`, `over_temp_alert` | 13, 25 | |
| `[i2c]` | `bus`, `pct2075`, `ina219`, `dht20`, `am2320` | 1, 0x48, 0x40, 0x38, 0x5C | |
| `[i2c]` | `ezo_ph`, `ezo_ec`, `ezo_rtd` | 0x63, 0x64, 0x66 | Only used by explicit `[[sensor]]` entries. |
| `[i2c]` | `ina219_shunt_ohms`, `ina219_max_amps` | 0.1, 3.2 | Calibration register derived from these. |
| `[limits]` | `pump_max_run_s`, `pump_max_duty` | 900, 30 | ADR-0009. |
| `[limits]` | `water_low_cm`, `over_temp_c` | 16, 36 | Comment out to disable an interlock. |
| `[limits]` | `distance_samples`, `distance_timeout_ms` | 5, 60 | Median of N pings. |
| `[tank]` | `full_cm`, `empty_cm` | 5, 20 | Geometry for `water_level_pct`. |
| `[button]` | `debounce_ms`, `double_window_ms`, `long_press_ms`, `active_low`, `pump_run_s` | 30, 400, 1000, true, 300 | |
| `[dosing]` | `enabled` | **false** | Phase 6.3, ADR-0014: off until you turn it on. |
| `[dosing]` | `ml_per_s`, `default_dose_ml`, `max_single_ml`, `max_daily_ml`, `max_doses_per_day` | 1, 5, 10, 30, 4 | Hard daily cap; lockout after N doses until acknowledged. |
| `[ha]` | `discovery`, `prefix` | true, `homeassistant` | |
| `[[camera]]` | `name`, `device`, `fallback`, `resolution`, `skip_frames` | upper `/dev/seedypod/camera-upper` (fallback `/dev/video0`), lower `/dev/seedypod/camera-lower` (fallback `/dev/video2`), 1280x720, 15 | See [Camera names](#camera-names) |

### Device list

With no `[[sensor]]` / `[[actuator]]` tables the stock Gardyn set is built
from `[pins]` and `[i2c]`: `pct2075`, `ina219`, `dht20` *(optional)*,
`am2320` *(optional)*, `dyp_a01`, `over_temp_alert` *(optional)*; actuators
`light` (`pwm_light`) and `pump` (`pwm_pump`). Optional devices that fail to
probe are skipped; required ones are kept and re-probed on every failed read.

Explicit tables replace that list entirely, **including the water ranger the
dry-run interlock needs** — list every part you keep. To add a probe
(pH, EC, water temperature), prefer the app's **Sensors** screen, which appends
instead (see *Sensors added from the app* below):

```toml
[[sensor]]
kind = "ezo_ph"        # pct2075 | ina219 | dht20 | am2320 | dyp_a01 | over_temp_alert | ezo_ph | ezo_ec | ezo_rtd
addr = 0x63            # i2c kinds
optional = true
[[sensor]]
kind = "dyp_a01"
trigger = 26
echo = 19
[[actuator]]
id = "dose_1"          # light | pump | dose_1 | dose_2 | dose_3
kind = "dosing"        # pwm_light | pwm_pump | dosing
pin = 5
```

`hald --check` rejects unknown kinds and ids, missing `addr`/`pin`/`trigger`/`echo`,
I²C addresses outside 0x08–0x77 or used twice, duplicate ids, and out-of-range limits, and prints the capability set the
config yields. `--sim` honours the same tables, so a config can be exercised on
a laptop first.

## MQTT

Prefix `seedypod/<unit-id>/`; the topic table in ADR-0007 is authoritative.
QoS 1 throughout. Client id `hald-<unit-id>`.

| Topic | Dir | Retained | Payload |
|---|---|---|---|
| `availability` | → | yes | `online` on connect; `offline` on shutdown and as the LWT |
| `system` | → | yes | `SystemInfo` |
| `sensor/<id>` | → | no | `Reading {ts, value, unit, quality}` — on change, and at least every `telemetry_interval_s` |
| `sensor/<id>/calibrate` | ← | — | `CalibrationCommand {point, value?}` — see *Calibration* below |
| `sensor/<id>/calibration` | → | yes | `CalibrationResult {ts, point, ok, points, detail}` for the last calibrate command |
| `actuator/<id>/state` | → | yes | `ActuatorState {on, level, since, fault, remainingS}`; a refused command republishes the state with its `fault` |
| `actuator/<id>/set` | ← | — | `ActuatorCommand {on?, level?, durationS?}` (empty payload = `{}`) |
| `event/button` | → | no | `{"press": "single" \| "double" \| "long"}` |
| `alert/<kind>` | → | yes | `Alert {kind, active, ts, detail}` for `water_low`, `pump_fault`, `dose_fault` (only with a doser configured), `over_temp`, `camera_missing` |
| `alert/pump_fault/ack` | ← | — | any payload; clears the latched pump fault |
| `alert/dose_fault/ack` | ← | — | any payload; clears every doser's lockout or fault |
| `ha/light/state`, `ha/light/brightness/state` | → | yes | `ON`/`OFF`, `0–100` (mirrors for HA's `light` platform) |
| `ha/light/set`, `ha/light/brightness/set` | ← | — | `ON`/`OFF`, `0–100` → translated to an `ActuatorCommand` |
| `ha/pump/state`, `ha/pump/percentage/state` | → | yes | `ON`/`OFF`, duty % |
| `ha/pump/set`, `ha/pump/percentage/set` | ← | — | `ON`/`OFF`, duty % → translated; the guard clamps and bounds it |

Semantics worth knowing:

- **Pump**: `{"on":true}` runs at the last/ max duty for `pump_max_run_s`;
  `level` is clamped to `pump_max_duty`; `durationS` is clamped to
  `pump_max_run_s`. A start is refused when the median water distance ≥
  `water_low_cm` (or the ranger is unavailable), when the PCB is ≥
  `over_temp_c`, when the board's GPIO25 alert line is asserted, or while a
  fault is latched. A running pump that trips latches `fault` (`dry-run`,
  `over-temp`) until `alert/pump_fault/ack`. `{"on":false}` always works.
- **Light**: `level` 0–100, no interlock; `{"on":true}` without a level
  restores the last on-level. The level is persisted and restored on boot.
- **Dosing** (`dose_1..3`): `durationS` is seconds of pumping, converted to ml
  through `ml_per_s`, clamped to `max_single_ml`; omitted → `default_dose_ml`.
  Refused when disabled, when the dose would cross `max_daily_ml` (UTC day),
  while a dose runs, or after `max_doses_per_day` until `alert/dose_fault/ack`.
  The ledger survives restarts.
- **Calibration** (`ph`, `ec`, `water_temp` on EZO circuits): put the probe in
  the reference solution and wait for the reading to settle, then send
  `{"point": …, "value": …}`. `value` uses the reported unit (pH, mS/cm, °C;
  EC goes to the circuit in µS/cm). pH: `mid` first (it clears the others),
  then optionally `low` and `high`. EC: `dry` in air, then `single`, or `low`
  and `high`. RTD: `single`. `clear` wipes stored points. Implausible values
  (pH outside 0–14, EC ≤ 0 or > 500 mS/cm) and points the circuit doesn't
  have are refused before anything reaches the bus; the result says why. Core
  exposes it as `POST /api/sensors/{id}/calibrate`.
- **Button** (GPIO13): single toggles the light, double starts/stops a
  `button.pump_run_s` bounded pump run, long acknowledges the pump fault and any dosing lockout. All
  three are also published on `event/button`.
- **Reconnect**: on broker loss `hald` backs off 1 → 30 s and keeps running;
  after reconnecting it republishes every retained topic and discovery.

## Home Assistant entities

Published retained under `<prefix>/<component>/<unit>_<object>/config` at boot
and on every reconnect. Every entity shares
`device = {identifiers: [<unit>], name: "Gardyn <unit>", manufacturer: "seedypod", model, sw_version}`
and `availability_topic = seedypod/<unit>/availability`.

| Component | Object | Binds to | Notes |
|---|---|---|---|
| `light` | `light` | `ha/light/*` | `brightness_scale: 100` |
| `fan` | `pump` | `ha/pump/*` | `speed_range_max = pump_max_duty`, so HA's 100 % is the duty cap |
| `sensor` | `air_temp`, `pcb_temp`, `water_temp` | `sensor/<id>` | `device_class: temperature`, °C |
| `sensor` | `humidity` | | `humidity`, % |
| `sensor` | `water_distance` | | `distance`, cm |
| `sensor` | `water_level_pct` | | no class, %, `mdi:water-percent` |
| `sensor` | `pump_v`, `pump_a`, `pump_w` | | `voltage` V, `current` A, `power` W |
| `sensor` | `ph` | | `device_class: ph` (no unit) |
| `sensor` | `ec` | | `conductivity`, mS/cm |
| `binary_sensor` | `water_low`, `pump_fault` | `alert/<kind>` | `device_class: problem` |
| `binary_sensor` | `over_temp` | `alert/over_temp` | `device_class: heat` |
| `button` | `ack_pump_fault` | `alert/pump_fault/ack` | "Acknowledge pump fault" |
| `binary_sensor`, `button` | `dose_fault`, `ack_dose_fault` | `alert/dose_fault`, `alert/dose_fault/ack` | "Dosing lockout" / "Acknowledge dosing lockout" (only when a doser is configured) |
| `button` | `dose_1..3` | `actuator/dose_N/set` | fires the default dose (only when a doser is configured) |
| `event` | `button` | `event/button` | `event_types: [single, double, long]` |

All sensors carry `state_class: measurement` and `value_template: {{ value_json.value }}`;
the full JSON is attached as attributes.

### Sensors added from the app

`devices/set` (and the app's Sensors screen) adds and removes probes at
runtime (ADR-0018). Addable kinds are `SensorKind` implementations, published
with their calibration steps in the retained `devices` inventory: `ezo_ph`
(0x63), `ezo_ec` (0x64) and `ezo_rtd` (0x66). An add goes live immediately:
the driver is probed, joins the registry and `caps`, and HA discovery is
republished. It is persisted in `<state_dir>/sensors.json` and appended to
the configured list at every boot. Refusals: kind not addable, address
outside 0x08–0x77 or in use, quantity already installed, probe not answering.
Built-in (`hal.toml`) sensors can't be removed this way. The inventory also
lists any configured sensor that failed to probe at boot, as `absent` with
the error.

## HTTP

| Endpoint | Returns |
|---|---|
| `GET /health` | `{ok, uptime_s, mqtt_connected}` |
| `GET /system` | `SystemInfo` (same payload as the `system` topic; reflects sensors added at runtime) |
| `GET /state` | `{unitId, ts, sensors{id: Reading}, actuators{id: ActuatorState}, alerts{kind: Alert}, lightHoursTotal}` |
| `GET /camera/<name>.jpg` | `image/jpeg`; one capture at a time per camera; `503` with the reason when the camera fails (and `camera_missing` is raised) |

Captures shell out to `fswebcam -S <skip_frames> --no-banner` and reject
anything that is not a plausible JPEG (upstream #143, #144).

## Camera names

USB cameras come up as `/dev/videoN` in whatever order they enumerate, so
upper and lower can swap after a reboot. Each UVC camera also exposes a
metadata node next to its capture node (`video0` + `video1`), which only
breaks things if it gets the name. `hald` therefore prefers stable names
pinned to the USB **port** by a udev rule that matches the capture node
only (`ATTR{index}=="0"`), and falls back to `/dev/videoN` until the rule
exists:

```sh
hald --list-cameras            # capture nodes, their ports, and the default assignment
hald --camera-rules            # rules for that assignment: first port → upper, second → lower
sudo hald --camera-rules upper=1-1.3:1.0 lower=1-1.2:1.0 \
  | sudo tee /etc/udev/rules.d/70-seedypod-cameras.rules
sudo udevadm control --reload && sudo udevadm trigger --subsystem-match=video4linux
ls -l /dev/seedypod/           # camera-upper, camera-lower
```

`scripts/install-hal` writes the rules on first install if it finds cameras,
and prints which port became which name. If the photos come out swapped,
rerun the third command with the ports exchanged. Which physical port feeds
which camera on a Gardyn is still unverified (see the
[hardware map](pin-map.md)).

## State file

`<state_dir>/sensors.json` holds the sensors added from the app (above).
`<state_dir>/state.json` (atomic write): `lightLevel`, `lightSince`,
`lightHoursTotal` (cumulative, for LED ageing), `lastPumpRun`, `doses{id:
ledger}`. On boot the light is restored to `lightLevel` without a glitch; on
SIGTERM the pump and dosers are turned off, the light is left as-is, the
state is saved and `availability` goes `offline`.

## mDNS

`_seedypod-hal._tcp` instance `<unit-id>` on the HTTP port with TXT
`id=<unit-id>`, `model=<model>`, `v=<hal version>`. Core discovers units from
this rather than from configuration.

## Install

```
curl -fsSL https://raw.githubusercontent.com/seedypod/core/main/scripts/install-hal | bash
```

`scripts/install-hal` detects the CPU (`aarch64` → Zero 2 W / Pi 4 / Pi 5;
`armv6l`/`armv7l` → Zero W), downloads `hald-<target>` from the latest GitHub
Release, installs it to `/usr/local/bin/hald`, writes `/etc/seedypod/hal.toml`
if absent (the commented defaults), creates the `seedypod` system user in
`gpio`, `i2c`, `video`, enables I²C (`raspi-config nonint do_i2c 0`) and the
PWM overlay (`dtoverlay=pwm,pin=18,func=2`, reboot required once), installs
`fswebcam`, pins camera names to USB ports (`/etc/udev/rules.d/70-seedypod-cameras.rules`,
see [Camera names](#camera-names)), and installs/enables `hald.service` (`Restart=always`,
`After=network-online.target`, hardened). `--binary ./hald` installs a local
build; `--version vX.Y.Z` pins a release; `--no-enable` skips starting it.

Operations: `journalctl -u hald -f`, `hald --config /etc/seedypod/hal.toml --check`,
`mosquitto_sub -v -t 'seedypod/#'`. See [Debugging](../DEBUGGING.md).

## Verification status

Everything here is tested on the simulator and against a local Mosquitto;
the real drivers compile for both targets but their register sequences,
timings and the PWM/overlay details are **unverified on a unit** until the
Phase 1 checklist in the [hardware map](pin-map.md) is done.
