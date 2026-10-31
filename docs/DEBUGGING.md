# Debugging

- `ssh pi@leafypod.local`
- `hald --check` validates `hal.toml`; `journalctl -u hald -f` streams the daemon.
- `journalctl -u leafypod-core -f` for core; `curl localhost:3000/api/system`.
- `sudo i2cdetect -y 1` — expect 0x40 (INA219), 0x48 (PCT2075), and 0x38 (DHT20, 3.0+). The AM2320 (1.0/2.0, 0x5C) does **not** answer `i2cdetect`.
- A pump that refuses to start with `fault: "dry-run"` is latched: refill, then acknowledge from the UI, HA, or `POST /api/alerts/pump_fault/acknowledge`.
- `mosquitto_sub -t 'leafypod/#' -v` shows everything `hald` publishes.
- Simulate without hardware: `hald --sim --time-scale 60` and `HAL_MQTT_URL= pnpm dev`.
