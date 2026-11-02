---
type: "Reference"
title: "Gardyn hardware map"
description: "Pins, I²C addresses, parts and model detection as documented upstream, with the Phase 1 verification checklist."
status: "draft"
generated: {"by": "claude/fable-5.1", "at": "2026-10-31T04:40:00+00:00"}
sources: [{"resource": "https://github.com/iot-root/garden-of-eden", "title": "iot-root/garden-of-eden (reference implementation, GPL-3; no code copied)"}, {"resource": "stock microSD of a Gardyn Home 3.0 (firmware master.440)", "title": "Stock Gardyn firmware, read-only inspection 2026-11-01 (proprietary; facts only, no code copied)"}, {"resource": "photos of a Gardyn Home 3.0 controller board and pump, 2026-11-01", "title": "Part labels and silkscreen, photographed by the maintainer"}]
---

# Gardyn hardware map

**Status: checked against the stock firmware, not yet probed on the board.**
Rows marked "upstream" come from
[iot-root/garden-of-eden](https://github.com/iot-root/garden-of-eden)
(`config.py`, `app/lib/hardware.py`, README). Rows marked "stock fw" match the
firmware on a Gardyn Home 3.0's stock card (hardware profile `hw_gh30`,
version `master.440`, Raspbian 9 on a Pi Zero W), read on 2026-11-01. When a
row is probed on the board, mark it "verified <date>, model X".

BCM numbering (not header pin numbers).

| Function | Interface | Pin / address | Notes | Source |
|---|---|---|---|---|
| Grow light | PWM out | GPIO18 | 20 kHz hardware PWM (stock); upstream used 8 kHz | stock fw |
| Pump | GPIO out | GPIO24 | Stock drives it plain on/off (100 %), 5 min runs, ~10.6 W; upstream used 50 Hz software PWM capped at 30 % for brown-outs. See below | stock fw |
| Water level | DYP-A01 ultrasonic | trigger GPIO26, echo GPIO19 | Stock: 30 µs trigger, 1 s timeout, keeps readings in 3–25 cm and takes the median of the last 6 | stock fw |
| Button | GPIO in | GPIO13 | pull-up, active low, falling edge, 80 ms debounce (stock) | stock fw |
| Over-temp alert | GPIO in | GPIO25 | PCT2075 OS output, pull-down; stock sets the over-temperature and hysteresis thresholds to 70 °C and only reports it | stock fw |
| PCB temperature | I²C | 0x48 PCT2075 | reads ~47 °C with the lights at 100 % | stock fw |
| Pump power | I²C | 0x40 INA219 | 0.08 Ω shunt (stock calibration) | stock fw |
| Air temp + humidity | I²C | 0x5C AM2320 (Gardyn 1.0/2.0) · 0x38 DHT20 (3.0, Studio) | Stock tries AM2320, then DHT20; our 3.0 uses the DHT20. AM2320 needs a wake-up write before it ACKs | stock fw |
| Upper camera | USB UVC | `/dev/seedypod/camera-upper` (udev, by USB port; `/dev/video0` fallback) | through an on-board hub; port unverified | upstream |
| Lower camera | USB UVC | `/dev/seedypod/camera-lower` (udev, by USB port; `/dev/video2` fallback) | port unverified | upstream |
| Controller | — | Pi Zero W (our 3.0) / Zero 2 W | microSD boot; stock runs it at `force_turbo=1`, `over_voltage=6` | stock fw |

## Tank and pump, from two weeks of stock logs

The data is in `tests/fixtures/gardyn-gh30-stock-2024/`.


- Water distance runs from ~5.9 cm just after a fill to ~20 cm empty, falling about 1.3 cm a day.
- The pump draws ~10.6 W while it lifts water. From ~19.6 cm it loses prime and draws ~3.3 W, which makes pump power a usable dry-run signal.
- Stock schedules, as observed in the logs: lights at 100 % from 09:00 to 23:00; the pump for 5 min at 03:00, 09:00, 15:00 and 21:00.
- The pump's label reads **TD40A-1248A** brushless DC pump: 12 V DC, 950 mA (11.4 W rated), max head 430 cm, max flow 600 L/h, IPX8. The ~10.6 W measured while lifting sits just under that rating.
- Raw ultrasonic readings below 3 cm (the blind zone) were the common bad reading; 1 % of good ones read under 4.4 cm.

## Controller board, from a photo

On our Home 3.0 the top board is silkscreened **Rev1.5 PCB 11/2019**. It carries the SoC, the micro-SD slot, a mini-HDMI port, two micro-USB ports labelled `PWR IN` and `USB`, and connectors labelled `H2O IN` (2-pin) and `TEMP IN` (4-pin). It is stacked on a second board through the 40-pin GPIO header. A small daughterboard with two connectors sits beside it; what it does (possibly the camera USB hub) is unverified.

## Model detection

DHT20 ACKs at 0x38 ⇒ Gardyn 3.0 or Studio; otherwise AM2320 ⇒ 1.0/2.0.
Studio tank ≈ 4 gal, Home ≈ 5 gal / 30 pods.

## Known failure modes (from upstream's issue tracker — these are our test cases)

- Pump safety scattered across callers (#108, #109, #114) → `PumpGuard` is the only path (ADR-0009).
- Guard used one ultrasonic ping while the alert used a median (#111) → median everywhere.
- PWM re-init on process start turns the light off (#131) → one long-lived daemon.
- Camera captures not serialized (#117); `fswebcam -S 2` overexposes (#143); exits 0 when unplugged (#144) → mutex, ≥10 skip frames, validate JPEG size.
- AM2320 doesn't answer `i2cdetect` (#142) → wake write before read.
- Shared MQTT identity across units (#130) → id from `/proc/cpuinfo` serial.

## Phase 1 checklist

1. Photograph both sides of the PCB, the Pi, header orientation, camera USB routing, PSU label → `docs/hardware/photos/`.
2. `dd` the stock microSD to an image (store off-repo).
3. Flash Raspberry Pi OS Lite 64-bit (Zero 2 W) with SSH/Wi-Fi/hostname preset.
4. `sudo i2cdetect -y 1`; run upstream's `distance.py`, `light.py --on`, `pump.py --on --speed 20` (5 s, water present), both cameras — as throwaway probes only. `hald --list-cameras` → record which USB port is the upper camera, so `hald --camera-rules` gets the default right.
5. Check the install steps on real Raspberry Pi OS, which the simulator and the installer tests can't:
   - **Camera ports:** `hald --list-cameras` names both cameras, and the generated udev rules put upper and lower on the right ports.
   - **Wi-Fi setup hotspot:** holding the button for 10 s opens `seedypod-setup-xxxx`, and joining a network from `http://10.42.0.1:3000/wifi` works (NetworkManager, polkit rule).
   - **Mosquitto:** `systemctl status mosquitto` is active with `/etc/mosquitto/conf.d/seedypod.conf`; `--mqtt-lan` opens 1884 with the printed password.
   - **SD card wear settings (ADR-0021):** after `install-hal`, `ls /etc/systemd/journald.conf.d/` shows `50-seedypod-volatile.conf` and `journalctl --header | grep -i 'file path'` points under `/run/log/journal`; `swapon --show` lists `/dev/zram0` and no `/var/swap`; `findmnt -no OPTIONS /` includes `noatime`. Reboot, then check all three again, and that `hald` and core come back. **Settings → Storage** shows a writes-per-day figure.
   - **Restore on a real card:** download a backup, reflash, run both installers, restore from **Welcome**. The helper runs through `sudo -n` and `systemd-run`, and the unit comes back with the same Home Assistant device. Then **Undo restore** and **Redo restore**.
6. Update this table with verified values and the model; file ADR-0008.
