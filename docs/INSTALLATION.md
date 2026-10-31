# Installation

> Phase 1 is not done: nothing here has run on a real Gardyn yet. Follow at your
> own risk, and **back up the stock card first** so bricking is a 5-minute reflash.

## 0. Back up

1. Power off, open the base, remove the Pi's microSD.
2. On a computer: `sudo dd if=/dev/<card> of=gardyn-stock.img bs=4M status=progress` and keep the image.

## 1. Flash

Raspberry Pi Imager → Raspberry Pi OS Lite (64-bit for Zero 2 W / Pi 4 / Pi 5;
32-bit for the original Zero W). In the advanced options set hostname
`leafypod`, enable SSH, add Wi-Fi. Reseat the card, boot, `ssh pi@leafypod.local`.

## 2. Enable I²C and install the HAL

```sh
sudo raspi-config nonint do_i2c 0
curl -fsSL https://raw.githubusercontent.com/leafypod/core/main/scripts/install-hal | bash   # Phase 2.9
hald --check
```

## 3. Install core (same Pi, or any LAN box)

```sh
curl -fsSL https://raw.githubusercontent.com/leafypod/core/main/scripts/install | bash
```

Core listens on `:3000`; set `HAL_MQTT_URL` in `/etc/systemd/system/leafypod-core.service`
if `hald` is elsewhere. Open `http://leafypod.local:3000/`.

## 4. Home Assistant

Point HA's MQTT integration at the same broker; the device appears via discovery
with no core required. See `docs/homeassistant/` (Phase 5).

## Uninstall

```sh
sudo systemctl disable --now leafypod-core hald
sudo rm -rf /opt/leafypod /etc/systemd/system/leafypod-core.service /etc/systemd/system/hald.service
```
Or reflash the stock image from step 0.
