---
type: "Guide"
title: "Deployment"
description: "How code moves from dev and main to a unit: tarballs, dev-latest, releases, scripts/deploy."
status: "draft"
generated: {"by": "claude/fable-5.1", "at": "2026-10-31T04:40:00+00:00"}
sources: [{"resource": "https://github.com/sleepypod/core", "title": "sleepypod/core (conventions and ADR precedents)"}, {"resource": "/adr/index.md", "title": "Architecture decision records"}]
---

# Deployment

How code gets from `dev` to a unit (mirrors sleepypod/core).

- **`dev`** → every push builds a tarball (`build.yml`) and re-tags the rolling
  `dev-latest` prerelease (`dev-release.yml`). `scripts/install --branch dev`
  installs it.
- **`main`** → `release.yml` cross-builds `hald` for armv6 and aarch64, builds
  core, and `semantic-release` publishes `vX.Y.Z` with the tarball and both
  binaries attached. `scripts/install` (no args) installs the latest release.
- **Feature branches** → `build.yml` tarball artifact, installable via
  `nightly.link` with `scripts/install --branch <name>`.
- **Local** → `scripts/deploy user@host` builds here and ships over SSH.

The unit runs two systemd services: `hald` (Rust, owns hardware) and
`seedypod-core` (Node, `:3000`). Both restart on failure. Core is LAN-only;
no outbound connections are made by either service.

## Repository secrets and variables

| Name | Kind | Used by | How to get it |
|---|---|---|---|
| `VERCEL_TOKEN` | secret | `vercel.yml` | vercel.com/account/settings/tokens → Create, scoped to *therealng's projects* |
| `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` | secrets | `vercel.yml` | set: team `therealngs-projects`, project `seedypod-demo` (`vercel project inspect seedypod-demo`) |
| `VERCEL_ENABLED` | variable = `true` | `vercel.yml` | Settings → Variables; the workflow is skipped until set |
| `BACKMERGE_TOKEN` | secret | `back-merge.yml` | fine-grained PAT owned by a `seedypod` org admin (admins bypass the `Dev` ruleset), resource owner `seedypod`, repo `core`, `Contents: read and write` |
| `RENOVATE_TOKEN` | secret | `renovate.yml` (self-hosted, Mondays 06:00 UTC) | fine-grained PAT, repo `seedypod/core`: Contents, Pull requests, Issues, Workflows read/write. The job skips while it is unset or the placeholder |

Coverage needs no secret: `test.yml` and `rust.yml` upload to Codecov with GitHub OIDC (`use_oidc: true`, `id-token: write`), and fork PRs fall back to Codecov's tokenless upload. No `CODECOV_TOKEN` secret is needed.

Renovate: minor/patch automerge after 3 days, Mondays; majors and the core stack (react, router, hono, vite, rppal, tokio…) stay manual; cargo is enabled; vulnerability alerts get the `security` label.
