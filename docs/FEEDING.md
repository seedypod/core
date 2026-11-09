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
   **Autopilot → Starter rules** has both ready, with the note each threshold
   comes from, plus one for a tank below half.

The tank-level sensor shows real water use, so top off when the tank is low
rather than on a weekly reminder.

## Chores

**Water → Chores** lists what the tower needs: thin, trim roots, top off,
refresh, feed and clean. Each says whether it comes **from a reading** or the
**calendar**:

- With a trusted reading, the chore follows the tank. "Tank at 40 %, falling
  8 % a day", or "EC 0.9 mS/cm, below the 1.2–2.0 for leafy greens". A due
  chore also shows in **Needs you** and raises an alert.
- Without one, it's a calendar guess and says why: "Calendar guess, no EC
  probe", or "tank level reading suspect". A suspect or stale tank level is
  never used to ask for a top-off.

Every dose and target links the knowledge note it comes from. **Done** logs the
chore in the tank log, and the chore counts from there. An agent reads the same
list over MCP (`list_chores`).

## Keep a tank log

**Water → Tank log → Log action** records what you did and when: fed 1 tsp
MaxiGro, topped off, refreshed, added 2 mL pH Down. Amount, product and note are
optional. With a log, a jump in EC or a drop in pH can be traced to the feed or
dose that caused it, and the unit can learn your tank's response
([ADR 0029](adr/0029-care-engine-and-agent-boundary.md)). An agent can log what
you tell it over MCP (`log_tank_action`) and read the log back
(`list_tank_actions`). The log is in the database, so backups carry it.
