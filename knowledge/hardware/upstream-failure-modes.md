---
type: "Evidence reference"
title: "Upstream failure modes"
description: "Hardware-relevant bugs recorded in garden-of-eden's issue tracker and the leafypod invariant each one motivates."
status: "draft"
generated: {"by": "claude/fable-5.1", "at": "2026-10-31T04:10:00+00:00"}
sources: [{"resource": "https://github.com/iot-root/garden-of-eden/issues", "title": "garden-of-eden open issues (read 2026-10-29)"}]
---

# Upstream failure modes

| Issue | Observation | leafypod invariant |
|---|---|---|
| #108, #109, #114 | Pump max-run and low-water checks lived in callers; scheduled/CLI runs bypassed them; the cap was a literal in three places | One `PumpGuard` in the HAL is the only path to the pump (ADR-0009) |
| #111 | Guard used one ultrasonic ping, alert used a 5-sample median | Median of N in the driver, consumed identically by guard and alert |
| #131 | Light turned off whenever a process started (PWM re-init); button toggled stale cached state | One long-lived daemon owns the pins |
| #117, #143, #144 | Camera captures unserialized; `fswebcam -S 2` overexposed; exit 0 with no camera | Mutex per device; ≥10 skip frames; validate JPEG size |
| #142 | AM2320 does not ACK `i2cdetect` | Wake write before read; do not infer absence from a scan |
| #130 | Every unit shared one MQTT identity | Unit id from `/proc/cpuinfo` serial |
| #3 | No power-loss recovery | Persist actuator + grow state; restore on boot |

These are test cases, not history: each row has (or will have) a unit test in `hal-core::safety` or the relevant driver.
