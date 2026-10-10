# Travel Atlas

Illustrated maps of the cities we travelled to, printed as small cards for one wall.

**OpenStreetMap is the only source of geography.** The illustration (watercolour fields, standing trees, roofs with soft shadows, painted water) is drawn by code directly from OSM shapes, so nothing can drift away from the real map. No AI-painted base layer is involved.

## Quick start

```powershell
npm test
node atlas.mjs render zaltbommel     # output/zaltbommel.svg + print PNG
node atlas.mjs wall                  # every place + output/index.html wall preview
```

The first render of a place fetches OSM data once through Overpass and caches it in `cache/osm/`. Use `node atlas.mjs fetch <place> --refresh` to update the cache. Print PNGs default to 600 dpi; change with `--dpi`.

## Card formats

| Format | Size | Use for | Typical `radiusMeters` |
|---|---|---|---|
| A6 portrait | 105 × 148 mm | cities | 2500–6000 |
| A7 landscape | 105 × 74 mm | towns | 800–1800 |

Both are 105 mm wide, so two A7 cards stack into exactly one A6. A wall of 30–40 cards stays on a clean grid.

## Add a place

Copy `places/_template-a6.json` or `places/_template-a7.json` to `places/<id>.json` and set:

- `name`, `country`, `center`, `radiusMeters` (half the map width in metres);
- `visits` — who went:
  - `shared` non-empty → we travelled together: **sun and moon stickers joined by a dotted thread with a heart**;
  - only `me` → sun; only `partner` → moon; both but at different times → sun and moon, not joined;
- up to five public `landmarks` with an optional transparent PNG sticker in `art/landmarks/<place>/`.

```json
{
  "name": "Dom Tower",
  "lat": 52.0906531,
  "lon": 5.1213086,
  "art": "art/landmarks/utrecht/dom-tower-v1.png",
  "artWidthMm": 6.5,
  "artDxMm": 2
}
```

The red dot is always the true coordinate. `artDxMm` / `artDyMm` only nudge the sticker (a thin leader line connects it); `artWidthMm` is the printed width. Names are printed very small on purpose, readable only up close.

No private stops or names are put on the map. Keep anything personal in `places/private/`, `*.private.json`, or `art/private/` (all gitignored).

## Style

The single style lives in `styles/anime.json`: palette, line weights (mm at ~25 m/mm, scaled automatically for wider city maps), tree density and size, sticker edge, textures, fonts. Edit it and re-run `render`.

Fonts are Windows system fonts (Cooper Black for titles, Segoe Print for labels).

## Landmark stickers

Generation prompts are in `art/landmarks/prompts.md`.

## How it works

1. `src/osm.mjs` — Overpass query over the map rectangle (roads, rail, water incl. multipolygon rivers, land use, buildings). Large maps fetch buildings in tiles; requests retry across mirrors.
2. `src/features.mjs` — projects and clips OSM elements into layers (land, water, waterways, roads, rail, buildings).
3. `src/illustrate.mjs` — paints the card as SVG.
4. `src/rasterize.mjs` — SVG → print PNG via resvg.
