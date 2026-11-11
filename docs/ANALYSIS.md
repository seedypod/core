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

## Label pods

A trained pod model needs examples: photos where someone has said what each
pod shows. **Analysis → Label pods** is where you give them.

1. Pick the camera: **Upper**, **Lower**, or **Both** to see the two stills
   from one round of captures together (stacked on a phone, side by side on a
   wider screen). Step to an older photo with the arrows if you like (the last
   48 per camera). In **Both** the arrows step through rounds: a round holds
   at most one still per camera, taken within 5 minutes of the round's newest
   still. A camera that took none in a round shows an empty slot there, not an
   older still.
2. Pick a label:
   - **Empty**: a capped pod, no yCube.
   - **Seeded**: a yCube is in, but nothing is visible yet.
   - **Sprouted**: the first leaves are showing.
   - **Growing**, **Ready** (to harvest) or **Unhealthy**.
3. Tap each pod that shows it. A tap sets the label. To remove a label, tap
   the pod again with the same label, or pick **Clear** and tap it. To change
   a label, pick the other one and tap the pod again.

When a pod is labelled, its plant and sowing date go with the label, so a
season of labels keeps the right species and age after pods are replanted.
Only a sown pod counts: one that is only planned (no sowing date, or still
empty), or sown after the photo's day, records no plant.
Changing a label later keeps the plant it was first given.

The counts above the photo show how many pods carry each label, across every
photo. **All labels** shows every labelled pod as its crop, newest photo
first, with its pod, plant, age and when the photo was taken. Filter by label
with the chips (each shows its count), **Change** a label with the same chips,
**Remove** it, or tap the crop to open its photo in the tagger. Labels are
kept per photo and pod, and they stay after the unit prunes the photo; a
pruned photo's labels can still be changed or removed.

Scripts use `PUT /api/vision/captures/{captureId}/labels/{slot}` with
`{"label": "seeded"}` (or `null` to clear it),
`GET /api/vision/captures/{captureId}/labels`, `GET /api/vision/labels` for
the counts and the labelled photos, and `GET /api/vision/labels/pods` for the
labelled pods themselves (`label`, `camera`, `limit` and `cursor`; pass the
response's `next` back as `cursor` for the next page). The `list_labels` MCP
tool returns the same, and `list_analyses` the summary under `labels`.
Labelling stays in the app: agents can read labels but not set or clear them.

## Export a dataset

**Analysis → Export a dataset** downloads a tar for the last 7, 30 or 90 days,
with or without the photos. Scripts can use
`GET /api/datasets/export?from=…&to=…&images=0|1` directly. Everything sits
under one folder, `seedypod-<unit>-<yyyymmdd from>-<yyyymmdd to>/`:

- `manifest.json`: format (`seedypod-dataset` version 2, since `labels.jsonl`
  gained `seeded` and the plant fields), window, unit, core version,
  analysers, and row counts (`counts.labels` among them).
- `captures.jsonl`, `analyses.jsonl` and `telemetry.jsonl`: one record per line.
- `labels.jsonl`: one labelled pod per line (see below).
- `regions.json`: every pod's box per camera, as fractions of the frame.
- `pods.json` and `grow_cycles.json`: what was planted where, and when.
- `images/<capture id>.jpg`: the photos.
- `README.md`: the layout above, in the archive itself.

This is what you pull to a laptop to check an analyser against what you see,
recalibrate a threshold, or train a model.

### Labels and pod crops

`labels.jsonl` has one row for each labelled pod whose photo was taken inside
the window. Rows are ordered by photo time, then photo, then pod:

```json
{"captureId":"upper-2026-10-20T00-00-00-000Z","ts":"2026-10-20T00:00:00.000Z","camera":"upper","slot":1,"label":"growing","labelledAt":"2026-10-31T09:00:00.000Z","plant":"Basil","plantedAt":"2026-10-06","daysSinceSowing":14,"image":"images/upper-2026-10-20T00-00-00-000Z.jpg","width":1280,"height":960,"region":{"x":128,"y":192,"w":640,"h":480},"box":{"x":0.1,"y":0.2,"w":0.5,"h":0.5}}
```

| Field | Meaning |
|---|---|
| `captureId`, `ts`, `camera` | The photo, when it was taken, and which camera (`upper`: pods 1–15, `lower`: 16–30) |
| `slot` | The pod, 1–30 |
| `label` | `empty` (capped, no yCube), `seeded` (yCube in, nothing visible yet), `sprouted`, `growing`, `ready` or `unhealthy` |
| `labelledAt` | When it was labelled |
| `plant`, `plantedAt` | The pod's plant and sowing date when it was labelled; `null` when it had none, or for labels from before core recorded them |
| `daysSinceSowing` | Whole days from `plantedAt` to `ts`; `null` without a sowing date |
| `image` | The photo's path in the archive, or `null` when it isn't there (exported without photos, pruned, or a demo still) |
| `width`, `height` | The photo's size in pixels, read from its JPEG header; `null` when the photo can't be read |
| `region` | The pod's crop in the photo's pixels, `x`, `y`, `w`, `h` with the origin top left; `null` when the photo can't be read |
| `box` | The same box as fractions of the frame (0–1); always present |

`region` is exactly the window the analysers score: `x = floor(box.x × width)`,
`y = floor(box.y × height)`, the right and bottom edges are
`ceil((box.x + box.w) × width)` and `ceil((box.y + box.h) × height)`, and all
four are clamped to the photo. A trainer crops
`image[region.y : region.y + region.h, region.x : region.x + region.w]`. When
`region` is null, for example for a photo read from the mirror instead, it
scales `box` by that photo's size in the same way.

`regions.json` holds every pod's box, labelled or not, in the shape
`{"upper": {"1": {"x", "y", "w", "h"}, …, "15": …}, "lower": {"16": …, "30": …}}`.
These are the boxes in use when the dataset is exported: the
[calibrated ones](#pod-boxes) where you moved a box, the measured defaults
elsewhere (`podRegions()` in `src/vision/regions.ts`, the same as
`GET /api/vision/regions`). An on-device classifier crops with the same boxes,
so training sees what the model will see. Moving a box later moves the crop
of photos labelled before, which is right as long as the camera hasn't moved.

## The learned pod-state analyser

`pod-state` is a small convolutional network (three 3×3 convolutions of 16, 32
and 64 channels, a global average pool and one dense layer, about 24,000
weights) that reads each pod's crop shrunk to 64×64 and names its state:
`empty`, `sprouted`, `growing`, `ready` or `unhealthy`. It has no `seeded`
class: that label came after the model, so training maps `seeded` to `empty`
(nothing visible yet). A six-class model needs the loader
(`parsePodStateModel`) extended first, since it only accepts these five. Per pod it stores two
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

It runs without ONNX: the Pi Zero W has no ONNX runtime that fits
([ADR 0019](adr/0019-pluggable-capture-analysis.md), 2026-11-09 amendment).
Core runs it in `podvision`, a small native binary, and in plain TypeScript
on the vision worker when that isn't there.

### Native runner

`podvision` (`hal/crates/podvision`, [#191](https://github.com/seedypod/core/issues/191))
does what the TypeScript runner does, natively: it decodes the still, crops
each pod, runs every enabled pod-state revision and prints the results. Core
runs it once per capture as a child process at `nice` 19, so the API keeps
answering, and kills it after 60 s. On a Pi Zero W it takes 3–4.5 s for a
camera's 15 pods (0.6–1.1 s to decode the still, 2.1–3.0 s for the forward
passes), where the TypeScript runner took about 33 s. Releases carry it next to `hald`
(`podvision-<target>` with a `.sha256`), `scripts/install` puts it in
`/usr/local/bin`, and the web updater swaps it with each release and puts it
back on a rollback. Core logs `pod-state runs in /usr/local/bin/podvision` at
startup when it finds the binary.

Results are stored under the same analyser ids and versions either way. When
podvision is missing, fails, times out or reports another version than core
lists, core logs why and runs the learned analysers in TypeScript instead.
The rule-based analysers always run in TypeScript. `PODVISION` points core at
another binary; set it empty to use the TypeScript runner only.
`PODVISION_TIMEOUT_MS` changes the timeout.

The two runners share the forward pass's parity fixture to 1e-4, but not
their JPEG decoders, so on real stills they agree to within the decoders'
difference. podvision's decoder is the closer one to training's (PIL). On
three of the unit's stills, with the shipped model:

| Compared with | podvision | TypeScript (jpeg-js) |
|---|---|---|
| PIL's pixels | mean 0.07, max 3 levels | mean 0.76–0.95, max 24 levels |

| podvision against the TypeScript runner | At full size | Forced to 1/2 scale |
|---|---|---|
| Crop inputs (normalised) | mean 0.009–0.012, max 0.33 | mean 0.07–0.09, max 2.7 |
| Probabilities | mean 0.001–0.007, max 0.075 | mean 0.002–0.013, max 0.14 |
| Same class | 45 of 45 pods | 45 of 45 pods |

podvision decodes at 1/2, 1/4 or 1/8 scale (DCT scaling) only when every
pod's crop stays at least as large as the model's 64×64 input there. The
smallest default box is about 65 px across at 1280×960, so with the default
regions it decodes at full size.

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

### Train, upload and compare models

A new model gets onto the unit without a release. The whole loop runs over the
REST API or MCP, so an agent can drive it:

1. **Label and export.** Label pods on the Analysis screen
   ([Label pods](#label-pods); MCP `list_labels` shows what is labelled), then
   `GET /api/datasets/export?images=1` (MCP `export_dataset` gives the path and
   what the window holds, with labels per class).
2. **Train** with [seedypod/training](https://github.com/seedypod/training):

   ```sh
   uv run --locked python scripts/train.py --pod seedypod.local --version 2 --revision my-model-2026-12
   ```

   It writes `pod-state.json` and a `report.json` with held-out scores for the
   model and for the rule-based analysers. Give each model its own
   `--revision`: an uploaded model runs as `pod-state-<revision>`.
3. **Upload** it as a revision, with the result ingest token (**Settings →
   Off-device storage and analysis**) and the file's SHA-256:

   ```sh
   curl -X POST "http://seedypod.local/api/models?sha256=$(shasum -a 256 pod-state.json | cut -d' ' -f1)&enable=1" \
     -H "Authorization: Bearer $SEEDYPOD_INGEST_TOKEN" --data-binary @pod-state.json
   ```

   MCP `upload_model` takes the file as base64, or a URL on the local network
   (the unit fetches nothing from the internet). Core checks the header (format,
   layers, classes, input size, version), the size (2 MB at most) and the hash
   before storing anything, and answers 400 with the reason otherwise. Uploads
   live under `DATA_DIR/models`, outside the release, so updates keep them. They
   are stored disabled unless `enable=1`.
4. **Compare.** Every enabled revision runs on each new capture as its own
   analyser, so the Analysis screen shows them beside each other, the shipped
   `pod-state` and the rule-based analysers. **Re-run** scores the stored photos
   with one.
5. **Choose.** `PATCH /api/models/{id}` with `{"enabled": true|false}` or
   `{"primary": true}` (MCP `set_model`). `GET /api/models` (MCP `list_models`)
   lists every revision: id (the first 12 hex digits of its SHA-256), version,
   revision, when it was trained and uploaded, whether it runs and which is
   primary, and whether it is `shipped` or `uploaded`. `DELETE /api/models/{id}`
   removes an upload; the shipped model can only be disabled.

Every upload, enable, disable, primary change, delete, reset and rollback is
recorded (`GET /api/models/events`). `POST /api/models/reset` goes back to the
shipped model alone, as primary, keeping the uploads disabled.
`POST /api/models/rollback` undoes the newest enable, disable, primary change
or reset, one per call. The primary revision is the one to trust when they
disagree; pod trends still follow the primary green-fraction analyser.

To ship a model with every unit instead, replace `models/pod-state.json` in a
core PR, with a new `--version`. The parity tests
(`src/vision/tests/podState.test.ts`, `cargo test -p podvision`, and
`src/vision/tests/nativeExecutor.test.ts` against the built binary) check that
both forward passes match PyTorch's within 1e-4 on a fixture the training
repository generates.

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
