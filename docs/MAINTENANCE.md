---
type: "Guide"
title: "Maintenance and self-repair"
description: "Routine care, what each alert means and how to clear it, health checks, backups, updates, and replacing parts on a seedypod unit."
status: "draft"
generated: {"by": "claude/opus-5.5", "at": "2026-10-31T13:00:00+00:00"}
sources: [{"resource": "/hardware/hal.md", "title": "hald reference"}, {"resource": "/hardware/pin-map.md", "title": "Gardyn hardware map"}, {"resource": "/INSTALLATION.md", "title": "Installation"}, {"resource": "/SENSORS.md", "title": "Adding a probe"}]
---

# Maintenance and self-repair

This page covers keeping a unit healthy and fixing it yourself. Two kinds of
advice are mixed here:

- **seedypod behaviour** (alerts, commands, files) comes from the code and is
  tested on the simulator.
- **Physical care** of the tower is general hydroponics practice. It isn't
  specific to, or verified on, every Gardyn model; where the hardware itself
  is unverified, the [hardware map](hardware/pin-map.md) says so.

## Routine care

| How often | What | seedypod helps by |
|---|---|---|
| Weekly | Top up the tank. Add nutrients. | Tank level on the dashboard. `water_low` alert. The nutrient reminder (Settings → Grow reminders). |
| Every 2–4 weeks, or each grow cycle | Drain the tank, wipe out algae and root debris, rinse the pump intake. | `pump_fault` (dry run) if the pump starves. The pump-power tile shows a clogged pump drawing less or more than usual. |
| Monthly | Recalibrate a pH probe (mid point at least). Check EC against a 1.413 mS/cm standard. | The calibration wizard on the **Sensors** screen ([Adding a probe](SENSORS.md)). |
| Monthly | Wipe the camera lenses. Check both cameras still frame their pods. | **Analysis → Latest photo** shows what each camera sees. A sudden drop in every pod's green area usually means a dirty or knocked lens, not dying plants. |
| Between grow cycles | Clean the pods and the grow column. Check the light bars for dead LEDs. | **Grow → End cycle / Start cycle** resets reminders. |
| Weekly, or nightly with a mirror | Back up the unit (below). | Nightly uploads to the mirror's bucket. The **Backup overdue** alert after 7 days without one. |

Store pH probes wet, in their storage solution, never in distilled water.
A probe that drifts after a fresh calibration, or responds slowly, is near
the end of its life.

## Alerts and what to do

| Alert | What it means | Fix |
|---|---|---|
| **Water low** (`water_low`) | The ranger reads the surface further away than `limits.water_low_cm` (16 cm by default). The pump won't start. | Fill the tank. The alert clears by itself. If it stays on with a full tank, check Settings → Tank calibration and the ranger's view. |
| **Pump fault** (`pump_fault`) | The dry-run interlock stopped the pump, or it ran past `limits.pump_max_run_s`. It is **latched**: the pump stays off until acknowledged. | Fix the cause (water, intake, kinked tube), then acknowledge it in **Alerts** or long-press the button (1 s). |
| **Dosing lockout** (`dose_fault`) | A doser hit its daily cap or its lockout count (ADR-0014). Latched. | Check the reservoir and the dosing schedule, then acknowledge. |
| **Board over temperature** (`over_temp`) | The board's temperature sensor or its alert line tripped. The pump is refused. | Check ventilation and the PSU. It clears when the board cools. |
| **Camera missing** (`camera_missing`) | A still came back empty or implausible. Usually unplugged, or a stale device name. | Reseat the USB cable. `hald --list-cameras` should show both. If they swapped ports, regenerate the rules ([Camera names](hardware/hal.md#camera-names)). |
| **Hardware daemon offline** (`hal_offline`) | Core lost `hald`: it crashed, the Pi rebooted, or the MQTT broker went away. | `journalctl -u hald -n 100`. `systemctl status mosquitto`. `hald` restarts itself (`Restart=always`). |
| **Light fault** (`light_fault`) | The light didn't take a command. | Check the light-bar connector, then `journalctl -u hald`. |
| **Backup overdue** (`backup_stale`) | No off-card backup has succeeded for 7 days. On a unit that never had one it reads "No off-card backup yet", 7 days after core first started. Also a problem sensor in Home Assistant. | **Settings → Backup → Download backup**, or set up the mirror for nightly backups. If the nightly upload is failing, Settings → Backup says why. It clears on the next backup. |
| **Thin seedlings / Check roots / Harvest window / Add nutrients** | Grow-cycle reminders from Settings → Grow reminders. | Do the task and dismiss the alert. |

## Health checks

On the Pi:

```sh
systemctl status hald seedypod-core mosquitto
journalctl -u hald -f                      # live daemon log
hald --config /etc/seedypod/hal.toml --check   # config errors and planned devices
sudo i2cdetect -y 1                        # expected below
hald --list-cameras                        # both cameras and their USB ports
mosquitto_sub -v -t 'seedypod/#'           # everything hald publishes
curl -s localhost:3000/api/healthcheck
```

Expected I²C addresses, with the stock parts and the default probe addresses:

| Address | Part |
|---|---|
| `0x48` | PCT2075 board temperature |
| `0x40` | INA219 pump power monitor |
| `0x38` | DHT20 air temperature + humidity (3.0 / Studio) |
| `0x5c` | AM2320 air temperature + humidity (older units, instead of 0x38) |
| `0x63`, `0x64`, `0x66` | Atlas EZO pH, EC, RTD probes, if fitted |

The **Sensors** screen shows the same inventory, with any part that didn't
answer at boot marked **not found** and the reason.

## Backups

A backup is one file, `seedypod-backup-<unit>-<date>.tar.gz`, that holds
everything needed to rebuild the unit on a new card:

| In the bundle | From |
|---|---|
| `seedypod.db` | The database: settings, schedules, grow cycles, pods, Autopilot rules, alerts, telemetry, analysis results. Copied with SQLite's online backup, so core keeps running. |
| `etc/seedypod/hal.toml` | Pin map, limits and unit id. |
| `etc/mosquitto/seedypod.passwd` | The Home Assistant broker password, if `--mqtt-lan` made one. |
| `var/lib/seedypod/*.json` | `hald`'s state: light level, dosing ledgers, probes added in the app (`sensors.json`). |
| `captures/` | Photos, only when you ask for them. |
| `manifest.json` | Unit, core and `hald` versions, database schema, creation time and a checksum per file. |

There are two ways to get one off the card. A copy on the same card would die
with it, so there is no local one.

- **Download.** **Settings → Backup → Download backup**, any time. **Include
  photos** adds the stills (without a mirror, that's the only copy of them;
  it makes the file much larger). The file holds the bucket secret and the
  MQTT password, so keep it somewhere private.
- **Nightly to the mirror's bucket.** With the off-device mirror set up
  ([Capture analysis](ANALYSIS.md#mirror-photos-off-the-unit-opt-in)), a
  bundle without photos (the mirror already has them) goes to `backups/`
  under the mirror's prefix every night after 03:00 unit time. It keeps the
  newest 14 for this unit and leaves other units' backups alone. **Back up
  now** runs it early. Failed uploads retry hourly.

If no backup has succeeded for 7 days, the **Backup overdue** alert comes up
on Home, in **Alerts** and in Home Assistant.

If **Settings → Backup** says a file was left out with "permission denied",
rerun `install-hal`. It adds core's user to the `seedypod` group, which can
read `hald`'s files.

From a script: `curl -OJ http://seedypod.local:3000/api/backup/download`
(`?photos=1` for photos). `GET /api/backup` shows the last backup, and
`POST /api/backup/run` runs a bucket backup.

To keep more than 30 days of photos, turn on the off-device mirror. For
analysis on another machine, use **Analysis → Export a dataset**.

## Updates

Rerun the installers. They keep your config and data:

```sh
curl -fsSL https://raw.githubusercontent.com/seedypod/core/main/scripts/install-hal | sudo bash
curl -fsSL https://raw.githubusercontent.com/seedypod/core/main/scripts/install | bash
```

Database migrations run when core starts. **Settings → About** shows the
versions running.

## Replacing parts

Power the unit off at the wall before opening it.

- **SD card.** Flash Raspberry Pi OS, rerun both installers, then restore
  the backup tarball. Use `tar xzf … -C /` with the services stopped. The
  unit keeps its id if `unit_id` is set in `hal.toml`. Otherwise it's derived
  from the Pi, so Home Assistant may see a new device after a Pi swap.
- **Camera.** Plug it into the same USB port and the stable name follows the
  port, so nothing changes. If you use a different port, run
  `hald --list-cameras` and regenerate the rules.
- **Air sensor.** A DHT20 and an AM2320 are interchangeable: `hald` detects
  which one answers.
- **pH / EC / temperature probe.** Swap the probe on the same EZO circuit,
  then recalibrate. A new circuit at the same address needs nothing else. At
  a new address, remove the old one and add the new one on the **Sensors**
  screen.
- **Pump or light bar.** These are on the Gardyn board's connectors (see the
  [hardware map](hardware/pin-map.md); the exact connectors are unverified).
  Afterwards, run the pump once from the **Water** screen and watch the
  pump-power tile. Then set the light from the **Light** screen.

After any repair, `hald --check` and a look at **Sensors** and **Alerts**
confirm the unit sees what it should.
