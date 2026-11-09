---
type: "Guide"
title: "Feeding and water quality"
description: "What to put in the tank and when, Gardyn's way or with another nutrient such as MaxiGro, the pH and EC to aim for, and how a probe and Autopilot replace guesswork."
status: "draft"
generated: {"by": "claude/opus-5.5", "at": "2026-11-09T11:30:00+00:00"}
sources: [{"resource": "https://github.com/seedypod/core/blob/dev/knowledge/nutrients/gardyn-feeding-guidance.md", "title": "Knowledge: Gardyn feeding guidance"}, {"resource": "https://github.com/seedypod/core/blob/dev/knowledge/nutrients/community-nutrients.md", "title": "Knowledge: Community nutrients"}, {"resource": "/SENSORS.md", "title": "Adding a probe"}, {"resource": "/AUTOPILOT.md", "title": "Autopilot"}]
---

# Feeding and water quality

seedypod doesn't add nutrients for you. It tells you what the tank actually
reads, so you feed by measurement instead of by calendar. This page gives the
numbers to start from. The evidence behind them, with every source, is in the
knowledge bundle: [Gardyn feeding guidance](https://github.com/seedypod/core/blob/dev/knowledge/nutrients/gardyn-feeding-guidance.md)
and [community nutrients](https://github.com/seedypod/core/blob/dev/knowledge/nutrients/community-nutrients.md).

## Gardyn's routine

For Gardyn Plant Food. A Home holds 5 gal, a Studio 4 gal; never let it fall below half.

| When | What |
|---|---|
| Setup | Plain water, no food |
| Most yCubes have sprouted (usually within 2 weeks) | Sprout dose: 1/4 tsp per gallon |
| Weekly, true leaves to early growth | Top off to full with 1/2 tsp per gallon added |
| Weekly, mature or fruiting | Top off with 1 tsp per gallon added |
| Every 4 weeks (2 with four or more fruiting plants) | Refresh: drain, wipe with water and a little baking soda, refill |

HydroBoost goes in weekly; its dose depends on your water (1–4 tsp for a Home).

## Using another nutrient

Teaspoons don't carry over between products. What owners use:

| Product | N-P-K | Fits |
|---|---|---|
| General Hydroponics MaxiGro | 10-5-14 | Leafy greens and herbs (high nitrogen) |
| General Hydroponics MaxiBloom | 5-15-14 | Flowering and fruiting (high phosphorus) |
| Hydroponic Research Veg+Bloom | 8-5-13 | Whole grow, one part. Buy Tap/Hard or RO/Soft to match your water |

A tower of greens and herbs runs on MaxiGro alone. Dissolve powder in a jug
before it goes in the tank. Mixed straight in, owners have seen pH read below 4.

## Targets

| | pH | EC (mS/cm) |
|---|---|---|
| Seedlings | 5.5–6.5 | 0.8–1.2 |
| Leafy greens | 5.5–6.5 | 1.2–2.0 (owners run 1.3–1.6) |
| Herbs | 5.5–6.5 | 1.0–2.0 |
| Fruiting | 5.5–6.3 | 2.0–2.4 |

Gardyn's food at its stock dose has been measured at about 1.2 mS/cm. Adjust pH
slowly: start at 1 mL of pH Up or Down per gallon and retest after 15–30
minutes. Overshooting is the common mistake.

## With seedypod

1. **Fit a pH and an EC probe** ([Adding a probe](SENSORS.md)). The readings
   show under **Water quality** on the home screen and go into history.
2. **Feed to the EC target**, not the teaspoon. Add nutrient until EC reaches
   the target for the crop; add plain water to bring it down.
3. **Let Autopilot watch** ([Autopilot](AUTOPILOT.md)). For example, notify
   when the one-hour average pH leaves 5.5–6.5, or when EC drops below 1.2.
   Backtest it against your recorded readings before you arm it.

The tank-level sensor shows real water use, so top off when the tank is low
rather than on a weekly reminder.
