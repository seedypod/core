---
type: "Decision record"
title: "Pump safety limits"
description: "Defaults for max run, duty, dry-run threshold and over-temperature, and where each number came from."
status: "draft"
generated: {"by": "claude/fable-5.1", "at": "2026-10-31T04:10:00+00:00"}
sources: [{"resource": "https://github.com/iot-root/garden-of-eden/blob/main/config.py", "title": "garden-of-eden config.py (MAX_PUMP_RUN_SECONDS, OVER_TEMP_HIGH, WATER_* defaults)"}, {"resource": "https://github.com/iot-root/garden-of-eden/blob/main/README.md", "title": "garden-of-eden README (pump duty note)"}]
---

# Pump safety limits

| Limit | Default | Provenance | Confidence |
|---|---|---|---|
| `pump_max_run_s` | 900 | Upstream: "follows the Gardyn and pump-vendor guidance" | medium — vendor doc not located |
| `pump_max_duty` | 30 % | Upstream README: full duty draws too much current for the system | medium — reproduce with the INA219 in Phase 1 |
| `water_low_cm` | 16 (distance sensor→surface) | Upstream: full ≈ 5 cm, empty ≈ 20 cm; low chosen with ~4 cm margin | low — calibrate per unit |
| `over_temp_c` | 36 (hysteresis 34) | Upstream `OVER_TEMP_HIGH` / `OVER_TEMP_HYSTERESIS` | medium |
| ultrasonic samples | 5 (median) | Upstream alert path; fixes #111 | high |

Each row becomes `stable` once measured on hardware and recorded with a `verified` attestation and a dated log entry.
