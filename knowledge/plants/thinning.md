---
type: "Reference"
title: "Thinning"
description: "How many sprouts to keep in each yCube, by plant, from Gardyn's thinning article: 1 for greens, lettuces, fruiting plants and large flowers, 3 for herbs and small flowers, and five plants not thinned. Behind the thin chore, the protocol's thin check and the catalog's thinTo."
status: "draft"
generated: {"by": "claude/opus-5.5", "at": "2026-11-20T18:00:00+00:00"}
sources: [{"resource": "https://help.mygardyn.com/en/articles/1771329", "title": "Gardyn help centre: Thinning: When, Why and How to Thin Your Sprouts, edited 2026-10-13, read 2026-11-20"}, {"resource": "https://help.mygardyn.com/en/categories/456897-ycubes", "title": "Gardyn help centre: yCubes plant pages, read 2026-11-20"}]
---

# Thinning

Gardyn overseeds every yCube so that something comes up, which means a pod usually holds more sprouts than it can grow well. Thinning cuts it back to the number that has enough light, water and air.

## Sprouts to keep

| Keep | Plants |
|---|---|
| 1 | Leafy greens and lettuces, vegetables, fruiting plants, large flowers (sunflowers, cornflower, hibiscus, borage, canna), and Mammoth Basil |
| 3 | Herbs, small flowers, and the mini strawberries |
| All (don't thin) | Arugula, chamomile, chives, garlic chives, wheatgrass |

The article names every plant it sells. `scripts/plants/gardyn-thinning.txt` holds that list by catalog id, and the catalog's `thinTo` takes it first, then the plant's own page. For a plant on neither, such as a custom one, seedypod uses the kind rule above (`thinRule` in `src/plants/catalog.ts`) and marks the count as estimated.

## How

- One sprout is one stem coming out of the rockwool, however many leaves it has.
- Cut the extras at the base with clean scissors. Pulling them damages the roots of the ones you keep.
- Thin about 5–7 days after the sprouts first get plant food.
- A yCover over the yCube after thinning keeps light off the rockwool and cuts algae.

## Where the list and the plant pages disagree

The thinning article and the plants' own pages differ on four plants. seedypod follows the article, which was edited more recently and exists to give these counts:

| Plant | Thinning article | Plant page |
|---|---|---|
| Chamomile | don't thin | 1 |
| Watercress | 3 | don't thin |
| Shiso | 1 | 3 |
| Red sorrel | 1 | 3 |

## Gaps

- The bare-root strawberries arrive as one live plant per yCube, so there is nothing to thin. Their page says so, and the article leaves them out.
- Sorrel's page covers several varieties at once and gives no count; it gets the leafy-green rule (1).
- The thin chore's calendar fallback still counts from planting (`thinningReminderDays`, default 14 d), not from the first feed plus 5–7 days.
