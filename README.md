<p align="center">
  <img src="web/public/favicon.svg" width="72" alt="" />
</p>
<h1 align="center">seedypod</h1>
<p align="center"><strong>Truly own your Gardyn.</strong> Local, cloud-free control for Gardyn hydroponic towers.</p>
<p align="center">
  <a href="https://github.com/seedypod/core/actions/workflows/test.yml"><img src="https://github.com/seedypod/core/actions/workflows/test.yml/badge.svg?branch=dev" alt="CI" /></a>
  <a href="https://github.com/seedypod/core/actions/workflows/rust.yml"><img src="https://github.com/seedypod/core/actions/workflows/rust.yml/badge.svg?branch=dev" alt="HAL (Rust)" /></a>
  <a href="https://codecov.io/gh/seedypod/core"><img src="https://codecov.io/gh/seedypod/core/branch/dev/graph/badge.svg" alt="codecov" /></a>
  <a href="https://github.com/seedypod/core/releases/latest"><img src="https://img.shields.io/github/v/release/seedypod/core?sort=semver" alt="Release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL_v3-blue.svg" alt="License: AGPL v3" /></a>
  <a href="https://seedypod.github.io"><img src="https://img.shields.io/badge/docs-seedypod.github.io-blue" alt="Docs" /></a>
  <a href="https://seedypod.vercel.app"><img src="https://img.shields.io/badge/live_demo-seedypod.vercel.app-brightgreen" alt="Live demo" /></a>
</p>
<p align="center">
  <a href="https://seedypod.vercel.app">Live demo</a> ·
  <a href="https://seedypod.github.io/getting-started/">Get started</a> ·
  <a href="https://seedypod.github.io/core/">User guide</a> ·
  <a href="https://seedypod.github.io/developers/">Developer docs</a> ·
  <a href="https://github.com/seedypod/core/issues">Issues</a>
</p>

A Gardyn has a Raspberry Pi inside and a cloud subscription in front of it. seedypod replaces the cloud with software that runs on that Pi. There's no account and no telemetry, and nothing leaves your LAN unless you turn it on. It's a sibling of [sleepypod](https://github.com/sleepypod).

**No Gardyn? [Try the live demo](https://seedypod.vercel.app).** It runs the real web UI against a simulated tower in your browser.

## How it works

| Part | What it does |
|---|---|
| **`hald`** (Rust) | Owns the pins and buses: the light, pump, sensors, cameras and button. A safety guard checks every pump and dose command. It publishes over MQTT with Home Assistant discovery. |
| **core** (TypeScript) | Runs scheduling, grow cycles, Autopilot rules, camera analysis and alerts. It serves a React web UI, a tRPC/REST API and an [MCP](https://modelcontextprotocol.io) endpoint for AI agents. |

## Features

- **Light and water:** light curves and pump cycles, with a 30-minute manual hold.
- **Autopilot:** WHEN/IF/THEN rules over live readings. Rules run as dry-runs until you arm them, and a backtest shows what one would have done.
- **Grow tracking:** grow cycles with reminders, a 30-pod layout, and camera captures with per-pod growth trends.
- **Probes:** add pH, EC and water-temperature probes from the app, with guided calibration.
- **Integrations:** Home Assistant over MQTT, MCP for agents, optional capture mirroring to S3-compatible storage, and dataset export.
- **Wi-Fi setup:** hold the button for 10 seconds to start a setup hotspot.
- **SD card care:** logs and swap stay in RAM, a meter shows the card's writes per day, and nightly backups go to your bucket. A dead card is a reflash plus **Welcome → Restore from a backup**.

> **Status:** the software is complete and tested against the simulator, but it hasn't run on a real Gardyn yet. Confirming the pin map on hardware is the next step. See [`docs/hardware/pin-map.md`](docs/hardware/pin-map.md).

## Install

Back up the stock microSD card first, then follow [docs/INSTALLATION.md](docs/INSTALLATION.md). On a fresh Raspberry Pi OS:

```sh
curl -fsSL https://raw.githubusercontent.com/seedypod/core/main/scripts/install | bash
```

## Development

No hardware is needed. `pnpm dev` runs core against a simulated HAL.

```sh
pnpm install
pnpm dev                 # core on :3000, web on :5173
pnpm test                # Vitest
pnpm hal:test            # cargo test
pnpm lint && pnpm tsc
```

The REST spec is at `http://localhost:3000/api/openapi.json`, and the MCP endpoint is `POST /api/mcp`.

## Contributing

`dev` is the integration branch, and `main` is release-only. Use conventional commits. A PR into `main` cuts a release, so its title must start with `feat:`, `fix:`, `perf:` or `revert:`. Read [AGENTS.md](AGENTS.md) and the [ADRs](docs/adr/) before changing hardware, safety or schema code.

## License

[AGPL-3.0](LICENSE).

seedypod is a clean-room implementation and uses no code from [iot-root/garden-of-eden](https://github.com/iot-root/garden-of-eden) (GPL-3). That project's pin map and bug history were invaluable references and are credited in [docs/hardware/pin-map.md](docs/hardware/pin-map.md).
