---
type: "Guide"
title: "Simulated bring-up"
description: "Phase 1 run against a simulated Gardyn: hald --sim, an MQTT broker and core, checked end to end in CI."
status: "stable"
generated: {"by": "claude/opus-5.5", "at": "2026-10-31T07:20:00+00:00"}
sources: [{"resource": "./pin-map.md", "title": "Gardyn hardware map (Phase 1 checklist)"}, {"resource": "./hal.md", "title": "hald — the hardware daemon"}, {"resource": "../adr/0007-hal-contract.md", "title": "ADR 0007: HAL contract v1"}]
---

# Simulated bring-up

Until a real Gardyn is on the bench, Phase 1 runs against a **simulated unit**.
`tests/sim/bringup.mjs` starts the stack exactly as it runs on a Pi, with the
hardware swapped out:

- `hald --sim` with a `hal.toml` for a fully fitted unit: the stock sensor set,
  an EZO pH probe, `dose_1` with dosing enabled, and one camera;
- an in-process MQTT broker (`aedes`) in place of Mosquitto;
- the built core server, connected through the real `MqttHalClient`
  (`HAL_MQTT_URL`, `HAL_UNIT_ID`, `HAL_HTTP_URL`) with its background services on;
- an in-process S3 server for the mirror and the nightly backups, and the real
  restore helper, whose `systemctl` calls come back to the harness
  (`tests/sim/fake-systemctl.mjs`), so it can stop and start `hald` and core.

```sh
cargo build --manifest-path hal/Cargo.toml -p hald
pnpm build
pnpm test:sim-bringup        # HALD_BIN=<path> to test another binary
```

CI runs it as **Sim Bring-up** on `dev` and on PRs touching `hal/`, `src/`,
`server/` or `tests/sim/`.

## Checklist

| # | Check | Through |
|---|---|---|
| 1 | `hald --check` accepts the unit config and plans the expected capabilities | CLI |
| 2 | Core sees `hald` online with the right unit id, model, sensors and actuators | `GET /api/system` |
| 3 | Telemetry flows from `hald` through MQTT into core (air, water distance, pH) | `GET /api/sensors` |
| 4 | Home Assistant discovery is retained for every entity, including `dose_fault` | `homeassistant/#` |
| 5 | A light command round-trips and `hald` echoes the new state | `POST /api/light` |
| 6 | Pump duty is clamped to the guard (30 %) and the run stops at its bound | `POST /api/pump/run-once` |
| 7 | A still is fetched over `hald`'s HTTP server and stored | `POST /api/camera/upper/capture` |
| 8 | Both on-device analysers score that still on the worker thread | `GET /api/vision/captures/{id}`, `/api/vision/status` |
| 9 | The dataset export streams a tar with the manifest, tables and stills | `GET /api/datasets/export` |
| 10 | `scripts/analysis-worker.mjs` posts results that compare next to the on-device ones; ingest is off without a token | `POST /api/analyses/results`, `GET /api/vision/compare/1` |
| 11 | EZO calibration reaches the probe; an unconfigured probe returns 412 | `POST /api/sensors/{id}/calibrate` |
| 12 | Exhausting the doser raises `dose_fault` (not `pump_fault`); acknowledging it clears the latch in `hald` | MQTT `actuator/dose_1/set`, `POST /api/alerts/{id}/acknowledge` |
| 13 | A probe added from the app goes live (readings, inventory, HA entity) and is removed again; removing a `hal.toml` probe is refused | `POST`/`DELETE /api/devices/sensors` |
| 14 | An armed Autopilot rule drives the light through `hald`; the kill switch releases it | `POST /api/automations`, `GET /api/light/owner`, `PUT /api/autopilot/enabled` |
| 15 | A bucket backup lands under the mirror prefix, and a download carries the database, `hal.toml`, the broker password and `hald`'s `sensors.json` | `POST /api/backup/run`, `GET /api/backup/bucket`, `GET /api/backup/download` against an in-process S3 server |
| 16 | **Backup → wipe → restore:** with the database, `hald`'s state and the broker password deleted and a stock `hal.toml`, the fresh core offers Welcome. Restoring the bucket backup through the real helper brings back the settings, schedule, grow cycle, Autopilot rule, app-added probe (live in `hald` again), `hal.toml`, password and LAN listener. The helper stops and starts both services in order | `POST /api/backup/browse`, `POST /api/backup/restore-from-bucket`, `scripts/seedypod-restore.cjs` with `tests/sim/fake-systemctl.mjs` |
| 17 | A bundle from newer software is refused with the version to install, and the unit is untouched | `POST /api/backup/restore` → 409 |
| 18 | Undo puts the fresh card back; a second undo redoes the restore | `POST /api/backup/undo` |
| 19 | Killing `hald` is noticed through the broker's last will | `hal_offline` alert |

## What it found

The first run showed that core never subscribed to `hald`'s topics. The
factory awaits `connectAsync()`, so the client is already connected when
`MqttHalClient` registers its `connect` handler, and that handler never ran.
Every real install would have shown the hardware as offline. The client now
also subscribes at construction time when it is handed an already-connected
client.

## What it does not cover

The simulation checks the software chain (contract, guards, MQTT, core, Home
Assistant). It cannot check anything physical: GPIO and I²C addresses, driver
timing and CRCs, INA219 calibration, button and GPIO25 polarity, the PWM
overlay, camera exposure, or the Raspberry Pi OS install steps (including the
SD card wear settings, `sudo` for the restore helper and `systemd-run`). Those stay in
the [Phase 1 checklist](pin-map.md) for a real unit.
