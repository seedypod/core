---
type: "Guide"
title: "Handoff"
description: "State of the repository at the pause point, how to transfer it, what to change afterwards, and what remains."
status: "stable"
generated: {"by": "claude/fable-5.1", "at": "2026-10-31T05:45:00+00:00"}
sources: [{"resource": "/implementation-plan.md", "title": "Implementation plan"}, {"resource": "/hardware/hal.md", "title": "hald reference"}, {"resource": "/DEPLOYMENT.md", "title": "Deployment and secrets"}]
---

# Handoff

Written at the pause point on 2026-10-31. `dev` is at the HAL merge; `main` is at the v1.0.0 release (Phase 0 scaffold). Both branches now live at `github.com/seedypod/core` (transferred from `ng/leafypod` and renamed; see the ADR-0001 amendment).

## 1. What exists

| Area | State | Verified by |
|---|---|---|
| Repo conventions | dev→main, PR title gate, semantic-release, back-merge, dev-latest, Codecov flags, Renovate, Stryker, Vercel workflow, OKF validator | 11 workflows; v1.0.0 released with `hald` binaries + tarball |
| Rust HAL (`hal/`) | `hal-core` (contract, traits, `PumpGuard`, `DoseGuard`, derived sensors), `hal-drivers` (all documented parts + EZO pH/EC/RTD + dosing, behind `hardware`), `hal-sim`, `hald` (MQTT, HA discovery, HTTP, mDNS, state file, CLI) | 145 tests; end-to-end run against Mosquitto; CI cross-builds armv6 + aarch64 |
| Core (`server/`, `src/`) | Hono + tRPC + OpenAPI + MCP + WS; `Store` (SQLite/drizzle + memory); scheduler, grow cycle, recorder, captures, vision, HA bridge, API key; `MqttHalClient` | 79 vitest (unit + integration) |
| Web (`web/`) | 8 screens + `/kiosk` on the sleepypod design system; seeded in-browser demo (`VITE_DEMO=1`) | 6 Playwright e2e over the built server; all routes rendered headlessly with zero console errors |
| Docs | `docs/` (22 OKF concepts: ADRs 0001–0016, guides, HAL reference, HA examples, plan) and `knowledge/` (4) | `scripts/validate_knowledge.py` in CI |

**Not done, needs hardware (Phase 1 / 2.10):** nothing has run on a real Gardyn. The pin map, I²C addresses, driver timing/CRCs, INA219 calibration, button/GPIO25 polarity, PWM overlay line, camera exposure and the install scripts' Raspberry Pi OS steps are all documented assumptions. The checklist is in `docs/hardware/pin-map.md`; the per-driver list is at the end of `docs/hardware/hal.md`.

**Known deliberate limits:** `hald` MQTT is plain TCP (LAN-only); over-temp uses a single threshold plus the GPIO25 line (latch provides anti-flap); the Next.js memory spike (plan 0.0) was not run — the plan is built on the Hono/Vite outcome.

## 2. Transfer (done 2026-10-31)

The repo moved from `ng/leafypod` to `seedypod/core` (GitHub redirects the old URLs) and the project was renamed to **seedypod** throughout: package, crates, MQTT prefix, mDNS service, install paths and `SEEDYPOD_*` installer variables. Re-attach the Claude GitHub App on the `seedypod` org if you want pushes from Claude sessions.

## 3. Destination settings (applied via the API)

- Default branch **`dev`**. Rulesets `Dev` (default branch, merge queue **merge**) and `Main` (`main`, merge queue **squash**, linear history); org admins bypass. Auto-merge on, branches deleted on merge.
- Required checks on both: `Lint`, `Typecheck`, `Unit Tests`, `Browser Tests`. Left optional on purpose: `fmt + clippy + test` (path-filtered to `hal/**`, so it never reports on TS-only PRs and would block them) and `check-title` (only runs on `pull_request`, never on `merge_group`, so requiring it would stall the queue). Add `codecov/patch` once Codecov reports.
- Secrets: `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` are real (Vercel project `seedypod-demo` in *therealng's projects*, aliased to `seedypod.vercel.app`). `CODECOV_TOKEN`, `VERCEL_TOKEN` and `BACKMERGE_TOKEN` hold placeholders — see [Deployment](DEPLOYMENT.md#repository-secrets-and-variables) for where each comes from. Variable `VERCEL_ENABLED=true`, so the demo deploy fails until `VERCEL_TOKEN` is real.
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

1. **Phase 1** — teardown, `dd` the stock card, flash, `hald --check` + `--features hardware` on the unit, confirm the pin map; file ADR-0008 with the real model/controller; mark `knowledge/hardware/*` and `docs/hardware/pin-map.md` as verified.
2. Promote `dev` → `main` with a `feat:` PR to cut a release containing the full stack (currently `main` = Phase 0 only).
3. Add a `dose_fault` alert kind to the contract (fixture first, then both sides) and an EZO calibration topic.
4. Docs site repo (`<owner>/<owner>.github.io`, Nextra) once the org exists; `docs/` remains the source.
5. iOS: evaluate forking `sleepypod/ios`'s networking layer against this tRPC router.

## 6. Conventions to keep

Conventional commits; PRs to `main` titled `feat:`/`fix:`/`perf:`/`revert:`; small single-concern PRs; every actuator command through the safety layer; contract changes start with a fixture in `hal/contract/fixtures/`; OKF frontmatter on every doc; run the validator. `AGENTS.md` has the invariants.
