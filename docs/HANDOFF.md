---
type: "Guide"
title: "Handoff"
description: "State of the repository at the pause point, how to transfer it, what to change afterwards, and what remains."
status: "stable"
generated: {"by": "claude/fable-5.1", "at": "2026-10-31T05:45:00+00:00"}
sources: [{"resource": "/implementation-plan.md", "title": "Implementation plan"}, {"resource": "/hardware/hal.md", "title": "hald reference"}, {"resource": "/DEPLOYMENT.md", "title": "Deployment and secrets"}]
---

# Handoff

Updated 2026-10-31 after the move to `github.com/seedypod/core` (from `ng/leafypod`; renamed to seedypod, see the ADR-0001 amendment). `dev` carries the full software stack, including the `dose_fault` alert and EZO calibration. `main` is promoted from `dev` by a `feat:` PR that cuts the first full-stack release.

## 1. What exists

| Area | State | Verified by |
|---|---|---|
| Repo conventions | dev→main, PR title gate, semantic-release, back-merge, dev-latest, Codecov flags, Renovate, Stryker, Vercel workflow, OKF validator | 11 workflows; v1.0.0 released with `hald` binaries + tarball |
| Rust HAL (`hal/`) | `hal-core` (contract, traits, `PumpGuard`, `DoseGuard`, derived sensors), `hal-drivers` (all documented parts + EZO pH/EC/RTD + dosing, behind `hardware`), `hal-sim`, `hald` (MQTT, HA discovery, HTTP, mDNS, state file, CLI) | 148 tests; end-to-end run against Mosquitto; CI cross-builds armv6 + aarch64 |
| Core (`server/`, `src/`) | Hono + tRPC + OpenAPI + MCP + WS; `Store` (SQLite/drizzle + memory); scheduler, grow cycle, recorder, captures, vision, HA bridge, API key; `MqttHalClient` | 86 vitest (unit + integration) |
| Web (`web/`) | 8 screens + `/kiosk` on the sleepypod design system; seeded in-browser demo (`VITE_DEMO=1`) | 6 Playwright e2e over the built server; all routes rendered headlessly with zero console errors |
| Docs | `docs/` (OKF concepts: ADRs 0001–0016, guides, HAL reference, HA examples, plan, this handoff) and `knowledge/` (4); published at [seedypod.github.io](https://seedypod.github.io) from `seedypod/seedypod.github.io` | `scripts/validate_knowledge.py` in CI |
| Org | `seedypod/.github` profile README; avatar source (`assets/avatar.svg`, sleepypod-style render) | — |

**Simulated Phase 1 done:** [`pnpm test:sim-bringup`](hardware/sim-bringup.md) runs the full stack against `hald --sim` over MQTT in CI (14 checks). It caught a subscribe race that would have kept core from ever seeing a real `hald`.

**Not done, needs hardware (Phase 1 / 2.10):** nothing has run on a real Gardyn. The pin map, I²C addresses, driver timing/CRCs, INA219 calibration, button/GPIO25 polarity, PWM overlay line, camera exposure and the install scripts' Raspberry Pi OS steps are all documented assumptions. The checklist is in `docs/hardware/pin-map.md`; the per-driver list is at the end of `docs/hardware/hal.md`.

**Known deliberate limits:** `hald` MQTT is plain TCP (LAN-only); over-temp uses a single threshold plus the GPIO25 line (latch provides anti-flap); the Next.js memory spike (plan 0.0) was not run — the plan is built on the Hono/Vite outcome.

## 2. Transfer (done 2026-10-31)

The repo moved from `ng/leafypod` to `seedypod/core` (GitHub redirects the old URLs) and the project was renamed to **seedypod** throughout: package, crates, MQTT prefix, mDNS service, install paths and `SEEDYPOD_*` installer variables. Re-attach the Claude GitHub App on the `seedypod` org if you want pushes from Claude sessions.

## 3. Destination settings (applied via the API)

- Default branch **`dev`**. Rulesets `Dev` (default branch, merge queue **merge**) and `Main` (`main`, merge queue **squash**, linear history); org admins bypass. Auto-merge on, branches deleted on merge.
- Required checks on both: `Lint`, `Typecheck`, `Unit Tests`, `Browser Tests`. Left optional on purpose: `fmt + clippy + test` (path-filtered to `hal/**`, so it never reports on TS-only PRs and would block them) and `check-title` (only runs on `pull_request`, never on `merge_group`, so requiring it would stall the queue). Add `codecov/patch` once Codecov reports.
- Secrets: `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` are real (Vercel project `seedypod-demo` in *therealng's projects*, aliased to `seedypod.vercel.app`). `VERCEL_TOKEN` and `BACKMERGE_TOKEN` hold placeholders — see [Deployment](DEPLOYMENT.md#repository-secrets-and-variables) for where each comes from. Variable `VERCEL_ENABLED=true`, so the demo deploy fails until `VERCEL_TOKEN` is real. Codecov needs no token: coverage uploads authenticate with GitHub OIDC.
- Labels: `mutation-test`, `dependencies`, `hardware`, `safety`, `security`.
- Still manual (UI only): install the Codecov and Renovate apps on the org, and upload the org avatar.

## 4. Running it

```sh
pnpm install && pnpm dev                 # core :3000 (simulator), web :5173
pnpm test · pnpm tsc · pnpm lint         # TS checks
pnpm hal:test                            # Rust
NODE_ENV=production CI=1 pnpm build && pnpm test:browser   # e2e (PW_CHROMIUM=<path> to use a system Chromium)
cargo run --manifest-path hal/Cargo.toml -p hald -- --sim --stdout --ticks 3
python3 -I scripts/validate_knowledge.py
```

On a unit: `scripts/install-hal` then `scripts/install`; set `HAL_MQTT_URL`, `HAL_UNIT_ID` (from `hald --check`) and `HAL_HTTP_URL` in the core service (`docs/INSTALLATION.md`).

## 5. Next steps, in order

1. **Phase 1 on a real unit** (the simulated run is done) — teardown, `dd` the stock card, flash, `hald --check` + `--features hardware` on the unit, confirm the pin map; file ADR-0008 with the real model/controller; mark `knowledge/hardware/*` and `docs/hardware/pin-map.md` as verified. With EZO probes fitted, run the calibration procedure in `docs/hardware/hal.md`.
2. Replace the placeholder secrets (`VERCEL_TOKEN`, `BACKMERGE_TOKEN`, `RENOVATE_TOKEN`) — tracked in seedypod/core#6 — and upload the org avatar. Renovate runs self-hosted from `.github/workflows/renovate.yml` once `RENOVATE_TOKEN` is real; no app install needed. The demo at seedypod.vercel.app was first deployed by hand with the Vercel CLI.
3. iOS: evaluated in [ADR-0017](adr/0017-ios-client.md) — new `seedypod/ios` app reusing sleepypod's tRPC transport, discovery and stream patterns; first add a `_seedypod._tcp` mDNS advertisement to core.
4. New probe types (dissolved oxygen, ORP, other vendors): one `SensorKind` impl each (ADR-0018); the Sensors screen and calibration wizard pick them up from the descriptor.

Done since the pause: transfer and rename; repo settings; Vercel project; the `dose_fault` alert kind; the EZO calibration topic; the docs site; the org profile; fixing the crash on first boot when the data directory is missing; adding, calibrating and removing pH/EC/temperature probes from the app (ADR-0018).

## 6. Conventions to keep

Conventional commits; PRs to `main` titled `feat:`/`fix:`/`perf:`/`revert:`; small single-concern PRs; every actuator command through the safety layer; contract changes start with a fixture in `hal/contract/fixtures/`; OKF frontmatter on every doc; run the validator. `AGENTS.md` has the invariants.
