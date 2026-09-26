# Travel Atlas experiment

This repository tests a repeatable illustrated-map workflow before we commit to a larger application.

The invariant is simple: **OpenStreetMap owns the geography; the illustration layer owns the mood.** Roads, rail, water edges, labels, landmark anchors, visitor marks, and attribution are restored deterministically after any generated artwork.

## What works in this experiment

- Cached OpenStreetMap extraction through Overpass.
- A6 portrait and A7 landscape outputs using one physical grid width of 105 mm.
- Three editable style presets in `styles/`.
- Circle/diamond Companion Marks for configurable visitor roles.
- Separate public-attraction and optional visited-place marker layers.
- An accurate generated scale bar and compact north compass on every map.
- Style-controlled river, canal, and stream widths, including open OSM waterways.
- SVG map rendering plus deterministic PNG rasterization for AI inputs.
- AI handoff bundles containing the reference, masks, protected overlay, prompt, and manifest.
- A three-style comparison page and timing report.
- A multi-place collection page for checking style consistency across city scales.
- Watch mode for rapid style iteration.

## Quick start

```powershell
npm test
node atlas.mjs fetch utrecht
node atlas.mjs experiment utrecht
node atlas.mjs collection utrecht domodossola zaltbommel
node atlas.mjs watch utrecht
```

`fetch` requires internet access once. Later renders use the cached OSM response.

Open `output/<place>/index.html` after `experiment`, `output/index.html` after `collection`, or use watch mode and open the printed local URL.

## Fast style iteration

Change only one of these files and rerun the experiment:

- `styles/cartographic.json`
- `styles/tourist.json`
- `styles/storybook.json`

Palette, line widths, feature visibility, label budget, AI strength, underlay saturation, prompt, and protected geometry are all data—not renderer code. The generated underlay is intentionally desaturated before exact OSM water and green areas are restored, so an AI colour mistake cannot convincingly masquerade as mapped water or parkland.

The generated AI bundle lives under `output/<place>/ai/<style>/`. It is deliberately provider-neutral. An image model may paint from the reference and masks, but its output is composited beneath exact water geometry and cleared road corridors before the protected SVG geometry is restored.

To test generated artwork, save the image locally and add this to the place file:

```json
"illustrations": {
  "tourist": {
    "image": "art/generated/berlin-tourist.png",
    "opacity": 0.92
  }
}
```

Then rerun `node atlas.mjs experiment berlin`.

The current experiment set is Utrecht (A6), Domodossola (A7), and Zaltbommel (A7). Their selected tourist underlays are stored in `art/generated/`. The checked-in place configs contain public sample data and no personal visit history.

## Keep personal data private

The repository ignores local secrets, credential files, and private map material. Keep personal source notes or artwork under `places/private/`, `art/private/`, or `private/`; use `*.personal.json` or `*.private.json` for other local records. Before committing a public place config, remove visit dates, private stops, names, addresses, and other identifying notes.

## Add a place

Copy the appropriate template from `places/`, then set:

- centre coordinate and map radius;
- A6 for a city or A7 for a small town;
- visit dates for `me`, `partner`, and/or `shared`;
- up to five manually approved default landmarks;
- personally visited places with `by` set to `me`, `partner`, or `both`.

A7 should normally use one landmark and a radius around 800–1800 m. A6 can support two or three landmarks and a radius around 2500–6000 m.

## Experiment gates

Before scaling the collection, test a dense city, a small town, and a coastal/river/mountain place. Record:

- fetch and render time;
- output size;
- A7 readability at one metre;
- geography changes introduced by AI;
- style consistency across places;
- minutes of manual correction.

The experiment report records the machine-measurable parts. The visual checks remain intentional human gates.
