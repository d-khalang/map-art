import test from "node:test";
import assert from "node:assert/strict";
import { loadPlace, loadStyle, validatePlace, validateStyle, visitState } from "../src/config.mjs";
import { buildOverpassQuery, buildingQueries, summarizeOsm } from "../src/osm.mjs";

const place = {
  id: "sample-town",
  name: "Sample Town",
  country: "Example",
  format: "A7",
  center: { lat: 50, lon: 10 },
  radiusMeters: 1200,
  visits: { me: ["2024-01"], partner: [], shared: [] },
  landmarks: []
};

test("place validation accepts the place contract", () => {
  assert.equal(validatePlace(structuredClone(place)).format, "A7");
  assert.throws(() => validatePlace({ ...place, format: "A5" }), /A6 or A7/);
});

test("all checked-in places and the style load", async () => {
  const places = await Promise.all(["utrecht", "domodossola", "zaltbommel"].map(loadPlace));
  assert.deepEqual(places.map((item) => item.format), ["A6", "A7", "A7"]);
  assert.equal((await loadStyle()).id, "anime");
});

test("overpass query covers the map rectangle and includes relations", () => {
  const query = buildOverpassQuery(place);
  assert.match(query, /\[bbox:[-\d.,]+\]/);
  assert.match(query, /nwr\["natural"="water"\]/);
  assert.match(query, /out geom qt;/);
  assert.doesNotMatch(query, /"building"/);
  assert.match(query, /footway/);
  assert.doesNotMatch(buildOverpassQuery({ ...place, radiusMeters: 3000 }), /footway/);
});

test("buildings are fetched in tiles for large maps", () => {
  assert.equal(buildingQueries(place).length, 1);
  assert.equal(buildingQueries({ ...place, radiusMeters: 3000 }).length, 4);
});

test("visit state distinguishes solo, separate, and shared trips", () => {
  assert.equal(visitState(place.visits), "me");
  assert.equal(visitState({ me: [], partner: ["2021"], shared: [] }), "partner");
  assert.equal(visitState({ me: ["2020"], partner: ["2021"], shared: [] }), "both");
  assert.equal(visitState({ me: [], partner: [], shared: ["2022"] }), "together");
  assert.equal(visitState({ me: [], partner: [], shared: [] }), "none");
});

test("OSM summary counts the main feature types", () => {
  const summary = summarizeOsm({ elements: [
    { tags: { highway: "primary" } },
    { tags: { railway: "tram" } },
    { tags: { natural: "water" } },
    { tags: { building: "yes" } }
  ] });
  assert.deepEqual(summary, { elements: 4, roads: 1, rail: 1, water: 1, buildings: 1 });
});

test("style validation catches missing sections and bad colours", () => {
  assert.throws(() => validateStyle({ id: "bad", palette: {} }), /lines is required/);
});
