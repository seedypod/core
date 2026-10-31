---
type: "Policy"
title: "Privacy"
description: "No outbound connections unless you configure an off-device mirror; no accounts, no telemetry."
status: "stable"
generated: {"by": "claude/opus-5.5", "at": "2026-10-31T12:00:00+00:00"}
sources: [{"resource": "https://github.com/sleepypod/core", "title": "sleepypod/core (conventions and ADR precedents)"}, {"resource": "/adr/0019-pluggable-capture-analysis.md", "title": "ADR 0019: Pluggable capture analysis"}]
---

# Privacy

seedypod makes no outbound connections unless you configure one. Camera stills
and timelapses stay on the unit (or on the core host you chose) and are served
only on your LAN. There is no account, no telemetry, and no crash reporting.
The Vercel demo runs a simulator in your browser and talks to no backend.

## Opt-in: off-device storage and analysis

Two features send data off the unit, and both are off until you fill them in
under **Settings → Off-device storage and analysis** (ADR 0019):

- **Mirror.** With an S3-compatible endpoint, bucket and keys saved, every new
  still (and any analysis mask you chose to keep) is copied to that bucket.
  The bucket is yours: seedypod talks to no other service, and the keys stay
  on the unit (they are never returned by the API). Clear the endpoint to stop
  copying; objects already in the bucket stay until you delete them there.
- **Result ingest.** With an ingest token set, a worker you run elsewhere can
  post analysis results to `POST /api/analyses/results`. Nothing leaves the
  unit for this: the worker reads stills through the same REST API (and API
  key, if you set one) as any other LAN client.

A dataset export (`GET /api/datasets/export`) is a download you start; it goes
only to the browser or script that asked for it.
