---
type: "Policy"
title: "Privacy"
description: "No outbound connections, no accounts, no telemetry; stills stay on the LAN."
status: "stable"
generated: {"by": "claude/fable-5.1", "at": "2026-10-31T04:40:00+00:00"}
sources: [{"resource": "https://github.com/sleepypod/core", "title": "sleepypod/core (conventions and ADR precedents)"}]
---

# Privacy

seedypod makes no outbound connections. Camera stills and timelapses stay on
the unit (or on the core host you chose) and are served only on your LAN. There
is no account, no telemetry, and no crash reporting. The Vercel demo runs a
simulator in your browser and talks to no backend.
