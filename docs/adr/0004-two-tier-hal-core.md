# ADR 0004: Two tiers — a hardware daemon and a core

**Status:** Accepted
**Date:** 2026-10-30

## Context

garden-of-eden runs three control surfaces (Flask REST, an MQTT service, and
per-invocation CLI scripts for cron) over one Python driver layer. Its bug list
shows what that costs: the pump max-run cap duplicated in three places (#114),
scheduled watering bypassing the low-water guard (#108), a pump started outside
the MQTT service never getting the cap (#109), the light glitching whenever a
process starts because each one re-initialises PWM (#131), two readers on one
camera (#117).

## Decision

Exactly one long-lived process owns the hardware: **`hald`** (Rust). It exposes
a small, versioned contract (ADR-0007) over MQTT + HTTP and enforces every
safety rule internally (ADR-0009). Everything else — tRPC, MCP, scheduling,
grow cycle, alerts, UI, Home Assistant extras — is **core**, which talks only
through the contract and never touches a pin.

Deployment topologies, all with the same contract:

| | Pi in the unit | hald | core |
|---|---|---|---|
| A (default) | Zero 2 W | yes | yes |
| B | Zero 2 W | yes | on a LAN box |
| C | Pi 5 | yes | yes (+ on-device CV) |

## Consequences

### Positive
- The safety layer cannot be bypassed by any caller.
- `hald` is an appliance: one static binary, deploy-and-forget; core iterates fast.
- Home Assistant works with `hald` alone via MQTT discovery.
- One core can manage several units.

### Negative
- Two codebases and two languages in one repo; the contract must be kept in
  lock-step (enforced by shared fixtures parsed by both test suites).

**Authors**: @ng
