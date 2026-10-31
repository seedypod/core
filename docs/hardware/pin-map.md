---
type: "Reference"
title: "Gardyn hardware map"
description: "Pins, I²C addresses, parts and model detection as documented upstream, with the Phase 1 verification checklist."
status: "draft"
generated: {"by": "claude/fable-5.1", "at": "2026-10-31T04:40:00+00:00"}
sources: [{"resource": "https://github.com/iot-root/garden-of-eden", "title": "iot-root/garden-of-eden (reference implementation, GPL-3; no code copied)"}]
---

# Gardyn hardware map

**Status: unverified on our unit.** Everything here comes from
[iot-root/garden-of-eden](https://github.com/iot-root/garden-of-eden)
(`config.py`, `app/lib/hardware.py`, README) and is the *hypothesis* Phase 1
confirms. When confirmed, replace "upstream" with "verified <date>, model X".

BCM numbering (not header pin numbers).

| Function | Interface | Pin / address | Notes | Source |
|---|---|---|---|---|
| Grow light | PWM out | GPIO18 | 8 kHz; hardware PWM channel on every Pi | upstream |
| Pump | PWM out | GPIO24 | 50 Hz; **not** a hardware PWM pin → software PWM; cap duty at 30 % (board browns out) | upstream |
| Water level | DYP-A01 ultrasonic | trigger GPIO26, echo GPIO19 | µs timing; use median of 5 | upstream |
| Button | GPIO in | GPIO13 | single = light, double = pump (upstream behaviour) | upstream |
| Over-temp alert | GPIO in | GPIO25 | from the PCB thermal monitor | upstream |
| PCB temperature | I²C | 0x48 PCT2075 | all models | upstream |
| Pump power | I²C | 0x40 INA219 | V / I / W | upstream |
| Air temp + humidity | I²C | 0x5C AM2320 (Gardyn 1.0/2.0) · 0x38 DHT20 (3.0, Studio) | AM2320 needs a wake-up write before it ACKs; won't show in `i2cdetect` | upstream |
| Upper camera | USB UVC | `/dev/seedypod/camera-upper` (udev, by USB port; `/dev/video0` fallback) | through an on-board hub; port unverified | upstream |
| Lower camera | USB UVC | `/dev/seedypod/camera-lower` (udev, by USB port; `/dev/video2` fallback) | port unverified | upstream |
| Controller | — | Pi Zero W (early) / Zero 2 W | microSD boot; header soldered mirrored | upstream |

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
5. Update this table with verified values and the model; file ADR-0008.
