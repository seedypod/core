---
type: "Decision record"
title: "ADR 0021: SD card wear and fast recovery"
description: "Write less to the microSD card, using sleepypod's eMMC approach, and make a dead card a ten-minute swap: automatic off-card backups, a one-step restore, and a ready-made SD image."
status: "draft"
generated: {"by": "claude/opus-5.5", "at": "2026-10-31T23:00:00+00:00"}
sources: [{"resource": "https://github.com/sleepypod/core/blob/dev/docs/adr/0018-tmpfs-raw-frames.md", "title": "sleepypod ADR 0018: tmpfs for live RAW frames"}, {"resource": "https://github.com/sleepypod/core/blob/dev/scripts/lib/journald-helpers", "title": "sleepypod journald helpers (RAM-only journal)"}, {"resource": "https://sleepypod.github.io/core/system/storage/", "title": "sleepypod: System → Storage (flash writes)"}, {"resource": "/adr/0012-deployment-and-trust.md", "title": "ADR 0012: Deployment and trust model"}, {"resource": "/adr/0019-pluggable-capture-analysis.md", "title": "ADR 0019: Pluggable capture analysis"}, {"resource": "/MAINTENANCE.md", "title": "Maintenance"}]
---

# ADR 0021: SD card wear and fast recovery

**Status:** Proposed
**Date:** 2026-10-31

## Context

A Gardyn boots from a microSD card in a Pi Zero 2 W. Cheap cards are the part
most likely to fail, and they fail in two ways:

- **Wear.** Constant small writes (logs, swap, a database) use up the flash.
- **Power loss.** A cut mid-write can corrupt the filesystem.

Moving the system to a USB drive doesn't fix this. A thumb drive uses the same
class of flash as an SD card, often with a worse controller. A real USB SSD is
more durable, but it has its own problems:

- The Zero 2 W's one USB port already carries the cameras through the board's
  hub.
- The drive would share that hub's power.
- The Pi still needs an SD card to hold its boot files.

What owners actually want is for a failed card not to matter. Today, recovery
means a shell session:

1. Flash Raspberry Pi OS.
2. Run two installers.
3. Untar a backup by hand.

That only works if the owner remembered to stop core and take a backup
(MAINTENANCE.md). Most won't have one.

sleepypod solved the wear half for the Pod's eMMC:

- A RAM-only journal (`scripts/lib/journald-helpers`).
- tmpfs for high-rate data (its ADR 0018).
- An hourly sample of the flash's sectors-written counter, shown as GB/day
  under **System → Storage**.

seedypod writes far less than a Pod, which streams about 1 GB/day of raw
frames. Its biggest wins are the system defaults, plus a recovery path that
needs no shell.

## Decision

### 1. Write less (ported from sleepypod)

`scripts/install-hal` applies these, each with a rollback, like sleepypod's
helper. Rerunning it reapplies them.

| Change | Why |
|---|---|
| journald `Storage=volatile`, `RuntimeMaxUse=32M` | The journal is the largest steady writer on an idle Pi. Logs survive until reboot. Faults and alerts are already in the database. |
| Swap on zram instead of the SD swapfile | `dphys-swapfile` pages to the card. zram compresses in RAM, which suits a 512 MB board. |
| `noatime` on `/` | Stops a metadata write on every file read. |

These are left unchanged:

- **The database.** SQLite stays on the card in WAL mode. Telemetry is
  already thinned to one row per sensor per interval.
- **Captures.** These are a few small JPEGs a day, pruned to a cap.

**Flash writes.** Core samples `/sys/block/mmcblk0/stat` hourly and shows
writes per day under **Settings → Storage**, as sleepypod does. With that
number, an owner can see whether a card's lifespan is years or decades.

Rejected for now: a read-only root (overlayroot). It removes nearly all wear,
but it makes every update and config change a remount dance. Revisit it if
the measured GB/day turns out high.

### 2. Back up automatically, off the card

Core makes a **backup bundle**: `seedypod-backup-<unit>-<date>.tar.gz`. It
contains:

- **`seedypod.db`:** taken with SQLite's online backup, so core keeps running.
- **`/etc/seedypod/`:** `hal.toml` and the Mosquitto LAN password file.
- **`/var/lib/seedypod/`:** `hald`'s state, the dosing ledger and the probes
  added in the app (`sensors.json`).
- **`manifest.json`:** unit id, core and `hald` versions, schema migration,
  creation time and file checksums.

Photos are left out by default. The mirror (ADR 0019) already carries them,
and they would make the bundle 100× larger. An **Include photos** switch
covers owners without a mirror.

Core runs as the install user and can't read `hald`'s state directory.
`install-hal` adds that user to a `seedypod` group with read access to
`/etc/seedypod` and `/var/lib/seedypod`. Read access is all that's needed.

Destinations:

- **Download**, always available: **Settings → Backup → Download**.
- **The mirror bucket** (ADR 0019), when one is set. Backups go nightly to
  `backups/` under the unit's prefix, keeping the last 14. It reuses the
  same S3 settings, credentials and retry queue.
- Nothing local. A backup on the same card dies with it.

**Staleness alert.** A `backup_stale` alert fires when no off-card backup
has succeeded for 7 days. Until the first one, it reads "No off-card backup
yet". The alert also shows on the Home screen and in Home Assistant.

The bundle holds the S3 secret and the MQTT password. Download shows a
warning saying so, and the bucket copy sits behind those same credentials.

### 3. Restore in one step

A restore can happen in three places. They all call one root helper,
`/usr/local/sbin/seedypod-restore <bundle>`. `install-hal` installs it and
grants the core user `NOPASSWD` for that one path, the same pattern sleepypod
uses for its service restarts. The helper:

1. Checks the manifest and checksums. It refuses a bundle from a **newer**
   schema than the installed core and names the version to install first.
2. Stops `seedypod-core` and `hald`.
3. Replaces the database, `/etc/seedypod` and `/var/lib/seedypod`.
4. Starts both services. Migrations run on start, as on any update.
5. Keeps the replaced files in `/var/lib/seedypod/pre-restore/` until the
   next successful restore, so a wrong bundle can be undone.

The three entry points:

- **First-run web UI.** A fresh install with an empty database opens on
  **Welcome**, with two options:
  - **Set up a new garden.**
  - **Restore from a backup.** Upload a bundle, or enter S3 settings to list
    the bucket's `backups/` and pick one, newest first.
- **Installer.** `scripts/install --restore <file|url>` restores right after
  installing, for people who prefer the shell.
- **Settings → Backup → Restore,** on a running unit.

Unit identity carries over. `unit_id` is in the restored `hal.toml`, or else
derived from the Pi's serial, which a card swap doesn't change. Home
Assistant keeps the same device and entities.

### 4. A ready-made SD card image

Each release attaches `seedypod-<version>-arm64.img.xz` to its GitHub
release:

- **Contents:** Raspberry Pi OS Lite, Mosquitto, `hald` and core, with the
  wear settings applied.
- **Build:** `rpi-image-gen` in CI on release, about 600 MB compressed.

seedypod is also listed in a Raspberry Pi Imager repository JSON
(`os_list`) on the docs site, so it shows up in Imager. Imager already sets
Wi-Fi, SSH and the hostname. Owners who skip that step can still get online
with the button-hold setup hotspot.

**Card replacement** becomes:

1. Flash the seedypod image with Raspberry Pi Imager.
2. Put the card in and power on.
3. Open `http://seedypod.local:3000` (the image's default hostname), choose **Restore from a backup**, and
   pick the latest.

That's about ten minutes and no shell. The unit comes back with its
schedules, grow cycle, pods, Autopilot rules, probes, calibration and
history.

### Phasing

Each phase ships on its own and is useful alone.

1. **Write less + flash meter.** Installer changes and the Storage card.
2. **Backup.** The bundle, download, nightly mirror upload, retention and
   `backup_stale`.
3. **Restore.** The helper, the installer flag, the Welcome screen and the
   Settings entry.
4. **Image.** The CI image build, release asset and Imager JSON.
   MAINTENANCE.md's **Replacing parts → SD card** becomes the three steps
   above.

## Alternatives considered

- **Boot from USB.** Not more reliable with a thumb drive. With an SSD it
  competes with the cameras for the one port and the hub's power, and the
  board still needs an SD card to hold its boot files. Revisit only after
  Phase 1 hardware recon shows what the hub can power.
- **Read-only root (overlayroot).** It would remove most wear, but it makes
  updates and every settings change harder. Deferred until the flash meter
  says it's needed.
- **Back up to Home Assistant.** HA backups cover HA, not other devices.
  Owners running HA with MinIO or another S3 add-on can point the mirror at
  it.
- **Image the whole card (`dd`).** It restores everything, but it's
  card-sized, slow, and needs a second machine. The bundle is a few MB.
- **Encrypt the bundle.** It would protect the S3 secret and MQTT password
  in a downloaded file. That isn't worth a passphrase the owner must keep
  safe, because losing it makes the backup useless. The warning on Download
  covers it.

## Consequences

- A dead card costs a new card and about ten minutes, provided off-card
  backups are on. The `backup_stale` alert exists to make sure they are.
- **Logs are lost on reboot.** Debugging a crash before a reboot means
  checking the database's alerts and faults, or turning persistent journald
  back on for the session (DEBUGGING.md gains the command).
- Release CI grows an image build. If it fails, it doesn't block the
  tarball release that the installers use.
- **Root helper.** The core user can run one root helper. It only accepts a
  bundle whose manifest and checksums validate, and it writes only to fixed
  paths.

## Recommended card

INSTALLATION.md recommends a **high-endurance** card, rated for continuous
video recording: SanDisk High Endurance, Samsung PRO Endurance, or similar.
It costs a few dollars more than a standard card and is the cheapest
single reliability gain available.
