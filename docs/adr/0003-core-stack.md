---
type: "Decision record"
title: "ADR 0003: Core application stack"
description: "TypeScript, Hono, Vite, TanStack Router, Tailwind 4; Next.js rejected pending the memory spike."
status: "draft"
generated: {"by": "claude/fable-5.1", "at": "2026-10-31T04:40:00+00:00"}
sources: [{"resource": "https://github.com/sleepypod/core", "title": "sleepypod/core (conventions and ADR precedents)"}]
---

# ADR 0003: Core application stack

**Status:** Proposed (pending the Phase 0 memory spike)
**Date:** 2026-10-30

## Context

sleepypod/core runs Next.js on the Eight Sleep Pod (aarch64, 2 GB). It works,
but the build needs post-processing (`strip-turbopack-external-hashes`,
hand-copying `.next/static` into standalone, deleting `instrumentation.ts` for
the Vercel demo) and `next start` idles at roughly 150–250 MB. The Gardyn's Pi
Zero 2 W has 512 MB. Nothing in core needs server rendering.

## Decision

- **TypeScript**, strict, everywhere outside `hal/`.
- **Hono** (Node adapter) as the server: `@hono/trpc-server` mounts tRPC,
  `trpc-to-openapi`'s fetch handler provides the REST facade and spec, the MCP
  `WebStandardStreamableHTTPServerTransport` is fetch-standard and mounts as a
  route, and Hono serves the built SPA. One `node server/dist/index.js`.
- **Vite + React 19 + TanStack Router** for the UI: file-based routes with typed
  params and search, static build output.
- **Tailwind 4** with the sleepypod token set (ADR-0016).
- Lingui for i18n from the first user-facing screen (Phase 4.1).

## Alternatives considered

- **Next.js** (sleepypod's choice). Rejected on the memory and build-complexity
  grounds above, *subject to the Phase 0.0 spike*: build sleepypod/core
  unchanged, run under a 512 MB cap on aarch64, and record RSS, boot-to-ready,
  and first-request latency against a hello-world Hono + Vite. If Next fits
  comfortably, this ADR is amended and `app/` ports verbatim.
- **FastAPI / Python.** Would discard the tRPC + MCP + iOS investment.

## Consequences

### Positive
- Core can run on the Zero 2 W already inside the unit (Topology A).
- No build post-processing; one tarball of `web/dist` + `server/dist`.
- Vercel demo is a static SPA build with `VITE_DEMO=1`.

### Negative
- Diverges from sleepypod in `app/`, build scripts, and `vercel.json`;
  routers, MCP, db, hooks and the design system port unchanged.
- Two dev processes (`vite` proxies `/api` to Hono).

**Authors**: @ng
