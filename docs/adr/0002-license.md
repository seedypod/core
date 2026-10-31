---
type: "Decision record"
title: "ADR 0002: License"
description: "AGPL-3.0, clean-room with respect to the GPL-3 upstream."
status: "stable"
generated: {"by": "claude/fable-5.1", "at": "2026-10-31T04:40:00+00:00"}
sources: [{"resource": "https://github.com/sleepypod/core", "title": "sleepypod/core (conventions and ADR precedents)"}, {"resource": "https://github.com/iot-root/garden-of-eden", "title": "iot-root/garden-of-eden (reference implementation, GPL-3; no code copied)"}]
---

# ADR 0002: License

**Status:** Accepted
**Date:** 2026-10-30

## Context

`iot-root/garden-of-eden` is GPL-3.0. `sleepypod/core` is AGPL-3.0. We want
to stay free to choose, and we want the same license across the sleepypod
family.

## Decision

**AGPL-3.0-only**, same as sleepypod. The implementation is clean-room: no
source from garden-of-eden is copied. Facts about the hardware (pin numbers,
I²C addresses, part numbers, observed failure modes) are not copyrightable and
are credited in `docs/hardware/pin-map.md`.

## Consequences

- Contributors must not paste upstream code; reimplement from the documented
  behaviour.
- Anyone running a modified seedypod as a network service must publish their
  changes — appropriate for a project whose whole point is owning your device.

**Authors**: @ng
