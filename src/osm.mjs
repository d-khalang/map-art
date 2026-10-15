import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { ROOT } from "./config.mjs";
import { fetchBbox } from "./geo.mjs";

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter"
];

// Client-side cap per request. Overpass only sends headers once the query is
// done, so this must outlast the server-side [timeout:...] in the queries.
const REQUEST_TIMEOUT_MS = 150000;
const ROUNDS = 2;

// Endpoints that failed this run are tried last for the following queries.
const endpointOrder = [...ENDPOINTS];
const demote = (endpoint) => {
  endpointOrder.splice(endpointOrder.indexOf(endpoint), 1);
  endpointOrder.push(endpoint);
};

const log = (message) => console.error(`[osm] ${message}`);
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

// Bump when the query changes so stale caches are refetched automatically.
export const QUERY_VERSION = 3;

const bboxString = ({ south, west, north, east }) => [south, west, north, east].map((v) => v.toFixed(6)).join(",");

// Geography without buildings: one request for the whole map rectangle.
export function buildOverpassQuery(place) {
  // Paths and service roads are unreadable on a wide city sheet and make
  // the query far heavier, so they are only requested for compact maps.
  const minorRoads = place.radiusMeters <= 2000 ? "|service|footway|path|cycleway|track" : "";
  return `[out:json][timeout:120][bbox:${bboxString(fetchBbox(place))}];
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
      queries.push(`[out:json][timeout:120][bbox:${bboxString(tile)}];(way["building"];relation["building"];);out geom qt;`);
    }
  }
  return queries;
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function runQuery(query, label) {
  const errors = [];
  for (let round = 0; round < ROUNDS; round++) {
    for (const endpoint of [...endpointOrder]) {
      const host = new URL(endpoint).host;
      const started = performance.now();
      log(`${label}: requesting ${host}...`);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            "User-Agent": "travel-atlas/1.0 (personal illustrated maps)"
          },
          body: new URLSearchParams({ data: query }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const data = await response.json();
        if (!Array.isArray(data.elements)) throw new Error("Overpass response has no elements array.");
        // Overpass reports its own timeouts/out-of-memory as a 200 with a remark.
        if (data.remark && /error|timed out|out of memory/i.test(data.remark)) throw new Error(data.remark);
        log(`${label}: ${data.elements.length} elements from ${host} in ${seconds(performance.now() - started)}`);
        return data.elements;
      } catch (error) {
        const reason = error.name === "TimeoutError" ? `no response after ${seconds(REQUEST_TIMEOUT_MS)}` : error.message;
        log(`${label}: ${host} failed after ${seconds(performance.now() - started)} (${reason})`);
        errors.push(`${host}: ${reason}`);
        demote(endpoint);
      }
    }
    if (round < ROUNDS - 1) {
      log(`${label}: all endpoints failed, retrying in 20s...`);
      await wait(20000);
    }
  }
  throw new Error(`Could not fetch OSM data (${label}). Finished queries are kept and reused on the next run. ${errors.join("; ")}`);
}

// Each finished query is saved, so a run that dies halfway resumes from there.
const partsDir = (placeId) => resolve(ROOT, "cache", "osm", "parts", placeId);
const partPath = (placeId, query) => resolve(partsDir(placeId), `${createHash("sha1").update(query).digest("hex").slice(0, 16)}.json`);

async function runQueryCached(placeId, query, label) {
  const path = partPath(placeId, query);
  try {
    const elements = JSON.parse(await readFile(path, "utf8"));
    log(`${label}: reusing ${elements.length} elements from an earlier partial run`);
    return elements;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const elements = await runQuery(query, label);
  await mkdir(partsDir(placeId), { recursive: true });
  await writeFile(path, JSON.stringify(elements));
  return elements;
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
  const buildings = buildingQueries(place);
  const queries = [
    { label: "geography", query: buildOverpassQuery(place) },
    ...buildings.map((query, i) => ({ label: `buildings ${i + 1}/${buildings.length}`, query }))
  ];
  log(`${place.id}: fetching ${queries.length} queries`);
  for (const { label, query } of queries) {
    for (const element of await runQueryCached(place.id, query, label)) {
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
  await rm(partsDir(place.id), { recursive: true, force: true });
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
