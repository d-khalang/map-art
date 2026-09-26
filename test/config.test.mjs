import test from "node:test";
import assert from "node:assert/strict";
import { companionState, loadPlace, validatePlace, validateStyle } from "../src/config.mjs";
import { buildOverpassQuery, summarizeOsm } from "../src/osm.mjs";

const place = {
  id: "sample-town",
  name: "Sample Town",
  country: "Example",
  format: "A7",
  center: { lat: 50, lon: 10 },
  radiusMeters: 1200,
  includeBuildings: true,
  visits: { me: ["2024-01"], partner: [], shared: [] },
  landmarks: []
};

test("place validation accepts the experiment contract", () => {
  assert.equal(validatePlace(structuredClone(place)).format, "A7");
});

test("all three selected experiment places satisfy the place contract", async () => {
  const places = await Promise.all(["utrecht", "domodossola", "zaltbommel"].map(loadPlace));
  assert.deepEqual(places.map((item) => item.format), ["A6", "A7", "A7"]);
});

test("A7 building queries are opt-in", () => {
  assert.match(buildOverpassQuery(place), /\["building"\]/);
  assert.doesNotMatch(buildOverpassQuery({ ...place, includeBuildings: false }), /\["building"\]/);
  assert.match(buildOverpassQuery(place), /wood\|scrub\|heath/);
});

test("companion mark distinguishes individual, both, and shared visits", () => {
  assert.deepEqual(companionState(place.visits), { value: "me", shared: false });
  assert.deepEqual(companionState({ me: ["2020"], partner: ["2021"], shared: [] }), { value: "both", shared: false });
  assert.deepEqual(companionState({ me: [], partner: [], shared: ["2022"] }), { value: "both", shared: true });
});

test("OSM summary classifies experiment features", () => {
  const summary = summarizeOsm({ elements: [
    { tags: { highway: "primary" } },
    { tags: { railway: "tram" } },
    { tags: { natural: "water" } },
    { tags: { leisure: "park" } },
    { tags: { natural: "wood" } },
    { tags: { building: "yes" } },
    { tags: { tourism: "museum" } }
  ] });
  assert.deepEqual(summary, { elements: 7, roads: 1, rail: 1, water: 1, green: 2, buildings: 1, pois: 1 });
});

test("style validation catches incomplete palettes", () => {
  assert.throws(() => validateStyle({ id: "bad", palette: {} }), /palette.paper/);
});
