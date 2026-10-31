---
type: "Decision record"
title: "ADR 0015: Event bus and mutation broadcast"
description: "One process-wide bus carries HAL events and mutations to SSE, WebSocket, the recorder and the HA bridge."
status: "stable"
generated: {"by": "claude/fable-5.1", "at": "2026-10-31T06:30:00+00:00"}
sources: [{"resource": "https://github.com/sleepypod/core", "title": "sleepypod/core (conventions and ADR precedents)"}]
---

# ADR 0015: Event bus and mutation broadcast

**Status:** Accepted
**Date:** 2026-10-31

## Decision

`src/lib/eventBus.ts` is the single fan-out point. `createCore()` subscribes
the HAL to it; routers emit `mutation` events; the scheduler emits
`schedule` events. Consumers: the tRPC `events.onChange` subscription (SSE),
`/api/ws`, the telemetry recorder, and the HA bridge. The UI invalidates
queries on events instead of polling.

Adapted from sleepypod ADR 0015.
