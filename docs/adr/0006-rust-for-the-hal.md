# ADR 0006: Rust for the hardware daemon

**Status:** Accepted
**Date:** 2026-10-30

## Context

garden-of-eden uses Python with gpiozero over the `pigpiod` daemon for
hardware-timed PWM. That stack has three problems for an appliance: a venv and
apt dependency surface that drifts across Raspberry Pi OS upgrades; a separate
daemon dependency; and `pigpio` does not work at all on the Pi 5's RP1 GPIO
block, so the Python stack cannot follow a controller upgrade.

## Decision

`hald` is Rust: `rppal` for GPIO/PWM/I²C (works on every Pi through the 5),
`embedded-hal` driver crates for INA219/PCT2075/DHT20/AM2320, `rumqttc` for
MQTT, `axum` for the still/health endpoints, `tokio`. Cross-compiled in CI with
`cross` for `arm-unknown-linux-gnueabihf` (Zero W) and
`aarch64-unknown-linux-gnu` (Zero 2 W / Pi 4 / Pi 5). Real drivers sit behind
the `hardware` cargo feature so laptops and CI build the simulator path.

Python is used only as a throwaway probe in Phase 1 (running upstream's driver
scripts to confirm the pin map on our unit); no Python ships.

## Alternatives considered

- **Python daemon first, Rust later.** Rejected: the Python version would ship
  and the port would never happen.
- **Node on the Pi for the HAL.** GPIO/I²C libraries are weak, especially on
  the Pi 5.

## Consequences

### Positive
- One static binary, < 10 MB resident, no runtime, no daemon, portable across
  controllers.
- Soft-PWM for the pump (GPIO24 is not a hardware PWM pin) and the µs echo
  timing for the ultrasonic sensor are straightforward on a dedicated thread.

### Negative
- Rust toolchain in CI and on contributor machines; `cross` for release builds.

**Authors**: @ng
