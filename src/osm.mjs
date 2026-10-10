import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { ROOT } from "./config.mjs";
import { fetchBbox } from "./geo.mjs";

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];

// Bump when the query changes so stale caches are refetched automatically.
export const QUERY_VERSION = 3;

const bboxString = ({ south, west, north, east }) => [south, west, north, east].map((v) => v.toFixed(6)).join(",");

// Geography without buildings: one request for the whole map rectangle.
export function buildOverpassQuery(place) {
  // Paths and service roads are unreadable on a wide city sheet and make
  // the query far heavier, so they are only requested for compact maps.
  const minorRoads = place.radiusMeters <= 2000 ? "|service|footway|path|cycleway|track" : "";
  return `[out:json][timeout:180][bbox:${bboxString(fetchBbox(place))}];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|pedestrian${minorRoads})(_link)?$"];
  way["railway"~"^(rail|light_rail|tram|narrow_gauge)$"];
  way["waterway"];
  nwr["natural"="water"];
  nwr["water"];
  nwr["waterway"="riverbank"];
  nwr["natural"~"^(wood|scrub|heath|grassland|wetland|beach|sand|bare_rock|scree|glacier)$"];
  nwr["landuse"~"^(forest|grass|meadow|recreation_ground|village_green|farmland|orchard|vineyard|allotments|cemetery|residential|commercial|retail|industrial|railway)$"];
  nwr["leisure"~"^(park|garden|pitch|golf_course|nature_reserve|playground)$"];
  nwr["amenity"="grave_yard"];
);
out geom qt;`;
}

// Buildings are the bulk of the data, so big maps fetch them in tiles that
// each stay well inside public Overpass limits.
export function buildingQueries(place) {
  const box = fetchBbox(place);
  const n = Math.max(1, Math.ceil(place.radiusMeters / 1500));
  const queries = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const tile = {
        south: box.south + (box.north - box.south) * i / n,
        north: box.south + (box.north - box.south) * (i + 1) / n,
        west: box.west + (box.east - box.west) * j / n,
        east: box.west + (box.east - box.west) * (j + 1) / n
      };
      queries.push(`[out:json][timeout:180][bbox:${bboxString(tile)}];(way["building"];relation["building"];);out geom qt;`);
    }
  }
  return queries;
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function runQuery(query) {
  const errors = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const endpoint of ENDPOINTS) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            "User-Agent": "travel-atlas/1.0 (personal illustrated maps)"
          },
          body: new URLSearchParams({ data: query }),
          signal: AbortSignal.timeout(240000)
        });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const data = await response.json();
        if (!Array.isArray(data.elements)) throw new Error("Overpass response has no elements array.");
        return data.elements;
      } catch (error) {
        errors.push(`${endpoint}: ${error.message}`);
      }
    }
    await wait(15000 * (attempt + 1));
  }
  throw new Error(`Could not fetch OSM data. ${errors.join("; ")}`);
}

export function cachePath(placeId) {
  return resolve(ROOT, "cache", "osm", `${placeId}.json`);
}

export async function readCachedOsm(placeId) {
  try {
    return JSON.parse(await readFile(cachePath(placeId), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function fetchOsm(place, { refresh = false } = {}) {
  if (!refresh) {
    const cached = await readCachedOsm(place.id);
    const sameExtent = cached?.queryVersion === QUERY_VERSION &&
      cached?.place?.format === place.format &&
      cached?.place?.radiusMeters === place.radiusMeters &&
      cached?.place?.center?.lat === place.center.lat &&
      cached?.place?.center?.lon === place.center.lon;
    if (cached && sameExtent) return { payload: cached, cacheHit: true, durationMs: 0 };
  }

  const started = performance.now();
  const seen = new Set();
  const elements = [];
  for (const query of [buildOverpassQuery(place), ...buildingQueries(place)]) {
    for (const element of await runQuery(query)) {
      const key = `${element.type}${element.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      elements.push(element);
    }
  }
  const payload = {
    fetchedAt: new Date().toISOString(),
    queryVersion: QUERY_VERSION,
    place: { id: place.id, format: place.format, center: place.center, radiusMeters: place.radiusMeters },
    elements
  };
  const path = cachePath(place.id);
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload)}
`);
  return { payload, cacheHit: false, durationMs: performance.now() - started };
}

export function summarizeOsm(payload) {
  const summary = { elements: payload.elements.length, roads: 0, rail: 0, water: 0, buildings: 0 };
  for (const element of payload.elements) {
    const tags = element.tags ?? {};
    if (tags.highway) summary.roads++;
    if (tags.railway) summary.rail++;
    if (tags.waterway || tags.natural === "water" || tags.water) summary.water++;
    if (tags.building) summary.buildings++;
  }
  return summary;
}
