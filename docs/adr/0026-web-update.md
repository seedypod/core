---
type: "Decision record"
title: "ADR 0026: One-click update from the web UI"
description: "A root update helper core runs through sudo with fixed arguments: it downloads the CI-built release for the chosen channel from GitHub, checks each asset's sha256, swaps it in keeping the previous version, and rolls back if core isn't healthy. The one sanctioned, user-initiated exception to core's no-internet rule."
status: "stable"
generated: {"by": "claude/opus-5.5", "at": "2026-11-08T23:30:00+00:00"}
sources: [{"resource": "https://github.com/sleepypod/core/blob/dev/scripts/bin/sp-update", "title": "sleepypod sp-update"}, {"resource": "https://github.com/seedypod/core/issues/128", "title": "seedypod/core#128: One-click update from the web UI"}, {"resource": "/adr/0012-deployment-and-trust.md", "title": "ADR 0012: Deployment and trust model"}, {"resource": "/adr/0021-sd-card-wear-and-recovery.md", "title": "ADR 0021: SD card wear and fast recovery"}]
---

# ADR 0026: One-click update from the web UI

**Status:** Accepted
**Date:** 2026-11-08

## Context

Updating a unit means SSH and `scripts/install`. A Pi Zero can't build core,
and a Pi Zero W took 53 minutes of a 56-minute install compiling
better-sqlite3 until releases started carrying an ARMv6 build of it. Owners
should be able to update from **Settings**, with no shell, without the unit
building anything, and without being left with a dead unit when an update
goes wrong.

Two rules stand in the way. Core runs as an ordinary account that can't
replace system files or restart services. And core is LAN-only: AGENTS.md
says never to add a route that reaches the internet from the unit (ADR 0012).

sleepypod solves the first with `sp-update`, a root script that downloads a
release tarball and swaps it in. It still runs `pnpm install` on every update
and rolls back only on a service that won't start.

## Decision

### A root helper with fixed arguments

`scripts/seedypod-update.cjs` is installed root-owned as
`/usr/local/sbin/seedypod-update` by `scripts/install`, with the install prefix
written in, like the restore helper (ADR 0021). It uses Node built-ins only and
never loads anything from the prefix, which core's account owns. Overrides
for tests are ignored as root.

`/etc/sudoers.d/seedypod-update` lists every command core may run, each with
its exact arguments:

```text
<core user> ALL=(root) NOPASSWD: /usr/local/sbin/seedypod-update --status
<core user> ALL=(root) NOPASSWD: /usr/local/sbin/seedypod-update --check
<core user> ALL=(root) NOPASSWD: /usr/local/sbin/seedypod-update --start
<core user> ALL=(root) NOPASSWD: /usr/local/sbin/seedypod-update --channel stable
<core user> ALL=(root) NOPASSWD: /usr/local/sbin/seedypod-update --channel dev
```

sudo refuses anything else, so core can't pass a URL, a path, a repository or
a version. The helper checks its arguments again and exits 2 on anything
else. The repository (`seedypod/core`) and the download prefix are constants
in the helper. Core calls it from one place, `src/update/client.ts`.

`--now` (update in the foreground) and `--rollback` (put the previous version
back) aren't in sudoers: they're for an owner on SSH.

### Channels

- **stable**: the newest `vX.Y.Z` release (`/releases/latest`), built from
  `main`.
- **dev**: the rolling `dev-latest` prerelease, built from `dev`.

The choice is kept in `/var/lib/seedypod-update/channel`, root-owned, so it
survives a database restore and can only be one of the two. With no choice
saved, a unit installed from `main` is on stable and anything else is on dev.

### Only prebuilt artifacts, each checked

The unit downloads what CI built and nothing else: `seedypod-core.tar.gz`, the
`hald` binary for its CPU when hald runs on this machine, and, on a Pi Zero W
whose dependencies changed, the ARMv6 better-sqlite3. `dev-release.yml` and
`release.yml` attach a `<asset>.sha256` next to the
tarball and each `hald` binary (the better-sqlite3 build already had one).

Each download must match every checksum the release has for it: the
`.sha256` asset and GitHub's own `digest` for the asset. At least one must
exist, or the helper refuses. A mismatch refuses the update before anything
on the unit changes or stops. Two more checks happen before the swap:

- The tarball's `.git-info` commit must be the release tag's commit, so a
  `dev-latest` caught half-published is refused rather than installed.
- The release must run on the Node the unit has. A release that needs a new
  Node is refused with "update over SSH with `scripts/install`".

Nothing is compiled. When `pnpm-lock.yaml` is unchanged, `node_modules` is
kept as it is, which is the common case. When it changed, `pnpm install
--prod --frozen-lockfile` runs as core's account (never as root) with the
store `node_modules` was linked from. A Pi Zero W needs the ARMv6
better-sqlite3 from the release for that; if the release has none for its
Node, the update is refused instead of compiling for an hour. pnpm has a
30-minute limit, so a compile that slips through fails and rolls back.

### Swap, health check, rollback

The helper runs the update as its own transient systemd unit
(`systemd-run`), since stopping core would otherwise stop the helper with
it. In order:

1. Download and check everything, unpack to `<prefix>.next`.
2. Stop core, and hald if its binary changed. Copy the database
   (`data/seedypod.db` with its `-wal` and `-shm`) aside.
3. Move every top-level entry of the prefix except `data/`, `node_modules/`,
   `.pnpm-store/` and `.env*` into `<prefix>.previous/code/`, then move the
   release's entries in. Each move is a rename on one filesystem.
   `<prefix>.previous/meta.json` records each step as it happens.
4. Install dependencies if the lockfile changed, with the old `node_modules`
   moved aside. Swap the hald binary by rename.
5. Start the services. Core is healthy when `/api/healthcheck` answers,
   `/api/system` reports the new version, and core sees hald if it did
   before. It has 5 minutes.

Any failure in steps 3 to 5 puts back everything `meta.json` lists,
including the database (a new core may have migrated it), then starts the
services and checks that the old version answers. The status says
`rolled-back`, or `rollback-failed` if the old version doesn't come back
either. After a successful update, `<prefix>.previous` keeps the previous
code until the next update. The database copy is deleted, and the restore
and update helpers are refreshed from the checked release.

While it runs, the helper puts a file in `/run/seedypod-busy/` so hald's USB
recovery won't reboot the unit mid-update. A lock file stops two updates at
once.

### Progress

The helper writes `status.json` (the step, the versions, the error) and
`update.log` to `/var/lib/seedypod-update`, readable by everyone. Core reads
them, and while an update runs it emits `update` events on the event bus
(ADR 0015) so Settings follows along over the SSE subscription. While core
itself restarts, the page polls until core answers again, then shows the
result.

### The exception to LAN-only

Core still never connects to the internet. The helper does, only when
someone on the LAN asks it to:

- **Settings → Update → Check** runs `--check`: two GET requests to
  `api.github.com` (the release, and its tag's commit).
- **Update** runs `--start`: those two again, then downloads from
  `github.com/seedypod/core/releases/download/`, which redirects to GitHub's
  asset storage. If dependencies changed, pnpm fetches packages from the npm
  registry, and prebuild-install fetches better-sqlite3's prebuilt binary
  for 64-bit ARM from its GitHub release.

Nothing checks for updates on a timer, and nothing reports anything about the
unit. The requests carry no unit id, only a `user-agent: seedypod-update`.
GitHub sees the unit's public IP address, as it would for `scripts/install`.

### Trust

The trust root is GitHub: TLS to `api.github.com` and `github.com`, and the
`seedypod/core` repository's releases. The sha256 checks catch a corrupt,
truncated or half-published download. They don't protect against someone who
can publish releases to `seedypod/core`, because the checksums come from the
same release. That's the trust `scripts/install` already asks for when an
owner pipes it into bash. Signed releases (minisign or Sigstore, with the
public key in the helper) would close that gap and are left for later.

Anyone on the LAN can start an update, as they can restore a backup or run
the pump (ADR 0012). The optional API key covers it like any other route.
They can only choose the channel, never the source.

## Consequences

- An update from the web replaces core's files and hald's binary. It does
  **not** redo the rest of `scripts/install`: the systemd units, polkit
  rule, port 80 forward, login logo and Node itself stay as they are. A
  release that needs those changes needs `scripts/install` over SSH. The
  update helper and restore helper are refreshed, so later updates use the
  newest helper.
- An update stops the unit for as long as core takes to start. On a Pi Zero
  that's up to a few minutes. Schedules don't run while it's stopped, and
  hald stops the pump when it restarts.
- Rollback restores the database copy, so readings and changes made in the
  minutes the new version ran are lost. A clean update loses nothing.
- `<prefix>.previous` costs the previous code's disk space, plus the previous
  `node_modules` when dependencies changed.
- A power cut mid-swap leaves `<prefix>.previous/meta.json`. `sudo
  seedypod-update --rollback` puts the previous version back from it.
- Releases from before this ADR have no `.sha256` assets. GitHub's digest
  still checks their downloads.
