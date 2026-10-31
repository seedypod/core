---
type: "Decision record"
title: "ADR 0012: Deployment and trust model"
description: "Tarball releases with hald binaries, systemd units, LAN-only trust with an opt-in API key."
status: "stable"
generated: {"by": "claude/fable-5.1", "at": "2026-10-31T06:30:00+00:00"}
sources: [{"resource": "https://github.com/sleepypod/core", "title": "sleepypod/core (conventions and ADR precedents)"}]
---

# ADR 0012: Deployment and trust model

**Status:** Accepted
**Date:** 2026-10-31

## Decision

- `main` releases via semantic-release with `leafypod-core.tar.gz` and the
  cross-built `hald` binaries attached; `dev` keeps a rolling `dev-latest`.
- `scripts/install` (core) and `scripts/install-hal` (daemon) set up systemd
  units; `scripts/deploy` ships a local build over SSH.
- **LAN-only trust.** tRPC, REST, MCP and the WebSocket stream have no
  authentication by default. An optional API key (settings) protects
  non-loopback clients; loopback is always exempt so the unit's own UI and
  scripts keep working. Core makes no outbound connections except to brokers
  the operator configures.
- MQTT credentials are stored in plaintext in `device_settings`, for the
  reasons sleepypod ADR 0019 gives: anyone with the database already owns
  the unit.
