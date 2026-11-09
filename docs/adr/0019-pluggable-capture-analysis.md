---
type: "Decision record"
title: "ADR 0019: Pluggable capture analysis"
description: "Vision analysers are an interface; their outputs share one versioned results table, export as a dataset, and can be mirrored to opt-in off-device storage and compute."
status: "stable"
generated: {"by": "claude/fable-5.1", "at": "2026-10-31T10:00:00+00:00"}
sources: [{"resource": "/adr/0004-two-tier-hal-core.md", "title": "ADR 0004: Two tiers — hardware daemon and core"}, {"resource": "/adr/0018-runtime-sensor-inventory.md", "title": "ADR 0018: Runtime sensor inventory"}, {"resource": "/PRIVACY.md", "title": "Privacy"}, {"resource": "https://github.com/sleepypod/core", "title": "sleepypod/core (sleep-stage calibration dataset)"}]
---

# ADR 0019: Pluggable capture analysis

**Status:** Accepted, amended 2026-11-09 (learned models run in plain TypeScript, not ONNX), and again 2026-11-09 (the pod-state forward pass runs natively, TypeScript as the fallback)
**Date:** 2026-10-31

> **Amendment, 2026-11-09 ([#185](https://github.com/seedypod/core/issues/185)).** Decision 1
> said a learned model would be "one more analyser that loads an ONNX file". That does not work
> on the unit this targets, a Pi Zero W (ARMv6, no NEON, 426 MB RAM). Measured on it:
>
> | Runtime | Result on the unit |
> |---|---|
> | `onnxruntime-node` / current `onnxruntime-web` | No ARMv6 build; WASM SIMD needs NEON, which the CPU doesn't have |
> | `onnxruntime-web@1.17.3`, non-SIMD WASM, SqueezeNet 1.1 | Compiling the 9 MB runtime took about 5 min, then the OOM killer stopped it at about 170 MB RSS before the model loaded |
> | Plain-JS CNN (64×64×3 crop → 3× conv3×3 16/32/64 → GAP → dense 5, about 24k parameters, about 100 KB) | **753 ms per pod, 22.6 s for 30 pods, 63 MB RSS** at `nice 19`, with core running |
>
> Captures are hourly, so about 23 s on the vision worker per capture is fine. So learned models
> ship as plain-TypeScript analysers with a weights file, the way sleepypod runs its sleep-stage
> model: fit off the device ([seedypod/training](https://github.com/seedypod/training)), ship a
> small, inspectable file (`models/pod-state.json`, format `seedypod-cnn` v1: a JSON header with
> the architecture, classes, input size and normalisation, and the tensors as base64 float32),
> and run it in plain code. The forward pass (`src/vision/cnn.ts`) is one narrow, pure boundary,
> a parsed weights file and a `Float32Array` in, logits out, kept apart from cropping,
> normalisation and the analyser, so a native backend (Rust, say) could replace it if the models
> outgrow JavaScript without touching the analyser. Like the rest of analysis it stays in core,
> never in `hald`. The first is `pod-state`; [Capture analysis](../ANALYSIS.md#the-learned-pod-state-analyser)
> says how it is trained and shipped.
>
> **Amendment, 2026-11-09 ([#191](https://github.com/seedypod/core/issues/191)).** In TypeScript,
> `pod-state` took about 33 s per capture on the unit and slowed core's API to about 1 s, because
> the worker thread shares the single core with the event loop. The native backend this
> amendment's predecessor left room for now exists: `podvision` (`hal/crates/podvision`), a small
> Rust binary that core starts for each capture as a child process at nice 19, under a 60 s
> timeout. It decodes the JPEG (at 1/2, 1/4 or 1/8 scale when every pod's crop still covers the
> model's input), crops the pods exactly as `cropInput` does, and runs the `seedypod-cnn` v1
> forward pass for every enabled revision; core stores its probabilities as the same rows under
> the same analyser ids and versions. It is its own process, never linked into `hald`, so a
> malformed still can only kill the child. If it is missing, fails or times out, core logs it and
> runs the TypeScript path, which stays the reference. It ships in the release tarball
> (`bin/podvision-<target>`), so the installer and the web updater (ADR 0026) checksum, swap and
> roll it back with core. Measured on the unit: about 0.36 s decode, 1.2–1.9 s forward pass for 15
> pods, 1.6–2.4 s per capture, 8.3 MB peak RSS.

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
  was justified by comparing outputs on a shared dataset. [sleepypod](https://sleepypod.github.io/developers/training/) took the
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
   that loads an ONNX file (superseded by the 2026-11-09 amendment: plain
   TypeScript with a weights file). Every enabled on-device analyser runs on each new
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
  fit off-device, ship the weights file as an analyser (the ONNX file of the original text; see the amendment).
- Two new trust boundaries: an outbound credential for the mirror and an
  inbound token for result ingest. Both are per-unit secrets in core's
  settings, never in `hal.toml`.

## Phases

All three phases shipped together; [Capture analysis](../ANALYSIS.md) is the
user and integrator guide.

1. **On device** — `CaptureAnalyzer` (`src/vision/analyzer.ts`), the
   `analysis_results` table (migrations 0002–0003 move `pod_growth` in as
   `green-threshold@1`), the worker queue (`src/vision/service.ts`,
   `visionWorker.ts`), `exg-otsu@1`, the Analysis screen, `list_analyses`.
2. **Export** — `GET /api/datasets/export`, a streamed tar
   (`src/datasets/`), with a download card on the Analysis screen.
3. **Off device** — `MirroredSink`/`S3Sink` (`src/camera/mirrorSink.ts`,
   SigV4 via `aws4fetch`), `POST /api/analyses/results` with its own bearer
   token, and `scripts/analysis-worker.mjs` as the reference worker.
