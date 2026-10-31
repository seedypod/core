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
  (`HAL_MQTT_URL`, `HAL_UNIT_ID`, `HAL_HTTP_URL`) with its background services on.

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
| 8 | EZO calibration reaches the probe; an unconfigured probe returns 412 | `POST /api/sensors/{id}/calibrate` |
| 9 | Exhausting the doser raises `dose_fault` (not `pump_fault`); acknowledging it clears the latch in `hald` | MQTT `actuator/dose_1/set`, `POST /api/alerts/{id}/acknowledge` |
| 10 | A probe added from the app goes live (readings, inventory, HA entity) and is removed again; removing a `hal.toml` probe is refused | `POST`/`DELETE /api/devices/sensors` |
| 11 | Killing `hald` is noticed through the broker's last will | `hal_offline` alert |

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
overlay, camera exposure, or the Raspberry Pi OS install steps. Those stay in
the [Phase 1 checklist](pin-map.md) for a real unit.
