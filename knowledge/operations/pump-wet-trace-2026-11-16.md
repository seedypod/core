---
type: "Finding"
title: "Pump wet trace (2026-11-16)"
description: "First real wet pump-current trace from the unit at 100 % duty: 0.93 A steady after a ~2.3 s ramp, which moves the dry cutoff and grace away from the synthetic assumptions."
status: "draft"
generated: {"by": "claude/opus-5.5", "at": "2026-11-16T21:10:00+00:00"}
sources: [{"resource": "pump-wet-trace-2026-11-16.csv", "title": "hald --pump-trace capture, unit gardyn-db753a85, 2026-11-16 20:38:05Z"}, {"resource": "https://github.com/seedypod/core/issues/220", "title": "#220 pump current dry-run guard"}, {"resource": "/operations/pump-safety-limits.md", "title": "Pump safety limits"}]
---

# Pump wet trace (2026-11-16)

On our unit (Gardyn 3.0, `gardyn-db753a85`), the pump at 100 % duty in water draws a steady **0.93 A at 12.5 V (11.7 W)**. That is half the 1.87 A that the guard's synthetic fixtures and `docs/hardware/hal.md` take from a single reading at 30 % duty. The dry cutoff and grace can't be set from those fixtures. The dry run (#220) is still to do.

## The run

| Item | Value |
|---|---|
| When | 2026-11-16 12:38:05 PST (20:38:05Z), cycle day 7 |
| How | `run_pump` 120 s at level 100, with hald on `HAL_PUMP_TRACE=/var/lib/seedypod/pump-trace.csv` (drop-in `/etc/systemd/system/hald.service.d/pump-trace.conf`) |
| Samples | 357 with the pump on, every 0.25 s (`pump_trace::EVERY`), plus the 2 s tail; [CSV](pump-wet-trace-2026-11-16.csv) |
| Steady current (t > 3 s) | mean 0.933 A, min 0.930, max 0.940, sd 0.004 |
| Supply | 12.59 V idle, 12.50 V under load; no brown-out (limit 10.8 V) |
| Tank | 13.6 cm to surface (43 %), sensor flagged suspect at 20:29Z |
| Stop | duty 0 at 119.70 s; current to 0 within one sample (119.95 s) |

## Start-up ramp

| t (s) | 0.25 | 0.50 | 1.03 | 1.28 | 1.53 | 2.04 | 2.29 |
|---|---|---|---|---|---|---|---|
| pump_a (A) | 0.19 | 0.33 | 0.06 | 0.26 | 0.40 | 0.59 | 0.93 |

The pump reaches its steady current about 2.3 s after the start. The INA219 facets share a 500 ms cache, so some of these 4 Hz reads repeat a stale value. The ramp's length still holds.

## What it changes

- **Cutoff:** `pump_dry_current_a` has to sit below 0.93 A, not below 1.87 A. The 1.2 A cutoff that `hal-core` tests use (`safety.rs`, `current_guard`) would trip on every normal wet run at 100 % duty. Choose it once the dry current is measured.
- **Grace:** the default `pump_dry_grace_ms` = 1000 ends while the current is still 0.06–0.59 A. With any cutoff above ~0.4 A, three low reads covering 300 ms would land inside the ramp and stop a healthy start. The grace needs to be at least ~2500 ms, unless the dry current turns out lower than the ramp values.
- **Fixtures:** this capture is the first real wet trace. It belongs in `hal-core/fixtures/pump_current/` next to the synthetic ones, once the cutoff and grace are set so that it passes.
- **Docs:** the "1.87 A wet at 30 %" line in `docs/hardware/hal.md` and the synthetic fixtures' headers predate #272, which runs the pump at 100 % duty like stock.

## Still open

- [ ] Dry run: pump lifted out of the water, owner at the tower, 10 s traced.
- [ ] Set `pump_dry_current_a` and `pump_dry_grace_ms` in `hal.toml` from the wet and dry traces, then remove the trace drop-in (one sudo step).
- [ ] Add both real traces to `WET_TRACES` / `DRY_TRACES` in `hal-core/src/safety.rs`.
- [ ] Until the cutoff is set, hald falls back to `pump_dry_guard = "level"`, which relies only on the tank-level sensor. That sensor reads suspect right now (alert `setup_water_sensor`).

## Missed scheduled run

The Monday 08:00 Germination run (15 min) on 2026-11-16 was not traced. The first sudo step to install the drop-in never ran, so hald was still on its 2026-11-14 start. The drop-in took effect when hald restarted at 12:21:57 PST. Seedlings watering (10 min daily at 08:00) starts on day 8, 2026-11-17, and each run is traced while the drop-in stays in place.
