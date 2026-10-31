---
type: "Decision record"
title: "ADR 0011: MCP tool design and Model Hardware Standard alignment"
description: "Tools are named read/write primitives with units and declared limits over the tRPC caller; refusals are errors."
status: "stable"
generated: {"by": "claude/fable-5.1", "at": "2026-10-31T06:30:00+00:00"}
sources: [{"resource": "https://github.com/sleepypod/core", "title": "sleepypod/core (conventions and ADR precedents)"}, {"resource": "https://www.anthropic.com/news/model-hardware-standard-research-preview", "title": "Model Hardware Standard research preview"}]
---

# ADR 0011: MCP tool design and Model Hardware Standard alignment

**Status:** Accepted
**Date:** 2026-10-31

## Context

Anthropic's Model Hardware Standard (research preview) describes devices as
a standardized driver with read/write primitives, discovery, and a reference
file of what can be measured, what can be adjusted, and the safety limits —
controlled through MCP, a CLI, or code files. The preview is not public yet.

## Decision

`src/mcp/server.ts` exposes tools that map onto that shape now:

- Reads: `status`, `history`, `list_schedules`, `pods`, `captures`, `pod_health`;
  resources `seedypod://sensors` and `seedypod://limits`.
- Writes: `set_light`, `run_pump`, `stop_pump`, `acknowledge_alert`,
  `upsert_schedule`, `delete_schedule`, `update_pod`, `grow_cycle`,
  `capture_still`.
- Every tool calls the tRPC caller, never the HAL directly, so the pump guard
  applies; a refusal is returned as a tool error with the HAL's reason.
- Limits are discoverable (`limits` resource, and in `status`) rather than
  implied, so an agent can plan within them.

Transport is stateless Streamable HTTP at `/api/mcp` with an Origin≠Host
rejection (DNS-rebinding guard), as in sleepypod.

## Consequences

- When MHS opens, the device reference file is generated from `SystemInfo`
  plus the tool list; primitive names may be renamed to match the spec.
