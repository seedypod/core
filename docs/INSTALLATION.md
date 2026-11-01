---
type: "Guide"
title: "Installation"
description: "Back up the stock card, flash Raspberry Pi OS, install hald and core, connect Home Assistant."
status: "draft"
generated: {"by": "claude/fable-5.1", "at": "2026-10-31T04:40:00+00:00"}
sources: [{"resource": "https://github.com/iot-root/garden-of-eden", "title": "iot-root/garden-of-eden (reference implementation, GPL-3; no code copied)"}, {"resource": "/adr/index.md", "title": "Architecture decision records"}]
---

# Installation

> Phase 1 is not done: nothing here has run on a real Gardyn yet. Follow at your
> own risk, and **back up the stock card first** so bricking is a 5-minute reflash.

## Which Pi

Open the base and read the board, or on the stock card run
`cat /proc/device-tree/model`. Gardyn has shipped the original **Pi Zero W**
(owners' reports; not yet confirmed on every model), and the Pi Zero 2 W is a
drop-in upgrade.

| Board | CPU | hald | core |
|---|---|---|---|
| **Pi Zero 2 W** | 4 × Cortex-A53, 64-bit | on the unit | on the unit, with **64-bit** Raspberry Pi OS |
| **Pi Zero W** (original) | 1 × ARM11 (ARMv6), 32-bit | on the unit | **not on the unit**: on another machine on your LAN |

Core runs on Node.js (the version in `.node-version`), which now ships only for
64-bit ARM and x86: Node 24 dropped 32-bit ARM, and no current Node builds for
ARMv6. Pinning an older Node that still does would leave core, which serves
your LAN, on a runtime past its security support, so seedypod doesn't.
`scripts/install --check` says whether a machine can run core.

**On a Pi Zero W, either:**

- **Swap in a Pi Zero 2 W** (about $15, same footprint and pins). The stock
  board's GPIO header is soldered on the underside, so buy one *without* a
  header and solder it on the same way. Then follow this guide as written.
- **Or split it:** flash 32-bit Raspberry Pi OS Lite on the unit and run only
  `install-hal --mqtt-lan`; install core on a 64-bit machine on your LAN (a
  Home Assistant box, a NAS, another Pi) and set `HAL_MQTT_URL`
  (`mqtt://<unit>:1884` with the printed user and password),
  `HAL_UNIT_ID` (from `hald --check` on the unit) and
  `HAL_HTTP_URL=http://<unit>:3001` in its `seedypod-core.service`.
  Wi-Fi setup from the app then acts on that machine, not the unit, so set the
  unit's Wi-Fi in Raspberry Pi Imager instead.

**Settings → About** shows the board hald runs on and the machine core runs on.

## 0. Back up

1. Power off, open the base, remove the Pi's microSD.
2. On a computer: `sudo dd if=/dev/<card> of=gardyn-stock.img bs=4M status=progress` and keep the image.

## 1. Flash

Use a **high-endurance** microSD card, the kind rated for continuous video
recording (SanDisk High Endurance, Samsung PRO Endurance or similar). It costs
a few dollars more than a standard card and is the cheapest reliability gain
there is. `install-hal` also cuts what the unit writes (below), and
**Settings → Storage** shows how much it writes a day.

Raspberry Pi Imager → Raspberry Pi OS Lite (64-bit for Zero 2 W / Pi 4 / Pi 5;
32-bit for the original Zero W, which then runs only hald: see [Which Pi](#which-pi)). In the advanced options set hostname
`seedypod`, enable SSH, add Wi-Fi. Reseat the card, boot, `ssh pi@seedypod.local`.

## 2. Enable I²C and install the HAL

```sh
sudo raspi-config nonint do_i2c 0
curl -fsSL https://raw.githubusercontent.com/seedypod/core/main/scripts/install-hal | bash   # Phase 2.9
hald --check
```

Besides `hald`, this keeps the system journal in RAM, moves swap to
compressed RAM (zram) and mounts `/` with `noatime`, so the card sees far
fewer writes ([ADR-0021](adr/0021-sd-card-wear-and-recovery.md)). Each change
is checked and undone if it doesn't take; `--no-wear` skips them. Logs then
last until reboot; [Debugging](DEBUGGING.md) shows how to keep them longer.

## 3. Install core (same Pi, or any 64-bit LAN box)

```sh
curl -fsSL https://raw.githubusercontent.com/seedypod/core/main/scripts/install | bash
```

The installer first checks the machine can run core and stops with the reason
if it can't. With hald on the same Pi it reads the unit id from `hald --check`
and points core at it; elsewhere, core starts on the simulator until you set
`HAL_MQTT_URL`, `HAL_UNIT_ID` and `HAL_HTTP_URL` in
`/etc/systemd/system/seedypod-core.service` ([Which Pi](#which-pi)). Core
listens on `:3000`. Open `http://seedypod.local:3000/`.

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

## Uninstall

```sh
sudo systemctl disable --now seedypod-core hald
sudo rm -rf /opt/seedypod /etc/systemd/system/seedypod-core.service /etc/systemd/system/hald.service \
  /usr/local/sbin/seedypod-restore /etc/sudoers.d/seedypod-restore /var/lib/seedypod-restore
```
Or reflash the stock image from step 0.
