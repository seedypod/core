---
type: "Decision record"
title: "ADR 0028: Camera capture format for image analysis"
description: "Measured on a real unit: fswebcam's second JPEG pass costs analysis almost nothing, while the camera's own MJPEG at 30 fps adds chroma noise that reads as leaf cover on empty pods. Keep JPEG stills and the MJPEG default for now; move analysis stills to the YUYV palette once hald can check a YUYV frame for tears."
status: "draft"
generated: {"by": "claude/opus-5.5", "at": "2026-11-09T08:30:00+00:00"}
sources: [{"resource": "/adr/0019-pluggable-capture-analysis.md", "title": "ADR 0019: Pluggable capture analysis"}, {"resource": "/adr/0021-sd-card-wear-and-recovery.md", "title": "ADR 0021: SD card wear and fast recovery"}, {"resource": "/hardware/hal.md", "title": "Hardware abstraction layer"}, {"resource": "/ANALYSIS.md", "title": "Capture analysis"}]
---

# ADR 0028: Camera capture format for image analysis

**Status:** Proposed
**Date:** 2026-11-09

## Context

Stills come from `fswebcam -p MJPEG -r 1280x960 -S 15 --jpeg 85`. It decodes the
camera's MJPEG frame and encodes a new JPEG, and the worry (#138) was that this
second lossy pass shifts colour and adds artefacts that skew the green fraction
the analysers measure (ADR 0019).

We measured on the real unit (Pi Zero W, armv6l, Raspbian kernel 6.18) on
2026-11-09 between 07:39 and 07:54 UTC, with both cameras present. The upper
camera is on USB port 1-1.3 and the lower on 1-1.4, behind a Terminus 1a40:0801
hub. Every camera access ran under `flock /tmp/seedypod-camera.lock`, between
hald's hourly captures. The scene was the empty tower lit by room lights at
night, so this measures how much *false* cover and noise each format makes,
not how well it sees leaves. Analysis used both v2 on-device analysers from
`src/vision` as of #145, run on a laptop over the fetched frames. The
measurement scripts are not in the repo; the numbers are below.

### What the cameras offer

Both are Alcorlink "View Camera" (`c499:0ac8`, `uvcvideo`) with identical modes
(`v4l2-ctl --list-formats-ext`):

| Format | Sizes (fps) |
|---|---|
| MJPG | 2592x1944, 2240x1600, 2048x1536, 1600x1200, 1280x1024 (15); 1280x960, 800x600, 640x480, 320x240 (30) |
| YUYV | 2592x1944, 2240x1600, 2048x1536 (2); 1920x1080, 1600x1200 (5); 1280x1024, 1280x960 (8); 1280x720 (10); 800x600 (20); 640x480, 320x240 (30) |

Controls: brightness, contrast, saturation, hue, gamma, gain (0–10, at 6),
sharpness, backlight compensation, power-line frequency (60 Hz), white balance
automatic (on; manual 2800–6500 K, at 5000), and exposure. Exposure reports
`auto_exposure = 0`, a value outside its own menu (1 manual, 3 aperture
priority), with an absolute exposure of 39–5000 (×100 µs) and dynamic frame rate
off. So at 30 fps exposure can't run past 33 ms, whatever the light.

### Capture time and size (1280x960 unless noted)

Wall and CPU seconds per still, measured with `time` around the locked command.
Sizes are per still.

| Method | Wall s | CPU s | Size |
|---|---|---|---|
| `fswebcam -p MJPEG --jpeg 85` (today) | 3.2–4.9 | 1.8–2.3 | 187–204 kB |
| Same run, camera's own frame (`--dumpframe`, trimmed at EOI) | same run | same run | 222–247 kB (+20 %) |
| `v4l2-ctl` MJPEG, skip 15, no decode | 1.09–1.20 | 0.10–0.15 | 223–247 kB |
| `v4l2-ctl` YUYV, skip 8 | 2.4–3.4 | 0.07–0.09 | 2.46 MB raw |
| `fswebcam -p YUYV --png 1` | 5.8–8.7 | 2.9–3.2 | 1.93–2.03 MB |
| `fswebcam -p YUYV --jpeg 85`, skip 15 | 5.0–7.9 | 1.5–1.6 | 163–190 kB |
| `v4l2-ctl` MJPEG 2592x1944, skip 15 | 1.9–2.4 | 0.1–0.3 | 382–514 kB |

YUYV at 1280x960 is 8 fps. `v4l2-ctl` reported dropped buffers on three of the
six YUYV runs, which is about 20 MB/s through the hub.

Core decodes every still with `jpeg-js` before analysis. On the unit that takes
3.5–6.5 s at 1280x960 and 17–50 s at 2592x1944, the slow case under memory
pressure (426 MB RAM).

### Analysis

Within each run the scene was static, so variation between frames is noise.
"False cover" is the green fraction the v2 analysers gave an empty pod. Both
analysers agreed to three decimals on every frame.

| Upper camera | ExG noise per pixel | Leaf-coloured pixels | Worst empty pod | Pod spread (sd) |
|---|---|---|---|---|
| fswebcam MJPEG→JPEG (today), 7 frames | 5.7 | 0.99 % | 0.035 (pod 9) | 0.0022 |
| Camera's MJPEG frame, same 5 frames | 6.0 | 1.17 % | 0.037 | 0.0017 |
| `v4l2-ctl` MJPEG, 5 frames | 6.1 | 1.08 % | 0.031 | 0.0021 |
| YUYV converted on the laptop, 3 frames | 3.3 | 0.66 % | 0.004 | 0.0002 |
| fswebcam YUYV→PNG, 2 frames | 2.8 | 0.34 % | 0.000 | 0.0000 |
| fswebcam YUYV→JPEG 85, 5 frames | 2.2 | 0.17 % | 0.002 | 0.0001 |

ExG noise is the per-pixel sample standard deviation of 2G − R − B across a
run. Leaf-coloured pixels is the share of the frame that passes both the excess-
green test and the leaf-colour test. The MJPEG stills taken just before and just
after the YUYV→JPEG run read 0.026 and 0.027 on pod 9, and up to 0.013 on
others; the YUYV stills between them read at most 0.002. The lower camera, in
darker light, gave at most 0.002 false cover in every format; its ExG noise was
3.9 for today's stills and 2.1 for YUYV→JPEG.

The re-encode alone, today's still against the raw frame it came from:

| | PSNR | Mean abs. difference | Pixels whose leaf mask flips |
|---|---|---|---|
| Re-encode vs its own frame (upper / lower) | 38.6 / 40.5 dB | 2.1 / 1.6 levels | 0.95 % / 0.08 % |
| One raw frame vs the next (upper / lower) | 28.8 / 30.2 dB | 6.6 / 5.2 levels | 2.1 % / 0.16 % |

Mean colour moved by at most 0.3 levels per channel. The re-encode slightly
*smooths* noise (5.4 vs 6.0 ExG on the same frames), and the worst empty pod
read 0.038 from the re-encoded stills against 0.037 from their own raw frames.

### Drift with auto exposure and white balance

The unit's 84 stored hourly stills (42 per camera, 2026-11-07 13:11 to
2026-11-09 07:28 UTC) span daylight, room lights and dark. Across the lit ones,
blue/red ratio had an sd of 0.12 on both cameras (0.62–1.18 on the upper one)
and mean luma ran from 41 to 116. The upper camera's worst empty pod moved
between 0.000 and 0.057; 10 of the 12 stills above 0.02 were in the warm,
low-blue stretches (blue/red under 0.85). That mixes changes in the light with
changes in the camera's settings, so it doesn't isolate auto white balance. Grow
lights weren't in these stills. Testing fixed exposure would mean writing
camera controls hald depends on, and `auto_exposure` can't be put back to its
reported value of 0 through its own menu, so we didn't change controls on the
live unit.

## Decision

1. **Keep JPEG stills, and keep fswebcam's re-encode.** The second lossy pass is
   not what skews cover: its error is about a third of the camera's own noise
   between two frames, it leaves colour alone, and passing the camera's frame
   through unchanged gave the same pod scores while costing 20 % more card.
   Raw MJPEG passthrough is rejected as an analysis fix.

2. **The camera's MJPEG mode is the problem, and YUYV is the fix.** In MJPEG at
   30 fps the stills carry green and magenta chroma speckle that reads as up to
   3.5 % (once 5.7 %) leaf cover on an empty pod. The same camera in YUYV, still
   saved as JPEG 85, reads under 0.2 %, has under half the per-pixel noise, and
   makes files 5–15 % smaller. Some of the gain is likely exposure rather than
   compression, because YUYV's 8 fps lets the camera expose longer at less gain.
   It is what the format switch delivers either way.

3. **Don't switch the default yet.** hald's tear check walks the camera's MJPEG
   frame and can't read a YUYV frame (hal.md, Stills), and this hub has a record
   of torn frames. A YUYV capture is also 1.5–4 s slower, and dropped buffers
   at 20 MB/s on the hub need a soak before trusting it. Moving the default needs
   a YUYV tear check in hald first: a frame cut short leaves a zero-filled tail,
   which core already looks for after the fact (ANALYSIS.md). That is follow-up
   work. Until then a unit can opt in with `palette = "YUYV"` per `[[camera]]`
   in `hal.toml`, accepting that torn frames are then caught only by fswebcam's
   own errors and core's zero-fill check.

4. **Don't go above 1280x960 on a Pi Zero.** 2592x1944 takes 17–50 s to decode
   for analysis and 2–2.5× the card. It can be revisited on a Pi 3 or later.

5. **PNG isn't worth it.** Lossless YUYV→PNG measured no better than YUYV→JPEG
   85 at the pod level, for about 10× the storage (2 MB a still, about 2.9 GB for
   30 days of both cameras hourly against 0.27 GB now) and more SD wear
   (ADR 0021).

## Consequences

- Nothing changes on units today. The analysers already shrug off most colour
  casts (#145); what is left is MJPEG chroma noise on the upper camera's
  brighter, busier scene.
- Follow-ups, each with a re-measure on the same lit scene:
  - YUYV tear check in hald (zero-filled or short frame), then `palette =
    "YUYV"` as the default, with a soak through the hub for dropped buffers.
  - Fixed white balance and exposure under the grow lights: read each
    control's value back after setting it, restore the camera's state when done,
    and compare a day of stills against auto.
  - Direct V4L2 capture of the camera's MJPEG (about 1.1 s and 0.1 CPU-s against
    3.2–4.9 s and 2 CPU-s). This is for capture time and CPU only, not analysis.
    It only helps while the palette stays MJPEG.
- Re-measure with plants in the pods, under the grow lights, before reading
  these numbers as accuracy. They bound noise and false cover only.

Refs: #138, #132, #145.
