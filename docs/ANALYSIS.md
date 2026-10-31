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

Pods 1–15 are seen by the upper camera and 16–30 by the lower one, in a
3 × 5 grid.

## On the unit

Two analysers run after every capture, on a worker thread so the app stays
responsive while a Pi decodes the photo:

| Analyser | What it does |
|---|---|
| `green-threshold@1` | Excess-green index (2G − R − B) above a fixed cut-off. The original baseline; drifts with grow-light colour and exposure. |
| `exg-otsu@1` | The same index with the cut-off chosen per photo by Otsu's method (the PlantCV approach), so a lighting change moves the threshold rather than the result. |

Open **Analysis** in the sidebar to:

- see every analyser, how many photos it has scored, and which one is
  **primary** (the one pod trends follow). **Make primary** switches it.
- **Re-run on stored photos** to score the photos still on the unit (the last
  30 days) with one analyser, for example after an update brings a new
  version. New versions are stored next to old ones; nothing is overwritten.
- **Compare on one pod**: one line per analyser over time.
- **Latest photo, side by side**: the newest still with every analyser's
  number for each pod.

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
   SEEDYPOD_URL=http://seedypod.local:3000 \
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
