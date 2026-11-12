---
type: "Reference"
title: "Gardyn feeding guidance"
description: "Gardyn's published plant food, HydroBoost, top-off and refresh doses, and its pH and EC targets, including where its own pages disagree."
status: "draft"
generated: {"by": "claude/opus-5.5", "at": "2026-11-09T10:00:00+00:00"}
sources: [{"resource": "https://help.mygardyn.com/en/articles/2526145", "title": "When and How to Add Plant Food for the First Time (Sprout Dose), read 2026-11-09"}, {"resource": "https://help.mygardyn.com/en/articles/1777985", "title": "How to Top Off Your Tank with Water and Plant Food, read 2026-11-09"}, {"resource": "https://help.mygardyn.com/en/articles/1788289", "title": "How, Why, and When to Add HydroBoost to your Tank, read 2026-11-09"}, {"resource": "https://help.mygardyn.com/en/articles/1777281", "title": "Discovering Water Quality: pH and EC, read 2026-11-09"}, {"resource": "https://help.mygardyn.com/en/articles/1788097", "title": "Tank Refresh Guide: When, Why and How, read 2026-11-09"}, {"resource": "https://mygardyn.com/blog/ph-and-ec-in-hydroponics/", "title": "Gardyn blog: pH and EC in hydroponics (2026-03-29)"}]
---

# Gardyn feeding guidance

What Gardyn publishes about feeding a tower, read on 2026-11-09. Doses are for Gardyn Plant Food and HydroBoost; they do not carry over to other nutrients (see [community nutrients](community-nutrients.md)). Tank volumes: Home 5 gal full, Studio 4 gal full; keep the tank at least half full.

## Plant food

| Stage | Dose | Source |
|---|---|---|
| Setup | none — plain water | Sprout Dose article |
| Sprout dose, once most yCubes have sprouted (usually within 2 weeks) | 1/4 tsp per gallon | Sprout Dose article |
| True leaves, early growth (weekly top-off) | 1/2 tsp per gallon | Top-off article |
| Mature, blooming, fruiting (weekly top-off) | 1 tsp per gallon | Top-off article |
| Refill after a refresh | same per-gallon doses: Home 2.5 tsp (growth) or 5 tsp (mature) in 5 gal; Studio 2 or 4 tsp in 4 gal | Tank Refresh Guide |

The Sprout Dose article contradicts itself: its ratio gives about 3/4 tsp for a 3-gallon Home start, but its mixing steps say 1 tsp (Studio: 1/2 vs 3/4 tsp).

## HydroBoost

Added weekly with the top-off or refresh, every 3 days for large mature plants. Dose per full tank, by water:

| Water | Home | Studio |
|---|---|---|
| Filtered, RO, distilled, soft | 1 tsp (5 mL) | 0.5 tsp (3 mL) |
| Standard tap | 2 tsp (10 mL) | 1.5 tsp (8 mL) |
| Hard | 4 tsp (20 mL) | 3 tsp (16 mL) |

Gardyn describes it as a plant-based water treatment that lowers pH.

## Tank cadence

| Task | Cadence |
|---|---|
| Top off to full with water and plant food | weekly |
| Refresh (drain, wipe with water and a little baking soda, no soap, refill) | at least every 4 weeks (the app counts 28 days); every 14 days with four or more fruiting plants or large mature plants; sooner on yellowing leaves, leaf-edge burn or yellowing between veins |
| Light and deep cleaning | no fixed interval published |

## pH and EC

Gardyn's help centre says that with its plant food and HydroBoost "you don't need to test your pH". Its blog, written for hydroponics in general, gives targets and says to test every 2–3 days:

| Crop | pH | EC (mS/cm) |
|---|---|---|
| Seedlings | — | 0.8–1.2 |
| Leafy greens | 5.5–6.5 | 1.2–2.0 |
| Herbs | 5.5–6.5 | 1.0–2.0 |
| Tomatoes, peppers | 5.8–6.3 | 2.0–3.5 (tomatoes) |
| Strawberries, cucumbers | 5.5–6.0 | — |

The blog's pH adjustment: pH Down (phosphoric or citric acid) or pH Up (potassium hydroxide), starting at 1 mL per gallon and retesting after 15–30 minutes. Raise EC with nutrient concentrate; lower it with plain pH-adjusted water. Calibrate pH meters every 1–2 weeks.

## Gaps

- Gardyn publishes no EC or ppm for its own plant food at any dose, so a measured EC can't yet be mapped back to "teaspoons of Gardyn food".
- The help centre and blog disagree on whether to test at all. Once a pH or EC probe is fitted ([Adding a probe](https://github.com/seedypod/core/blob/dev/docs/SENSORS.md)), the unit's own readings settle it for that tank.
