import test from "node:test";
import assert from "node:assert/strict";
import { loadStyle } from "../src/config.mjs";
import { assembleRings, clipRing, makeProjection } from "../src/geo.mjs";
import { renderMap } from "../src/illustrate.mjs";
import { rasterizeSvg } from "../src/rasterize.mjs";

const square = (lat, lon, d) => [
  { lat, lon }, { lat, lon: lon + d }, { lat: lat + d, lon: lon + d }, { lat: lat + d, lon }, { lat, lon }
];

const payload = {
  elements: [
    { type: "way", id: 1, tags: { highway: "primary" }, geometry: [{ lat: 50, lon: 9.99 }, { lat: 50, lon: 10.01 }] },
    { type: "way", id: 2, tags: { landuse: "forest" }, geometry: square(50.001, 10.001, 0.003) },
    { type: "way", id: 3, tags: { building: "yes" }, geometry: square(49.999, 9.998, 0.0003) },
    // A river multipolygon split into two member ways, reaching far off the map.
    { type: "relation", id: 4, tags: { natural: "water", type: "multipolygon" }, members: [
      { type: "way", role: "outer", geometry: [{ lat: 49.996, lon: 9.0 }, { lat: 49.996, lon: 11.0 }, { lat: 49.997, lon: 11.0 }] },
      { type: "way", role: "outer", geometry: [{ lat: 49.997, lon: 11.0 }, { lat: 49.997, lon: 9.0 }, { lat: 49.996, lon: 9.0 }] }
    ] }
  ]
};

const place = {
  id: "sample",
  name: "Sample",
  country: "Example",
  format: "A7",
  center: { lat: 50, lon: 10 },
  radiusMeters: 1500,
  visits: { me: [], partner: [], shared: ["together"] },
  landmarks: [{ name: "Old Gate", lat: 50, lon: 10 }]
};

test("multipolygon member ways join into one closed ring", () => {
  const rings = assembleRings(payload.elements[3].members);
  assert.equal(rings.outer.length, 1);
  assert.deepEqual(rings.outer[0][0], rings.outer[0].at(-1));
});

test("rings are clipped to the rectangle", () => {
  const ring = [{ x: -100, y: -100 }, { x: 100, y: -100 }, { x: 100, y: 100 }, { x: -100, y: 100 }];
  const clipped = clipRing(ring, { minX: 0, minY: 0, maxX: 10, maxY: 10 });
  assert.ok(clipped.every((p) => p.x >= 0 && p.x <= 10 && p.y >= 0 && p.y <= 10));
});

test("projection puts the centre in the middle of the map rectangle", () => {
  const { project } = makeProjection(place);
  const c = project(place.center);
  assert.equal(c.x, 525);
  assert.ok(Math.abs(c.y - (160 + 510 / 2)) < 1e-9);
});

test("render emits an A7 card with trees, landmark, linked travellers, attribution", async () => {
  const { svg, stats } = await renderMap(place, await loadStyle(), payload);
  assert.match(svg, /width="105mm" height="74mm"/);
  assert.match(svg, /OpenStreetMap contributors/);
  assert.match(svg, /Old Gate/);
  assert.match(svg, /class="travellers"/);
  assert.match(svg, /stroke-dasharray/);
  assert.ok(stats.trees > 0);
  assert.equal(stats.buildings, 1);
  // Rendering must not crash the rasterizer, including the off-map river.
  assert.ok(rasterizeSvg(svg, 400).length > 1000);
});

test("separate visits show both stickers without a thread; solo shows one", async () => {
  const style = await loadStyle();
  const both = (await renderMap({ ...place, visits: { me: ["a"], partner: ["b"], shared: [] } }, style, payload)).svg;
  const travellers = both.slice(both.indexOf('class="travellers"'));
  assert.doesNotMatch(travellers.slice(0, travellers.indexOf("</g>\n")), /stroke-dasharray/);
  const solo = (await renderMap({ ...place, visits: { me: ["a"], partner: [], shared: [] } }, style, payload)).svg;
  assert.equal((solo.match(/filter="url\(#sticker\)"><g transform/g) ?? []).length, 1);
});
