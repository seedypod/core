---
type: "Reference"
title: "Gardyn light zones"
description: "Per-pod light-zone grid for the Gardyn Home (30) and Studio (16), measured from Gardyn's official zone map, with Gardyn's placement rules."
status: "stable"
generated: {"by": "claude/opus-5.5", "at": "2026-11-02T08:30:00+00:00"}
sources: [{"resource": "https://help.mygardyn.com/en/articles/11567361", "title": "Gardyn Plant Placement Guide: Understanding Light Zones"}, {"resource": "https://help.mygardyn.com/en/articles/11547329", "title": "Gardyn All Plants Placement by Light Zone Guide"}]
---

# Gardyn light zones

Gardyn defines three zones: high at the centre ("strongest light"), medium surrounding it, low in "the outer and lower areas". The text gives no row numbers; the grid exists only as an illustration. We measured it by colour-segmenting every pod in that image (`scripts/plants/measure-zones.py`, which re-downloads the image and reproduces the result).

Rows top → bottom, columns left → right. H = high, M = medium, L = low.

**Home (3 × 10)** — 12 high, 12 medium, 6 low

| Row | Left | Centre | Right |
|---|---|---|---|
| 1 | L | L | L |
| 2 | M | M | M |
| 3 | H | H | M |
| 4 | M | H | H |
| 5 | H | H | M |
| 6 | M | H | H |
| 7 | H | H | M |
| 8 | M | H | H |
| 9 | M | M | M |
| 10 | L | L | L |

**Studio (2 × 8)** — 5 high, 9 medium, 2 low (lower-left and upper-right, matching the map's caption)

| Row | Left | Right |
|---|---|---|
| 1 | M | L |
| 2 | M | M |
| 3 | H | M |
| 4 | M | H |
| 5 | H | M |
| 6 | M | H |
| 7 | H | M |
| 8 | L | M |

The side columns alternate high and medium because pods sit on alternating sides of each pole, nearer and farther from the light bar.

## Gardyn's placement rules (paraphrased)

- Fruiting plants go in high light; leafy greens in medium (too much light can hasten bolting); herbs in low to medium.
- If the ideal spot is unavailable, place the plant one zone lower.
- Cucumbers start at the bottom of the middle column so the vine climbs into higher light.
- Leave space between larger plants so they do not shade smaller ones, and move plants as they grow.
- 14–16 hours of light daily.

The grid in code is `src/components/Grow/lightZones.ts` (read off the same diagrams for the 3D tower's zone overlay); this measurement reproduces it pod for pod. The pod planner (`src/plants/planner.ts`, ADR 0024) builds on that grid and applies the rules above. Gardyn's cucumber note names the middle column, which only the Home has; on a Studio the cucumber goes by its zone.
