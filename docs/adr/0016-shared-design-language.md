---
type: "Decision record"
title: "ADR 0016: Shared design language with sleepypod"
description: "Tokens, ds/ and ui/ ported verbatim with domain renames; extraction to a shared package deferred."
status: "stable"
generated: {"by": "claude/fable-5.1", "at": "2026-10-31T06:30:00+00:00"}
sources: [{"resource": "https://github.com/sleepypod/core", "title": "sleepypod/core (conventions and ADR precedents)"}]
---

# ADR 0016: Shared design language with sleepypod

**Status:** Accepted
**Date:** 2026-10-31

## Decision

`web/src/globals.css`, `src/components/ds/`, `src/ui/` and `AppShell` are
copies of sleepypod's with domain tokens renamed (`cool/warm` → `water/light`,
`side-left/right` → `pod-ok/pod-attention`, sleep stages → growth phases,
vitals → ph/ec/water). `next/link` and `next/navigation` became TanStack
Router's `Link`/`useLocation`. A shared `@org/ds` package is deliberately
deferred until the second consumer's needs have stabilised.

## Consequences

- The two apps read as one family; fixes are ported by hand until extraction.
