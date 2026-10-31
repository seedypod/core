---
type: "Decision record"
title: "ADR 0019: Pluggable capture analysis"
description: "Vision analysers are an interface; their outputs share one versioned results table, export as a dataset, and can be mirrored to opt-in off-device storage and compute."
status: "draft"
generated: {"by": "claude/fable-5.1", "at": "2026-10-31T10:00:00+00:00"}
sources: [{"resource": "/adr/0004-two-tier-hal-core.md", "title": "ADR 0004: Two tiers — hardware daemon and core"}, {"resource": "/adr/0018-runtime-sensor-inventory.md", "title": "ADR 0018: Runtime sensor inventory"}, {"resource": "/PRIVACY.md", "title": "Privacy"}, {"resource": "https://github.com/sleepypod/core", "title": "sleepypod/core (sleep-stage calibration dataset)"}]
---

# ADR 0019: Pluggable capture analysis

**Status:** Proposed
**Date:** 2026-10-31

## Context

Core scores every capture with one hard-wired routine
(`src/vision/analyze.ts`): decode the JPEG, take a fixed rectangle per pod,
count pixels whose excess-green index clears a fixed threshold, store one
number per pod in `pod_growth`. It works as a first signal, but:

- There is exactly one analyser and one output column. Trying a per-image
  (Otsu) threshold, a leaf-area estimate or a learned model means replacing
  the routine, so two methods can never be compared on the same photos.
- Results carry no analyser identity or version. Re-scoring old captures
  after an improvement overwrites history instead of sitting beside it.
- The decode runs synchronously on core's event loop; a 1280×720 frame costs
  about 70 ms on a laptop and an estimated 0.7–1 s on a Pi Zero 2 W, during
  which the API, live events and MQTT handling pause.
- Captures are pruned at 720 per camera (30 days hourly) because the SD card
  is the only store. Anything that wants a season of photos — a timelapse, a
  training set, a yield study — has no way to get them.
- The cell-culture analogy fits: a pod is a well, green fraction is
  confluence, the trend is a growth curve. That field moved from fixed
  thresholds to per-image thresholds to learned segmentation, and each step
  was justified by comparing outputs on a shared dataset. sleepypod took the
  same route for its sleep-stage classifier: pair device signals with ground
  truth, build a dataset off the device, fit there, run the cheap result on
  the device.

## Decision

1. **Analysers are an interface, like `SensorKind` (ADR 0018).** A
   `CaptureAnalyzer` declares an `id`, a `version`, the metrics it emits, where
   it may run (`device`, `remote` or both) and a `run(image, pods)` that
   returns per-pod results. The current routine becomes `green-threshold@1`;
   the first addition is `exg-otsu@1` (excess green with a per-image Otsu
   threshold, the PlantCV approach). A learned model is one more analyser
   that loads an ONNX file. Every enabled on-device analyser runs on each new
   capture, on a worker thread, through a single queue that drops to the
   newest capture when it falls behind.

2. **One results table replaces `pod_growth`.** Each row is
   `(captureId, analyzer, version, slot, metric, value, detail?)`, where
   `detail` is small JSON (a bounding box, a confidence). Masks and other
   large outputs go to the blob sink, keyed by capture and analyser, never
   into SQLite. Analysers that share captures are therefore comparable with
   one query; the UI gets a compare view (same photo, outputs side by side,
   trends overlaid) and MCP a read-only `list_analyses` tool. Re-running an
   analyser at a new version over past captures adds rows; it never
   overwrites.

3. **Export is a dataset, not a backup.** `GET /datasets/export` streams a
   bundle of photos, results, pod and grow-cycle metadata and the sensor
   telemetry for the same windows, as JSONL (Parquet later if it earns it).
   This is seedypod's counterpart of sleepypod's sleep-stage dataset script:
   the thing you pull to a laptop to measure, recalibrate or train.

4. **Off-device storage is a second `BlobSink`.** `BlobSink` already
   abstracts where stills live (`FsSink`, `MemorySink`). A `S3Sink` (any
   S3-compatible target: R2, MinIO, a NAS) is added as a *mirror*: the local
   copy keeps the timelapse working offline and keeps today's pruning; the
   mirror lifts the retention limit. Retention becomes "local short, remote
   long".

5. **Off-device compute posts results back.** A remote worker (laptop, GPU
   box) pulls captures and metadata through the REST API, runs analysers
   marked `remote`, and posts rows to `POST /analyses/results` under its own
   analyser id and version, authenticated with a bearer token. Those rows
   land in the same table, so on-device and off-device outputs compare
   directly. Nothing in core waits on a remote worker.

6. **Opt-in, and `hald` stays out of it.** The mirror and the remote worker
   are off by default, configured explicitly, and documented in `PRIVACY.md`
   (which today promises no outbound connections; it will say "none unless
   you configure a mirror"). Analysis is app logic and stays in core (ADR
   0004): `hald` captures frames and guards the pump, and a malformed JPEG
   must never be able to take that process down.

## Consequences

- A new method is one `CaptureAnalyzer` implementation and a fixture of
  expected outputs on the test captures; the compare view, export and MCP
  pick it up without per-analyser code.
- `pod_growth` is migrated into the results table as `green-threshold@1`
  rows, so existing trends survive. `podTrends` reads whichever analyser the
  settings name as primary (default `green-threshold@1` until `exg-otsu@1`
  has been compared on real units).
- Capture scoring leaves the event loop; the Pi's API stays responsive during
  analysis. JPEG decoding is still the dominant cost, and a native decoder
  (`sharp`, with scaled decoding) or a small raw frame from `hald` for
  scoring only are follow-ups the table makes measurable.
- Training a local model becomes a data question, not an architecture
  change: label pods in the UI ("sprouted", "unhealthy", "ready"), export,
  fit off-device, ship the ONNX file as an analyser.
- Two new trust boundaries: an outbound credential for the mirror and an
  inbound token for result ingest. Both are per-unit secrets in core's
  settings, never in `hal.toml`.

## Phases

1. **On device** — `CaptureAnalyzer`, the results table and migration, the
   worker queue, `exg-otsu@1`, the compare view, `list_analyses`.
2. **Export** — the dataset bundle and a documented pull-to-laptop workflow.
3. **Off device** — `S3Sink` mirror and the results-ingest endpoint, when
   there is a remote worker to use them.
