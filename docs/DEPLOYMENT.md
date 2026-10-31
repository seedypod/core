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
`leafypod-core` (Node, `:3000`). Both restart on failure. Core is LAN-only;
no outbound connections are made by either service.
