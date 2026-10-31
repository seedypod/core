# Architecture decision records

Format follows sleepypod/core (`# ADR NNNN: Title`, Status/Date, Context, Decision, Consequences, amendments appended) with OKF frontmatter on top. `status: stable` = Accepted, `draft` = Proposed.

- [0001 New repository and naming](0001-new-repository.md)
- [0002 License](0002-license.md)
- [0003 Core application stack](0003-core-stack.md)
- [0004 Two tiers — hardware daemon and core](0004-two-tier-hal-core.md)
- [0005 tRPC as the primary control plane](0005-trpc.md)
- [0006 Rust for the hardware daemon](0006-rust-for-the-hal.md)
- [0007 HAL contract v1](0007-hal-contract.md)
- 0008 Target controller per topology — *after Phase 1*
- [0009 Pump safety guard and latched faults](0009-pump-safety-guard.md)
- [0010 Drizzle ORM + SQLite behind a Store interface](0010-drizzle-sqlite-store.md)
- [0011 MCP tool design and MHS alignment](0011-mcp-and-mhs.md)
- [0012 Deployment and trust model](0012-deployment-and-trust.md)
- [0013 Core-level MQTT bridge for Home Assistant](0013-ha-bridge.md)
- [0014 Auto-dosing safety](0014-auto-dosing-safety.md) — proposed
- [0015 Event bus and mutation broadcast](0015-event-bus.md)
- [0016 Shared design language with sleepypod](0016-shared-design-language.md)
- [0017 iOS client — reuse sleepypod's transport, not its app](0017-ios-client.md) — proposed
- [0018 Runtime sensor inventory](0018-runtime-sensor-inventory.md)
- [0019 Pluggable capture analysis](0019-pluggable-capture-analysis.md) — proposed
