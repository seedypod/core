<p align="center">
  <img src="web/public/favicon.svg" width="72" alt="" />
</p>
<h1 align="center">leafypod</h1>
<p align="center"><strong>Truly own your Gardyn.</strong> Local, cloud-free control for Gardyn hydroponic towers — a sibling of <a href="https://github.com/sleepypod">sleepypod</a>.</p>

<p align="center">
  <a href="https://leafypod.vercel.app">Live demo</a> ·
  <a href="https://leafypod.github.io/getting-started/">Get started</a> ·
  <a href="https://leafypod.github.io/core/">User guide</a> ·
  <a href="https://leafypod.github.io/developers/">Developer docs</a> ·
  <a href="https://github.com/leafypod/core/issues">Issues</a>
</p>

**No Gardyn? [Try the live demo](https://leafypod.vercel.app).** It runs the real web UI against a simulated tower in your browser.

## What it is

A Gardyn is a nice piece of hardware with a Raspberry Pi inside and a cloud subscription in front of it. leafypod replaces the cloud with software you run on the Pi that's already there:

- **`hald`** — a small Rust daemon that owns the pins and buses (grow light, pump, water level, temperature/humidity, power monitor, cameras, button). Every pump command passes through a safety guard: bounded runs, dry-run interlock, over-temperature cutoff, latched faults. Publishes over MQTT with Home Assistant discovery, so HA works with nothing else installed.
- **core** — a Hono + tRPC server with an OpenAPI REST facade, an [MCP](https://modelcontextprotocol.io) endpoint for AI agents, scheduling, grow-cycle reminders, alerts, and a React web UI. Runs on the Zero 2 W inside the unit, or on any box on your LAN.
- **iOS** (planned) — reuses the sleepypod app architecture.

Everything stays on your LAN. No account, no telemetry, no phoning home.

## Status

Phase 0 of the [implementation plan](docs/implementation-plan.md): repo, CI/CD, design system, contract, safety guard, simulator, dashboard. Nothing has touched a real Gardyn yet — that's Phase 1. Watch the plan for progress.

## Quick start (development, no hardware)

```sh
pnpm install
pnpm dev            # core on :3000 with the simulated HAL, web on :5173
pnpm test           # vitest
pnpm hal:test       # cargo test
cargo run --manifest-path hal/Cargo.toml -p hald -- --sim --ticks 3
```

`http://localhost:3000/api/openapi.json` is the REST spec; `POST /api/mcp` is the MCP endpoint.

## Install on a Gardyn

See [docs/INSTALLATION.md](docs/INSTALLATION.md) — back up the stock microSD first, flash Raspberry Pi OS, then:

```sh
curl -fsSL https://raw.githubusercontent.com/leafypod/core/main/scripts/install | bash
```

## Contributing

`dev` is the integration branch; `main` is release-only. Conventional commits; every PR to `main` must be titled `feat:`/`fix:`/`perf:`/`revert:` (the title gate enforces it) because it cuts a release. Read [AGENTS.md](AGENTS.md) and the [ADRs](docs/adr/).

## License

[AGPL-3.0](LICENSE). Clean-room: no code from [iot-root/garden-of-eden](https://github.com/iot-root/garden-of-eden) (GPL-3) is used — its pin map and bug history were invaluable references, and are credited in [docs/hardware/pin-map.md](docs/hardware/pin-map.md).
