# Project guidance

## Architecture

Two tiers, one contract (ADR-0004, ADR-0007):

- `hal/` (Rust): `hald` owns the hardware. `hal-core` holds the contract types,
  `Sensor`/`Actuator` traits, the config-driven registry, and `safety::PumpGuard`.
  `hal-sim` is the fake. Real drivers live behind the `hardware` feature.
- `server/` + `src/` (TypeScript): Hono entrypoint; `src/server/` tRPC routers
  (`routers/app.ts` is the root) with trpc-to-openapi at `/api/*`;
  `src/mcp/` the MCP server over the tRPC caller; `src/hardware/` the HAL
  client interface, `SimHal`, and the contract schemas; `src/lib/eventBus.ts`
  the mutation/HAL event bus delivered to the UI as a tRPC subscription (SSE).
- `web/` (Vite + React + TanStack Router): file routes in `web/src/routes/`;
  components in `src/components/`, design system in `src/components/ds/` and
  `src/ui/`, tokens in `web/src/globals.css` (ported from sleepypod).

## Invariants

- **Every actuator command goes through the safety layer.** Never call a
  driver's `set_level` for the pump except from the `PumpGuard` decision path.
  Never add a code path that starts the pump without a bounded duration.
- **Pins, addresses and limits live only in `hal/crates/hald/src/config.rs`
  (and `hal.toml`).** Drivers take them as arguments.
- **The contract is shared.** Change `hal/contract/fixtures/` first, then make
  both `contract.rs` and `contract.ts` accept it. Both test suites parse the
  fixtures.
- **A fault latches.** Faults clear only via `acknowledge`; no auto-recovery
  without an explicit, default-off setting and an ADR.
- LAN-only trust model: no auth on tRPC/MCP; never add a route that reaches
  the internet from the unit.
- Vitest tests are colocated in `src/<area>/tests/`; Rust tests in-module.
  Add a behavioral regression test with every fix; Stryker tracks survivors.
- Conventional commits. Keep PRs small (single concern) so review tooling
  reads the whole diff.

## Releases

Every PR to `main` is a release promotion. Its title must start with `feat:`,
`fix:`, `perf:`, or `revert:` (optional scope and `!`). The PR title gate
enforces this. `main`'s merge queue squashes, so `back-merge.yml` pushes a real
`--no-ff` merge of `main` into `dev` after each release; it needs the
`BACKMERGE_TOKEN` secret (org-admin fine-grained PAT, or a GitHub App token on
the Dev ruleset bypass list). Without it, it skips; on conflict it opens an
issue with the manual steps.

## Hardware debugging

`docs/DEBUGGING.md` covers SSH, `hald --check`, `journalctl -u hald`, I²C
probing, and reading the latched-fault state.
