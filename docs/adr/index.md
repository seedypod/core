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
- 0010 Drizzle ORM + SQLite · 0011 MCP & MHS alignment · 0012 Deployment · 0013 MQTT bridge · 0014 Auto-dosing safety · 0015 Event bus · 0016 Shared design language — *planned*
