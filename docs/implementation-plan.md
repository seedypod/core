---
type: "Plan"
title: "Implementation plan (Phase 0 → 1.0)"
description: "Phased build plan with parallelism markers, ADR index, HAL contract draft and OKRs."
status: "draft"
generated: {"by": "claude/fable-5.1", "at": "2026-10-31T04:40:00+00:00"}
sources: [{"resource": "https://github.com/sleepypod/core", "title": "sleepypod/core (conventions and ADR precedents)"}, {"resource": "https://github.com/iot-root/garden-of-eden", "title": "iot-root/garden-of-eden (reference implementation, GPL-3; no code copied)"}, {"resource": "https://www.anthropic.com/news/model-hardware-standard-research-preview", "title": "Model Hardware Standard research preview"}]
---

# Gardyn Liberation — Implementation Plan (Phase 0 → Done)

**Status:** v3 — Phases 0, 3, 4, 5 and the software half of 7/8 built (2026-10-31); Phase 1 (hardware recon) and the Rust driver validation in Phase 2 need a real unit · **Date:** 2026-10-29 · **Author:** @ng (drafted with Claude)
**Name:** seedypod (ADR-0001; drafted as leafypod). Repo: `seedypod/core`.

Sibling project to [sleepypod](https://github.com/sleepypod): a sealed consumer appliance (Gardyn hydroponic tower) whose embedded Linux controller (a Raspberry Pi) is re-flashed to run a local, cloud-free control stack. This plan mirrors sleepypod's conventions exactly (branching, CI, Codecov, Stryker, semantic-release, Renovate, Vercel demo, Nextra docs on Pages, ADRs, OKF knowledge bundle) so tooling and muscle memory carry over.

Legend: **∥** = can run in parallel with the preceding item(s) in the same phase · **⛔** = hard dependency · **⏱** = rough effort for one person.

---

## 0. Ground truth (what we know going in)

Everything below comes from `iot-root/garden-of-eden` (`config.py`, `app/lib/hardware.py`, `docs/design.md`, `mqtt.py`) and its issue tracker. Treat as *hypotheses to verify on our unit* in Phase 1.

### 0.1 Hardware map (BCM numbering)

| Function | Interface | Pin / addr | Notes |
|---|---|---|---|
| Grow light | PWM | GPIO18 | 8 kHz; hardware PWM channel on every Pi |
| Pump | PWM | GPIO24 | 50 Hz; **not** a hardware PWM pin → software PWM; upstream caps duty at 30 % |
| Water level | Ultrasonic DYP-A01 | trig GPIO26 / echo GPIO19 | µs-timing sensitive; take 5-sample median |
| Button | GPIO in | GPIO13 | single = light, double = pump |
| Over-temp alert | GPIO in | GPIO25 | from PCB thermal monitor |
| PCB temp | I²C PCT2075 | 0x48 | all models |
| Pump power | I²C INA219 | 0x40 | V/I/W |
| Air temp/humidity | I²C | 0x5C AM2320 (Gardyn 1.0/2.0) · 0x38 DHT20 (3.0 / Studio) | AM2320 needs a wake-up write before it ACKs (#142) |
| Cameras | USB UVC | `/dev/video0` upper, `/dev/video2` lower | via on-board hub; fswebcam needs ≥10 skip frames (#143), exits 0 when unplugged (#144) |
| Controller | Pi Zero W (early) / Zero 2 W | microSD | header soldered in mirrored orientation |

Model detection: DHT20 present ⇒ 3.0+; else AM2320 ⇒ 1.0/2.0; Studio is 3.0-class with a ~4 gal tank (Home ≈ 5 gal, 30 pods).

### 0.2 Safety invariants (lifted from upstream's bug list — these are the spec, not nice-to-haves)

1. **Single owner of the pump.** Max run (`900 s` upstream default), dry-run interlock (water distance > low threshold ⇒ refuse), and over-temp cutoff are enforced *inside the pump driver*. No caller — REST, MQTT, cron, CLI, MCP — can bypass them (#108, #109, #114).
2. **One long-lived daemon owns the pins.** No per-invocation scripts; starting a process must never glitch an output (#131).
3. **Median-of-N ultrasonic** in the driver, used identically by guards and alerts (#111).
4. **Serialized camera access**; validate output size, not exit code (#117, #143, #144).
5. **Per-unit identity** derived from `/proc/cpuinfo` serial, never a shared default (#130).
6. **Fail-safe on fault = stay off until a human acknowledges**; auto-recovery is opt-in (sleepypod ADR-0022 pattern).
7. **Power-loss recovery**: persisted actuator + grow-cycle state restored on boot (#3).

### 0.3 Upstream roadmap we are superseding

6 open milestones (0–53 % complete, no due dates), 63 open issues, two "product" milestones (Plant Guidance, Web UI) never received an issue. All of it is table-stakes IoT; the only non-trivial items are model detection (#72) and the safety bugs above. We take the pin map and bug list; we fork nothing (GPL-3 — a clean-room reimplementation keeps our license choice open; see ADR-0002).

---

## 1. Architecture

```
┌───────────────── core (TypeScript: Hono server + Vite/React SPA, TanStack Router) ─────────┐
│  Web UI (React)   tRPC routers   MCP server   Scheduler   Grow-cycle   Alerts   SQLite     │
│  HA bridge (MQTT discovery)   HomeKit (hap-nodejs, later)   Demo mode (simulated HAL)      │
└──────────────────────────────▲──────────────────────────────────────────────────────────────┘
                               │  HAL contract: MQTT (telemetry/commands/HA discovery) + HTTP (stills, health)
┌──────────────────────────────┴──── hal (Rust, one static binary, systemd) ─────────────────┐
│  Sensor/Actuator trait registry · safety interlocks · mDNS · simulator backend · OTA-able  │
│  rppal (GPIO/PWM/I²C) · embedded-hal driver crates · v4l2 capture · rumqttc · axum         │
└──────────────────────────────▲──────────────────────────────────────────────────────────────┘
                               │
                 Gardyn PCB (lights, pump, sensors, cameras, button)
```

**Deployment topologies (pick per unit; both supported from day one):**

| Topology | Pi in the unit | Runs HAL | Runs core | When |
|---|---|---|---|---|
| **A. Single-box on Zero 2 W** | Zero 2 W (drop-in, ~$15) | yes | yes — Hono + static SPA idles ~60–90 MB, fits 512 MB | **Default.** Whole stack inside the unit, no extra hardware |
| **B. Split** | Zero 2 W | yes | no — core on a LAN box (home server / HA host) | Multiple units under one core, or if A proves tight |
| **C. Pi 5 single-box** | Pi 5 (+ ribbon, own PSU) | yes | yes | Only when on-device CV (Phase 7) is wanted |

The lightweight core is what makes A possible: sleepypod's Next.js standalone needed the Pod's 2 GB and a post-processed build (`strip-turbopack-external-hashes`, hand-copied `.next/static`, `rm instrumentation.ts` for the Vercel demo). See ADR-0003. The HAL contract is identical in all three, so a unit can move between topologies by changing one URL.

### 1.1 Repository layout (single repo, mirrors `sleepypod/core` + its `modules/` multi-language precedent)

```
core/
├── server/               # Hono (Node): mounts tRPC (@hono/trpc-server), OpenAPI (trpc-to-openapi fetch handler),
│                         # MCP (WebStandardStreamableHTTPServerTransport, Origin guard), serves web/dist, starts instrumentation
├── web/                  # Vite + React SPA; TanStack Router file routes in web/src/routes/; globals.css tokens; ds/ ui/ AppShell/
├── src/
│   ├── server/           # tRPC routers, context; src/mcp/ tools (framework-agnostic, ported from sleepypod)
│   ├── hardware/         # HAL client (MQTT + HTTP), capability probing, simulator
│   ├── scheduler/        # cron-parser + node-schedule jobs (lights, pump, captures)
│   ├── grow/             # grow-cycle state machine, reminders
│   ├── alerts/           # persisted, dismissible alerts (water_low, pump_fault, …)
│   ├── db/               # drizzle schema + migrations (sqlite)
│   ├── mqtt/             # HA bridge (discovery, state, commands) — ADR-0019 pattern
│   ├── lib/              # shared pure logic
│   └── hooks/, components/
├── hal/                  # Rust workspace (cargo), cross-compiled in CI
│   ├── crates/hal-core   # traits, registry, safety, config
│   ├── crates/hal-drivers# ina219, pct2075, am2320, dht20, dyp-a01, pwm-light, pwm-pump, uvc
│   ├── crates/hal-sim    # simulator backend (feature-gated)
│   └── crates/hald       # the daemon binary (axum + rumqttc + mdns-sd)
├── docs/
│   ├── adr/              # NNNN-slug.md, sleepypod template
│   ├── hardware/         # board photos, pin map, teardown notes
│   ├── DEPLOYMENT.md INSTALLATION.md DEBUGGING.md PRIVACY.md
│   └── testing/
├── knowledge/            # OKF v0.2 bundle (horticulture evidence, calibration, CV eval)
├── scripts/              # install, deploy, flash, probe
├── tests/                # top-level: instrumentation/proxy tests, integration/, browser/ (Playwright *.e2e.ts via run.mjs)
│                         # unit tests are COLOCATED: src/<area>/tests/<file>.test.ts (sleepypod convention); hal has cargo tests
├── codecov.yml  .releaserc.json  renovate.json  vercel.json  stryker.config.mjs
├── vitest.config.mts  eslint.config.ts  .githooks/  .node-version  AGENTS.md
```

---

## 2. Phases

### Phase 0 — Repo & conventions bootstrap  ⏱ 1 day

Goal: an empty-but-complete repo where `dev → main` already releases, docs deploy, demo deploys, and coverage reports — before any product code.

| # | Task | ∥ | Notes |
|---|---|---|---|
| 0.1 | Create GitHub org + repos `core`, `<name>.github.io`; org profile README (`.github/profile`) | | `gh repo create <org>/core --public --license <see ADR-0002>` |
| 0.2 | ADR-0001 *New repository & naming*, ADR-0002 *License* | ∥ 0.1 | Clean-room ⇒ MIT/Apache-2 possible; GPL only if we vendor upstream code (we won't) |
| 0.3 | Branch model: `dev` (integration) → `main` (release). Protect both; merge queue on `main`; squash on `main`, merge-commit on `dev` | ⛔ 0.1 | identical to sleepypod |
| 0.4 | Scaffold **Hono (Node) + Vite/React 19 + TanStack Router** (file-based routes via `@tanstack/router-plugin`), TS strict, pnpm, `.node-version` 24.x; Tailwind 4; copy eslint, editorconfig, `.githooks` (lint-staged pre-commit; tsc+eslint+drizzle-check+changed-tests pre-push), `prepare` hook. Dev: `vite` proxies `/api` → Hono | ∥ 0.3 | ADR-0003 records Next.js as rejected: needs ≥2 GB, build post-processing, SSR unused |
| 0.5 | CI `test.yml` (`name: CI`): matrix {Lint (changed files only), Typecheck, Unit (`vitest run --coverage`, Codecov upload), Browser (`NODE_ENV=production CI=1 pnpm build && pnpm test:browser`, Playwright chromium)}; `concurrency` cancel-in-progress; triggers push `dev`, `pull_request`, `merge_group`, `workflow_dispatch`; `CI=1` disables hardware instrumentation at startup | ⛔ 0.4 | no coverage thresholds in vitest — Codecov gates |
| 0.6 | CI `rust.yml`: fmt, clippy -D warnings, test, `cross` builds for `arm-unknown-linux-gnueabihf` (Zero W), `aarch64-unknown-linux-gnu` (Zero 2 / Pi 4 / Pi 5); upload `hald-<target>` artifacts; `cargo-llvm-cov` → Codecov flag `rust` | ∥ 0.5 | path-filtered to `hal/**`; Codecov `carryforward: true` so TS-only PRs don't zero it |
| 0.7 | `codecov.yml` with flags `javascript` (src/, app/, lib/) and `rust` (hal/); project target auto ±1 %, patch ±8 % | ∥ 0.5 | |
| 0.8 | `release.yml` on `main`: semantic-release (conventionalcommits, sleepypod `releaseRules`), build, pin `.git-info`, tarball `core.tar.gz` + attach `hald-*` binaries to the GitHub Release | ⛔ 0.5, 0.6 | |
| 0.9 | `pr-title-gate.yml` (regex `^(feat∣fix∣perf∣revert)(\(…\))?!?: ` on PRs to `main`), `back-merge.yml` (`workflow_run` after "Analyze & Release", `--no-ff` merge main→dev pushed directly with `BACKMERGE_TOKEN`, opens a "needs a hand" issue on conflict), `build.yml` (tarball on every branch for `gp-update`-style installs), `dev-release.yml` (push to `dev` ⇒ re-tag rolling `dev-latest` prerelease), `ref-collision-check.yml` (fail if a branch name equals a tag), `openapi.yml` (boot the built app in CI, poll `/api/openapi.json`, upload artifact) | ∥ 0.8 | all copied from sleepypod/core |
| 0.10 | `mutation.yml`: Stryker, weekly Sat 06:00 UTC + `mutation-test` label; shards by module | ∥ 0.8 | can land empty-config now, shards in Phase 3 |
| 0.11 | `renovate.json`: automerge minor/patch, 3-day min age, Monday schedule, major = manual, conventional prefixes; add `cargo` manager | ∥ 0.8 | |
| 0.12 | `vercel.json`: deploy **only `dev`**, `VITE_DEMO=1 pnpm --filter web build` → static SPA with the in-browser tRPC `demoLink` (sleepypod `src/demo/` pattern); no instrumentation stripping needed | ⛔ 0.4 | live demo URL goes in README like `sleepypod.vercel.app` |
| 0.13 | Docs site repo: Nextra/MDX, `content/{getting-started,core,hal,hardware,developers,troubleshooting}`, `ci.yml` (build + playwright), `pages.yml` (GitHub Pages) | ∥ 0.4 | copy `sleepypod.github.io` skeleton |
| 0.14 | `knowledge/` OKF v0.2 bundle: `index.md`, `log.md`, `references/okf.md` pinned to the same upstream spec revision, `scripts/validate_knowledge.py` + CI step | ∥ 0.13 | starts nearly empty; Phase 6/7 fill it |
| 0.15 | `AGENTS.md` (+ `.claude/`): copy sleepypod rules; add HAL-specific ones (never bypass safety module, never hardcode pins outside `hal/config`) | ∥ 0.4 | |
| 0.16 | `.github/SUPPORT.md` (model/version, how to grab + share logs); labels created by hand: `mutation-test`, `dependencies`, `hardware`, `safety`. Sleepypod has **no** issue/PR templates, CODEOWNERS, commitlint or labeler — don't add them | ∥ 0.13 | |
| 0.17 | ADR-0003 *Core stack* (TS/React/Next/Lingui), ADR-0004 *Two-tier HAL/core split*, ADR-0005 *tRPC*, ADR-0006 *Rust for the HAL*, ADR-0007 *HAL contract: MQTT + HTTP* | ∥ 0.2 | sleepypod ADR format: `docs/adr/NNNN-kebab-title.md`, no frontmatter, `# ADR NNNN: Title`, `**Status:** Proposed` / `**Date:** YYYY-MM-DD`, sections Context / Decision / (Rationale, Alternatives Considered) / Consequences (Positive/Negative/Neutral) / References, amendments appended as `## Amendment (date)`; status Proposed until Phase 2 proves them |
| 0.0 | **Spike (do first, ~1 h): does Next.js fit?** Build `sleepypod/core` unchanged, run `next start` under `systemd-run -p MemoryMax=512M` on aarch64 (or on the Zero 2 W after Phase 1.4); record idle RSS, boot-to-ready, first-request latency, and the same for a hello-world Hono + Vite SPA. Decide ADR-0003 on the numbers: Next fits ⇒ port `app/` verbatim and keep sleepypod's build; else Hono/Vite. The rest of this plan is written for the Hono/Vite outcome; swapping back touches only 0.4, 0.12, 0.18, 3.7, 3.8, 3.11, 4.3 | | reversible; nothing downstream depends on the answer until 0.4 |
| 0.18 | OpenAPI + trpc-panel like sleepypod: `trpc-to-openapi` fetch handler mounted in Hono at `/api/*`, spec at `/api/openapi.json`, docs at `/api/docs`, panel at `/panel` | ∥ 0.4 | lands with the first router in Phase 3 but the CI artifact job is Phase 0 |

**Exit criteria:** a `feat:` PR dev→main cuts `v0.1.0` with a Release containing an (empty) core tarball and `hald` binaries for both targets; Codecov comments on PRs; `dev` auto-deploys to Vercel; docs site live on Pages.

### Phase 1 — Hardware reconnaissance & root  ⏱ ½ day hands-on  **∥ Phase 0 (fully independent)**

| # | Task | ∥ | Notes |
|---|---|---|---|
| 1.1 | Open the unit; photograph the PCB (both sides), the Pi, header orientation, camera USB routing, PSU rating. Commit to `docs/hardware/` | | This decides Topology B feasibility |
| 1.2 | **`dd` the stock microSD** to an image; store off-repo (it's Gardyn's proprietary firmware). Note card size | ⛔ 1.1 | rollback path — never skip |
| 1.3 | Optional: mount the image read-only, inventory their services/pins/cloud endpoints into `docs/hardware/stock-firmware-notes.md` (no code copied) | ∥ 1.4 | pure recon; useful for confirming pin map on our revision |
| 1.4 | Flash Raspberry Pi OS Lite (64-bit if Zero 2) with SSH + Wi-Fi + hostname preconfigured in Imager; boot; `ssh` in | ⛔ 1.2 | **this is "root"** — owning the boot media |
| 1.5 | Probe: `i2cdetect -y 1`; run upstream's Python drivers *as throwaway probes only* (`distance.py`, `light.py --on`, `pump.py --on --speed 20` for 5 s with water present, both cameras) to confirm every row of §0.1 on *our* model | ⛔ 1.4 | record actual addresses/model; AM2320 won't show in i2cdetect without wake |
| 1.6 | Record findings: `docs/hardware/pin-map.md` (authoritative), update §0.1, file ADR-0008 *Target controller* (stay on Zero W vs Zero 2 W vs Pi 5) | ⛔ 1.5 | |
| 1.7 | If upgrading: order Zero 2 W (no header) + header, or Pi 5 + 40-pin ribbon + USB-C PSU; for Pi 5 plan to cut 5 V on the ribbon (keep GND) and re-route cameras | ∥ 1.6 | |

**Exit criteria:** we can toggle light and pump and read every sensor from a shell on our own OS, with the pin map confirmed and the stock image backed up.

### Phase 2 — HAL (Rust daemon)  ⏱ 1–2 weeks  ⛔ Phase 1.6 (pin map) · Phase 0.6 (CI)

| # | Task | ∥ | Notes |
|---|---|---|---|
| 2.1 | ADR-0007 finalize **HAL contract** (freeze before 2.4 so core can start): MQTT topic tree, payload schemas (JSON, versioned `v1`), HTTP endpoints, HA discovery entity set, mDNS service `_seedypod-hal._tcp` with TXT `id`,`model`,`v` | | the one artifact that unblocks Phase 3 in parallel |
| 2.2 | `hal-core`: `Sensor`/`Actuator` traits, config-driven registry (`hal.toml`: `[[sensor]] kind="ina219" addr=0x40`), unit types, `Reading{ts,value,unit,quality}`, reprobe-on-failure | ⛔ 2.1 | pH/EC/RTD later are just more registry entries |
| 2.3 | `hal-core::safety`: pump max-run timer, dry-run interlock (distance median vs threshold), over-temp cutoff (GPIO25 + PCT2075 hysteresis 34/36 °C), light sanity; **fault ⇒ latched off until `acknowledge`**; every actuator command passes through here | ⛔ 2.2 | §0.2 items 1, 3, 6; unit-test exhaustively; ADR-0009 *Pump safety guard* (sleepypod ADR-0022 shape) |
| 2.4 | `hal-sim` backend: deterministic fake hardware (tank drains when pump runs, temp drifts, cameras serve fixtures). Used by `hald --sim`, by core's demo mode, and by CI | ∥ 2.3 | |
| 2.5 | Drivers (one PR each, all ∥ after 2.2): `pwm-light` (rppal hw PWM, 8 kHz) · `pwm-pump` (thread soft-PWM 50 Hz, duty cap configurable, default 30 %) · `ina219` · `pct2075` · `dht20` · `am2320` (wake write) · `dyp-a01` (trig/echo, 5-sample median, timeout) · `button` (debounce, single/double/long) · `uvc` (v4l2 or fswebcam shell-out; mutex; skip ≥10 frames; validate JPEG size) | ∥ each other | each ships with a loopback/sim test |
| 2.6 | `hald`: tokio runtime; rumqttc client with LWT `…/availability`; publish telemetry at configurable cadence + on change; subscribe commands; axum `GET /health`, `GET /camera/{upper,lower}` (JPEG), `GET /system`; mDNS advertise; persisted state file for power-loss recovery; SIGTERM ⇒ pump off | ⛔ 2.3, 2.5 | |
| 2.7 | HA discovery published by the HAL itself (light, fan-as-pump w/ percentage, sensors with proper `device_class`, binary_sensor water_low, `event` entity for button) so HA works with **zero core** | ∥ 2.6 | upstream's entity set is the starting list |
| 2.8 | Per-unit identity (`/proc/cpuinfo` Serial) + model detection (I²C fingerprint) | ∥ 2.6 | |
| 2.9 | Packaging: `scripts/install-hal.sh` (systemd unit, `hal.toml`, user `hal` in `gpio`,`i2c`,`video`), OTA-able self-update from GitHub Release assets, `hald --check` config lint | ⛔ 2.6 | |
| 2.10 | On-device soak: 72 h on the real unit with scheduled runs from `mosquitto_pub` only; watch for PWM glitches, I²C dropouts, camera lockups | ⛔ 2.9 | |
| 2.11 | ADR-0006/0007/0009 → Accepted; docs `content/hal/` | ⛔ 2.10 | |

**Exit criteria:** `hald` runs as a service on the unit, HA sees the device via discovery alone, all §0.2 invariants have tests, CI builds both targets, coverage flag `rust` reporting.

### Phase 3 — Core (tRPC / scheduler / DB / MCP)  ⏱ 1–2 weeks  ⛔ Phase 2.1 (contract) · **∥ Phase 2.2–2.10**

Core is built against `hal-sim` from day one; real hardware only enters at 3.9.

| # | Task | ∥ | Notes |
|---|---|---|---|
| 3.1 | `src/hardware/halClient`: MQTT subscribe/publish + HTTP; typed by the contract (zod schemas generated from a shared JSON Schema in `hal/contract/`); capability probing from mDNS/`/system` not from config (sleepypod probe-first pattern) | | |
| 3.2 | Drizzle + SQLite schema: `device_settings`, `device_state`, `telemetry` (downsampled), `schedules` (light/pump/capture), `grow_cycles`, `pods` (30 slots: plant, planted_at, notes), `alerts`, `captures`, `light_hours` (cumulative, for LED aging) | ∥ 3.1 | ADR-0010 *Drizzle/SQLite* (copy) |
| 3.3 | tRPC routers: `device`, `light`, `pump`, `sensors`, `schedule`, `grow`, `pods`, `camera`, `alerts`, `system`; event bus → mutation broadcast (ADR-0015 pattern) delivered to the UI as **tRPC subscriptions over SSE** (`httpSubscriptionLink`) — no WebSocket server/port; add `@hono/node-ws` only if a high-rate stream (live camera preview) ever needs it | ⛔ 3.1, 3.2 | the Pi provides nothing here; transports are purely the server's |
| 3.4 | Scheduler: cron-parser + node-schedule; light curves (sunrise/sunset ramps), pump cycles (duration not on/off pairs), capture intervals; schedule compiler clamps to HAL limits | ∥ 3.3 | |
| 3.5 | Grow-cycle state machine + reminders (thinning d14, root-check d21, harvest d35, nutrients every 7 d — all settings); acknowledge from UI/HA/MCP | ∥ 3.4 | |
| 3.6 | Alerts module: persisted, dismissible (`water_low`, `pump_fault`, `over_temp`, `camera_missing`, `hal_offline`) | ∥ 3.4 | |
| 3.7 | MCP server on top of tRPC, sleepypod shape exactly: Hono route `/api/mcp` stateless Streamable HTTP (fresh `McpServer` + `WebStandardStreamableHTTPServerTransport({sessionIdGenerator: undefined, enableJsonResponse: true})` per request, Origin≠Host rejected as DNS-rebinding guard, GET/POST/DELETE), implementation in `src/mcp/{server,caller,schemas,units}.ts` + `tools/{status,control,schedules,grow,maintenance,settings}.ts`; tools = read state, set light/pump within limits, run-once pump, capture still, schedule CRUD, grow actions; resources = latest telemetry, captures; **MHS-shaped**: every capability a named read/write primitive with units + declared limits (ADR-0011 *MCP & MHS alignment*) | ⛔ 3.3 | |
| 3.8 | Demo mode (`VITE_DEMO=1`): tRPC `demoLink` with in-browser handlers over `hal-sim`-equivalent TS fakes + seeded history; powers Vercel | ⛔ 3.1 | port sleepypod `src/demo/` |
| 3.9 | Integration against real `hald` on the bench (Topology A); contract tests in `tests/` | ⛔ 2.10, 3.3 | |
| 3.10 | Stryker shards: `server`, `scheduler`, `hardware`, `grow`, `alerts`, `db` | ∥ 3.9 | |
| 3.11 | Install/deploy: `scripts/install` (systemd `core.service` :3000 running `node server/dist/index.js` + `web/dist`), `scripts/deploy` (build locally, archive over SSH), update-from-Release via tRPC (sleepypod `sp-update` pattern, `gp-*` bin scripts); LAN-only iptables policy; measure RSS on Zero 2 W (target < 120 MB) | ∥ 3.9 | ADR-0012 *Deployment* |

**Exit criteria:** core schedules and drives a real unit via `hald`; MCP client (Claude) can read sensors and run a bounded pump cycle; Vercel demo works without hardware.

### Phase 4 — Web UI  ⏱ 1 week  ⛔ 3.3 (routers) · **∥ 3.4–3.11**

| # | Task | ∥ | Notes |
|---|---|---|---|
| 4.1 | **Port the sleepypod design system** (ADR-0016 *Shared design language*): copy `app/globals.css` (Tailwind 4 `@theme`, ~250 semantic vars, IBM Plex Sans/Mono), `src/components/ds/` (core/layout/forms/feedback/notice/toast/charts), `src/ui/` (shadcn `base-vega` on base-ui, lucide, CVA), `src/components/AppShell/` (Sidebar/TabBar/navItems/footerStatus/PullToRefresh). Replace the 5 `next/link` + `next/navigation` imports with TanStack `Link`/`useLocation`/`useSearch`. Rename domain tokens: `--color-cool/warm` → `--color-water/light`, `--side-left/right` → `--pod-ok/--pod-attention`, `--stage-*`/`--chart-vital-*` → growth/telemetry series. Lingui from the start | | ~1 day; do NOT extract a shared `@org/ds` package yet — copy first, extract after the second consumer stabilizes |
| 4.1b | Reuse screen patterns: `Schedule/` (CurveEditor, CurveChart, SetPointEditor, DaySelector, TimeInput, ConfirmDialog) → light curves + pump schedules; `TempControl` dial → brightness; `Sensors`/`Environment` cards → telemetry; `status/`+`diagnostics/` → HAL health | ⛔ 4.1 | |
| 4.2 | Screens: Dashboard (live sensors, water gauge, light/pump state), Lights (brightness + curve editor), Water (run-once with countdown, history, tank calibration), Schedule editor, Grow cycle + 30-pod grid, Cameras (latest + timelapse scrubber), Alerts banner, Settings (HAL URL, MQTT, HA, limits, units) | ∥ each other after 4.1 | |
| 4.3 | Browser tests (playwright `*.e2e.ts` via `tests/browser/run.mjs`, `webServer: node server/dist/index.js` with `CI=1`, temp DBs seeded) in CI "Browser Tests" lane | ⛔ 4.2 | |
| 4.4 | Wall-display mode (kiosk route, large type, dark) — the "extending displays" lesson | ∥ 4.3 | |
| 4.5 | Docs `content/core/` user guide, screenshots captured via `capture/` scripts like the sleepypod site | ⛔ 4.2 | |

**Exit criteria:** everything controllable from the UI; demo on Vercel; docs with screenshots.

### Phase 5 — Integrations  ⏱ 3–5 days  ⛔ Phase 3 · **tasks ∥ each other**

| # | Task | Notes |
|---|---|---|
| 5.1 | HA: core-level bridge adds what HAL discovery can't (grow-cycle reminders as events, alerts, schedule enable switches, run-once service); `docs/homeassistant/lovelace-example.yaml`; ADR-0013 *MQTT bridge* (copy ADR-0019) | HAL-only HA already works from Phase 2 |
| 5.2 | HomeKit via `hap-nodejs` (light as Lightbulb, pump as Switch/Fan, sensors) — reuse sleepypod identity derivation ADR-0020 | optional |
| 5.3 | iOS: evaluate forking `sleepypod/ios` shell (tRPC client, networking, mock client pattern) → `seedypod/ios` | optional; separate repo |
| 5.4 | M5 Dial / small physical controller for light+pump (sleepypod `m5-rotary-dial` pattern, mDNS discovery) | optional |
| 5.5 | Notifications: HA is the delivery channel; no push service of our own | decision in ADR-0013 |

### Phase 6 — Hardware expansion  ⏱ 1–2 weekends  ⛔ Phase 2 · **∥ Phases 4–5**

| # | Task | ∥ | Notes |
|---|---|---|---|
| 6.1 | Pi 5 swap (Topology B): ribbon, cut 5 V, own PSU, cameras to Pi USB; `hald` on `aarch64`; note `pigpio` is irrelevant to us (rppal works on RP1) | | ADR-0008 update |
| 6.2 | Water chemistry: Atlas EZO-pH (I²C 0x63), EZO-EC (0x64), EZO-RTD (0x66) on the shared bus **with Atlas isolated carrier** (pH/EC interfere in one reservoir otherwise); drivers in `hal-drivers`; calibration flows in UI; HA `device_class` ph/conductivity/temperature | ∥ 6.1 | registry entries + 3 small drivers |
| 6.3 | Dosing: 2–3 peristaltic pumps (pH-down, nutrient A/B) on spare GPIO via a MOSFET board; `Actuator` entries with hard daily volume caps in `safety`; dosing controller in core (target bands, hysteresis, lockout after N doses) — **off by default, ADR-0014 *Auto-dosing safety*** | ⛔ 6.2 | the feature Gardyn doesn't sell |
| 6.4 | Light-hours counter → LED aging estimate + replace reminder (upstream's "Maintenance" milestone idea) | ∥ 6.2 | trivial once 3.2 exists |
| 6.5 | `knowledge/` OKF: concepts for nutrient/pH target bands by crop, calibration protocol, tank geometry — each with `sources` | ∥ 6.2 | |

### Phase 7 — Plant intelligence (CV)  ⏱ open-ended  ⛔ 6.1 (compute) or off-device inference · **∥ Phase 5**

| # | Task | Notes |
|---|---|---|
| 7.1 | Capture pipeline: hourly stills → per-pod crops (fixed camera, fixed pod geometry ⇒ static crop map per model) → timelapse | core |
| 7.2 | Germination / growth detection per pod: start with classical CV (green-pixel area over time) before any model; evaluation protocol + metrics as OKF concepts (sleepypod `training` pattern) | |
| 7.3 | `training/` repo (Python, uv, OKF knowledge base) if/when a learned model is justified; vendor pinned core files with checksums like sleepypod | separate repo |
| 7.4 | MCP: expose "which pods look unhealthy" as a resource; Claude as the agronomist over MCP | |

### Phase 8 — Hardening & 1.0  ⏱ 1 week  ⛔ everything above

| # | Task | ∥ | Notes |
|---|---|---|---|
| 8.1 | 30-day unattended soak on the primary unit; alert on every fault class at least once (inject via `hald --sim-fault`) | | |
| 8.2 | Security: LAN-only default, optional API key for tRPC/MCP, MQTT TLS opt-in flags (two-flag split from ADR-0019); `PRIVACY.md` (cameras never leave LAN) | ∥ 8.1 | |
| 8.3 | Coverage audit doc (`docs/testing/coverage-audit-<date>.md`), Stryker baseline ≥ sleepypod's | ∥ 8.1 | |
| 8.4 | Docs complete: getting-started (flash → install → first schedule in 15 min), hardware guides per Gardyn model, troubleshooting, migrating-from-garden-of-eden | ∥ 8.1 | |
| 8.5 | Release `v1.0.0` via `feat!:` PR to `main`; announce; link MHS waitlist/alignment note in README | ⛔ 8.1–8.4 | |

**Done** = a second Gardyn (or a Studio) can be liberated by someone else from the docs alone, HA + MCP + UI all work, and every safety invariant has a test and an alert.

---

## 3. Critical path & parallelism map

```
Phase 0 ──────────────────────────┐
Phase 1 (independent) ────────────┤
                                  ├─► 2.1 contract ─┬─► Phase 2 (HAL) ───┐
                                  │                 └─► Phase 3 (core) ──┼─► 3.9 integrate ─► Phase 4 (UI) ─┐
                                  │                                      │                                  ├─► Phase 8
                                  │                                      ├─► Phase 5 (integrations) ────────┤
                                  │                                      └─► Phase 6 (hardware) ─► Phase 7 ─┘
```

Two people could run Phase 2 and Phase 3 fully in parallel after 2.1; one person should do 2.1–2.4 first, then alternate.

---

## 4. ADR index (sleepypod template: Status/Date, Context, Decision, Consequences, References, Authors)

| # | Title | Phase | Seed |
|---|---|---|---|
| 0001 | New repository & naming | 0 | |
| 0002 | License (clean-room, no GPL code vendored) | 0 | |
| 0003 | Core application stack: TS, React, Tailwind 4, Lingui; **Hono + Vite + TanStack Router vs Next.js decided by the 0.0 spike** (hypothesis: Next needs ≥2 GB and build post-processing; SSR unused) | 0 | new — supersedes sleepypod 0003/0004 |
| 0004 | Two-tier split: HAL daemon ↔ core | 0 | new |
| 0005 | tRPC as the primary control plane; MCP and MQTT are additive surfaces | 0 | copy + extend |
| 0006 | Rust for the HAL (vs Python/gpiozero) | 0→2 | new |
| 0007 | HAL contract: MQTT + HTTP, versioned schemas, HA discovery from the HAL | 2 | new |
| 0008 | Target controller per topology (Zero 2 W split / Pi 5 single-box) | 1 | new |
| 0009 | Pump safety guard & fault latching | 2 | adapt 0022 |
| 0010 | Drizzle ORM + SQLite | 3 | copy |
| 0011 | MCP tool design & Model Hardware Standard alignment | 3 | new |
| 0012 | Deployment (tarball releases, update-from-Release, LAN-only) | 3 | adapt |
| 0013 | MQTT bridge for Home Assistant (core-level) | 5 | adapt 0019 |
| 0014 | Auto-dosing safety (caps, lockouts, off by default) | 6 | new |
| 0015 | Event bus & mutation broadcast | 3 | copy |
| 0016 | Shared design language: port sleepypod tokens/ds/ui/AppShell; extraction to a shared package deferred | 4 | new |

---

## 5. HAL contract v1 (draft for ADR-0007)

Prefix `seedypod/<unit-id>/`. Retained where marked. Payloads JSON; numbers SI; `ts` ISO-8601.

| Topic | Dir | Retained | Payload |
|---|---|---|---|
| `availability` | → | yes | `online` / `offline` (LWT) |
| `system` | → | yes | `{model, hal_version, serial, caps:[…], limits:{pump_max_s, pump_max_duty}}` |
| `sensor/<id>` | → | no | `{ts, value, unit, quality}` — ids: `air_temp`, `humidity`, `pcb_temp`, `water_distance`, `water_level_pct`, `pump_v`, `pump_a`, `pump_w`, `ph`, `ec`, `water_temp` |
| `actuator/<id>/state` | → | yes | `{on, level, since, fault?}` — ids: `light`, `pump`, `dose_<n>` |
| `actuator/<id>/set` | ← | — | `{on?, level?, duration_s?}` — HAL clamps and may refuse (`fault` in state) |
| `event/button` | → | no | `{press: single ∣ double ∣ long}` |
| `alert/<kind>` | → | yes | `{active, ts, detail}` — `water_low`, `pump_fault`, `over_temp`, `camera_missing` |
| `alert/<kind>/ack` | ← | — | `{}` clears a latched fault |
| HTTP `GET /health`, `/system`, `/camera/{upper ∣ lower}.jpg` | | | |
| HA discovery `homeassistant/<component>/<unit-id>_<id>/config` | → | yes | standard MQTT discovery; `device.identifiers=[unit-id]` |

---

## 6. OKRs (first quarter) — new for this project; sleepypod has no OKR docs, only ADRs + `knowledge/` (OKF)

**O1 — Own the hardware.**
KR1.1 Stock firmware imaged and replaced on unit #1; pin map confirmed for our model (Phase 1).
KR1.2 `hald` runs 30 days unattended with zero manual interventions (Phase 8.1).
KR1.3 100 % of §0.2 invariants covered by tests; 0 bypass paths (Phase 2.3).

**O2 — Ship the sleepypod-grade stack.**
KR2.1 `v0.1.0` cut from CI within 1 day of repo creation (Phase 0).
KR2.0 Core + HAL run together on the Zero 2 W inside the unit, core RSS < 120 MB (Topology A).
KR2.2 Codecov project ≥ 85 % JS, ≥ 80 % Rust; Stryker score ≥ 70 % on `server`/`scheduler`/`safety`.
KR2.3 Vercel demo + Pages docs live by end of Phase 4.

**O3 — Exceed Gardyn.**
KR3.1 HA, MCP, and web UI control with no cloud account (Phase 3–5).
KR3.2 pH/EC/water-temp telemetry with calibration (Phase 6.2).
KR3.3 One other person liberates their unit from the docs alone (Phase 8 "done").

---

## 7. Open questions (answer before the phase that needs them)

1. **Name.** Settled as `seedypod` (ADR-0001 amendment); still needs a domain + App Store check if an iOS app follows. (Phase 0, ADR-0001)
2. **Which Gardyn do we have?** 1.0/2.0 (AM2320) vs 3.0/Studio (DHT20). Decides driver priority. (Phase 1.5)
3. **Zero W or Zero 2 W inside?** Zero W ⇒ must cross-compile `armv6` and skip any on-device core. (Phase 1.1)
4. **Single repo vs `hal` split out?** Plan assumes single repo (mirrors `modules/` precedent); revisit if Rust CI time dominates. (Phase 2.11)
6. **Does Zero 2 W actually host the core comfortably?** Measure in 3.11; if RSS or SQLite I/O on microSD disappoints, Topology B is a one-line change. (Phase 3)
5. **MHS.** When the spec opens, reconcile ADR-0011 primitive names with it. (Phase 3.7)
