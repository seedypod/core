---
type: "Finding"
title: "My Pod Planner cross-check (2026-11-02)"
description: "How My Pod Planner's zone grid, per-plant zones, harvest days, difficulty and placement algorithm compare with Gardyn's official guidance."
status: "draft"
generated: {"by": "claude/opus-5.5", "at": "2026-11-02T08:30:00+00:00"}
sources: [{"resource": "https://www.mypodplanner.com/", "title": "My Pod Planner (public web app, read 2026-11-02)"}, {"resource": "/plants/gardyn-light-zones.md", "title": "Gardyn light zones"}, {"resource": "/plants/catalog-provenance.md", "title": "Catalog provenance"}]
---

# My Pod Planner cross-check (2026-11-02)

My Pod Planner is a free web app (beta) that lays out Gardyn pods by light zone. Its 134-plant catalog (121 pod plants plus 13 microgreens) and its placement logic ship in the site's JavaScript bundle. We found no published repository or licence, so seedypod does not reuse its data; this note records only comparisons against Gardyn's own guidance.

## Results

| Check | Agreement | Notes |
|---|---|---|
| Zone grid (Home and Studio) | identical, pod for pod | Same as our measurement of Gardyn's map |
| Per-plant zone | 117 of 120 matched plants (97.5%) | Differs on Mammoth Basil (planner high, Gardyn medium), Dragon Beans (planner low, Gardyn high), Chamomile (planner low, Gardyn medium) |
| Days to harvest vs Gardyn's first-harvest window (±1 week) | 50 of 67 (75%) | Fruiting crops about a month early (peppers, tomato, eggplant at 60–65 days vs Gardyn's 3–4 months); fast greens at ~3 weeks vs Gardyn's 1–2 months — consistent with seed-packet maturity or baby-leaf timing |
| Difficulty vs Gardyn care level | 43 of 72 (60%) | Disagreements run both ways; the planner's ratings are its own |
| Coverage | — | 19 plants in Gardyn's guide are not in the planner (e.g. Thai Eggplant, Purple/Yellow Beans, Cape Gooseberry, Shiso, Purslane) |

Conclusion: the planner's zones were clearly derived from Gardyn; its harvest days and difficulty were not.

## Placement algorithm differences

| Behaviour | Gardyn guidance | My Pod Planner | seedypod |
|---|---|---|---|
| Ideal zone full | Place one zone lower | Substitutes a different plant that fits the free zone, or fills with greens flagged as a fallback | One zone lower, flagged; overflow reported, never substituted |
| Cucumbers | Bottom of the middle column | Bottom-centre | Bottom-centre |
| Some peppers (Burrito, Candy Cane, Shishito) | High light | Top or bottom row ("edge row", to avoid shading) — these rows are Gardyn's low zone | High light, with large plants spaced apart |
| Shading | Space larger plants apart | Only via the edge-row rule | Adjacency penalty for large plants |
| Nursery | Germinate off-unit, move on readiness signs | 10-pod nursery, transfer after 10 days | 10-pod nursery model without zones |
| Staggering | Succession table (gap after harvest-ready) | Up to three waves per plant at a per-plant cadence | Gardyn's succession groups: harvest-ready + group gap |
| Plan generation | — | Builds a mix by preference (≈20–33% lettuce, 23% herbs, 15% greens, flowers, fruiting for experienced growers) | User picks plants; no auto-mix yet |

The auto-mix is a feature worth adding later, sourced from Gardyn's welcome-kit and refresh-kit guides rather than invented ratios.
