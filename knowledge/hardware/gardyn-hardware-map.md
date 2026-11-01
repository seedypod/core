---
type: "Reference"
title: "Gardyn hardware map"
description: "Pins, I²C addresses, sensor parts and per-model differences, as documented upstream and awaiting verification on our unit."
status: "draft"
generated: {"by": "claude/fable-5.1", "at": "2026-10-31T04:10:00+00:00"}
sources: [{"resource": "https://github.com/iot-root/garden-of-eden/blob/main/config.py", "title": "garden-of-eden config.py (pin and address defaults)"}, {"resource": "https://github.com/iot-root/garden-of-eden/blob/main/app/lib/hardware.py", "title": "garden-of-eden hardware.py (model detection)"}]
---

# Gardyn hardware map

The controller is a Raspberry Pi Zero W (owners' reports; iot-root recommends a Zero 2 W upgrade) or Zero 2 W booting from microSD. BCM numbering. The stock board's GPIO header is on the underside, so a replacement Zero 2 W needs its header soldered the same way. Only a Zero 2 W (on 64-bit Raspberry Pi OS) can run core; a Zero W runs hald alone (docs/INSTALLATION.md, Which Pi). hald reports the board as `board` in its system info.

| Function | Interface | Pin / address | Note |
|---|---|---|---|
| Grow light | PWM | GPIO18 | 8 kHz, hardware PWM |
| Pump | PWM | GPIO24 | 50 Hz, software PWM, duty capped at 30 % |
| Water level | DYP-A01 ultrasonic | trig GPIO26 / echo GPIO19 | median of 5 |
| Button | input | GPIO13 | |
| Over-temp alert | input | GPIO25 | |
| PCB temperature | I²C 0x48 | PCT2075 | all models |
| Pump power | I²C 0x40 | INA219 | |
| Air temp/humidity | I²C 0x5C AM2320 (1.0/2.0) · 0x38 DHT20 (3.0/Studio) | | AM2320 needs a wake write |
| Cameras | USB | /dev/video0 upper, /dev/video2 lower | |

Model inference: DHT20 at 0x38 ⇒ 3.0+; else AM2320 ⇒ 1.0/2.0. Home ≈ 5 gal / 30 pods; Studio ≈ 4 gal.

Verification status: **none of this has been measured on our unit.** The Phase 1 probe (see `docs/hardware/pin-map.md`) upgrades this concept to `stable` with a `verified` attestation.
