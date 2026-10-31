---
type: "Decision record"
title: "ADR 0010: Drizzle ORM + SQLite behind a Store interface"
description: "One SQLite file via drizzle on the unit; an in-memory Store with identical semantics for tests and the browser demo."
status: "stable"
generated: {"by": "claude/fable-5.1", "at": "2026-10-31T06:30:00+00:00"}
sources: [{"resource": "https://github.com/sleepypod/core", "title": "sleepypod/core (conventions and ADR precedents)"}]
---

# ADR 0010: Drizzle ORM + SQLite behind a Store interface

**Status:** Accepted
**Date:** 2026-10-31

## Context

sleepypod uses drizzle + better-sqlite3 (ADR 0010 there). seedypod has the
same shape of data (settings, schedules, alerts, history) but also needs the
whole application to run in a browser for the Vercel demo, where native
SQLite is unavailable.

## Decision

`src/store/types.ts` defines `Store`; `SqliteStore` (drizzle, migrations in
`src/db/migrations`, WAL mode) runs on the unit and `MemoryStore` runs in
tests and the demo. One conformance suite exercises both. Routers, scheduler,
grow engine and recorder depend only on the interface.

Telemetry is downsampled (one sample per sensor per minute) into the same
file; a second database is unnecessary at this volume.

## Consequences

- Every new persisted concept is added to the interface, both stores and the
  conformance test — slightly more code, no behaviour drift between demo and unit.
- Migrations are generated with `drizzle-kit generate` and applied at boot;
  the folder is resolved from source, the esbuild bundle, or `MIGRATIONS_DIR`.
