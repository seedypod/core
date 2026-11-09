---
type: "Guide"
title: "Capture analysis"
description: "How the unit scores pods from camera stills, how to compare analysers, export a dataset, mirror photos off the unit, and plug in an off-device analyser."
status: "draft"
generated: {"by": "claude/opus-5.5", "at": "2026-10-31T12:00:00+00:00"}
sources: [{"resource": "/adr/0019-pluggable-capture-analysis.md", "title": "ADR 0019: Pluggable capture analysis"}, {"resource": "/PRIVACY.md", "title": "Privacy"}]
---

# Capture analysis

Every still the unit takes is scored per pod by one or more **analysers**.
Each analyser says how much of each pod's crop looks like plant (the *green
fraction*, 0–1), and the trend of that number drives the growing / stalled /
declining verdicts on the Grow screen and the `pod_health` MCP tool.

Pods 1–15 are seen by the upper camera and 16–30 by the lower one: three
columns left to right, counted across then down from the top.

## On the unit

Three analysers run after every capture, on a worker thread so the app stays
responsive while a Pi decodes the photo:

| Analyser | What it does |
|---|---|
| `green-threshold@2` | Excess-green index (2G − R − B) above a fixed cut-off. The original baseline; drifts with grow-light colour and exposure. |
| `exg-otsu@2` | The same index with the cut-off chosen per photo by Otsu's method (the PlantCV approach), so a lighting change moves the threshold rather than the result. |
| `pod-state@1` | A small learned model that names each pod empty, sprouted, growing, ready or unhealthy, with a confidence. See [the learned pod-state analyser](#the-learned-pod-state-analyser). |

Both count only what can be a plant, in two steps (version 2, from
[#132](https://github.com/seedypod/core/issues/132)):

- **Leaf colour.** Excess green alone also fires on the white tower under a warm
  or green-tinted light, a grey-green wall and dark olive shadow; version 1 read
  30–65 % cover on a tower with every pod empty. A pixel counts only when green is
  its strongest channel, its hue lies between yellow-green and blue-green, and it
  is saturated and bright enough to tell. On the reference stills from an empty
  tower, every pod now reads 2 % or less.
- **Whose plant it is.** Each connected blob of plant pixels counts for a pod
  only when it grows from that pod: its centre lies in the pod's box, or it
  reaches the middle third of the box, where the cup is. The leaves of a large
  plant that spill over the edge of an empty neighbour's box don't count there,
  and plants that have grown into each other still count for each pod they grow
  from. Specks too small to be a seedling count for no one.

### Pod boxes

Each pod is scored on a box around its cup. The defaults were measured on a
Gardyn Home 3.0's stills, one box per cup centred on its opening
(`src/vision/regions.ts`). The **Pod bounds** view on the Analysis screen draws
them over the stills, each with its dashed middle third, so you can see what
each pod is scored on.

If your camera sits a little differently, press **Edit boxes** in that view.
Drag a box onto its pod's cup, and drag its corner to fit the plant. You can
also focus a box and move it with the arrow keys, or resize it with Shift and
the arrow keys. **Save boxes** keeps them per camera. **Reset to measured**
brings back the defaults. New photos are scored on the saved boxes, and so is
the Grow page's crop of each pod. **Re-run** an analyser to rescore the photos
already on the unit. Scripts read and set the boxes with `GET /api/vision/regions`
and `PUT /api/vision/regions/{camera}`. The reference worker
(`scripts/analysis-worker.mjs`) uses the unit's boxes.

The slot order hasn't been checked against Gardyn's own pod numbering yet
([pin map](hardware/pin-map.md)). If Gardyn numbers them differently, only the
order of the measured boxes changes. Pod 28's cup is below the lower camera's
frame, so its box sits at the bottom edge, where its plant comes into view.

A pod marked **empty** in the app reads "no cover" on the Analysis screen,
whatever the camera sees there; hover it for the analysers' numbers.

A damaged frame gets no score. `hald` refuses torn frames before core sees them
([Stills](hardware/hal.md#stills)), and core stores nothing that isn't a whole
JPEG. Analysis also skips a still with full-width rows of the solid green a
zero-filled camera buffer decodes to, because that colour scores as leaf cover on
an empty pod. It costs nothing, since the analysers have the pixels anyway, and it
covers stills taken before `hald` could refuse them. Such a still stays in the
gallery, with no results.

Stills scored before this check existed keep their scores until they are looked at
again. Run **Re-run** once on any analyser: a still found to be damaged loses
everything this unit scored from it, under every analyser, so it stops affecting
the pod trends. Other stills are untouched, and so are results a remote worker
posted. This only finds the green fill; a frame torn some other way, such as a grey
block, is only caught by `hald` as it arrives.

Open **Analysis** in the sidebar. The top card shows the newest still from
both cameras side by side (stacked on a phone), with three pickers:

- **Analyser**: every analyser, how many photos it has scored, and which one is
  **primary** (the one pod trends follow). **Make primary** switches it.
  **Re-run** scores the photos still on the unit (the last 30 days) with that
  analyser, for example after an update brings a new version. New versions
  are stored next to old ones; nothing is overwritten.
- **Camera**: both, upper or lower, for the stills and the table below.
- **View**: the photo, or **Pod bounds** drawn over it with the chosen
  analyser's reading for each pod.

Below it, **Per pod, latest frames** lists every pod on the cameras shown in
one table, with every analyser's number from its camera's newest still, and
**One pod over time** draws one line per analyser.

**Keep analysis masks** (Settings → Cameras) also stores `exg-otsu`'s
plant/not-plant mask for each photo as a 1-bit PBM image, about 115 kB each.
It is off by default to spare the SD card.

## Export a dataset

**Analysis → Export a dataset** downloads a tar for the last 7, 30 or 90 days,
with or without the photos. Scripts can use
`GET /api/datasets/export?from=…&to=…&images=0|1` directly. The archive holds:

- `manifest.json`: window, unit, core version, analysers, and row counts.
- `captures.jsonl`, `analyses.jsonl` and `telemetry.jsonl`: one record per line.
- `pods.json` and `grow_cycles.json`: what was planted where, and when.
- `images/<capture id>.jpg`: the photos.
- `README.md`: the layout above, in the archive itself.

This is what you pull to a laptop to check an analyser against what you see,
recalibrate a threshold, or train a model.

## The learned pod-state analyser

`pod-state` is a small convolutional network (three 3×3 convolutions of 16, 32
and 64 channels, a global average pool and one dense layer, about 24,000
weights) that reads each pod's crop shrunk to 64×64 and names its state:
`empty`, `sprouted`, `growing`, `ready` or `unhealthy`. Per pod it stores two
results: `pod_state`, the index of the most likely class (its `detail` names
it and holds every class's probability), and `pod_state_confidence`, that
class's probability. The Analysis screen shows the state in a column beside the
green fractions, on the pod bounds when it is the chosen analyser, and the
pod's latest state under **One pod over time**. It can't be primary, since pod
trends follow a green fraction.

**The shipped model is a bootstrap, not a validated classifier.** Revision
`bootstrap-2026-11` was trained before anyone had labelled a pod and before
any pod on the reference unit had sprouted, so its labels are weak: a pod
counts as `empty` when the rule-based analysers read 0.5 % cover or less and
it wasn't planted, or was planted too recently to have sprouted; the other four
classes come from synthetic plants (leaf shapes of growing size, and
yellow-brown ones for `unhealthy`) painted onto real empty-pod crops. It has
learned roughly "how much plant, and what colour", the same thing the rule
analysers measure, and it is a baseline for a model trained on real labels to
beat. Its training block in the weights file (`training`) records the counts
and held-out scores; on held-out real crops it called 251 of 252 empty pods
empty (the rule analysers agree with those labels by construction, since they
made them), and on held-out synthetic plants it got 89 % right, where leaf
cover alone gets 49 %. Neither number says how it does on real seedlings.
Stills taken with the grow light off are skipped, since it never saw one.

It runs in plain TypeScript, not ONNX: the Pi Zero W has no ONNX runtime that
fits ([ADR 0019](adr/0019-pluggable-capture-analysis.md), 2026-11-09
amendment). On the unit that costs about 0.75 s per pod, about 23 s for a
capture of 30 pods, on the vision worker.

### Weights file

The model ships with core as `models/pod-state.json`, so every release and the
web updater carry it. The format is `seedypod-cnn` version 1: one JSON file
with a header (the analyser id, a `version` results are stored under, a
`revision` name, the class names, the input size and per-channel
normalisation, the layer list) and each tensor as little-endian float32 in
base64. It is about 130 KB. `POD_STATE_MODEL` points core at a different file;
set it empty to run without one.

Without the file, or with one that doesn't parse or lists other classes, the
analyser is listed as off: the Analysis screen says why, and it is never run
or re-run.

### Train a better one

Training lives in [seedypod/training](https://github.com/seedypod/training):
export a dataset with photos, label pods on the Analysis screen when that
lands, then

```sh
uv run --locked python scripts/train.py --pod seedypod.local --version 2 --revision my-model-2026-12
```

It writes `pod-state.json` and a `report.json` with held-out scores for the
model and for the rule-based analysers. Give each new model a new `--version`,
so its results sit beside the old ones instead of mixing with them. To ship it,
replace `models/pod-state.json` in a core PR. The parity test
(`src/vision/tests/podState.test.ts`) checks that core's forward pass matches
PyTorch's within 1e-4 on a fixture the training repository generates.

## Mirror photos off the unit (opt-in)

The unit keeps 30 days of photos. To keep a whole season, set up an
S3-compatible bucket (Cloudflare R2, Backblaze B2, MinIO, a NAS) under
**Settings → Off-device storage and analysis**:

1. Fill in the endpoint, bucket, region (`auto` for R2), an optional key
   prefix such as `kitchen/`, and an access key pair that can read, write,
   list and delete in that bucket (listing and deleting are for the nightly
   backups). Save.
2. Press **Test**. It writes, reads back and deletes a probe object.
3. Press **Copy existing photos** to upload what is already on the unit.

From then on each new photo (and mask) is copied in the background. The unit
still prunes its own copy after 30 days; the bucket keeps everything, and the
app reads from it when the local copy is gone. If uploads keep failing, an
**Off-device copy failed** alert says why; it clears on the next success.
The same bucket also gets a nightly backup of the unit under `backups/`
([Maintenance → Backups](MAINTENANCE.md#backups)).

Nothing is sent anywhere until these fields are filled in. See
[Privacy](PRIVACY.md).

The mirror is checked against a real S3 server (MinIO) by
`src/camera/tests/mirror.s3.test.ts`. That test runs only when you point it at
a server:

```sh
MIRROR_TEST_ENDPOINT=http://127.0.0.1:9000 MIRROR_TEST_ACCESS_KEY=… MIRROR_TEST_SECRET=… \
  pnpm exec vitest run src/camera/tests/mirror.s3.test.ts
```

It creates its own bucket and removes it afterwards. With
`MIRROR_TEST_BUCKET` it uses that existing bucket instead (an R2 token scoped
to one bucket can't create buckets), under a fresh prefix. Either way it
deletes everything it wrote. In CI, **Mirror (real S3)**
(`.github/workflows/mirror-s3.yml`) runs it weekly and whenever the mirror
changes, once the `MIRROR_TEST_*` secrets hold a real bucket (see
seedypod/core#6).

## Plug in an off-device analyser

A heavier model can run on a laptop or GPU box and post its results back
under its own name. They appear on the Analysis screen next to the on-device
analysers, and can be made primary.

1. **Settings → Off-device storage and analysis → Result ingest token →
   Generate**, copy the token, and save.
2. Run a worker. `scripts/analysis-worker.mjs` is a reference you can copy:

   ```sh
   SEEDYPOD_URL=http://seedypod.local \
   SEEDYPOD_INGEST_TOKEN=<token> \
   node scripts/analysis-worker.mjs --id my-model --version 1 --limit 48
   ```

   It reads `GET /api/captures` and the JPEGs (add `SEEDYPOD_API_KEY` if the
   unit has an API key), scores each pod, and posts:

   ```http
   POST /api/analyses/results
   Authorization: Bearer <token>

   {
     "analyzer": "my-model",
     "version": 1,
     "results": [
       { "captureId": "upper-2026-10-31T10-00-00-000Z", "slot": 3, "metric": "green_fraction", "value": 0.42, "detail": { "confidence": 0.9 } }
     ]
   }
   ```

Rules the endpoint enforces:

- **Names.** The analyser id is lowercase letters, digits, `.`, `_` or `-`.
  The on-device ids are refused (409), so a worker can't overwrite them.
- **Metrics.** `green_fraction` is what pod trends use. Anything else, such as
  `leaf_count` or `health_score`, is stored and exported too.
- **Replace, not append.** Posting the same capture, analyser, version, pod
  and metric again replaces the value.
- **Pruned photos.** For a photo the unit has already pruned (one the worker
  read from the mirror), include its `ts` and `camera`. Otherwise it is
  reported back under `skipped`.
- **Size.** Up to 10,000 results and 5 MB per request.
- **Token.** Ingest is off (404) while the token is empty. The token is
  separate from the API key, which still guards every other endpoint.
