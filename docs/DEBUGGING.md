---
type: "Guide"
title: "Debugging"
description: "SSH, hald --check, journalctl, I²C probing, latched faults, simulator."
status: "draft"
generated: {"by": "claude/fable-5.1", "at": "2026-10-31T04:40:00+00:00"}
sources: [{"resource": "https://github.com/iot-root/garden-of-eden", "title": "iot-root/garden-of-eden (reference implementation, GPL-3; no code copied)"}, {"resource": "/adr/index.md", "title": "Architecture decision records"}]
---

# Debugging

- `ssh <your-login>@seedypod.local`, with the username you gave Raspberry Pi Imager: there's no default `pi` ([Installation → The login](INSTALLATION.md#the-login)).
- `hald --check` validates `hal.toml`; `journalctl -u hald -f` streams the daemon.
- `journalctl -u seedypod-core -f` for core; `curl localhost:3000/api/system`.
- **Logs only last until reboot.** `install-hal` keeps the journal in RAM to spare the SD card (ADR-0021). Alerts and faults are still in the database (**Alerts**, `GET /api/alerts`). To chase a crash that needs logs from before a reboot, keep the journal on the card for a while, then turn it back off:

  ```sh
  sudo mkdir -p /etc/systemd/journald.conf.d
  printf '[Journal]\nStorage=persistent\n' | sudo tee /etc/systemd/journald.conf.d/99-debug-persistent.conf
  sudo systemctl restart systemd-journald      # logs now survive reboots
  # … reproduce, reboot, then: journalctl -b -1 -u hald -u seedypod-core
  sudo rm /etc/systemd/journald.conf.d/99-debug-persistent.conf && sudo systemctl restart systemd-journald
  ```
- **Logs are quiet by default.** On a unit, core and `hald` keep warnings and errors, so pump faults, refusals and raised alerts always show, and drop the routine lines before formatting them. The journal is already in RAM, so this saves CPU and memory rather than card wear. For more, open a timed window; it ends by itself and goes back to what was set:

  ```sh
  curl -X POST localhost:3000/api/system/logging -H 'content-type: application/json' -d '{"debugMinutes":30}'   # everything, for 30 minutes (240 at most)
  curl -X POST localhost:3000/api/system/logging -H 'content-type: application/json' -d '{"debugMinutes":0}'    # end it now
  curl localhost:3000/api/system/logging                                                                        # see what's in force
  ```

  `{"mode":"off"}` keeps errors alone, and `{"mode":"quiet"}` puts it back. That differs from sleepypod's `off`, which keeps nothing, on purpose: a device running a pump must not go silent about a failure. A crash report still reaches the journal. `@homebridge/ciao` is the one known gap: its `FATAL` line goes to `console.log` just before it exits the process, so outside a debug window you only see core exit and restart. The setting is `recording-policy.json` beside the database, read at most once a second, so a change takes effect in about a second with no restart. A damaged file counts as `quiet`, and a `debugUntil` more than 240 minutes away counts as no window. With core on another machine, `hald` stays quiet unless you write that file on the unit (`{"loggingMode":"quiet","debugUntil":<epoch ms>}`). In a debug window `hald` logs what `RUST_LOG` allows, `info` by default. `hald` needs `install-hal` run once for this; until then it logs as before.
- **Core takes a while after a restart.** It's one bundle (`scripts/build-server.mjs`), because a cold start used to go on resolving `node_modules`. A stack trace points into `server/dist/*.js`, with source maps beside it. The MCP and OpenAPI stacks load on first use, so the first `/api/mcp` or REST call after a restart is slower than the next. V8's compile cache lives in `/var/cache/seedypod/compile-cache`, written once a minute after the first start of a version; deleting it is always safe.
- **A restore that didn't finish.** The helper logs each step to `/var/lib/seedypod-restore/status.json`. When the web UI starts the restore, it runs as a transient unit: `journalctl -u 'seedypod-restore-*'`. `sudo seedypod-restore --status` prints the last run. "restore isn't installed" means `scripts/install` hasn't put the helper and its sudoers rule in place; `sudo -n -l /usr/local/sbin/seedypod-restore` as the core user should print the path. `sudo seedypod-restore --undo` puts back what the last restore replaced. A failed restore puts the old files back by itself.
- **SD card writes:** **Settings → Storage** (or `GET /api/storage/flash`) shows writes per day. To see who is writing, `sudo iotop -ao` or `cat /proc/<pid>/io`; **Settings → SD card → Database** (or `GET /api/storage/database`) splits the database's share by table. `swapon --show` should list only `/dev/zram0`.
- `sudo i2cdetect -y 1` — expect 0x40 (INA219), 0x48 (PCT2075), and 0x38 (DHT20, 3.0+). The AM2320 (1.0/2.0, 0x5C) does **not** answer `i2cdetect`.
- A pump that refuses to start with `fault: "dry-run"` is latched: refill, then acknowledge from the UI, HA, or `POST /api/alerts/{id}/acknowledge` (the id is in `GET /api/alerts`). A doser stuck on `fault: "lockout"` works the same way through the `dose_fault` alert.
- `mosquitto_sub -t 'seedypod/#' -v` shows everything `hald` publishes.
- Simulate without hardware: `pnpm dev` runs core against an in-process simulator (no `HAL_MQTT_URL`), with the web UI on :5173. `pnpm dev:sim` does the same with a week of seeded history, pods, a grow cycle and Autopilot rules (`SEED_DEMO=1`, data in `./data/sim`, simulated time at 60×); delete `./data/sim` to start over. For the full chain, run `hald --sim --time-scale 60` and point core at it with `HAL_MQTT_URL`.
