"""Measure Gardyn's light-zone grid from its official zone map image.

Downloads the map from Gardyn's help centre (not committed; it is Gardyn's
artwork), crops each tower, colour-segments the pods (red = high, peach =
medium, yellow = low), merges blobs split by outlines, clusters them into
columns by x and sorts by y. Prints the per-column zone sequence top→bottom,
which is what src/components/Grow/lightZones.ts encodes.

Run:  python3 -I scripts/plants/measure-zones.py   (needs Pillow and network)
"""
import statistics
import sys
import tempfile
import urllib.request
from collections import deque
from pathlib import Path

from PIL import Image

MAP_URL = 'https://usw2.frontkb-cdn.com/attachments/9015708/255041/6b832c21-1323-4c4f-84ed-104741851675.png'
# Crop boxes (x0, y0, x1, y1) in the 905×355 source image, and column counts.
TOWERS = {'home': ((285, 35, 405, 300), 3), 'studio': ((745, 40, 850, 250), 2)}


def classify(rgb):
    r, g, b = rgb
    if r > 200 and g > 190 and b < 120:
        return 'L'
    if r > 220 and 150 < g < 205 and b < 160:
        return 'M'
    if r > 150 and g < 150 and b < 120:
        return 'H'
    return None


def blobs(im):
    w, h = im.size
    px = im.load()
    seen = [[False] * w for _ in range(h)]
    out = []
    for y in range(h):
        for x in range(w):
            if seen[y][x] or not classify(px[x, y]):
                continue
            q = deque([(x, y)])
            seen[y][x] = True
            pts, cols = [], {}
            while q:
                cx, cy = q.popleft()
                pts.append((cx, cy))
                k = classify(px[cx, cy])
                cols[k] = cols.get(k, 0) + 1
                for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                    if 0 <= nx < w and 0 <= ny < h and not seen[ny][nx] and classify(px[nx, ny]):
                        seen[ny][nx] = True
                        q.append((nx, ny))
            if len(pts) > 60:
                out.append([sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts), cols, len(pts)])
    merged = []
    for b in sorted(out, key=lambda b: -b[3]):
        for m in merged:
            if abs(m[0] - b[0]) < 28 and abs(m[1] - b[1]) < 28:
                for k, v in b[2].items():
                    m[2][k] = m[2].get(k, 0) + v
                break
        else:
            merged.append(b)
    return [(m[0], m[1], max(m[2], key=m[2].get)) for m in merged]


def main():
    with tempfile.TemporaryDirectory() as d:
        src = Path(d) / 'map.png'
        urllib.request.urlretrieve(MAP_URL, src)
        im = Image.open(src).convert('RGB')
        for name, (box, ncols) in TOWERS.items():
            crop = im.crop(box)
            crop = crop.resize((crop.width * 4, crop.height * 4), Image.LANCZOS)
            bs = blobs(crop)
            xs = sorted(b[0] for b in bs)
            cents = [xs[int(i * (len(xs) - 1) / (ncols - 1))] for i in range(ncols)]
            for _ in range(30):
                groups = [[] for _ in cents]
                for b in bs:
                    groups[min(range(len(cents)), key=lambda i: abs(b[0] - cents[i]))].append(b)
                cents = [statistics.mean(x[0] for x in g) for g in groups]
            print(f'{name}: {len(bs)} pods')
            for i, g in enumerate(groups):
                g.sort(key=lambda b: b[1])
                print(f'  column {i + 1}: ' + ' '.join(b[2] for b in g))


if __name__ == '__main__':
    sys.exit(main())
