"""Build src/plants/catalog.json from Gardyn's published facts.

Inputs (both in this folder, raw extracts with provenance headers):
  gardyn-zone-guide.txt     name|zone              (Gardyn light-zone placement guide)
  gardyn-store-ycubes.txt   name|handle|yield|care|first harvest  (Gardyn yCube store)

Everything else is derived by rules in this file and flagged as inferred:
  category      by name (fruiting, vegetable, legume, flower, herb, green, lettuce)
  succession    Gardyn's succession table groups; exact when the plant (or its
                family) is named in the table, inferred otherwise
  size          'large' for fruiting/vining plants and sunflowers (shading rule)
  placement     'bottomCenter' for cucumbers (Gardyn's explicit exception)
  harvestMonths from the store when present; otherwise the median of the same
                category in the store, flagged estimated

Run:  python3 -I scripts/plants/build-catalog.py
"""
import json
import re
import statistics
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parents[1] / 'src' / 'plants' / 'catalog.json'


def rows(name):
    for line in (HERE / name).read_text().splitlines():
        if line.strip() and not line.startswith('#'):
            yield line.split('|')


def slug(s):
    s = s.lower().replace('ñ', 'n').replace("'", '')
    return re.sub(r'[^a-z0-9]+', '-', s).strip('-')


# Store product names that differ from the zone guide's names.
STORE_ALIAS = {
    'Banana Peppers': 'Banana Pepper', 'Breen Lettuce': 'Breen', 'Cucumbers': 'Cucumber',
    'Flashy Lettuce': 'Flashy Trout Back', 'Iceberg Lettuce': 'Iceberg', 'Jalapeños': 'Jalapeño',
    'Marigold': 'Marietta Marigold', 'Red Cherry Tomatoes': 'Red Cherry Tomato',
    'Red Sails': 'Red Sails Lettuce', 'Sweet Peppers': 'Sweet Pepper',
}

FRUITING = re.compile(r'pepper|jalape|tomato|eggplant|strawberr|gooseberry|cucumber|okra|pumpkin|squash')
LEGUME = re.compile(r'\bbeans?\b|\bpeas\b')
VEGETABLE = re.compile(r'broccoli|cauliflower|kohlrabi|celery|cabbage|beet')
FLOWER = re.compile(r'sunflower|celosia|snapdragon|stock|zinnia|portulaca|viola|cornflower|hibiscus|borage|canna|chamomile|dianthus|gitana|marigold|matilda|nasturtium|petunia|campanula|calendula|impatiens|torenia')
HERB = re.compile(r'basil|lavender|stevia|parsley|sage|savory|shiso|marjoram|tarragon|catnip|chervil|chives|cilantro|dill|lemon balm|lemongrass|mint|oregano|rosemary|thyme|onion')
LETTUCE = re.compile(r'lettuce|buttercrunch|butterhead|cardinale|endive|flashy|iceberg|lollo|monte carlo|romaine|salanova|salad bowl|rouge|bronze arrow|breen')


def category(name):
    n = name.lower()
    if 'microgreen' in n:
        return 'microgreen'
    if FRUITING.search(n):
        return 'fruiting'
    if LEGUME.search(n):
        return 'legume'
    if FLOWER.search(n):
        return 'flower'
    if HERB.search(n):
        return 'herb'
    if VEGETABLE.search(n):
        return 'vegetable'
    if LETTUCE.search(n):
        return 'lettuce'
    return 'green'


# Gardyn succession table (help.mygardyn.com/en/articles/1782337):
#   fast-greens: Arugula, Tatsoi, Mustard greens, most lettuce varieties
#   long-greens-herbs: Kale, Swiss Chard, Collard Greens, Tokyo Bekana, Basil, Dill, Parsley, Chives
#   fast-fruiting: Beans, Peas, Cucumbers
#   long-fruiting: Tomatoes, Peppers, Eggplants, Strawberries
#   flowers: Petunias, Marigolds, Snapdragons, Lavender
NAMED = [
    ('fast-greens', r'arugula|tatsoi|mustard'),
    ('long-greens-herbs', r'kale|swiss chard|collard|tokyo bekana|basil|dill|parsley|chives'),
    ('fast-fruiting', r'\bbeans?\b|\bpeas\b|cucumber'),
    ('long-fruiting', r'tomato|pepper|jalape|eggplant|strawberr'),
    ('flowers', r'petunia|marigold|snapdragon|lavender'),
]


def succession(name, cat):
    n = name.lower()
    for cls, pat in NAMED:
        if re.search(pat, n):
            return cls, False
    inferred = {
        'lettuce': 'fast-greens', 'green': 'fast-greens', 'herb': 'long-greens-herbs',
        'vegetable': 'fast-greens', 'legume': 'fast-fruiting', 'flower': 'flowers',
        'fruiting': 'fast-fruiting' if re.search(r'okra|pumpkin|squash', n) else 'long-fruiting',
    }[cat]
    return inferred, True


def months(s):
    m = re.findall(r'\d+', s or '')
    return [int(m[0]), int(m[1])] if len(m) == 2 else None


def main():
    zones = {}
    for name, zone in rows('gardyn-zone-guide.txt'):
        if name == 'Dragon Beans Green Beans':
            zones['Dragon Beans'] = zone
            zones['Green Beans'] = zone
        else:
            zones[name] = zone

    store = {}
    for name, handle, yld, care, first in rows('gardyn-store-ycubes.txt'):
        if handle == 'seedless-ycube':
            continue
        key = STORE_ALIAS.get(name, name)
        store[key] = {'handle': handle, 'yield': yld.lower() or None, 'care': care.lower() or None, 'harvest': months(first)}

    unknown = sorted(set(store) - set(zones))
    if unknown:
        raise SystemExit(f'store products with no zone-guide entry: {unknown}')

    # Category medians of the store's harvest windows, for estimates.
    by_cat = {}
    for name, s in store.items():
        if s['harvest']:
            by_cat.setdefault(category(name), []).append(s['harvest'])
    median = {c: [round(statistics.median(h[0] for h in hs)), round(statistics.median(h[1] for h in hs))] for c, hs in by_cat.items()}

    plants = []
    for name in sorted(zones):
        cat = category(name)
        s = store.get(name, {})
        succ, succ_inferred = succession(name, cat)
        harvest = s.get('harvest')
        n = name.lower()
        plants.append({
            'id': slug(name),
            'name': name,
            'category': cat,
            'zone': zones[name],
            'harvestMonths': harvest or median.get(cat),
            'harvestEstimated': harvest is None,
            'careLevel': s.get('care'),
            'yield': s.get('yield'),
            'succession': succ,
            'successionInferred': succ_inferred,
            'size': 'large' if (cat in ('fruiting', 'legume') and 'strawberr' not in n) or 'sunflower' in n else 'normal',
            'placement': 'bottomCenter' if 'cucumber' in n else None,
            'gardynHandle': s.get('handle'),
            'inStore': bool(s),
        })

    OUT.parent.mkdir(parents=True, exist_ok=True)
    doc = {
        'version': 1,
        'generatedFrom': ['scripts/plants/gardyn-zone-guide.txt', 'scripts/plants/gardyn-store-ycubes.txt'],
        'sources': {
            'zone': 'https://help.mygardyn.com/en/articles/11547329',
            'zoneMap': 'https://help.mygardyn.com/en/articles/11567361',
            'store': 'https://mygardyn.com/collections/ycubes',
            'succession': 'https://help.mygardyn.com/en/articles/1782337',
        },
        'categoryHarvestMedians': median,
        'plants': plants,
    }
    OUT.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + '\n')
    cats = {}
    for p in plants:
        cats[p['category']] = cats.get(p['category'], 0) + 1
    print(f'{len(plants)} plants → {OUT.relative_to(HERE.parents[1])}  in store: {sum(p["inStore"] for p in plants)}  categories: {cats}')


if __name__ == '__main__':
    main()
