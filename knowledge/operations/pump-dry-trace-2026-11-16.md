---
type: "Finding"
title: "Pump dry and air-lock trace (2026-11-16)"
description: "Supervised dry run on the unit at 100 % duty: 0.55–0.71 A dry against 0.93 A wet, and an air lock after re-submerging that looked the same as dry for ~70 s before clearing by itself."
status: "draft"
generated: {"by": "claude/opus-5.5", "at": "2026-11-16T23:05:00+00:00"}
sources: [{"resource": "pump-dry-trace-2026-11-16.csv", "title": "hald --pump-trace capture, unit gardyn-db753a85, 2026-11-16 22:49:11Z"}, {"resource": "/operations/pump-wet-trace-2026-11-16.md", "title": "Pump wet trace (2026-11-16)"}, {"resource": "https://github.com/seedypod/core/issues/220", "title": "#220 pump current dry-run guard"}]
---

# Pump dry and air-lock trace (2026-11-16)

On our unit, the pump running dry at 100 % duty draws **0.55–0.71 A**, against **0.93 A** wet. Once it went back in the water, it stayed air-locked at the same dry current for about 70 s, then cleared by itself. On current alone, a dry pump and an air-locked pump look the same.

## The run

The pump ran for 180 s at level 100 with `HAL_PUMP_TRACE` on, and the owner was at the tower. They lifted the pump out of the water partway through, held it out for about 15 s, and lowered it back in. [CSV](pump-dry-trace-2026-11-16.csv).

| Phase | t (s) | pump_a (A) | Note |
|---|---|---|---|
| Start-up ramp | 0–2.6 | 0.05–0.62 | Same shape as the [wet run](pump-wet-trace-2026-11-16.md): 0.93 A reached at 2.61 s |
| Wet | 2.6–30 | 0.93–0.94 (mean 0.930) | |
| Lifted, dry | 30.06–~46 | 0.89 → 0.71 within 1 s, then down to 0.59 | 0.85 at 30.82, 0.71 at 31.07 |
| Back in water, air-locked | ~46–116 | 0.55–0.70 (mean 0.604) | The re-submersion time is from the owner's ~15 s hold. Nothing shows it in the current |
| Re-primed | 116.4–120.2 | 0.72 → 0.93 over ~4 s | Cleared without help |
| Wet | 120–179.8 | 0.93–0.94 (mean 0.940) | Stopped on time; 0 A within one sample |

The supply held between 12.50 and 12.54 V the whole time.

## What it means for the guard

- **Cutoff:** a `pump_dry_current_a` of **0.80 A** sits about 0.13 A under the wet floor (0.93) and 0.09 A over the highest dry or air-locked read after the first second (0.71). The first dry read was 0.89, and the reads got under 0.80 within ~1 s of lifting.
- **Grace:** the start-up ramp is still under 0.80 A at 2.0 s in both runs, and reaches 0.93 by 2.3–2.6 s. `pump_dry_grace_ms` must therefore be at least ~3000 ms. The default of 1000 would stop every start.
- **Air lock counts as dry:** with the cutoff at 0.80 A the guard would stop an air-locked pump too. That's correct, because no water moves, but it also stops the pump before it can clear by itself the way it did here. After a dry stop, someone should check that the intake is under water and that water reaches the top before running it again.
- **Fixtures:** this trace and the wet one replace the synthetic `dry` and `wet` fixtures in `hal-core/fixtures/pump_current/`, with the cutoff at 0.80 and the grace at ≥ 3000 ms.

## Open

- [ ] Set `pump_dry_current_a = 0.8` and `pump_dry_grace_ms = 3000` in the unit's `hal.toml`, then remove the trace drop-in (one sudo step).
- [ ] Change the default grace and the test cutoff in `hal-core`, and add both real traces to `WET_TRACES` / `DRY_TRACES`.
- [ ] Whether an air lock always clears by itself, and how fast, is untested beyond this one ~70 s case.
