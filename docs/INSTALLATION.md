---
type: "Guide"
title: "Installation"
description: "Back up the stock card, flash seedypod OS or install hald and core by script, connect Home Assistant."
status: "draft"
generated: {"by": "claude/fable-5.1", "at": "2026-10-31T04:40:00+00:00"}
sources: [{"resource": "https://github.com/iot-root/garden-of-eden", "title": "iot-root/garden-of-eden (reference implementation, GPL-3; no code copied)"}, {"resource": "/adr/index.md", "title": "Architecture decision records"}]
---

# Installation

**Back up the stock microSD card first** ([step 0](#0-back-up)). With that image,
a failed install is a 5-minute reflash back to stock.

Then [flash seedypod OS](#flash-seedypod-os-recommended). It's the recommended way
onto a new card: hald, core and everything else are already on it, so there's
nothing to compile and no `sudo` step. Steps 1 to 3 are the scripts, for a unit
that's already running, or a board the image doesn't cover.

## Which Pi

Open the base and read the board, or on the stock card run
`cat /proc/device-tree/model`. Gardyn has shipped the original **Pi Zero W**
(owners' reports; not yet confirmed on every model), and the Pi Zero 2 W is a
drop-in upgrade. Both run hald and core on the unit; they differ in which Node
core runs on.

| Board | OS | Node for core |
|---|---|---|
| **Pi Zero 2 W** (or Pi 3, 4, 5) | Raspberry Pi OS Lite **64-bit** | the version in `.node-version` (24), preferred |
| Pi Zero 2 W on a 32-bit OS | Raspberry Pi OS Lite 32-bit | Node 22 (official ARMv7 build) |
| **Pi Zero W** (original) | Raspberry Pi OS Lite 32-bit | Node 22 (unofficial-builds.nodejs.org ARMv6 build) |

Node 24 ships only for 64-bit ARM and x86, so 32-bit Pis fall back to Node 22,
the last line with 32-bit ARM builds. CI runs the tests and the build on both.
Node 22 gets security fixes until **April 2027**; after that a Pi Zero W should
move to a Pi Zero 2 W on 64-bit Raspberry Pi OS. `scripts/install --check`
prints which Node a machine gets.

seedypod OS is 32-bit for both boards, so it's on Node 22 even on a Zero 2 W. It
runs the ARMv6 build from unofficial-builds.nodejs.org, which is a community
build, not a Node.js release. The image doesn't change that clock:

- A card flashed today stops getting Node security fixes in April 2027, and core
  has no auth on your LAN, so after that date the unit relies on your network.
- Nothing on the unit updates itself. Node and core move when you reflash or
  rerun the installers, and Raspberry Pi OS packages when you run `apt`.
- The Zero W has no way onto Node 24. The Zero 2 W does: flash 64-bit Raspberry Pi
  OS Lite and use the scripts below.

On a Pi Zero W:

- The installer takes `better-sqlite3` from the release as a prebuilt ARMv6
  binary (upstream's 32-bit ARM binary is built for ARMv7 and would crash). If
  the release has none, or it won't load, the installer compiles it instead.
  That takes about 53 minutes and needs `build-essential`, which the installer
  adds; run `install-hal` first so swap is on compressed RAM while it compiles.
- One 1 GHz core runs hald, core and camera analysis. It works, but expect the
  app to be slower than on a Zero 2 W.

**Upgrading to a Pi Zero 2 W** (about $15, same footprint and pins): the stock
board's GPIO header is soldered on the underside, so buy one *without* a
header and solder it on the same way. Flash 64-bit Raspberry Pi OS Lite and
follow this guide; restore your backup from **Welcome** to keep your garden.

Core can also run on another 64-bit machine on your LAN instead: run
`install-hal --mqtt-lan` on the unit, install core there and set
`HAL_MQTT_URL` (`mqtt://<unit>:1884` with the printed user and password),
`HAL_UNIT_ID` (from `hald --check` on the unit) and
`HAL_HTTP_URL=http://<unit>:3001` in its `seedypod-core.service`. Wi-Fi setup
from the app then acts on that machine, not the unit.

**Settings → About** shows the board hald runs on and the machine core runs on.

## How long it takes

Measured on a Pi Zero W over Wi-Fi. A Pi Zero 2 W should be quicker, but hasn't
been timed.

| Step | Time |
|---|---|
| First boot, until SSH opens | about 3 minutes |
| `install-hal` | about 4.5 minutes |
| Core install, compiling `better-sqlite3` | about 56 minutes, 53 of them the compile |
| Core install, with the prebuilt binary | not timed yet; it skips that compile |
| Update (rerunning the core installer) | about 2 minutes |
| Reboot, until core serves pages | about 4 minutes |
| seedypod OS, first boot until core serves pages | not timed on a real unit yet |

## 0. Back up

1. Power off, open the base, remove the Pi's microSD.
2. On a computer: `sudo dd if=/dev/<card> of=gardyn-stock.img bs=4M status=progress` and keep the image.

## Flash seedypod OS (recommended)

Raspberry Pi OS Lite (32-bit, trixie) with `hald`, core and its production
dependencies, Node 22, the ARMv6 `better-sqlite3`, Mosquitto, the port 80 forward,
the SD card settings, the login logo and the camera naming already on it. It runs
on a **Pi Zero W** and a **Pi Zero 2 W**, and it's 32-bit on both, so it can't be the
64-bit mistake below. For a 64-bit OS on a Zero 2 W, use the [scripts](#1-flash).

Use a high-endurance card, as in [step 1](#1-flash). The download is about 650 MB and
needs a card of at least 4 GB; it grows to fill the card on first boot.

### With Raspberry Pi Imager

This is the way to get a login and Wi-Fi onto the card. In Imager 2.0:

1. **App Options → Content Repository → Edit → Use custom URL**, and paste one of
   these, then **Apply & Restart**.
   - The latest release: `https://github.com/seedypod/core/releases/latest/download/seedypod-os-imager.json`
   - The `dev` build: `https://github.com/seedypod/core/releases/download/dev-latest/seedypod-os-imager.json`

   `rpi-imager --repo <url>` does the same. To go back, pick the Raspberry Pi
   repository in the same dialog.
2. Pick your device. Only the Pi Zero W (shown as Raspberry Pi Zero in the official
   list) and Zero 2 W are offered, and **seedypod OS** is the only OS.
3. In the customisation steps set a username and password, Wi-Fi (2.4 GHz on a Zero
   W), and turn on SSH with a key or password if you want a shell. The hostname is
   already `seedypod`. Imager keeps what you entered last time, so read what's there.
4. Write the card and reseat it. `scripts/check-image --card /Volumes/bootfs` reads it
   back: it says whether it will boot a Zero W, and which login and network it got.

### Without Imager

Check the download, then write it with anything that writes images:

```sh
gh release download dev-latest -R seedypod/core -p 'seedypod-os.img.xz*'
scripts/check-image seedypod-os.img.xz
```

`sha256sum -c seedypod-os.img.xz.sha256` checks the sha256 on its own.
`seedypod-os-manifest.txt` beside it lists the commit, the base image and every
package. In Imager, **Use custom** on a local file skips the customisation, so a card
written that way has [no login](#no-login-on-the-card) and needs the hotspot.

### First boot

Power on and leave it. The card grows, makes its own SSH host keys, reads the unit id
from the Pi and starts `hald` and core: no step of yours, and no reboot, because I²C
and hardware PWM are already set. Then open `http://seedypod.local/`.

Nothing that belongs to one unit is on the image. SSH host keys, the unit id and the
machine id are made on the unit, the login and Wi-Fi come from Imager, and core's
database starts empty on **Welcome**, where you can restore a backup. No password is
built in, and the broker has none to leak: it only listens on the Pi itself until you
run `scripts/install-hal --mqtt-lan`, which makes one on the unit.

### The login

There is no default login. The account is the username you gave Imager, with your
password or key, and `sudo` asks for that password. Any name works, `seedypod`
included, because `hald` and core have accounts of their own, `seedypod-hal` and
`seedypod-core`, which nobody logs in to.

### No login on the card

The unit works without one: all of it is in the app, and `pi` stays locked. To get a
shell later, without reflashing, power off and put two files on the card's `bootfs`:

```sh
touch /Volumes/bootfs/ssh
echo "yourname:$(openssl passwd -6)" > /Volumes/bootfs/userconf.txt
```

Boot, and `ssh yourname@seedypod.local`.

### No Wi-Fi on the card

Hold the unit's button for **10 seconds** and join `seedypod-setup-xxxx`, as in
[Change Wi-Fi](#change-wi-fi). It doesn't open by itself, because an open network
should need someone at the unit.

### Updating

Rerun the installers from your login, as with any other unit. They keep core on
`seedypod-core` and `hald` on `seedypod-hal`, and don't recompile anything:

```sh
curl -fsSL https://raw.githubusercontent.com/seedypod/core/dev/scripts/install-hal | bash -s -- --version dev-latest
curl -fsSL https://raw.githubusercontent.com/seedypod/core/dev/scripts/install | bash -s -- --branch dev
```

Core stops while it updates. `scripts/deploy` doesn't work on a flashed unit, because
the login doesn't own `/opt/seedypod`.

## 1. Flash

For a card that isn't seedypod OS. Use a **high-endurance** microSD card, the kind rated for continuous video
recording (SanDisk High Endurance, Samsung PRO Endurance or similar). It costs
a few dollars more than a standard card and is the cheapest reliability gain
there is. `install-hal` also cuts what the unit writes (below), and
**Settings → Storage** shows how much it writes a day.

Raspberry Pi Imager → Raspberry Pi OS Lite (64-bit for Zero 2 W / Pi 4 / Pi 5;
32-bit for the original Zero W, which runs core on Node 22: see [Which Pi](#which-pi)). A Zero W won't
boot a 64-bit OS, and won't tell you so ([Won't come online](#wont-come-online)).
In the advanced options set hostname `seedypod`, enable SSH, add Wi-Fi. A Zero W
only has 2.4 GHz Wi-Fi, so give it a 2.4 GHz network.

Check the username and password before you write the card. Imager keeps what
you entered last time, so both can look filled in when you never chose them for
this card. The login is whatever is there, not necessarily `pi`, and `sudo` asks
for that password. With key-only SSH and a password you don't know, you have no
`sudo` and have to reflash.

Reseat the card, boot, `ssh <your-login>@seedypod.local`. `seedypod.local`
answers before SSH does: SSH opens near the end of first boot, so "connection
refused" for the first few minutes is normal. After a reflash the unit has a new
host key, so run `ssh-keygen -R seedypod.local` first.

## 2. Enable I²C and install the HAL

**On a Pi Zero W, use the `dev` commands for now.** `main` doesn't have the
ARMv6 fixes yet, so a Zero W needs these in place of the `curl` lines in this
step and the next. This goes away at the next release.

```sh
curl -fsSL https://raw.githubusercontent.com/seedypod/core/dev/scripts/install-hal | bash -s -- --version dev-latest
curl -fsSL https://raw.githubusercontent.com/seedypod/core/dev/scripts/install | bash -s -- --branch dev
```

Everyone else:

```sh
sudo raspi-config nonint do_i2c 0
curl -fsSL https://raw.githubusercontent.com/seedypod/core/main/scripts/install-hal | bash   # Phase 2.9
hald --check
```

Reboot once afterwards: hardware PWM on GPIO18, which dims the light, only comes
up after a reboot.

Besides `hald`, this keeps the system journal in RAM, moves swap to
compressed RAM (zram) and mounts `/` with `noatime`, so the card sees far
fewer writes ([ADR-0021](adr/0021-sd-card-wear-and-recovery.md)). Each change
is checked and undone if it doesn't take; `--no-wear` skips them. Logs then
last until reboot; [Debugging](DEBUGGING.md) shows how to keep them longer.

It also shortens each boot: cloud-init goes off now first boot has done its work,
as long as your Wi-Fi is shown to come back without it, and nothing that runs the
pump and lights waits for Wi-Fi. `--no-boot` skips these
([details](hardware/hal.md#install)).

`hald` runs as its own locked `seedypod` account (`seedypod-hal` on seedypod OS, where
none of this applies), so don't name your login `seedypod` in Imager. If you did, `install-hal` warns and uses that login for
hald: it works, but hald then has the login's groups and shell, and shares an
account with core. Nothing migrates it; reflash with another username to keep
them apart.

## 3. Install core (same Pi, or any 64-bit LAN box)

```sh
curl -fsSL https://raw.githubusercontent.com/seedypod/core/main/scripts/install | bash
```

The installer first picks the Node for this machine (24, or 22 on a 32-bit
Pi; [Which Pi](#which-pi)). With hald on the same Pi it reads the unit id from `hald --check`
and points core at it; elsewhere, core starts on the simulator until you set
`HAL_MQTT_URL`, `HAL_UNIT_ID` and `HAL_HTTP_URL` in
`/etc/systemd/system/seedypod-core.service` ([Which Pi](#which-pi)). Core
listens on `:3000`, and on a Raspberry Pi the installer forwards port 80 to it.
Open `http://seedypod.local/`. `:3000` keeps working, and it's still what the
iOS app uses.

The forward is one nftables rule loaded by `seedypod-port80.service`, so it
comes back after a reboot, and core still sees each client's own address, which
keeps the API key in force. It's IPv4 only, like core itself. If something else
already listens on port 80, the installer leaves it alone and says so. On any
other machine it leaves port 80 alone unless you run `scripts/install --port80`.
`scripts/install --no-port80` removes the forward and keeps it off on later
installs.

Core also advertises itself over Bonjour as `_seedypod._tcp` on that port,
so the iOS app finds it without an address. The TXT record carries `id`
(the unit id), `v` (core's version) and `auth` (`1` when an API key is set
in Settings, else `0`). To turn it off, set `SEEDYPOD_MDNS=0` in
`seedypod-core.service`.

A new install opens on **Welcome**. Choose **Set up a new garden**, or
**Restore from a backup** if this card replaces one that died
([Maintenance → Restoring a backup](MAINTENANCE.md#restoring-a-backup)). From
the shell, `--restore` does the same with a downloaded file or a URL:

```sh
curl -fsSL https://raw.githubusercontent.com/seedypod/core/main/scripts/install | bash -s -- --restore ~/seedypod-backup-kitchen-20261031-030000.tar.gz
```

The installer also puts the restore helper at `/usr/local/sbin/seedypod-restore`
(root-owned) and lets the core user run it with `sudo`
(`/etc/sudoers.d/seedypod-restore`), for that one path. Once the unit is
running, **Settings → Backup** downloads a backup. Set up the off-device
mirror ([Capture analysis](ANALYSIS.md#mirror-photos-off-the-unit-opt-in))
and a backup goes to your bucket every night.

An SSH login then opens with an animated logo, the version and the unit's
address. It runs from `/etc/profile.d/seedypod-logo.sh`, only for an interactive
login on a terminal, so `ssh host cmd`, `scp`, `sftp` and `rsync` never see it.
Any key skips it. Terminals that don't do truecolor get a still 256-colour logo
or one line of text; over SSH, truecolor is detected from `TERM`, by asking the
terminal, or from a client that sets `SendEnv COLORTERM`. To turn it off, `touch
~/.hushlogin`, or set `SEEDYPOD_NO_LOGO=1` in `/etc/environment`.
`scripts/install --login-logo` reinstalls just this.

## Change Wi-Fi

No keyboard needed. Hold the unit's button for **10 seconds** (at 1 s it
acknowledges any latched fault; keep holding). Core opens an open hotspot named
`seedypod-setup-xxxx` for 15 minutes:

1. Join `seedypod-setup-xxxx` from a phone.
2. Open `http://10.42.0.1:3000/wifi`, pick your network, enter its password,
   **Join**.
3. The unit leaves the hotspot and joins your network. Rejoin your network
   on the phone and open `http://seedypod.local:3000/`.

If the password was wrong, the hotspot comes back and the Wi-Fi screen says
why. On your LAN, **Settings → Wi-Fi** does the same without the button.
The installer lets the core service user manage NetworkManager
(`/etc/polkit-1/rules.d/50-seedypod-network.rules`). The hotspot is open
because pressing the button already proves someone is at the unit; it closes
itself after 15 minutes.

## 4. Home Assistant

`hald` publishes the unit to Home Assistant over MQTT discovery, so HA needs to
reach the same broker. Pick one:

- **HA on another machine, using the unit's broker.** Run
  `scripts/install-hal --mqtt-lan`. The broker then also listens on port
  **1884** with a password, and the installer prints the `homeassistant`
  password once. In HA, go to **Settings → Devices & services → Add
  integration → MQTT** and enter host `seedypod.local`, port 1884, user
  `homeassistant` and that password. Port 1883 stays local to the Pi.
- **HA's own broker** (the Mosquitto add-on). Install `hald` with
  `--no-broker`, then point both sides at HA's broker:
  - In `/etc/seedypod/hal.toml`, set `mqtt_url = "mqtt://homeassistant.local:1883"`
    plus `mqtt_username` and `mqtt_password`.
  - In `/etc/systemd/system/seedypod-core.service`, set
    `HAL_MQTT_URL=mqtt://USER:PASS@homeassistant.local:1883`.

  Then run `sudo systemctl daemon-reload && sudo systemctl restart hald seedypod-core`.

Either way the device appears in HA with no further setup. See
`docs/homeassistant/` for an example dashboard.

## Won't come online

**No SSH and no `seedypod.local`, ever.** On a Pi Zero W, suspect a 64-bit OS. It
never boots and gives no error. Put the card in a computer and run
`scripts/check-image --card /Volumes/bootfs`, or look for these:

- The root partition is still 2.5 GB, because first boot never grew it.
- `bootfs` has only `kernel8.img` and `kernel_2712.img`.
- `config.txt` has `arm_64bit=1`.

Any of those means reflashing with Raspberry Pi OS Lite (32-bit). Otherwise check
the Wi-Fi network is 2.4 GHz.

**`seedypod.local` answers but SSH refuses.** Wait: SSH opens about 3 minutes
after power on, later than mDNS.

**SSH warns that the host key changed.** The card was reflashed. Run
`ssh-keygen -R seedypod.local`.

**SSH says permission denied.** The login is what Imager had, not necessarily
`pi`. If you've forgotten it, `user-data` on the card's `bootfs` has it under
`user: name`, and `scripts/check-image --card` prints it.

**The browser says connection refused.** That's normal until step 3 finishes:
SSH works from first boot, but nothing serves pages before core is installed.
After that, the address is `http://seedypod.local/`, with `:3000` also working.
After a reboot, allow about 4 minutes.

**You can't find it by IP.** The unit can land on a different subnet from your
computer, where a network scan misses it. Use `seedypod.local`.

## Uninstall

```sh
sudo systemctl disable --now seedypod-core hald
sudo systemctl disable --now seedypod-port80 || true
sudo rm -rf /opt/seedypod /etc/systemd/system/seedypod-core.service /etc/systemd/system/hald.service \
  /etc/systemd/system/seedypod-port80.service \
  /usr/local/sbin/seedypod-restore /etc/sudoers.d/seedypod-restore /var/lib/seedypod-restore \
  /usr/local/share/seedypod /etc/profile.d/seedypod-logo.sh
```
Or reflash the stock image from step 0.
