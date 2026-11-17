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
the arrow keys. If a camera can't see a pod at all (slot 28's cup sits below
the lower frame, so its box may land on bare pipe), remove that box with its
**×** or Delete. The pod is then left unscored on that camera until you
**Put back** its box. **Save boxes** keeps them per camera. **Reset to measured**
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

Hover over a pod in either view (or focus it from the keyboard) for a card
with everything known about it: the plant, its status and age, every
analyser's reading on that photo (a learned analyser's runner-up too when it
is close), the trend with its recent photos and the pod's note. Click or tap
the pod to keep the card open and chart that pod under **One pod over time**.

Below it, **Per pod, latest frames** lists every pod on the cameras shown in
one table, with every analyser's number from its camera's newest still. The
chart under it starts on **All pods**: a small chart of each planted pod's
leaf cover from the primary analyser over about the last week, all on one
scale, so the pods that are coming up stand out. Pick a pod there or in the
**Pod** picker for **One pod over time**, which draws one line per analyser.

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
2. Check the suggestions. A pod with a [suggested label](#suggested-labels)
   shows it dashed with a question mark, for example `6 · sprouted?`; its
   tooltip says where it came from (*last labelled sprouted on 13 Nov*,
   *pod-state 86%*). With no label picked, tap a pod to accept its
   suggestion. **Accept the rest** under each photo accepts every remaining
   suggestion on it; pods without one stay unlabelled.
   If a pod can't be seen on the photo, or its box sits over the tower
   rather than a cup, pick **Clear** and tap it: that
   [dismisses the suggestion](#dismissed-suggestions) on that photo, so
   **Accept the rest** skips it. Tap it again with **Clear** to bring the
   suggestion back.
3. For the pods that changed, or that have no suggestion, pick a label (tap
   the picked one again to put it down):
   - **Empty**: a capped pod, no yCube.
   - **Seeded**: a yCube is in, but nothing is visible yet.
   - **Sprouted**: only seed leaves, the first pair of small, rounded leaves.
   - **Growing**: true leaves showing (the plant's own leaf shape).
   - **Ready** (to harvest) or **Unhealthy**.
4. Tap each pod that shows it. A tap sets the label, over any suggestion. To
   remove a label, tap the pod again with the same label, or pick **Clear**
   and tap it. To change a label, pick the other one and tap the pod again.
   **Clear** on a pod with a saved label removes the label; only on a pod
   with just a suggestion does it dismiss the suggestion.

When a pod is labelled, its plant and sowing date go with the label, so a
season of labels keeps the right species and age after pods are replanted.
Only a sown pod counts: one that is only planned (no sowing date, or still
empty), or sown after the photo's day, records no plant.
Changing a label later keeps the plant it was first given.

Each label chip shows how many pods carry that label, across every photo.
The line under the chips says how many labels were picked, accepted or
corrected, and how often each suggester was right. **All labels** shows
every labelled pod as its crop, newest photo first, with its pod, plant, age
and when the photo was taken. Filter by label with the chips (each shows its count), **Change** a label with the same chips,
**Remove** it, or tap the crop to open its photo in the tagger. Labels are
kept per photo and pod, and they stay after the unit prunes the photo; a
pruned photo's labels can still be changed or removed.

### Suggested labels

Most pods look the same as on the last photo labelled, so the tagger suggests
each pod's label (#261):

- The pod's newest label on an earlier photo carries forward (`carry`), since
  states change slowly. It never carries across a replant: a label saved with
  another sowing date, or with none from before the pod's sowing day, doesn't
  count.
- `pod-state` overrides that only when it names a later stage
  (empty < seeded < sprouted < growing < ready; `unhealthy` is never later)
  with confidence 0.8 or more (`pod-state@<version>`, the newest version
  that scored the photo).
- With no earlier label, a confident `pod-state` guess is the suggestion on
  its own. With neither, there is no suggestion.
- The model has no `seeded` class, so a pod whose record is `seeded` turns an
  `empty` suggestion into `seeded` (`record`).

A suggestion is not a label. A pod nobody touched hasn't been checked, so it
is never stored: counting it as right would grade the model on its own
guesses. Each saved label records how it was saved in `source`:

- `picked`: the pod had no suggestion (every label from before suggestions
  reads back as `picked`).
- `accepted`: the label is the suggestion.
- `corrected`: the grower chose another label; the suggestion is kept in
  `suggested`, with `suggestedBy` and, for the model, `suggestedConfidence`.

Score a model only on reviewed labels (`accepted` and `corrected`).
`GET /api/vision/labels` (and `list_analyses` under `labels`) counts labels by
`sources`, and gives each suggester under `suggesters` with how often it was
accepted or corrected and the share right, so you can tell whether the model
beats "same as last time".

Scripts use `PUT /api/vision/captures/{captureId}/labels/{slot}` with
`{"label": "seeded"}` (or `null` to clear it); the unit works out `source`
from the pod's suggestion. `GET /api/vision/captures/{captureId}/suggestions`
lists the suggestions (`slot`, `label`, `by`, `confidence`, and `from`, the
photo time of a carried label), and
`POST /api/vision/captures/{captureId}/suggestions/accept` saves every
unlabelled pod's suggestion on that photo as `accepted`, leaving pods without
one unlabelled. `GET /api/vision/captures/{captureId}/labels`,
`GET /api/vision/labels` for the counts and the labelled photos, and
`GET /api/vision/labels/pods` for the labelled pods themselves (`label`,
`camera`, `limit` and `cursor`; pass the response's `next` back as `cursor`
for the next page). The `list_labels` MCP tool returns the same, and
`list_analyses` the summary under `labels`. Labelling stays in the app:
agents can read labels but not set or clear them.

### Dismissed suggestions

A suggestion can point at a pod the photo doesn't show: the pod is hidden,
or its box isn't on a pod at all (on the lower camera a box can sit over the
tower body). **Clear** on such a pod dismisses its suggestion on that photo
only; the dashed tag goes, and the box's tooltip says it was dismissed. The
unit keeps the dismissal, so a reload doesn't bring the suggestion back.
`GET /api/vision/captures/{captureId}/suggestions` leaves dismissed pods out,
and **Accept the rest** (`POST …/suggestions/accept`) skips them on the unit,
not only in the app. A label picked on a dismissed pod is saved as `picked`,
since there was no suggestion to accept or correct.

A dismissal is not a label. It never shows in the label counts, the
`picked`/`accepted`/`corrected` line, **All labels** or `labels.jsonl`; the
dataset export carries dismissals in their own file,
`suggestion_dismissals.json`. Nothing hides a pod on its own: a box that
doesn't sit on a pod should be moved in **Analysis → Latest photos → Pod
bounds → Edit boxes** (the tooltip on each suggested pod says so, and the
link under the label chips opens it).

Scripts use `PUT /api/vision/captures/{captureId}/suggestions/{slot}/dismissal`
to dismiss, `DELETE` on the same path to bring the suggestion back, and
`GET /api/vision/captures/{captureId}/suggestions/dismissals` to list a
photo's dismissals (`slot`, `dismissedAt`).

### Pod codes

Under the photo, **Pod codes** lists the pods whose yCube dot code was read
([Dot codes](#dot-codes), #224), and only those. **Read codes** takes a
full-size pod-ID still on each camera and reads it. That's slow on a Pi Zero,
and a camera whose still is dark, damaged or fails keeps its last reads. Each
row shows what the pod reads as and the plant that code is:

- With no plant confirmed for the code, it offers the
  [shared table](#shared-pod-codes)'s plant as a known code
  (`Basil · known code`), or else the pod record's plant as a guess
  (`Basil?`). **Confirm** saves the pair.
- **Correct** (or **Say which**, when the pod has no plant) saves the code
  as another plant.
- A confirmed code shows its plant with a tick. If the shared table names
  another plant for it, the row says so; yours is kept.

The unit also reads them once a day, during the 12:00 hour local time, when
the grow light is most likely on.

Only pairs the owner has confirmed are kept, and confirming or correcting one
never changes a pod's record or a plan.

#### Shared pod codes

Gardyn's codes are the same on every unit, so core ships a table of codes
other owners confirmed (#259), `src/vision/podCodes.json`. It is bundled with
each release and reaches a unit only through an update: a unit never fetches
it. Each entry has the code, the plant (a name from the plant catalog), how
many units named that plant, and a status:

- `confirmed`: two or more units agree, or a maintainer checked a crop.
- `pending`: one unit so far. Never suggested.
- `ambiguous`: units name different plants for the code. Never suggested.

What a code is comes from, in order: your confirmed pair, then a `confirmed`
shared entry, then the pod record. A known code is still only a suggestion:
it needs **Confirm**, which saves your own pair, before anything counts it as
yours. The dataset export carries your confirmed pairs in `pod_codes.json`.

#### Share pod codes

Once you have confirmed a code, **Share pod codes** in Pod codes opens a
GitHub issue form in your browser, filled in with:

- your confirmed pairs, one `code → plant` per line. A pair whose plant isn't
  in the plant catalog is left out, and the panel names it;
- the app version;
- a unit fingerprint: the first 16 hex digits of a SHA-256 of the unit's id.
  It lets the bot tell two units that agree from one unit submitting twice.
  Nothing else about the unit goes in: no location, name or IP address.

You sign in to GitHub and submit the form yourself. The unit only builds the
link and never contacts GitHub. A form can't be filled in with files, so the
panel also offers each confirmed pod's crop as a download (from the pod-ID
still, else the newest still) to drag into **Crops**. Scripts use
`GET /api/vision/pod-codes/share` and
`GET /api/vision/pod-codes/crops/pod-<slot>.jpg`.

The pod-codes bot (`.github/workflows/pod-codes.yml`, running
`scripts/pod-codes-merge.ts`) picks up an issue labelled `pod-codes`. It
checks each line's code and plant, and comments on any line it rejects. It
merges the rest into the table, counting each fingerprint once per code (or
the GitHub account, without a fingerprint), and opens a pull request into
`dev` that links back to the issue. A unit that names another plant for a
code it named before moves its vote. A maintainer who has checked a crop adds
`pod-codes-verified` to the issue, and the bot confirms the issue's pairs
with one unit. The bot never commits to `dev` or `main`. GitHub doesn't run
CI on a pull request that `GITHUB_TOKEN` opens, so close and reopen it before
merging.

### Pods out of order

The owner moves yCubes by hand, so the tower can drift from the pod records
and from the plan. A pod whose code is confirmed says what it holds. When that
disagrees with its record or the plan applied last, **Needs you** shows one
line, *Pods out of order*. It links to the list above Pod codes, which names
each pod and offers two fixes:

- **Update the records to match the tower**: swaps of pod records, the same
  as moving pods on Grow, so each plant keeps its sowing date, status and
  notes. Nothing changes until **Update records** and then **Yes, update the
  records**. If what's out of order changed in between, it refuses and shows
  the list again.
- **Move the pods to match the plan**: the swaps to make on the tower by
  hand, for example *swap pod 2 ↔ pod 7*. Read the codes again after.

Only pods with a known code take part: your confirmed pair, else a
`confirmed` entry in the shared table (the list says *by a known code other
units confirmed*). Either fix still waits for you. An unread pod, or one whose
code is neither, is never moved or corrected, and a pod that would need one is
listed as one neither fix can settle. Scripts use
`GET /api/vision/pod-order` and `POST /api/vision/pod-order/fix` with the
`key` it returned. Scripts use `GET /api/vision/pod-codes`,
`POST /api/vision/pod-codes/read`, `PUT /api/vision/pod-codes/{code}` with
`{"plant": "Basil"}`, and `DELETE /api/vision/pod-codes/{code}`.

## Export a dataset

**Analysis → Export a dataset** downloads a tar for the last 7, 30 or 90 days,
with or without the photos. Scripts can use
`GET /api/datasets/export?from=…&to=…&images=0|1` directly. Everything sits
under one folder, `seedypod-<unit>-<yyyymmdd from>-<yyyymmdd to>/`:

- `manifest.json`: format (`seedypod-dataset` version 4, since
  `suggestion_dismissals.json` came in; version 3 added `source` and the
  suggestion fields to `labels.jsonl`, and `pod_codes.json`), window, unit,
  core version, analysers, and row counts (`counts.labels` and
  `counts.dismissals` among them).
- `captures.jsonl`, `analyses.jsonl` and `telemetry.jsonl`: one record per line.
- `labels.jsonl`: one labelled pod per line (see below).
- `regions.json`: every pod's box per camera, as fractions of the frame.
- `pods.json` and `grow_cycles.json`: what was planted where, and when.
- `pod_codes.json`: every dot code → plant pair you confirmed (`code`,
  `plant`, `confirmedAt`), whenever it was confirmed (`counts.podCodes`).
- `suggestion_dismissals.json`: every pod whose suggestion you
  [dismissed](#dismissed-suggestions) on a photo taken in the window
  (`captureId`, `ts` the photo's time, `slot`, `dismissedAt`), ordered by
  photo time, then photo, then pod. Not labels: a trainer can use them to
  drop pods that can't be seen, or to find boxes that need moving.
- `images/<capture id>.jpg`: the photos.
- `README.md`: the layout above, in the archive itself.

This is what you pull to a laptop to check an analyser against what you see,
recalibrate a threshold, or train a model. To avoid a feedback loop, weight
`corrected` labels up, and drop or down-weight labels `accepted` from the
model's own suggestion (`suggestedBy` `pod-state@…`) when training that model.

### Labels and pod crops

`labels.jsonl` has one row for each labelled pod whose photo was taken inside
the window. Rows are ordered by photo time, then photo, then pod:

```json
{"captureId":"upper-2026-10-20T00-00-00-000Z","ts":"2026-10-20T00:00:00.000Z","camera":"upper","slot":1,"label":"growing","labelledAt":"2026-10-31T09:00:00.000Z","plant":"Basil","plantedAt":"2026-10-06","daysSinceSowing":14,"source":"corrected","suggested":"sprouted","suggestedBy":"pod-state@1","suggestedConfidence":0.86,"image":"images/upper-2026-10-20T00-00-00-000Z.jpg","width":1280,"height":960,"region":{"x":128,"y":192,"w":640,"h":480},"box":{"x":0.1,"y":0.2,"w":0.5,"h":0.5}}
```

| Field | Meaning |
|---|---|
| `captureId`, `ts`, `camera` | The photo, when it was taken, and which camera (`upper`: pods 1–15, `lower`: 16–30) |
| `slot` | The pod, 1–30 |
| `label` | `empty` (capped, no yCube), `seeded` (yCube in, nothing visible yet), `sprouted`, `growing`, `ready` or `unhealthy` |
| `labelledAt` | When it was labelled |
| `plant`, `plantedAt` | The pod's plant and sowing date when it was labelled; `null` when it had none, or for labels from before core recorded them |
| `daysSinceSowing` | Whole days from `plantedAt` to `ts`; `null` without a sowing date |
| `source` | How it was saved: `picked` (no suggestion), `accepted` (the suggestion) or `corrected` (another label than the suggestion); see [Suggested labels](#suggested-labels) |
| `suggested` | What the tagger suggested, or `null` when it suggested nothing |
| `suggestedBy` | Where the suggestion came from: `carry` (the pod's last label), `record` (a seeded pod record) or `pod-state@<version>`; `null` with no suggestion |
| `suggestedConfidence` | The model's confidence when the model made the suggestion, else `null` |
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

### Dot codes

Each Gardyn yCube has five dots in a line below its opening: four rings, each
open or marked with a bar, a slanted bar or a half fill, then a solid dot that
ends the code ([#224](https://github.com/seedypod/core/issues/224)). Gardyn
doesn't publish what the codes mean, so core learns which code is which plant
from the owner's confirmations. At 1280×960 the dots are a few pixels across;
on a full-size pod-ID still (2592×1944, [hal.md](hardware/hal.md#pod-id-stills))
they are 12–22 px on the nearer pods.

`podvision --codes --pods '{…}' --image still.jpg` reads them. For each pod box
(widened a little and lengthened downwards, since the dots sit near the bottom)
it keeps what is darker than its surroundings, finds the one run of exactly
five similar blobs evenly spaced along a line, and takes the solid end as the
end of the code. It reads each ring's inside in coordinates scaled to the dot's
own width and height, measured against the line of dots rather than the
frame, because every pod faces the camera at its own angle:

| Symbol | Mark | What it measures |
|---|---|---|
| `o` | open | the centre is light |
| `\|` | bar | a dark bar through the centre, square to the line (within 25°) |
| `/` | slanted bar | the same at 35–55° to the line |
| `h` | half filled | the dark part's centre sits off the dot's centre |

The code is the four marks from the far end to the one beside the solid dot,
for example `oo||` for open, open, bar, bar. Every step has a margin and the
confidence is the smallest one. Below 0.5 there is no code: a pod that is too
small, too steep, or has a mark that is none of these (a bar along the line,
two solid dots) comes back unknown, never as a guess. The output gives each
pod's `code` (or `null`), `confidence`, and the five dots' centres.

The test crops are in `hal/crates/podvision/fixtures/dotcodes` with
`cases.json`: what each pod reads as by eye, and `confirmed: false` until the
owner confirms it. A half fill comes in at least two orientations (split along
the line and across it, pod 2 has both); the reader gives both as `h`. If two
plants ever turn out to share a code, the orientation is the first thing to
split on.

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
