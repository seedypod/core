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
| top | `light_fade_ms` | 800 | How long a full swing of the light takes. Smaller changes take less. 0 for no fade. At most 60000. |
| `[pins]` | `light_pwm`/`light_pwm_channel`/`light_hz` | 18 / 0 / 20000 | Hardware PWM. GPIO18 is channel 2 on a Pi 5. |
| `[pins]` | `pump_pwm`/`pump_hz` | 24 / 50 | Software PWM on a dedicated thread. |
| `[pins]` | `distance_trigger`/`distance_echo` | 26 / 19 | DYP-A01. |
| `[pins]` | `button`, `over_temp_alert` | 13, 25 | |
| `[i2c]` | `bus`, `pct2075`, `ina219`, `dht20`, `am2320` | 1, 0x48, 0x40, 0x38, 0x5C | |
| `[i2c]` | `ezo_ph`, `ezo_ec`, `ezo_rtd` | 0x63, 0x64, 0x66 | Only used by explicit `[[sensor]]` entries. |
| `[i2c]` | `ina219_shunt_ohms`, `ina219_max_amps` | 0.08, 3.2 | Calibration register derived from these. The driver sets the INA219 to average 128 shunt samples (68 ms, about 3.4 periods of the 50 Hz pump PWM) and 16 bus samples: config `0x3E7F`. A single sample would land anywhere in the PWM cycle. |
| `[limits]` | `pump_max_run_s`, `pump_max_duty` | 900, 100 | ADR-0009. At 100 % the pump pin is held high with no software PWM, as the stock firmware drives it; below that it pulses at `pump_hz`. Lower the cap only for a board that browns out: pumps differ between units, and below 100 a weak one may not lift water to the top. |
| `[limits]` | `pump_brownout_v`, `pump_brownout_ms`, `pump_brownout_pi` | 10.8, 300, true | The brown-out guard. Past the spin-up grace, at least three reads in a row of the pump supply (the INA219's bus voltage, read with the current every 100 ms) below `pump_brownout_v`, covering `pump_brownout_ms`, stop the pump and latch `brown-out: supply fell to 10.2 V for 0.3 s` until acknowledged. The supply idles at about 12.6 V; 10.8 V is a 12 V supply 10 % low. A missing read never trips it. `pump_brownout_v` may be 6–12, or 0 for off, and the ms 100–10000; without an INA219 it's off. With `pump_brownout_pi`, hald also reads the Pi's under-voltage flag (`/sys/devices/platform/soc/soc:firmware/get_throttled`, bit 0) once a second while the pump runs, if it can be read, and two reads in a row that report it trip the same fault. `hald --check` prints `pump_brownout_guard`; `system.limits` reports `pumpBrownoutV`, `pumpBrownoutMs` and `pumpBrownoutPi`. |
| `[limits]` | `water_low_cm`, `over_temp_c` | 16, 65 | Comment out to disable an interlock. `water_low_cm` is the level guard's cutoff (cm from the ranger to the surface): a start is refused on a reading at or past it, and a running pump stops on trusted readings that stay there (below). It's the default: the app may set it within the bounds below, but never clear it, and can't turn on an interlock this file turned off. In `"current"` mode it's still reported, as core's warning level. |
| `[limits]` | `water_low_min_cm`, `water_low_max_cm` | 8, 19 | The bounds of the `water_low_cm` the app may set (the Gardyn tank reads ~5 cm full, ~20 cm empty): 0 < min ≤ `water_low_cm` ≤ max ≤ `tank.empty_cm`, or `--check` fails (a cutoff past the bottom would never trip). A request outside them is held to the nearer one and logged, never refused; a kept value outside narrowed bounds is held to them at boot. |
| `[limits]` | `water_low_hold_ms`, `water_low_hold_min_ms`, `water_low_hold_max_ms` | 0, 0, 60000 | How long a running pump's tank must read at or past `water_low_cm`, with no good reading between, before the level guard stops it; at least 0.5 s (two readings), so 0 is the guard as it always was. A longer hold rides out a noisy ranger. A start is still refused on one low reading, and a ranger with no trusted reading for 3 s still stops the pump, whatever the hold. The app may set it within the bounds: min ≤ hold ≤ max ≤ 60000, or `--check` fails; held and kept like the grace. The level trip latches `dry-run: tank level read 17 cm, past 16 cm for 0.5 s`, or `dry-run: tank level unknown: no trusted reading for 3 s`. |
| `[limits]` | `pump_dry_current_a`, `pump_dry_after_ms`, `pump_dry_grace_ms` | **unset**, 300, 3000 | The pump current guard (#220): off until a cutoff is set, and off without an INA219. While the pump runs, `hald` reads its current every 100 ms (skipping the INA219's 500 ms cache). Past the grace after a start, at least three reads in a row below the cutoff, covering `pump_dry_after_ms`, mean it's pulling air, and it stops with `dry-run: pump drew 0.6 A, below 0.8 A for 0.3 s: it's pulling air`: about 0.3 s. The after may be 100–10000 ms. `pump_dry_current_a` and `pump_dry_grace_ms` are defaults: the app may set either, held to the bounds below (a cutoff it can change but never clear), and hald keeps them in `state.json` and uses them at boot without waiting on core. The older `pump_dry_after_s` / `pump_dry_grace_s`, in seconds, still load (not both forms of one). Set the cutoff below the wet current at the lowest duty you run. On our unit at 100 % duty, the pump draws 0.93 A wet and 0.55–0.71 A dry or air-locked, and takes ~2.3 s to reach its wet current after a start, hence the 3 s grace; its `hal.toml` sets 0.8 A ([wet](https://github.com/seedypod/core/blob/dev/knowledge/operations/pump-wet-trace-2026-11-16.md) and [dry](https://github.com/seedypod/core/blob/dev/knowledge/operations/pump-dry-trace-2026-11-16.md) traces). The brown-out guard waits out the same grace. |
| `[limits]` | `pump_dry_grace_min_ms`, `pump_dry_grace_max_ms` | 300, 5000 | The bounds of the grace the app may set: min ≤ `pump_dry_grace_ms` ≤ max ≤ 10000, or `--check` fails. A request outside them is held to the nearer one and logged, never refused; a kept grace outside narrowed bounds is held to them at boot. |
| `[limits]` | `pump_dry_current_min_a`, `pump_dry_current_max_a` | 0.1, 3.0 | The bounds of the cutoff the app may set: 0 < min ≤ max, and a `pump_dry_current_a` set here must lie within them, or `--check` fails. Held and kept like the grace. |
| `[limits]` | `pump_dry_guard`, `pump_dry_guard_app` | `"both"`, true | Which dry-run guard stops a running pump: `"level"` (the tank level only), `"current"` (the pump current only) or `"both"` (either). It's the default: the app may pick another, kept in `state.json`, unless `pump_dry_guard_app = false`, which locks it to this file's (a different mode from the app is refused and logged, and a kept one is dropped at boot). Nothing from the app can leave the pump with no dry-run guard: a mode that would (`"level"`, or a fallback to it, with `water_low_cm` unset) is refused, and no cutoff can be cleared. `"current"` needs a cutoff and an INA219, or hald warns and runs `"level"`; `"both"` without them is `"level"` too, with a warning. In `"level"` and `"both"` a low tank refuses a start; in `"current"` it doesn't, and a pump monitor with no reading for 2 s stops the pump with `monitor-lost: …`, latched for an acknowledge. `hald --check` prints this file's settings (not the app's): the guard in effect (`limits.pump_dry_guard`), why (`limits.pump_dry_guard_why`) and any fallback under `warnings`. |
| `[limits]` | `distance_samples`, `distance_timeout_ms`, `distance_gap_ms`, `distance_max_cm` | 5, 60, 60, empty × 1.5 | Median of N pings, taken `distance_gap_ms` apart so one ping doesn't hear the last one's echo. With an even count of answers the lower middle one counts, since stray echoes only read long. A ping further than `distance_max_cm` (the tank's empty depth plus half again by default) is a stray echo and counts as no answer. Fewer than two answers within 3 cm of the median marks the distance, and the level from it, `suspect`; two that agree are a reading however many pings were dropped. |
| `[tank]` | `full_cm`, `empty_cm` | 5, 20 | Geometry for `water_level_pct`. |
| `[button]` | `debounce_ms`, `double_window_ms`, `long_press_ms`, `setup_hold_ms`, `active_low`, `pump_run_s` | 30, 400, 1000, 10000, true, 300 | |
| `[dosing]` | `enabled` | **false** | Phase 6.3, ADR-0014: off until you turn it on. |
| `[dosing]` | `ml_per_s`, `default_dose_ml`, `max_single_ml`, `max_daily_ml`, `max_doses_per_day` | 1, 5, 10, 30, 4 | Hard daily cap; lockout after N doses until acknowledged. |
| `[usb_recovery]` | `enabled`, `boot_wait_s`, `reboot_attempts`, `busy_checks`, `busy_wait_s`, `attempts`, `settle_s` | true, 90, **0**, 20, 60, 2, 20 | See [USB recovery](#usb-recovery) |
| `[ha]` | `discovery`, `prefix` | true, `homeassistant` | |
| `[[camera]]` | `name`, `device`, `fallback`, `resolution`, `palette`, `skip_frames` | upper `/dev/seedypod/camera-upper` (fallback `/dev/video0`), lower `/dev/seedypod/camera-lower` (fallback `/dev/video2`), 1280x960, MJPEG, 15 | See [Camera names](#camera-names) |
| `[[camera]]` | `capture_attempts`, `capture_retry_ms`, `capture_timeout_s`, `inspect_frames` | 3, 1000, 15, true | See [Stills](#stills) |
| `[[camera]]` | `full_resolution`, `full_capture_timeout_s` | 2592x1944, 60 | See [Pod-ID stills](#pod-id-stills) |

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
| `system` | → | yes | `SystemInfo`; its `limits` report the dry-run guard: the mode in effect (`pumpDryGuard`), the one asked for (`pumpDryGuardAsked`), why they differ (`pumpDryGuardWhy`, only when they do) and whether the app may change it (`pumpDryGuardApp`); the current cutoff (`pumpDryCurrentA`, null when none) and the grace; the tank cutoff (`waterLowCm`) and its hold (`waterLowHoldMs`); and each one's bounds (`pumpDryCurrentMinA`/`MaxA`, `pumpDryGraceMinMs`/`MaxMs`, `waterLowMinCm`/`MaxCm`, `waterLowHoldMinMs`/`MaxMs`). Republished after every `pump/guard/set` |
| `pump/guard/set` | ← | — | `PumpGuardCommand {dryGraceMs?, dryCurrentA?, dryGuard?, waterLowCm?, waterLowHoldMs?}`, at least one. Numbers are held to hal.toml's bounds, a mode is refused when hal.toml locks it or it would leave no guard (logged; there's no reply), and what's taken is kept in `state.json`. `null` is the same as leaving a field out, so nothing can be cleared. An empty payload, or one with any other field, is refused |
| `pump/run` | → | yes | `PumpRun {startedAt, endedAt, everyMs, samples, wetA, endedBy, fault, levelPct, levelCm}`, once per run when it ends: `samples` are `[ms, A, V]` every 100 ms over the first 12 s (≤ 120; `null` where a read failed or there's no INA219), `wetA` the median current past the grace (null if it ended inside the grace or there's no INA219), `endedBy` `deadline`, `stop` or `fault` (with the latched `fault`), and the last tank reading. Separate from `--pump-trace` |
| `sensor/<id>` | → | no | `Reading {ts, value, unit, quality}` — on change, and at least every `telemetry_interval_s` |
| `sensor/<id>/calibrate` | ← | — | `CalibrationCommand {point, value?}` — see *Calibration* below |
| `sensor/<id>/calibration` | → | yes | `CalibrationResult {ts, point, ok, points, detail}` for the last calibrate command |
| `actuator/<id>/state` | → | yes | `ActuatorState {on, level, since, fault, remainingS}`; a refused command republishes the state with its `fault` |
| `actuator/<id>/set` | ← | — | `ActuatorCommand {on?, level?, durationS?}` (empty payload = `{}`) |
| `event/button` | → | no | `{"press": "single" \| "double" \| "long" \| "setup"}` |
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
  `water_low_cm` (or the ranger is unavailable), while `water_low` is active,
  when the PCB is ≥ `over_temp_c`, when the board's GPIO25 alert line is
  asserted, or while a fault is latched. A running pump that trips latches
  `fault` (`dry-run`, `over-temp`) until `alert/pump_fault/ack`. `{"on":false}`
  always works. While the pump runs, and for 2 s after, `hald` reads the pump
  current every 100 ms and the ranger once a second, between telemetry rounds;
  these reads feed the guard in memory only, so telemetry, MQTT and core stay on
  `telemetry_interval_s`. Two trusted readings at `water_low_cm`, 0.5 s or more
  apart, stop it with a dry-run; `suspect` readings neither confirm the water low
  nor say it's back, and 3 s with no trusted reading counts as the ranger gone.
  With `pump_dry_current_a` set, a pump drawing less than that trips a dry-run
  that says so: `dry-run: pump drew 0.4 A, below 1.2 A for 0.3 s: it's pulling
  air`. A failed INA219 read restarts the count and never trips it.
  Either dry-run clears itself after a minute of good water; one from the current
  waits a whole minute after the trip, as the tank read full all along. A stop
  the pump driver refuses latches `stop-failed: …` and is retried on every read
  until it takes; it waits for an acknowledge.
- **`water_low`** is debounced over the last 6 telemetry rounds, so a ranger
  on stray echoes doesn't raise a new alert every few seconds. A reading at
  `water_low_cm` raises it at once, no reading raises it on the third such round
  of the 6 (or on the first after boot), and it clears after 6 good rounds in a row,
  so the hold scales with `telemetry_interval_s`. A reading flagged `suspect`, with
  fewer than half the pings answering, counts as no reading.
- **Light**: `level` 0–100, no interlock; `{"on":true}` without a level
  restores the last on-level. The level is persisted and restored on boot.
  Every change fades, from any source, even in perceived brightness rather than
  in duty, on its own thread so it can't hold up the pump guard or sensor reads.
  `actuator/light/state` and the state file carry the target from the moment the
  command lands, once: nothing publishes or persists per step. A new command
  mid-fade carries on from the light's actual level. Boot restores the level
  exactly, without a fade (upstream #131), and a stop mid-fade lands on the target.
  While `hald` is down the light stays at its last level, with nothing managing it:
  the safer failure for plants. On a restart, `hald` reads the running duty from
  sysfs first, because opening the channel disables it, and turns it straight back on
  at that duty at the configured frequency. That leaves a few syscalls of dark, then
  boot restores the saved level exactly. A reboot resets the PWM, so the light is off
  until `hald` restores it. A failed write, or one that hasn't come back 3 s after
  its fade should have ended, shows as `fault` in the state, which core raises as
  `light_fault`, until a write succeeds.
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
  `button.pump_run_s` bounded pump run, long acknowledges the pump fault and any dosing lockout.
  Keep holding to `button.setup_hold_ms` (10 s) and a `setup` press follows: `hald`
  does nothing else with it, and core opens its Wi-Fi setup hotspot
  ([Installation → Change Wi-Fi](../INSTALLATION.md#change-wi-fi)). All four are
  published on `event/button` and on the Home Assistant button event entity.
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
| `event` | `button` | `event/button` | `event_types: [single, double, long, setup]` |

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
| `GET /camera/full/<name>.jpg` | `image/jpeg` at `full_resolution` (2592x1944), for reading pod dot codes (#224); waits on the same per-camera lock; `503` with the reason on failure, which raises nothing |

### Stills

Captures shell out to `fswebcam -p MJPEG -S <skip_frames> --no-banner`. The
palette is always set: left alone, a camera keeps whatever format it last used,
so two identical cameras can come up as MJPEG and YUYV. The default of 1280x960
is the sensor's own 4:3 shape, so nothing is cropped, and a Pi Zero re-encodes it
in a few seconds; 2592x1944 takes roughly four times that.

A capture fails if any of these is true (upstream #143, #144):

- `fswebcam` exits non-zero, or prints a known failure such as
  `Not a JPEG file` or `Timed out`. It often exits 0 after these.
- The saved file is too small, or has no SOI and EOI markers.
- The camera's raw frame is damaged.

The last check matters most. `fswebcam` decodes every frame and encodes a new
JPEG, and libjpeg repairs what it can without a word, so a torn frame arrives as
a valid file of a torn picture. hald asks for the raw frame as well
(`--dumpframe`) and walks its entropy-coded data: Huffman decoding only, with no
IDCT, colour conversion or image buffer. Lost USB packets show up as a scan that
ends short or overruns, a code no table holds, a restart marker out of turn, or a
DC value no 8-bit sample can produce. Damage smaller than one MCU can pass; it
leaves a local blemish, not a tear. Only `MJPEG` and `JPEG` palettes can be walked.
Anything libjpeg reads without repairing it passes, such as a partial DHT or padding
before EOI, because refusing a good frame makes a working camera look dead.

Each failed attempt is retried in a new process, up to `capture_attempts`, waiting
`capture_retry_ms` × the attempt number. `capture_timeout_s` kills a hung
`fswebcam`, so with the defaults a bad camera answers in about 15 s and a wedged
one in at most 48 s. A device node that isn't there fails at once with no retries.
Once a camera has used up its attempts it gets one try per still until it gives a
good frame, so a unit can run for months on one camera without the other costing
it CPU. That also keeps the alert quiet: its detail says only what kind of failure
it was (`no good frame: damaged frame`), and the log has the specifics.

Every `/camera/<name>.jpg` response, good or not, says what it saw of the link:
`X-Seedypod-Damaged-Frames` is how many of this capture's attempts came back
damaged, and `X-Seedypod-Hub-Boots` is `missing/total` of the last 10 boots the USB
hub didn't come up by itself. `hald --usb-recover` records those in `usb-boots` in
the state dir, one small write per boot. Core turns both into a
[connection notice](../MAINTENANCE.md#reseat-a-camera-cable). A retry hides damage
from `camera_missing`, so the count comes from here.

After the last attempt `/camera/<name>.jpg` returns `503` with the reason and
`camera_missing` goes up naming the camera. It stays up until every camera that
failed has produced a good frame, so one good camera can't hide the other. If
good frames from a camera are being refused (the log says why, under `capture
rejected`), set `inspect_frames = false` for it; damaged frames then get through.

### Pod-ID stills

Core asks for an occasional still at the sensor's full 2592x1944
(`/camera/full/<name>.jpg`), where the yCube dot codes under each pod are big
enough to read (#224). It runs the same `fswebcam` checks as a regular still, at
`--jpeg 95`, with up to two attempts and `full_capture_timeout_s` (60) each; it
took 13 s and 7 CPU-s on a Pi Zero W. It never changes the regular stills: their
size, the one-try mode of a failing camera, the damaged-frame count and
`camera_missing` all ignore it.

## Camera names

USB cameras come up as `/dev/videoN` in whatever order they enumerate, so
upper and lower can swap after a reboot. Each UVC camera also exposes a
metadata node next to its capture node (`video0` + `video1`), which only
breaks things if it gets the name. `hald` therefore prefers stable names
pinned to the USB **port** by a udev rule that matches the capture node
only (`ATTR{index}=="0"`):

```sh
hald --list-cameras            # capture nodes, their ports, and the default assignment
hald --camera-rules            # rules for that assignment: first port → upper, second → lower
sudo hald --camera-rules upper=1-1.3:1.0 lower=1-1.2:1.0 \
  | sudo tee /etc/udev/rules.d/70-seedypod-cameras.rules
sudo udevadm control --reload && sudo udevadm trigger --action=add --subsystem-match=video4linux
ls -l /dev/seedypod/           # camera-upper, camera-lower
```

`--action=add` matters: a plain `udevadm trigger` sends `change`, which doesn't
create the links.

You rarely need this by hand. `install-hal` installs a udev rule that runs
`hald --sync-camera-rules` (as `seedypod-camera-rules.service`, five seconds after
a USB camera appears), so a hub that wasn't up during the install still gets
named. It keeps any pins already in the file, so an assignment set by hand
stays, and every rule matches a USB interface only (`SUBSYSTEMS=="usb"`, and
`--camera-rules` refuses anything else).

Port order is only the default: the first port becomes `upper`, the second
`lower`, and nothing ties a port to a position in the tower. On our 3.0 the default
is right (`1-1.3` is the top camera, `1-1.4` the bottom), but check yours with the
[marker check](../MAINTENANCE.md#check-which-camera-is-which). To correct the names,
write the assignment by hand. It keeps working with a camera missing, so this is
also how to name the one good camera on a unit whose other camera won't enumerate:

```sh
sudo hald --camera-rules upper=1-1.3:1.0 lower=1-1.4:1.0 \
  | sudo tee /etc/udev/rules.d/70-seedypod-cameras.rules
sudo udevadm control --reload && sudo udevadm trigger --action=add --subsystem-match=video4linux
```

The `fallback` in `hal.toml` is only used when the port proves that node is that
camera, and that's checked on every attempt, because a camera can drop off the bus
mid-capture. `/dev/videoN` numbers shift: when one camera fails to bind, the other
takes its number, and without this check its picture would be saved under the
wrong name. With a pin, the node's port must match it. With no pin, both cameras
must be on the bus, and the default order decides.

A lone camera is named only if it's on a stock port (`1-1.3` is `upper`, `1-1.4` is
`lower`, as confirmed on our 3.0), so a unit with one dead camera keeps the other.
On any other port it could be either one, so it stays unnamed and the alert says
`one camera on the bus and no pins: pin it with --camera-rules`. If your unit is
wired differently, a lone camera can take the wrong name, so run the marker check.

## State file

`<state_dir>/sensors.json` holds the sensors added from the app (above).
`<state_dir>/state.json` (atomic write): `lightLevel`, `lightSince`,
`lightHoursTotal` (cumulative, for LED ageing), `lastPumpRun`, `doses{id:
ledger}`, and the dry-run guard settings the app made (`pumpDryGraceMs`,
`pumpDryCurrentA`, `pumpDryGuard`, `waterLowCm`, `waterLowHoldMs`), each
re-clamped to hal.toml's bounds at boot. On boot the light is restored to `lightLevel` without a glitch; on
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
`fswebcam`, pins camera names to USB ports now or when the cameras appear
(`/etc/udev/rules.d/70-seedypod-cameras.rules`, see [Camera names](#camera-names)), installs Mosquitto with a listener on
`127.0.0.1:1883` and no password (`/etc/mosquitto/conf.d/seedypod.conf`,
written once), and installs/enables `hald.service` (`Restart=always`,
`After=mosquitto.service`, hardened, with a [watchdog](#watchdog) and the pump
pin driven low after every stop). `--binary ./hald` installs a local
build; `--version vX.Y.Z` pins a release; `--no-enable` skips starting it.
`--mqtt-lan` adds a password-protected listener on port 1884 for Home
Assistant on another machine and prints the `homeassistant` password once;
`--no-broker` skips Mosquitto, for use with another broker such as Home
Assistant's add-on ([Installation → Home Assistant](../INSTALLATION.md#4-home-assistant)).

It also cuts SD card writes ([ADR-0021](../adr/0021-sd-card-wear-and-recovery.md)).
Each change is checked once applied and undone if the check fails; a rerun
reapplies them:

| Change | How | Check, and the rollback if it fails |
|---|---|---|
| Journal in RAM | `/etc/systemd/journald.conf.d/50-seedypod-volatile.conf` (`Storage=volatile`, `RuntimeMaxUse=32M`), then restart `systemd-journald` | journald is active again, or the drop-in is removed |
| Swap on zram | `systemd-zram-generator` with `/etc/systemd/zram-generator.conf` (half the RAM, at most 512 MB, zstd), then `dphys-swapfile` off | `swapon` lists `/dev/zram0`, or the config is removed and the swapfile stays on. Skipped when zram is already on (Raspberry Pi OS with `rpi-swap`) |
| `noatime` on `/` | adds it to the `/` line in `/etc/fstab`, then `mount -o remount,noatime /` | `findmnt --verify` accepts the file and `/` shows `noatime`, or `fstab` is restored. Skipped when it's already there (stock Raspberry Pi OS) |

`--no-wear` leaves all three alone.

It also shortens boot. These are checked and undone the same way, but no check
run during the install can see the next boot, so the rollback can't catch a unit
that comes up without Wi-Fi. What protects a headless unit is the precheck: cloud-init
only goes off if every active connection is shown to come back without it, and
anything less leaves it on.

| Change | How | Check, and the rollback if it fails |
|---|---|---|
| cloud-init off | `touch /etc/cloud/cloud-init.disabled`, once first boot is finished | Every active connection must come back without it: a keyfile in `/etc/NetworkManager/system-connections`, or a `netplan-*` one with `/etc/netplan/*.yaml` and netplan's generator present (Imager's Wi-Fi). Otherwise, or if nmcli can't say, it stays on. The file is removed if `daemon-reload` or that check fails after it |
| No swap file on the card | `/etc/rpi/swap.conf.d/50-seedypod.conf` (`Mechanism=zram`) | The zram swap unit still exists and no longer needs the loop device, or the file is removed. Skipped when `Mechanism` is already set, or under `--no-wear` |
| Mosquitto not waiting for the network | a copy of the vendor unit in `/etc/systemd/system` without `network-online.target` (a drop-in can't remove a dependency) | systemd no longer orders it after the target, or the copy is removed |

`hald` and core don't wait for `network-online.target` either, because the pump
and lights have to run without Wi-Fi. `--no-boot` leaves the three above alone.
That start order needs three things, none of which `--no-boot` turns off:

- `hald` opens its hardware once, so `ExecStartPre` waits up to 30 s for
  `/sys/class/pwm/pwmchip0` and the I²C bus to be usable by its user, then starts
  regardless.
- Core's Home Assistant bridge retries with backoff (5 s up to 5 minutes), because
  the broker may be out of reach until Wi-Fi is up.
- There's no RTC, so after a power cut the clock is wrong until NTP answers. For the
  first 3 minutes after boot, or until `systemd-timesyncd` has synced, pump schedules
  and Autopilot's `timeOfDay` triggers wait. A pump slot in that window is skipped, and
  a `timeOfDay` trigger fires within its usual grace. Dosing only runs through Autopilot.

Imager's user, password, Wi-Fi and hostname are written once on first boot and
stay, so cloud-init has nothing left to do; it would only ever act again if
`meta-data` on `bootfs` got a new instance id. To turn it back on:
`sudo rm /etc/cloud/cloud-init.disabled`.

For core's backups, the user core runs as (the one who ran the installer, or
the owner of `/opt/seedypod`; `SEEDYPOD_CORE_USER` overrides) joins the
`seedypod` group, which can read `/etc/seedypod`, `/var/lib/seedypod` and the
Mosquitto password file (`mosquitto:seedypod`, mode 0640). A running core is
restarted so it picks up the group.

Operations: `journalctl -u hald -f`, `hald --config /etc/seedypod/hal.toml --check`,
`mosquitto_sub -v -t 'seedypod/#'`. See [Debugging](../DEBUGGING.md).

A rerun only touches what changed: apt runs for a package that's missing,
`daemon-reload` for a unit that's different, and hald restarts for a new binary,
unit or group. A rerun with the same binary leaves a running pump alone. A restart
that's owed is recorded in `/var/lib/seedypod/.restart-hald` first, so an install
that dies part way still restarts hald on the rerun.

## Watchdog

`hald.service` is `Type=notify` with `WatchdogSec=10`. hald sends `READY=1` once
the engine has booted (the light restored, the fader running), and `WATCHDOG=1`
from the engine loop itself, once per tick, so pings stop when the loop hangs.
There's no side thread to keep pinging a stuck loop. 10 s without one and systemd
kills hald (`SIGABRT`) and starts it again 3 s later, as for a crash.

The loop ticks once a second, and a tick takes longer on a telemetry round, every
10 s. The stock sensors take well under a second (the ultrasonic median is about
0.3 s, at most 0.6 s), but an EZO probe blocks 0.9 s per read, 1.8 s when it asks
for more time, so three of them make a round of about 7 s. `WatchdogSec=3` would
kill a unit with EZO probes on every round; 10 s leaves room for them and still
catches a hang. The watchdog arms at `READY=1`, so a slow start isn't counted
against it. `TimeoutStartSec=120` covers the 30 s hardware wait and a slow Pi Zero
start.

`ExecStopPost=-/usr/local/lib/seedypod/pump-off` runs after every stop: `systemctl
stop` or `restart`, a crash, a watchdog kill. The pump is software PWM, so a hald
that dies mid-run can leave its pin high. The script drives the pump pin low with
`pinctrl set <pin> op dl`, or `raspi-gpio`, sysfs GPIO, then libgpiod's `gpioset`,
whichever the OS has, and logs which in `journalctl -u hald`. It never touches the
light, which stays as it is across a restart. The `-` means it never fails the unit.

The script asks `hald --config /etc/seedypod/hal.toml --pump-pin` for the pin, so
hal.toml (`pump_pwm` under `[pins]`, or an `[[actuator]]` with `id = "pump"`) stays
the only place it's set, and an edit since the install is followed. If hald can't
answer (a hal.toml it can't parse), the script uses the pin hald gave at install,
which is written into the script. `--pump-pin` prints nothing for a pump that low
doesn't turn off (not `pwm_pump`) or one on a light's pin, and then nothing is
driven.

A hald from before the watchdog never pings, so `install-hal` only adds
`Type=notify` and `WatchdogSec` when the binary it installs has `--pump-pin`, which
came with it. An older hald under the watchdog unit (say, after going back to an
older release by hand) would be killed every 10 s: rerun `install-hal`, which writes
the unit for the hald it finds.

The web updater swaps the binary but doesn't install units, so this needs
`sudo scripts/install-hal` run once on the unit.

### Hardware watchdog (off)

The Pi's BCM2835 watchdog can reboot the board when systemd itself stops
responding, through `RuntimeWatchdogSec=` in `/etc/systemd/system.conf.d/`. It's
**not** enabled. The chip allows at most about 15 s, and a Pi Zero 2 W in memory
pressure can stall PID 1 that long; a reboot there takes the light and cameras with
it, and a slow boot that stalls again would loop. It would also spend the USB hub's
reboot budget on reboots that aren't for the hub. hald's own watchdog covers the
common case, a hung or crashed hald. To try it on a unit anyway:

```sh
sudo mkdir -p /etc/systemd/system.conf.d
printf '[Manager]\nRuntimeWatchdogSec=15\n' | sudo tee /etc/systemd/system.conf.d/50-seedypod-watchdog.conf
sudo systemctl daemon-reexec      # dmesg shows bcm2835-wdt in use
# to undo: sudo rm /etc/systemd/system.conf.d/50-seedypod-watchdog.conf && sudo systemctl daemon-reexec
```

## USB recovery

The cameras sit behind a USB hub that often doesn't enumerate at boot, on stock
firmware too. On our unit it comes up on about 1 boot in 4, independently each time.
When it misses, the port reads SE1 (`hprt0` `0x1c00`). Usually only another boot
clears it, but some boots connect late without one: see the
[hardware map](pin-map.md#known-issue-usb-hub-missing-at-boot).

`seedypod-usb-recover.service` runs `hald --usb-recover` once per boot, as root. If
the bus still has nothing on it `boot_wait_s` after boot, it can reboot to try again,
up to `reboot_attempts` times in a row. **That is off by default**
(`reboot_attempts = 0`): an unattended reboot is an automatic recovery, and the
timing hasn't been proved on a unit yet (see below). Set it above 0 in `hal.toml` to
turn it on. At 1 boot in 4, `reboot_attempts = 4` (five boots) finds the hub about 3
times in 4. With reboots off, or once they run out, a boot that misses stops there:
the unit stays online without cameras, the unit shows as failed, and `hald` raises
`camera_missing` starting `USB hub:`, clearing it when the bus fills.

When reboots are on, the count is in `usb-reboots` in the state dir. It is written
and synced before each reboot, and only resets when the hub is seen, so a power cut
or a power cycle doesn't start it again. If it can't be read or written, the unit
doesn't reboot. To allow more tries after fixing the cable,
`sudo rm /var/lib/seedypod/usb-reboots`.

It won't reboot:

- While the pump or a doser is running, or the Wi-Fi setup hotspot is up. It looks at
  `hald`'s `/state`, and if `hald` can't say, that counts as running.
- During an update or a restore: `install`, `install-hal` and the restore helper
  each keep a file in `/run/seedypod-busy` while they run. It's in `/run`, so one that
  died mid-way is cleared by the next boot and can't hold reboots for good.
- Before an image's first boot has finished (`unit.env` is written last), or while
  cloud-init is enabled and hasn't finished.

For all of these it waits `busy_wait_s` and looks again, up to `busy_checks` times,
which outlasts a full pump run, then leaves this boot alone. It also won't reboot:

- On a unit with no cameras (`camera = []`). The stock pair is the default, so with
  reboots on, a Pi that really has no hub reboots `reboot_attempts` times once and
  then never again; leave `reboot_attempts = 0` on one.
- If anything else is on the bus, so a hub that came up, or any other USB device, is
  left alone. It only acts on the Pi's `dwc_otg` and `dwc2` controllers, never in
  gadget mode. Wi-Fi is on SDIO, not USB.

`attempts` adds root hub re-probes before any reboot, 2 by default. In
a controlled series, 7 of 40 boots found the hub at 123-151 s, after re-probes at about
90 and 111 s, and none rebooted. It isn't known yet whether the re-probes or the wait
did it, so the defaults (`boot_wait_s = 90`, `attempts = 2`, `reboot_attempts = 0`)
are pending that test. **Don't rebind the USB controller:** binding `dwc_otg` again
segfaults the kernel, and a hung kernel leaves the pump's GPIO as it was.
`rebind_controller` did that once; it now has no effect, and stays only so a
`hal.toml` that sets it loads.

To test on a unit, with the pump off, set `reboot_attempts` above 0 under
`[usb_recovery]` in `hal.toml`, then empty the bus and run it by hand. It reboots:

```sh
echo usb1 | sudo tee /sys/bus/usb/drivers/usb/unbind   # drops the hub and cameras
ls /sys/bus/usb/devices                                # no 1-1 or 1-1.*: usb1 remains
sudo hald --config /etc/seedypod/hal.toml --usb-recover
cat /var/lib/seedypod/usb-reboots                      # after it's back: gone if the hub came up
cat /var/lib/seedypod/usb-boots                        # one character a boot, newest last
```

The journal is in RAM, so the reboot takes its own log with it. These two files are
the record: `usb-reboots` counts reboots in a row, and in `usb-boots` a `+` is a boot
where the hub came up by itself and a `-` is one where it didn't.

## Verification status

Everything here is tested on the simulator and against a local Mosquitto.
On a real Gardyn 3.0 (Pi Zero W, from 2026-11-06), `hald --features hardware`
ran with MQTT and its I²C sensors answered; the light's hardware PWM on GPIO18
matched the commanded duty, fades ran smoothly, and the level held across
`hald` restarts and reboots; both UVC cameras took stills. Still **unverified
on a unit**, because its tank is empty: the pump driver, the INA219 pump-power
calibration and dry-run detection, and the ultrasonic level against water. The
[watchdog](#watchdog) and the pump-off script are tested against a fake notify
socket and stub GPIO tools, not yet on a unit. The
button is unverified too, and the cameras' USB hub comes up on only some boots
([handoff](../HANDOFF.md#the-usb-hub-the-one-open-fault)). The
[hardware map](pin-map.md) has the per-row status.
