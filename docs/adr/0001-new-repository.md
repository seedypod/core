---
type: "Decision record"
title: "ADR 0001: New repository and naming"
description: "Why a new repo instead of a fork, the leafypod name, and the single-repo layout."
status: "stable"
generated: {"by": "claude/fable-5.1", "at": "2026-10-31T04:40:00+00:00"}
sources: [{"resource": "https://github.com/sleepypod/core", "title": "sleepypod/core (conventions and ADR precedents)"}, {"resource": "https://github.com/iot-root/garden-of-eden", "title": "iot-root/garden-of-eden (reference implementation, GPL-3; no code copied)"}]
---

# ADR 0001: New repository and naming

**Status:** Accepted
**Date:** 2026-10-30

## Context

Gardyn hydroponic towers ship with a Raspberry Pi and a cloud subscription. An
existing community project, `iot-root/garden-of-eden` (Python/Flask/pigpio,
GPL-3), proves local control is feasible but has 63 open issues, two never-started
product milestones, and a PR cadence slower than we want to move. We also already
maintain `sleepypod`, which solved the same class of problem (sealed consumer
appliance with an embedded Linux controller) for Eight Sleep hardware.

## Decision

Start a new repository rather than fork. Name the project **leafypod**: the
sleepypod naming pattern, and Gardyn's plant slots are literally called pods.
Until the dormant `leafypod` GitHub organization is released, the repository
lives at `ng/leafypod` and will transfer to `leafypod/core` (GitHub redirects
renames). Sibling repos follow sleepypod: `leafypod/leafypod.github.io` (docs),
later `leafypod/ios`.

Single repository for core (TypeScript) and the HAL (Rust, `hal/`), mirroring
sleepypod's `modules/` precedent with Codecov flags per language.

## Consequences

- No upstream code is vendored (see ADR-0002); the upstream pin map and bug
  history are used as references and credited.
- Conventions (branching, CI, release, docs) are copied from `sleepypod/core`
  so tooling and habits carry over.

**Authors**: @ng
