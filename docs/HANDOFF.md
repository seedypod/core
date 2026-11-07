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
| Web (`web/`) | 8 screens + `/kiosk` on the [sleepypod](https://sleepypod.github.io/) design system; seeded in-browser demo (`VITE_DEMO=1`) | 6 Playwright e2e over the built server; all routes rendered headlessly with zero console errors |
| Docs | `docs/` (OKF concepts: ADRs 0001–0016, guides, HAL reference, HA examples, plan, this handoff) and `knowledge/` (4); published at [seedypod.github.io](https://seedypod.github.io) from `seedypod/seedypod.github.io` | `scripts/validate_knowledge.py` in CI |
| Org | `seedypod/.github` profile README; avatar source (`assets/avatar.svg`, sleepypod-style render) | — |

**Simulated Phase 1 done:** [`pnpm test:sim-bringup`](hardware/sim-bringup.md) runs the full stack against `hald --sim` over MQTT in CI (19 checks, including a backup → wipe → restore round trip). It caught a subscribe race that would have kept core from ever seeing a real `hald`.

**Not done, needs hardware (Phase 1 / 2.10):** nothing has run on a real Gardyn. The pin map, I²C addresses, driver timing/CRCs, INA219 calibration, button/GPIO25 polarity, PWM overlay line, camera exposure and the install scripts' Raspberry Pi OS steps are all documented assumptions. The checklist is in `docs/hardware/pin-map.md`; the per-driver list is at the end of `docs/hardware/hal.md`.

**Known deliberate limits:** `hald` MQTT is plain TCP (LAN-only); over-temp uses a single threshold plus the GPIO25 line (latch provides anti-flap); the Next.js memory spike (plan 0.0) was not run — the plan is built on the Hono/Vite outcome.

## 2. Transfer (done 2026-10-31)

The repo moved from `ng/leafypod` to `seedypod/core` (GitHub redirects the old URLs) and the project was renamed to **seedypod** throughout: package, crates, MQTT prefix, mDNS service, install paths and `SEEDYPOD_*` installer variables. Re-attach the Claude GitHub App on the `seedypod` org if you want pushes from Claude sessions.

## 3. Destination settings (applied via the API)

- Default branch **`dev`**. Rulesets `Dev` (default branch, merge queue **merge**) and `Main` (`main`, merge queue **squash**, linear history); org admins bypass. Auto-merge on, branches deleted on merge.
- Required checks on both: `Lint`, `Typecheck`, `Unit Tests`, `Browser Tests`. Left optional on purpose: `fmt + clippy + test` (path-filtered to `hal/**`, so it never reports on TS-only PRs and would block them) and `check-title` (only runs on `pull_request`, never on `merge_group`, so requiring it would stall the queue). Add `codecov/patch` once Codecov reports.
- Secrets: `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` are real (Vercel project `seedypod-demo` in *therealng's projects*, aliased to `seedypod.vercel.app`). `VERCEL_TOKEN` holds a placeholder; back-merge uses a deploy key (`BACKMERGE_DEPLOY_KEY`, set) — see [Deployment](DEPLOYMENT.md#repository-secrets-and-variables) for where each comes from. Variable `VERCEL_ENABLED=true`, so the demo deploy fails until `VERCEL_TOKEN` is real. Codecov needs no token: coverage uploads authenticate with GitHub OIDC.
- Labels: `mutation-test`, `dependencies`, `hardware`, `safety`, `security`.
- Still manual (UI only): install the Codecov and Renovate apps on the org, and upload the org avatar.

## 4. Running it

```sh
pnpm install && pnpm dev                 # core :3000 (simulator), web :5173
pnpm dev:sim                             # the same, seeded with the demo's week of history (./data/sim)
pnpm test · pnpm tsc · pnpm lint         # TS checks
pnpm hal:test                            # Rust
NODE_ENV=production CI=1 pnpm build && pnpm test:browser   # e2e (PW_CHROMIUM=<path> to use a system Chromium)
cargo run --manifest-path hal/Cargo.toml -p hald -- --sim --stdout --ticks 3
python3 -I scripts/validate_knowledge.py
```

On a unit: `scripts/install-hal` then `scripts/install`; set `HAL_MQTT_URL`, `HAL_UNIT_ID` (from `hald --check`) and `HAL_HTTP_URL` in the core service (`docs/INSTALLATION.md`).

## 5. Next steps, in order

1. **Phase 1 on a real unit** (the simulated run is done) — teardown, `dd` the stock card, flash, `hald --check` + `--features hardware` on the unit, confirm the pin map; file ADR-0008 with the real model/controller; mark `knowledge/hardware/*` and `docs/hardware/pin-map.md` as verified. With EZO probes fitted, run the calibration procedure in `docs/hardware/hal.md`.
2. Replace the placeholder secrets (`VERCEL_TOKEN` and the `MIRROR_TEST_*` R2 set) — tracked in seedypod/core#6 — and install the Mend Renovate app on the org (github.com/apps/renovate); it reads `renovate.json`, no token. The demo at seedypod.vercel.app was first deployed by hand with the Vercel CLI.
3. iOS: evaluated in [ADR-0017](adr/0017-ios-client.md) — new `seedypod/ios` app reusing [sleepypod](https://sleepypod.github.io/developers/ios/)'s tRPC transport, discovery and stream patterns; first add a `_seedypod._tcp` mDNS advertisement to core.
4. New probe types (dissolved oxygen, ORP, other vendors): one `SensorKind` impl each (ADR-0018); the Sensors screen and calibration wizard pick them up from the descriptor.

Done since the pause: transfer and rename; repo settings; Vercel project; the `dose_fault` alert kind; the EZO calibration topic; the docs site; the org profile; fixing the crash on first boot when the data directory is missing; adding, calibrating and removing pH/EC/temperature probes from the app (ADR-0018).

## 6. Conventions to keep

Conventional commits; PRs to `main` titled `feat:`/`fix:`/`perf:`/`revert:`; small single-concern PRs; every actuator command through the safety layer; contract changes start with a fixture in `hal/contract/fixtures/`; OKF frontmatter on every doc; run the validator. `AGENTS.md` has the invariants.

## 7. Real unit bring-up (2026-11-06)

First run on real hardware: a Gardyn 3.0, Pi Zero W Rev 1.1, unit `gardyn-db753a85`, on `dev`.

### Where it stands

- The unit runs the OS image from `dev-latest`, built at #106, on a 64 GB card. Its login is `seedypod`, and it sits on a separate IoT network at `192.168.2.177`. Later `dev` changes such as #117 aren't on it yet. The tank is empty, so the pump has never run.
- **Open:** #118, bounded automatic reboot when the hub is missing, reviewed at `677377f`, with `codecov/patch` still pending. Hold it until the hub question below is settled. The persistent boot log is written and passing on top of it in the `camera-fix` agent's worktree, unopened.
- **Release:** `main` is far behind `dev`, and its installer has no ARMv6 path, so a Zero W needs the `dev` commands until `dev` is released. The release is the owner's call.

### Measured

| | Before | Now |
|---|---|---|
| New unit | About 1 hour by hand (53 min compiling `better-sqlite3`) | OS image: core serving 4m31s after power-on, SSH about 7.5 min, on first boot only |
| Update | 6m13s | 1m24s |
| Reboot to core serving | About 4 min | About 2.5 min |
| Card writes | About 440 MB/day | About 63 MB/day (20-minute sample) |
| Core at idle | 6.4% CPU, 90 MB | 3.4% CPU, 109 MB |

Node and SQLite run fine on the Zero W: about 230 MB of RAM stays free, and queries take milliseconds. The compile was the only real pain, and the prebuilt package removes it.

### Confirmed on hardware

Fades, slider taps (touch emulation), port 80, login logo, Database page, Re-run clearing a torn still's scores, and the light surviving reboots. Top and bottom camera names were checked with black pod caps ([marker check](MAINTENANCE.md#check-which-camera-is-which)). Both cameras gave 10 of 10 clean frames on boots with the hub up.

Bugs only the unit could show: the over-temp line reads active low; a first PWM open after boot hit `Permission denied` because udev is slow, so the light was lost until a restart; and fswebcam re-encodes torn frames into valid JPEGs, so only the raw frame shows damage.

Not yet tested: the water sensor with a tank, and the first pump run. Don't run the pump dry. The power-up light flicker is also unexplained: note when it happens.

### The USB hub: the one open fault

The cameras sit behind a `1a40:0801` hub on a small `HUB_V1.1` board, fed by an OTG lead from the Pi's `USB` port. It enumerates on only some boots. Reseating its connectors cured a separate fault on the top camera (`-71`, torn frames), not this one.

| Condition | Hub up |
|---|---|
| Stock logs, kernel 4.14 | 3 of 5 |
| Logged series on the image | 3 of 16 |
| Eight-reboot series on the image | 2 of 8 |
| Stock's `force_turbo=1`, `over_voltage=6` on the image | 3 of 8 (stopped early) |

- On a bad boot `hprt0` stays at `0x00001c00`, both data lines high, so nothing connects and the kernel logs nothing. dmesg matches good boots through `Init: Power Port (0)`; good boots then show `00001101`. No undervoltage: `throttled=0x0`, core 1.35 V.
- **Tried, no effect:** root hub re-probe, `buspower` toggle, port disable, unbind then reboot (1 of 6), `dtoverlay=dwc2`. A period-5 pattern failed its prediction.
- **Never use:** a `dwc_otg` rebind. The bind segfaults and takes USB down until a reboot. #118 removes that code path.
- **Likely cause:** hub start-up or its connection, not Pi software. That's a judgement, not proven: an independent review (Codex) notes the Pi's own USB circuit isn't excluded. Pads `C8` and `C9` on the hub board look unpopulated in a photo, unverified.

**Next, in order:**
1. Rerun stock's settings for 20 or more boots against the same without them. 3 of 8 isn't conclusive. If it holds, a config line may be the fix.
2. With the unit open, on a bad boot: unplug and replug the USB-A plug with the Pi running, which has never been tried.
3. Measure 5 V at the hub board during boot, and D+ and D- on a bad boot.
4. Swap the lead for a short micro-USB OTG one. Try the hub on a laptop. Consider a capacitor at `C8` once a meter shows what the pads connect to.
5. Compare the stock card on this hardware if the above doesn't settle it.

Logs for all of this are in `~/Documents/seedypod/bringup-logs-2026-11-06/`, and photos in `~/Documents/seedypod/doc-screenshots-2026-11-06/` (off-repo; the room shots show the owner's home).

### Smaller follow-ups

- `install --restore` on a unit where core has never run can leave `data/` owned by root: create it as the core account in `finish_prefix`.
- A failed capture's alert can stay quiet if hald clears `camera_missing` first (`said` in `captures.ts`).
- The first-boot SSH figure in [Installation](INSTALLATION.md) still says about 3 minutes: 7.5 on the image.
- The Vercel team is blocked for fair use, so the demo isn't deploying and the `deploy` check fails on every PR. CodeRabbit's included reviews have run out on the `ng/seedypod-core` mirror (`ng/core` is sleepypod's: never push there).
- The docs site hasn't been updated with this work. A Discord write-up was asked for: it needs a channel.


## 8. Controlled hub comparison (2026-11-07)

Forty warm reboots on the same development image, in 20 balanced pairs with the
order within each pair randomized (seed `20261107`). The owner confirmed the unit
was not touched during the series. Each result below is the USB inventory at
184–208 seconds of uptime, with a distinct boot id and the requested firmware
settings verified. These are **not** cold power-cycle results.

| Same image, different boot settings | Hub and both cameras present | Connected before 90 s | Connected after 90 s |
|---|---|---|---|
| Original configuration; reported core voltage 1.35 V | 8 of 20 | 5 | 3 |
| Add `force_turbo=1`, `over_voltage=6`; reported core voltage 1.40 V | 7 of 20 | 3 | 4 |

The stock turbo/voltage settings did not improve the observed success rate and
are not a reliable fix. This sample does not establish that the configurations
are equivalent or rule out a smaller effect. Every sample reported
`throttled=0x0`; that does not measure the hub's supply or exclude a cable fault.

**New evidence changes the recovery question:** seven successful boots first
showed the hub at 123–151 seconds. The recovery service tried root-hub re-probes
at about 90 and 111 seconds. Four late connections were reported as recovered
during the second attempt; three appeared after the service gave up at about
132 seconds. The unit was untouched, so these connections did not require a
physical replug or another reboot. This does **not** prove that re-probing caused
them: a series without automatic re-probes is still needed.

The earlier 01:03 connection, 13 minutes after boot, remains ambiguous: the owner
had reassembled the top container around that period, though the Pi was already
mounted. Do not count it as demonstrated spontaneous recovery.

### Current state and next test

- Original boot configuration restored byte-for-byte (SHA-256 checked); reported
  core voltage back to 1.35 V. Both services, the hub and both cameras are up.
  The temporary test helper and its scoped sudo rule have been removed.
- Keep #118 held. Its proposed default reboot at 90 seconds precedes all seven
  late connections observed here, and removing the root-hub re-probes has not
  been justified by this new evidence. Never rebind the `dwc_otg` controller.
- Next distinguish **waiting** from **retrying**: leave a boot without automatic
  re-probes up longer, then compare with a deliberately delayed root-hub retry.
  Preserve the boot configuration and collect monotonic kernel timestamps in
  both conditions. Root access must be re-established to configure that test;
  the temporary helper covered only this completed comparison.
- If that does not settle the fault, continue the physical checks from section 7:
  live USB-A replug on a failed boot, a known-good OTG lead, hub supply/data-line
  measurements, and comparison with another host or the stock card.
- The tank is still empty. No pump command was issued; filled-tank sensor and
  bounded pump testing remain outstanding.

Raw per-boot JSON (kernel and recovery logs, firmware settings, voltage, USB
inventory and HAL state), the controller and summary are saved off-repo in
`~/Documents/seedypod/bringup-logs-2026-11-07/`. The software follow-ups #120 and
#121 and installation timings #123 are merged. Boot-log PR #122 and release
PR #124 remain drafts; the docs site refresh is deployed. The Discord write-up
is drafted but not posted; no destination channel was supplied.
