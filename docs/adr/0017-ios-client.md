---
type: "Decision record"
title: "ADR 0017: iOS client — reuse sleepypod's transport, not its app"
description: "Evaluation of forking sleepypod/ios's networking layer against seedypod's tRPC router, and what core must add first."
status: "draft"
generated: {"by": "claude/opus-5.5", "at": "2026-10-31T07:10:00+00:00"}
sources: [{"resource": "https://github.com/sleepypod/ios", "title": "sleepypod/ios (Networking/, Services/PodDiscovery.swift, Services/SensorStreamService.swift)"}, {"resource": "/adr/0005-trpc.md", "title": "ADR 0005: tRPC as the primary control plane"}, {"resource": "/adr/0012-deployment-and-trust.md", "title": "ADR 0012: Deployment and trust model"}]
---

# ADR 0017: iOS client — reuse sleepypod's transport, not its app

**Status:** Proposed
**Date:** 2026-10-31

## Context

Handoff step 5 asked whether `sleepypod/ios` (Swift/SwiftUI, AGPL-3.0, 149
Swift files) can be forked as the seedypod app by pointing its networking
layer at this repo's tRPC router. The relevant pieces of that app:

| Piece | File | What it does | Fits seedypod? |
|---|---|---|---|
| tRPC transport | `Networking/SleepypodCoreClient.swift` (the `// MARK: - tRPC Transport` section, ~150 lines) | `GET /api/trpc/<proc>?input=` and `POST` with a superjson `{"json": …, "meta": …}` envelope, batched queries (`?batch=1`), result/error decoding, transient-error retry | **Yes, as is.** Core mounts the same `@hono/trpc-server` at `/api/trpc` with the `superjson` transformer (ADR-0005), so the wire format is identical |
| Backend protocol | `Networking/SleepypodProtocol.swift` | ~45 bed-specific calls: sides, °F set-points, priming, vitals, sleep stages | **No.** There is no overlap with `sensors`, `light`, `pump`, `schedules`, `grow`, `camera`, `vision`, `alerts` |
| Mock backend | `Networking/MockClient.swift`, `APIBackend.swift` | Demo mode and backend picker behind the protocol | **The pattern, not the code.** A seedypod mock mirrors `SimHal` |
| Discovery | `Services/PodDiscovery.swift` | `NWBrowser` for `_sleepypod._tcp` with TXT records, manual IP fallback | **The pattern only.** Core advertises nothing today; only `hald` advertises `_seedypod-hal._tcp`, and that is the daemon's HTTP port, not core |
| Live stream | `Services/SensorStreamService.swift` | `URLSessionWebSocketTask` to `ws://<ip>:3001` with a receive loop | **The receive loop, retargeted** to `ws://<host>:3000/api/ws` (CoreEvent frames, ADR-0015) |
| Models, views, HealthKit, ML, snore, Watch | the remaining ~85% | Sleep-domain UI and analysis | **No** |

Two gaps sit on the core side: there is no Bonjour advertisement for core,
and when the optional API key (ADR-0012) is set, off-host requests must send
`X-API-Key`, which the sleepypod client never does.

## Decision

Do **not** fork `sleepypod/ios`. Start `seedypod/ios` as a new app and copy in,
with attribution (both repos are AGPL-3.0 and have the same maintainer):

1. the tRPC transport (`query`, `mutate`, `batchQuery`, decoding, retry), with
   an optional `X-API-Key` header added;
2. the `NWBrowser` discovery pattern, browsing `_seedypod._tcp`;
3. the WebSocket receive loop, pointed at `/api/ws`;
4. the protocol + mock + backend-picker structure, re-expressed as a
   `SeedypodProtocol` over this router: `system.info`, `sensors.latest`,
   `light.set`, `pump.runOnce`/`stop`, `schedules.*`, `grow.*`, `camera.*`,
   `alerts.list`/`acknowledge`.

Shared UI comes from the design language that is already ported (ADR-0016),
not from sleepypod's sleep views.

Generating a Swift client from `/api/openapi.json` with
`swift-openapi-generator` is the fallback if hand-written tRPC calls drift.
Every procedure already declares input and output schemas, so the REST facade
is complete.

## Prerequisites in core (before the app)

- Advertise core over mDNS as `_seedypod._tcp` on its HTTP port, with TXT
  `id` (unit), `v` (version) and `auth` (`1` when an API key is set).
- Keep `/api/ws` frames documented as part of the API reference.

## Consequences

- The app needs about 300 lines of proven networking code instead of a
  1,100-line client rewritten around another domain, and none of sleepypod's
  HealthKit or ML weight comes along.
- Both apps keep the same transport. A fix there should be ported both ways
  until it is worth extracting into a shared Swift package, mirroring the
  deferred extraction in ADR-0016.
- iOS stays optional: the web UI, Home Assistant and MCP cover every
  capability today.

**Authors**: @ng (evaluation drafted with Claude)
