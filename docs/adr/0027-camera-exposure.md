---
type: "Decision record"
title: "ADR 0027: Cameras in HomeKit and Home Assistant"
description: "Both tower cameras appear in the Home app and Home Assistant as snapshot cameras that show the newest stored still. Live streaming is declined on the Pi Zero W, with CPU measured on a real unit."
status: "stable"
generated: {"by": "claude/opus-5.5", "at": "2026-11-08T08:00:00+00:00"}
sources: [{"resource": "/adr/0013-ha-bridge.md", "title": "ADR 0013: Core-level MQTT bridge for Home Assistant"}, {"resource": "/adr/0019-pluggable-capture-analysis.md", "title": "ADR 0019: Pluggable capture analysis"}, {"resource": "/adr/0023-homekit.md", "title": "ADR 0023: HomeKit bridge and per-unit identity"}, {"resource": "https://github.com/homebridge/HAP-NodeJS", "title": "HAP-NodeJS CameraController"}, {"resource": "https://www.home-assistant.io/integrations/camera.mqtt/", "title": "Home Assistant MQTT camera"}, {"resource": "https://www.home-assistant.io/integrations/generic/", "title": "Home Assistant generic camera"}]
---

# ADR 0027: Cameras in HomeKit and Home Assistant

**Status:** Accepted
**Date:** 2026-11-08

## Context

The two tower cameras show only in the web UI, as stills. Owners want them in
the Home app and in Home Assistant too (#134). The stills already exist: hald
takes one per camera every `captureIntervalMin` (60 by default) with
`fswebcam` at 1280×960 (`hal-drivers/src/uvc.rs`). Core stores each one under
`DATA_DIR/captures` (ADR 0019). The cameras are USB UVC devices that put out
MJPEG, and both sit behind one USB 2.0 hub on a Pi Zero W: one ARMv6 core and
426 MB of RAM. The hub's link is already the unit's weak point
(`docs/hardware/`).

### What things cost on a real unit

Measured on 2026-11-08 on a Gardyn 3.0 running seedypod OS (Pi Zero W, kernel
`armv6l`). Busy share comes from `/proc/stat` deltas over each step, so USB,
IRQ and kernel work count too. Camera steps ran under
`flock /tmp/seedypod-camera.lock`. Core, hald and avahi were running, so the
idle unit was already 28 % busy. The CPU column is the whole core over the
step, baseline included; the cost of the step is what lies above 28 %.

| Step | Wall | Busy (of the one core) | CPU time |
|---|---|---|---|
| Idle baseline, 20 s | 20.1 s | 28 % | 5.5 s |
| One still the way hald takes it (1280×960, skip 15, re-encode q85) | 4.0 s | 79 % | 3.1 s (≈ 2 s above baseline) |
| Pull MJPEG 640×480 at 30 fps for 10 s, no decode | 10.6 s | 37 % | 3.9 s |
| Pull MJPEG 1280×960 at 30 fps for 10 s, no decode | 10.6 s | 39 % | 4.0 s |
| Software MJPEG decode, 640×480 (`fswebcam -F 31` minus `-F 1`) | — | — | **≈ 144 ms per frame** |
| Hardware H.264 encode (bcm2835-codec, `/dev/video11`) | — | — | **fails**: `REQBUFS` EINVAL, dmesg "failed to create component ril.video_encode (Not enough GPU mem?)" with `gpu_mem` 64 MB and 4.8 MB of 256 MB CMA free |
| Serve one stored 200 KB still over HAP (read + ChaCha20-Poly1305 in 1 KB frames, node 22) | 206 ms | — | **149 ms** |
| Publish one 200 KB still to the local broker (`mosquitto_pub -f`) | 74 ms | — | — |

`ffmpeg` is not in the image.

## Options

**HomeKit live view: `CameraController` with ffmpeg and SRTP.** HomeKit
streams only H.264 over SRTP. The camera's MJPEG would have to be decoded and
re-encoded at, say, 640×480 at 15 fps:

- In software, the decode alone is 15 × 144 ms ≈ 2.2 s of CPU per second,
  more than twice what the Pi has, before any H.264 encode.
- The VideoCore encoder doesn't start on the shipped configuration, so
  hardware encoding needs a bigger GPU split and a reboot, which takes RAM from
  a unit with 169 MB free. Even then, the stream still pulls ~10 % of the core
  in USB work.
- A stream holds the UVC device, so hald's stills would fail while someone is
  watching, and camera alerts (`camera_missing`, link damage) would fire.
- It would add ffmpeg to the image.

Not viable on this hardware.

**HomeKit snapshots only: `CameraController`, live view refused.** Home asks
for a snapshot about every 10 s per camera while it shows the camera, and not
otherwise. Answering from storage costs ~150 ms of CPU per request (the
encryption, not the camera). With both cameras on screen that is ≈ 3 % of the
core while the Home app is open, and nothing otherwise. The image is as old
as the last capture.

**HomeKit snapshots that trigger a capture.** That would be ≈ 2 s of CPU
and 4 s of camera time per snapshot. At Home's 10 s cadence it would keep
the Pi near full and the cameras busy. Rejected.

**Home Assistant: MQTT `camera`.** HA shows the last image published on a
topic. Core's bridge (ADR 0013) publishes each new still once, retained: 2 ×
~200 KB per capture interval. It needs no setup beyond the bridge, but it only
reaches HA when core's bridge points at HA's broker.

**Home Assistant: generic camera on a still URL.** HA polls a URL. A fixed URL
for the newest stored still, `GET /api/camera/<upper|lower>/latest.jpg`,
works with any HA setup that can reach the unit. Each poll costs one file read.
It needs manual setup in HA.

**Home Assistant: MJPEG stream.** It costs the same USB time and device
contention as HomeKit live view, minus the transcode. Rejected for the same
contention reasons.

## Decision

- **No live streaming on the Pi Zero W.** The cameras stay stills-only. A
  future unit with a faster board, or a hardware encoder that works on the
  shipped image, would need a new ADR with fresh measurements.
- **HomeKit:** each camera hald reports is a bridged accessory, "Upper
  camera" or "Lower camera". It carries a `CameraController` with one RTP
  stream service (H.264 baseline 3.1, AES_CM_128 SRTP, 1280×960 down to
  320×240) and no microphone or recording.
  - A snapshot is the newest stored still, sent as stored; Home scales it.
  - Only a camera with no stored still at all takes one, through
    `camera.capture`, at most once per 10 minutes, with concurrent requests
    sharing it.
  - `prepareStream` and `handleStreamRequest` refuse with "live view is off".
  - Code: `src/homekit/accessories/camera.ts`.
- **Home Assistant:** core's bridge publishes discovery for an MQTT `camera`
  per camera, `<unit>_core_camera_<name>` on `seedypod/<unit>/core/camera/<name>`.
  It sends the newest stored still, raw JPEG and retained, on connect and
  after every stored still. A still already on the topic isn't sent again.
  `GET /api/camera/<name>/latest.jpg` (`cache-control: no-cache`) serves the
  same still for a generic camera. Neither one takes a capture.
- Every stored still now emits the `captures` mutation, whether scheduled or
  on demand. Before, only the app's capture button did, so the UI also
  refreshes on scheduled stills.

## Consequences

- Both apps show what the web UI shows, at no camera cost. The image is up to
  one capture interval old. Owners who want fresher images shorten
  `captureIntervalMin` and pay hald's ≈ 2 s of CPU per still.
- Tapping a camera in the Home app shows the snapshot. Starting live view
  fails with "No Response". That is the intended outcome of refusing the
  stream, not a fault.
- Adding the two camera accessories bumps the bridge's configuration number.
  Home picks them up without re-pairing. It puts accessories that appear after
  pairing in the **bridge's own room**, which is often "Default Room" even when
  every earlier accessory was moved. Owners move the cameras, or set the
  bridge's room first (Home → Settings → Hubs & Bridges → the bridge →
  Room). HAP has no way to set a room.
- What Home asks for shows in the journal. Each line is logged the first time
  and again whenever the outcome changes:
  - At publish: `homekit: bridged …`.
  - Every `POST /resource`, with the accessory, size, reason and HTTP status
    or byte count: `homekit: image request for Upper camera, 640x360, reason 0: 201813 bytes in 160 ms`.
    It includes refusals hap-nodejs makes before core sees the request: 404
    for no camera, 207/-70412 while Home has the camera's streaming off.
  - The camera's own answer: `homekit: upper camera: snapshot 640x360 served …`,
    `… found no stored still`, or `… failed: …`.
  - Home switching a camera's streaming: `homekit: Upper camera: Home turned streaming off, so its snapshots are refused`.

  No `image request` line at all means Home never asked.
- The cameras stay bridged. Bridged cameras work in Home: Homebridge bridges
  them by default, and its "unbridge" option exists only so a slow snapshot
  can't stall the other accessories. Here a snapshot is a file read and never
  blocks the bridge. Unbridging would need each camera added separately with
  its own setup code.
- With `captureIntervalMin` 0 and no stills, HomeKit takes one still per
  camera per 10 minutes while Home asks. HA shows nothing until a still is
  taken.
- An API key (`settings.apiKey`) also guards `latest.jpg` from LAN clients.
  The generic camera can't send `x-api-key`, so a unit with a key should use
  the MQTT camera.
- Not verified here: how the Home app and HA show these entities on the
  owner's devices. The HAP accessory tree, the snapshot path and the MQTT
  payloads are covered by tests.

## Amendment (2026-11-09): snapshot-only cameras must still advertise a full camera

**Supersedes** the camera's stream declaration in the Decision above ("one RTP
stream service (H.264 baseline 3.1 …) and no microphone").

As first shipped (#151), both camera tiles in the Home app read "No Response",
and Home never sent a snapshot request (#182). The declared camera was:

- one stream
- 15 fps only, at five sizes
- baseline H.264 at level 3.1 only
- no audio, so hap-nodejs added no Microphone service

The HAP debug log (#180) shows the home hub pairing, reading every
accessory's firmware, and writing `Active = 1` on both cameras. It subscribed
to nothing on the cameras and sent no `/resource`. The Mac never opened its
own connection, and no snapshot request reached the unit with Garden open.

After #181 the declaration matches homebridge-camera-ffmpeg:

- two streams
- HAP's 16:9 and 4:3 sizes at 30 fps, 320×180 to 1920×1080 and 1600×1200
- baseline, main and high H.264 at levels 3.1, 3.2 and 4.0
- AAC-ELD 16 kHz audio, which brings the Microphone service

After the update, with Garden open in Home, the Mac connected to the bridge itself. It read
both cameras' `SupportedVideoStreamConfiguration` and then sent `POST /resource`
for each camera about every 10 s. Each request got the stored still
(1280×720 requested, 202–223 KB, 55–87 ms).

**Rule:** a snapshot-only camera still declares a full camera: two streams,
the standard 30 fps sizes, the three H.264 profiles and levels, and an audio
codec so the Microphone service exists. It then refuses live view in
`prepareStream`. Declaring costs nothing, because nothing is encoded or sent.
`camera.test.ts` pins the declaration.

**Not isolated:** which missing element made Home give up. It was changed as
one set and wasn't bisected on a device.
