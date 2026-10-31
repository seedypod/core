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
- `sudo i2cdetect -y 1` — expect 0x40 (INA219), 0x48 (PCT2075), and 0x38 (DHT20, 3.0+). The AM2320 (1.0/2.0, 0x5C) does **not** answer `i2cdetect`.
- A pump that refuses to start with `fault: "dry-run"` is latched: refill, then acknowledge from the UI, HA, or `POST /api/alerts/pump_fault/acknowledge`.
- `mosquitto_sub -t 'seedypod/#' -v` shows everything `hald` publishes.
- Simulate without hardware: `hald --sim --time-scale 60` and `HAL_MQTT_URL= pnpm dev`.
