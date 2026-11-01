---
type: "Guide"
title: "Debugging"
description: "SSH, hald --check, journalctl, I²C probing, latched faults, simulator."
status: "draft"
generated: {"by": "claude/fable-5.1", "at": "2026-10-31T04:40:00+00:00"}
sources: [{"resource": "https://github.com/iot-root/garden-of-eden", "title": "iot-root/garden-of-eden (reference implementation, GPL-3; no code copied)"}, {"resource": "/adr/index.md", "title": "Architecture decision records"}]
---

# Debugging

- `ssh pi@seedypod.local`
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
- **A restore that didn't finish.** The helper logs each step to `/var/lib/seedypod-restore/status.json`. When the web UI starts the restore, it runs as a transient unit: `journalctl -u 'seedypod-restore-*'`. `sudo seedypod-restore --status` prints the last run. "restore isn't installed" means `scripts/install` hasn't put the helper and its sudoers rule in place; `sudo -n -l /usr/local/sbin/seedypod-restore` as the core user should print the path. `sudo seedypod-restore --undo` puts back what the last restore replaced. A failed restore puts the old files back by itself.
- **SD card writes:** **Settings → Storage** (or `GET /api/storage/flash`) shows writes per day. To see who is writing, `sudo iotop -ao` or `cat /proc/<pid>/io`. `swapon --show` should list only `/dev/zram0`.
- `sudo i2cdetect -y 1` — expect 0x40 (INA219), 0x48 (PCT2075), and 0x38 (DHT20, 3.0+). The AM2320 (1.0/2.0, 0x5C) does **not** answer `i2cdetect`.
- A pump that refuses to start with `fault: "dry-run"` is latched: refill, then acknowledge from the UI, HA, or `POST /api/alerts/{id}/acknowledge` (the id is in `GET /api/alerts`). A doser stuck on `fault: "lockout"` works the same way through the `dose_fault` alert.
- `mosquitto_sub -t 'seedypod/#' -v` shows everything `hald` publishes.
- Simulate without hardware: `pnpm dev` runs core against an in-process simulator (no `HAL_MQTT_URL`), with the web UI on :5173. `pnpm dev:sim` does the same with a week of seeded history, pods, a grow cycle and Autopilot rules (`SEED_DEMO=1`, data in `./data/sim`, simulated time at 60×); delete `./data/sim` to start over. For the full chain, run `hald --sim --time-scale 60` and point core at it with `HAL_MQTT_URL`.
