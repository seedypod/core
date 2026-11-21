---
type: "Reference"
title: "Plant pages"
description: "What seedypod takes from each plant's page in Gardyn's help centre (Latin name, days to sprout and to maturity, size, temperature, care level, full-dose cue, care and harvest notes), how the notes were rewritten, and where the pages contradict themselves."
status: "draft"
generated: {"by": "claude/opus-5.5", "at": "2026-11-20T18:00:00+00:00"}
sources: [{"resource": "https://help.mygardyn.com/en/categories/406209-plants", "title": "Gardyn help centre: Plants category (246 articles), read 2026-11-20"}, {"resource": "https://help.mygardyn.com/en/categories/456897-ycubes", "title": "Gardyn help centre: yCubes (140 plant pages in 4 collections), read 2026-11-20"}]
---

# Plant pages

Gardyn's help centre has a page for each yCube it sells or has sold: 52 leafy greens, 26 herbs, 30 fruiting plants and 32 flowers. Each opens with a header of facts and ends with Care & Harvest notes. All 139 catalog plants have a page. Oopsy Daisy and Pink Swiss Chard have pages but are not in the zone guide, so the catalog leaves them out.

## Facts

`scripts/plants/gardyn-help-plants.txt` holds the facts by catalog id, and `build-catalog.py` puts them in `facts` in `src/plants/catalog.json`:

| Field | From the page's | Notes |
|---|---|---|
| `latinName` | Latin name | Cultivars in single quotes; three typos corrected (Cucumis sativus, Origanum, Torenia fournieri) |
| `sproutDays` | Days to Sprout | Used when the Plant Book has none; preferred to Iowa State's soil table |
| `maturityDays` | Days to Maturity | For fruiting plants it runs about a month ahead of the store's First Harvest, which counts from sowing the yCube; 59 of 68 store plants agree within half a month |
| `heightFt` | Plant Size | As Gardyn labels it: `<1`, `1`, `2-3`, `1+` |
| `tempF` | Temperature, in Care & Harvest | 90 pages give a range |
| `careLevel` | Care Level | Fills the 66 plants the store doesn't sell; "Advanced" is the store's "Expert" |
| `fullDose` | Ready for Full Dose | True leaves or 1/2-inch roots for most; roots only for onions, chives, lemongrass, wheatgrass, canna and some beans |
| `thinTo` | Thin to | Second to the [thinning article](thinning.md) |

The page's light zone is not used: the [placement guide](gardyn-light-zones.md) is the zone source. They disagree on seven plants (chamomile, endive and lemon balm by one zone; green cabbage, night-scented stock and purple beans by one zone the other way; sorrel lists every zone).

## Care and harvest notes

`src/plants/care.json` holds notes on harvesting, pruning, support, pollinating, pests and climate for 136 plants. The three petunia pages have no Care & Harvest section. The notes are rewritten in seedypod's own words from each page, with every number, threshold and cue kept. They leave out recipes, origin stories, product upsell, and the root-check line that every page repeats, since root trimming is its own chore. They're served by `planner.plant` and MCP's `plant_care`, and shown on Grow's pod panel. They aren't bundled into the web app.

## Where the pages are wrong

- Green Cabbage's header repeats Yellow Snapdragon's sprout, maturity, zone and size, so its numbers are doubtful.
- Purple Cayenne's harvest note opens with Lemon Hot Pepper's "harvest when yellow". The rewrite drops it.
- The bean and nasturtium pages tell you to keep "your soaked Canna yCube" separate.
- Most greens say to leave 1/3 of the plant, while arugula, radicchio, collards and perpetual spinach say to take no more than 1/3. Each note keeps its own page's rule.
- The pepper pages say cross-pollinating varieties mixes this season's fruit. Crossing only changes the seeds, so the rewrite keeps just the advice to use a separate brush per variety.

## Re-reading

The help centre fetches without trouble at one page every 1.5 s. mygardyn.com's store and Plant Book returned HTTP 429 to every request on 2026-11-20, so the store extract (`gardyn-store-ycubes.txt`, read 2026-11-02) was not refreshed.
