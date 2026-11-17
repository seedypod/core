---
type: "Reference"
title: "Zone tolerance"
description: "Which light zones beyond its ideal one a plant does acceptably in, by category, and what each costs the pod planner: Gardyn's one-zone-lower rule first, one zone higher for herbs, flowers and legumes, never below medium for fruiting plants."
status: "draft"
generated: {"by": "claude/opus-5.5", "at": "2026-11-17T12:00:00+00:00"}
sources: [{"resource": "https://help.mygardyn.com/en/articles/11567361", "title": "Gardyn Plant Placement Guide: Understanding Light Zones"}, {"resource": "https://help.mygardyn.com/en/articles/11547329", "title": "Gardyn All Plants Placement by Light Zone Guide"}]
---

# Zone tolerance

Gardyn gives each plant one light zone and one fallback: "if the ideal spot is unavailable, place your plants one light zone lower". Owners report that plants are less strict than that: one will do fine a zone higher or lower depending on the space around it. So the catalog gives every plant the zones beyond its ideal where it still does acceptably (`tolerates`), each with a cost, and the planner weighs that cost against shading instead of following one fixed fallback. The rule is `src/plants/tolerance.ts`; the costs are planner weights, not measured yields.

## Defaults by category

| Category | Also does ok in | Basis |
|---|---|---|
| All | one zone lower | Gardyn's own fallback rule. |
| Fruiting | nothing below medium | Gardyn puts every fruiting plant in high light; its rule allows one zone lower, so medium is as far as it goes. |
| Herbs | one zone higher too | Gardyn's map page puts herbs in "low to medium", and its zone guide spreads them over all three zones (mint low, basil medium, lavender high). |
| Flowers, legumes | one zone higher too | The zone guide spreads both over high and medium (snapdragons high, violas medium; beans high, peas medium). |
| Lettuce, leafy greens, vegetables | nothing higher | Gardyn warns that too much light can hasten bolting; brassicas bolt too. |

A custom plant takes its category's default unless it names its own zones (the Plan screen's "Add plant" dialog, or `tolerates` on the MCP `add_plant` tool).

## Costs

| Zone | Cost |
|---|---|
| Ideal | 0 |
| One lower | 1 |
| One higher | 2 (3 for a large plant) |
| Two lower | 3 |
| Two higher | 4 |

One lower stays cheapest so Gardyn's published fallback still comes first, and layouts that fitted Gardyn's rule barely change. A large plant pays one more to go up: the high zone is the centre cluster, where Gardyn's "leave space between larger plants so they do not block light from smaller plants nearby" bites hardest. Zones outside a plant's tolerance cost the same if a plan allows them (`overrides.allowedZones`); a pod a person places outside both is flagged on the Plan screen.

## Gaps

- No per-plant evidence yet: every plant in a category gets the same tolerance. Kale and chard likely take high light better than arugula or lettuce, but nothing published by Gardyn says so.
- Costs are relative weights for placement, not predictions of growth or yield.
