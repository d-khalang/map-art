import test from "node:test";
import assert from "node:assert/strict";
import { loadStyle } from "../src/config.mjs";
import { renderMap, renderMask } from "../src/render.mjs";
import { rasterizeSvg } from "../src/rasterize.mjs";

const payload = {
  fetchedAt: "2026-09-19T00:00:00.000Z",
  elements: [
    { type: "way", id: 1, tags: { highway: "primary" }, geometry: [{ lat: 50, lon: 9.99 }, { lat: 50, lon: 10.01 }] },
    { type: "way", id: 2, tags: { natural: "water" }, geometry: [{ lat: 49.998, lon: 9.998 }, { lat: 49.998, lon: 10.002 }, { lat: 50.002, lon: 10.002 }, { lat: 50.002, lon: 9.998 }, { lat: 49.998, lon: 9.998 }] },
    { type: "way", id: 3, tags: { waterway: "river", name: "Sample River" }, geometry: [{ lat: 49.995, lon: 9.995 }, { lat: 50.005, lon: 10.005 }] }
  ]
};

const place = {
  id: "sample",
  name: "Sample",
  country: "Example",
  format: "A7",
  center: { lat: 50, lon: 10 },
  radiusMeters: 1500,
  includeBuildings: false,
  visits: { me: [], partner: [], shared: ["2025-05"] },
  landmarks: [{ name: "Old Gate", lat: 50, lon: 10 }],
  visitedPlaces: [{ name: "Reading Room", lat: 50.001, lon: 10.001, by: "both" }]
};

test("render emits physical A7 dimensions, attribution, landmarks, and companion mark", async () => {
  const style = await loadStyle("tourist");
  const { svg } = await renderMap(place, style, payload);
  assert.match(svg, /width="105mm" height="74mm"/);
  assert.match(svg, /OpenStreetMap contributors/);
  assert.match(svg, /Old Gate/);
  assert.match(svg, /Reading Room/);
  assert.match(svg, /class="visited-place"/);
  assert.match(svg, />500 m</);
  assert.match(svg, />N</);
  assert.match(svg, /stroke="#82B9C5" stroke-width="14"/);
  assert.match(svg, /<circle/);
  assert.match(svg, /<rect/);
});

test("road mask is monochrome and preserves road geometry", async () => {
  const style = await loadStyle("tourist");
  const mask = renderMask(place, style, payload, "roads");
  assert.match(mask, /fill="#000000"/);
  assert.match(mask, /stroke="#FFFFFF"/);
});

test("SVG rasterization produces a PNG suitable for image input", async () => {
  const style = await loadStyle("tourist");
  const mask = renderMask(place, style, payload, "roads");
  const png = rasterizeSvg(mask, 256);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});
