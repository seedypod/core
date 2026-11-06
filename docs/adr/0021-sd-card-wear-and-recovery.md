---
type: "Decision record"
title: "ADR 0021: SD card wear and fast recovery"
description: "Write less to the microSD card, using sleepypod's eMMC approach, and make a dead card a ten-minute swap: automatic off-card backups, a one-step restore, and a ready-made SD image."
status: "stable"
generated: {"by": "claude/opus-5.5", "at": "2026-10-31T23:00:00+00:00"}
sources: [{"resource": "https://github.com/sleepypod/core/blob/dev/docs/adr/0018-tmpfs-raw-frames.md", "title": "sleepypod ADR 0018: tmpfs for live RAW frames"}, {"resource": "https://github.com/sleepypod/core/blob/dev/scripts/lib/journald-helpers", "title": "sleepypod journald helpers (RAM-only journal)"}, {"resource": "https://sleepypod.github.io/core/system/storage/", "title": "sleepypod: System → Storage (flash writes)"}, {"resource": "/adr/0012-deployment-and-trust.md", "title": "ADR 0012: Deployment and trust model"}, {"resource": "/adr/0019-pluggable-capture-analysis.md", "title": "ADR 0019: Pluggable capture analysis"}, {"resource": "/MAINTENANCE.md", "title": "Maintenance"}]
---

# ADR 0021: SD card wear and fast recovery

**Status:** Accepted (phases 1–3; phase 4 built, see [the amendment](#amendment-2026-11-06-phase-4-as-built))
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

[sleepypod](https://sleepypod.github.io/core/system/storage/) solved the wear half for the Pod's eMMC:

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

SQLite stays on the card in WAL mode, and captures are left alone: a few
small JPEGs a day, pruned to a cap. Core's own database writes are batched
(below).

**Database writes.** Thinning telemetry to one row per sensor per minute
turned out not to be enough. Rows are tiny, but WAL mode writes whole 4 KB
pages. Each row on its own dirtied the table, its `sqlite_sequence` entry and
the sensor index: 3.4 pages for about 30 bytes. A unit measured 124 KB a
minute from core, and 340–390 MB a day at the card once the filesystem's
journal is added.

A 24-hour replay of `hald`'s cadence through the real core, with `water_low`
firing, gives this WAL traffic. Before the change it lands about 5% under the
unit's rate.

| Writer | Before | After |
|---|---|---|
| Telemetry rows | 132 MB/day | 21 MB/day |
| Live alert detail | 32 MB/day | none |
| Captures, flash samples, everything else | 0.8 MB/day | 0.8 MB/day |
| **Total** | **166 MB/day** | **22 MB/day** |

- **Telemetry is batched.** Rows wait in memory and go to the card in one
  transaction every `telemetryFlushMin` (a device setting, 5 minutes by
  default, 1–60). A batch dirties each page once however many rows land on it.
  sleepypod takes the same shape for its raw frames (its ADR 0018): hot data
  in RAM, and one write on a cadence instead of a continuous stream.
- **Five minutes, not sleepypod's 15.** One minute costs 62 MB/day, five 22,
  fifteen 11. Past five the saving is too small to matter to any card, and a
  power cut would cost three times as much history.
- **Charts have no hole.** `telemetry.range` merges the held rows with the
  stored ones. It doesn't flush, because a chart polling every minute would
  undo the batching.
- **Old telemetry thins itself.** The table grew by about 1 MB a day for ever,
  and every scan and backup carried it. Rows stay at one a minute for 90 days,
  which is as far back as any chart goes (Autopilot's backtests stop at 14), then
  thin to one per 15 minutes. That's about 27 MB a year, so nothing needs dropping
  outright on a 64 GB card. Harvest Outlook reads captures, not telemetry. A dataset
  export of an old window gets the thinned rows.

  It only deletes, once a week at 04:00, in transactions of 6 hours of every sensor
  with a pause between: about 10 MB of WAL a week against 150 MB of telemetry
  writes, so about 7% more. Six-hour slices per sensor measured 40 MB, because
  each sensor rewrote the same pages. A counter remembers how far it got, so old
  rows are never read twice. The file stops growing without a `VACUUM`, which
  would rewrite all of it: freed pages go back to SQLite's free list.
- **A power cut loses at most one interval of sensor history.** Nothing else
  waits: settings, schedules, grow data, alert raises and clears, and
  `hald`'s dosing ledger are all written as they happen. Core flushes on
  SIGTERM and SIGINT, before a backup, and on close, so stops, updates and
  restores lose nothing. A crash counts as a power cut.
- **A failing card can't grow memory.** A failed flush keeps its rows for the
  next try. The buffer stops at 5,000 rows, about ten hours of a stock unit,
  and then drops the oldest, like sleepypod's cap on pinned frames. Reaching
  the cap tries one flush. If that fails, only the timer retries until a flush
  lands, so a bad card can't stall the event loop on every sample.
- **A backup never leaves held rows out.** If they can't reach the card, the
  backup fails instead and says why, rather than producing a bundle that would
  lose them on a restore.
- **Live alert detail stays in memory.** `water_low` and `over_temp` carry the
  current reading, so their detail changes every 10 seconds. A raise is
  written at once. After that the newest detail from `hald` is held in memory,
  served by `alerts.list`, and written with the clear, acknowledge or dismiss,
  so history keeps the last value. A restart shows the row's older detail only
  until `hald`'s retained alert arrives. Details from core's own alerts
  (reminders, `backup_stale`, `mirror_failed`) still write through: they
  change rarely, and nothing would bring them back.

Measured and left alone:

- **`wal_autocheckpoint`** stays at 1000. Checkpoints rewrite about 1.5 MB/day
  after batching. 4000 would save 0.7 MB/day for a 16 MB WAL and a longer
  replay after a power cut; lower values cost more.
- **`synchronous`** is already NORMAL once the database is in WAL mode, as
  sleepypod sets it by hand, so a commit doesn't fsync.
- **`light_hours`** writes only when the light turns off, about twice a day.
- **Captures and analysis** write about 17 pages per photo, in one
  transaction. **Autopilot runs** write 3 pages each, only when a rule fires.
- **Re-raising an alert with the same detail** is free: SQLite leaves the page
  clean when the row doesn't change.

**Flash writes.** Core samples `/sys/block/mmcblk0/stat` hourly and shows
writes per day under **Settings → Storage**, as sleepypod does. Until a day
of samples exists, it shows the average since boot. With that
number, an owner can see whether a card's lifespan is years or decades.

**Database view.** The meter says how much the card takes, not who is writing.
**Settings → SD card → Database** answers that for `seedypod.db`, after
sleepypod's System → Databases: file and WAL size, journal mode, migrations, an
on-demand `quick_check`, and each table's rows, bytes, last write and rows per
hour over 24 h, busiest first.

- **Metadata only.** It has no row browser and takes no SQL, because rows hold
  Wi-Fi details and bucket credentials. sleepypod's row browser wasn't ported.
- **Off the event loop.** A scan runs on a worker thread that exits when done,
  on its own read-only connection. A Pi Zero W has one core, so the thread runs
  at nice 19 and core and `hald` pre-empt it.
- **One pass over the file.** `dbstat` gives bytes and exact row counts together.
  Hourly counts walk back from the newest rowid and stop after 1000 rows older
  than the window, because telemetry has no index on time alone. Without `dbstat`
  the view falls back to `COUNT(*)` and shows no sizes.
- **Cached.** A report lives for 5 minutes, or 20 times the last scan's length if
  that is longer, so a growing file can't take more than 1/20th of the time. The
  page only scans when it's open, so visiting Settings costs nothing.
- **No writes.** Nothing is stored; the last integrity result is held in memory.
  `temp_store = MEMORY` keeps sorts off the card. The connection leaves the
  database and `-wal` untouched. A reader can move a mark in `-shm`, which dirties
  at most one 4 KB page per scan, the page core's next commit dirties anyway.
  Statements run in their own read transactions, since one held across the scan
  would stop checkpoints from resetting the WAL.

Counts are rows by the time stored in them, not commits, so batched writes show
as their rows. Tables dated by `updatedAt` count rows changed, a floor. Updates
that move no time column don't show, and a table with no time column reports no
count at all.

Rejected for now: a read-only root (overlayroot). It removes nearly all wear,
but it makes every update and config change a remount dance. Revisit it if
the measured GB/day turns out high.

### 2. Back up automatically, off the card

Core makes a **backup bundle**: `seedypod-backup-<unit>-<date>.tar.gz`. It
contains:

- **`seedypod.db`:** taken with SQLite's online backup, so core keeps running.
- **`/etc/seedypod/hal.toml`**, and the Mosquitto LAN password file
  (`/etc/mosquitto/seedypod.passwd`) when `--mqtt-lan` made one.
- **`/var/lib/seedypod/`:** `hald`'s state, the dosing ledger and the probes
  added in the app (`sensors.json`).
- **`manifest.json`:** unit id, core and `hald` versions, schema migration,
  creation time and file checksums. It is the last entry, so checksums are
  computed as the files stream by.

Photos are left out by default. The mirror (ADR 0019) already carries them,
and they would make the bundle 100× larger. An **Include photos** switch
covers owners without a mirror.

Core runs as the install user. `install-hal` and `install` add that user to
the `seedypod` group, which can read `/etc/seedypod`, `/var/lib/seedypod`
and the Mosquitto password file (owner `mosquitto`, group `seedypod`, mode
0640). Read access is all that's needed.

Destinations:

- **Download**, always available: **Settings → Backup → Download**.
- **The mirror bucket** (ADR 0019), when one is set. Backups go nightly to
  `backups/` under the unit's prefix, keeping the last 14. It reuses the
  same S3 settings, credentials and retry queue.
- Nothing local. A backup on the same card dies with it.

**Staleness alert.** A `backup_stale` alert fires when no off-card backup
has succeeded for 7 days. A finished download counts as one. On a unit that
has never had one, the 7 days count from core's first start, and the alert
reads "No off-card backup yet". The alert also shows on the Home screen and
in Home Assistant.

The bundle holds the S3 secret and the MQTT password. Download shows a
warning saying so, and the bucket copy sits behind those same credentials.

### 3. Restore in one step

A restore can happen in three places. They all call one root helper,
`/usr/local/sbin/seedypod-restore <bundle>`. It ships in core's tarball, so
it always matches the installed schema. `scripts/install` copies it there
(root-owned, with the install prefix written in) and grants the core user
`NOPASSWD` for that one path, the same pattern sleepypod uses for its service
restarts. The helper:

1. Copies the bundle into a root-only staging directory, then checks it
   there: only known file names, only regular files, every checksum in the
   manifest. It refuses a bundle from a **newer** schema than the installed
   core and names the version to install first.
2. Stops `seedypod-core` and `hald`. When core asks for the restore, the
   rest runs in its own transient unit (`systemd-run`), since stopping core
   would otherwise stop the helper too.
3. Replaces the database, `hal.toml`, the Mosquitto password file and
   `hald`'s state files. It never restores Mosquitto's config: when a
   password file comes back, the helper writes the LAN listener itself.
4. Starts both services. Migrations run on start, as on any update.
5. Keeps the replaced files in `/var/lib/seedypod-restore/pre-restore/`
   until the next successful restore, so a wrong bundle can be undone with
   `seedypod-restore --undo` or **Undo restore** in Settings. That
   directory is root-owned, unlike `hald`'s state directory, so nothing but
   the helper can change what an undo puts back.

The three entry points:

- **First-run web UI.** A fresh install with an empty database opens on
  **Welcome** (a new database starts with `setupComplete` off; databases
  from before this ADR migrate as set up), with two options:
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
- **A power cut loses up to `telemetryFlushMin` of sensor history.** Charts
  show a gap. Reading the database file can lag the app by as much, whether by
  hand or in the Database view.
- **Logs are lost on reboot.** Debugging a crash before a reboot means
  checking the database's alerts and faults, or turning persistent journald
  back on for the session (DEBUGGING.md gains the command).
- Release CI grows an image build. If it fails, it doesn't block the
  tarball release that the installers use.
- **Root helper.** The core user can run one root helper. It only accepts a
  bundle whose manifest and checksums validate, and it writes only to fixed
  paths. Its path overrides (for tests and the simulated bring-up) are
  ignored when it runs as root.
- **Restore is a LAN route.** Like every other route (ADR-0012), restore is
  open to the LAN unless an API key is set. A restored `hal.toml` brings its
  `[limits]` with it, so a restore can change the pump limits within what
  `hald` accepts. Every pump run stays bounded and goes through `PumpGuard`.

## Amendment 2026-11-06: phase 4 as built

Phase 4 shipped as `seedypod-os.img.xz`, and differs from what's proposed above in
three ways, all because of what the first real install found.

- **32-bit, not arm64.** Gardyn's Pi Zero W can't boot a 64-bit OS and gives no
  error, so an arm64 image would fail on the board it most needs to serve. The armhf
  image runs on a Zero W and a Zero 2 W. It stays on Node 22 even on a Zero 2 W, where
  a 64-bit install by script gets Node 24.
- **The official image customised in a chroot, not `rpi-image-gen` or `pi-gen`.** Both
  generators build the OS again from packages, so what they make isn't what Raspberry
  Pi ships, and they'd have to rebuild the first-boot behaviour the Imager flow relies
  on: cloud-init renaming `pi`, growing the root partition, generating SSH host keys.
  Starting from the published Lite image, pinned by sha256 in
  `scripts/image/base.env`, keeps exactly that flow. It builds in minutes rather than
  most of an hour, and moving to a new Raspberry Pi OS is two lines. Packages added
  during the build come from the live archive, so two builds of one commit aren't
  byte-identical; `seedypod-os-manifest.txt` records what went in.
- **The installers build it.** `scripts/image/bake` runs `scripts/install-hal` and
  `scripts/install` inside the image under emulation, from the release's own tarball.
  So what they set up lands on the image with no second copy to keep in step, and
  only what can't happen in a chroot moves to first boot (`scripts/image/first-boot`):
  the unit id, unblocking Wi-Fi, the SD card settings, whose checks need a running
  system, and camera names, which it retries each boot until the USB hub shows up.

Two accounts differ from a scripted install. The login doesn't exist until first boot,
so core can't run as it, and gets `seedypod-core`. `hald` gets `seedypod-hal`, because
Raspberry Pi OS makes the login by renaming `pi`, which would fail if the name were
taken; that leaves `seedypod` free for anyone who types it into Imager. `scripts/install`
and `scripts/install-hal` keep these accounts on a rerun, and the first-boot files root
runs are copied out of `/opt/seedypod`, which `seedypod-core` owns.

There's no default login and no default password. Imager sets the login, and a card
with none works from the app alone, with `pi` locked. The setup hotspot still needs
the button: a fresh card doesn't open a network of its own accord.

The image is built on each push to `dev`, on each release, and on pull requests that
touch the build. It runs as a job after the release job and is never cancelled, like
`sqlite-armv6`, and `dev-release.yml` leaves the last image in place while the next
one builds, so `dev-latest`'s image can lag its tarball by one build.

## Recommended card

INSTALLATION.md recommends a **high-endurance** card, rated for continuous
video recording: SanDisk High Endurance, Samsung PRO Endurance, or similar.
It costs a few dollars more than a standard card and is the cheapest
single reliability gain available.
