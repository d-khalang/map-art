import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { ROOT } from "./config.mjs";

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];

export function buildOverpassQuery(place) {
  const { lat, lon } = place.center;
  const r = place.radiusMeters;
  const buildingClause = place.includeBuildings
    ? `way(around:${r},${lat},${lon})["building"];`
    : "";
  return `[out:json][timeout:120];
(
  way(around:${r},${lat},${lon})["highway"~"motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|pedestrian"];
  way(around:${r},${lat},${lon})["railway"~"rail|light_rail|tram"];
  way(around:${r},${lat},${lon})["waterway"];
  way(around:${r},${lat},${lon})["natural"="water"];
  way(around:${r},${lat},${lon})["water"];
  way(around:${r},${lat},${lon})["leisure"="park"];
  way(around:${r},${lat},${lon})["landuse"~"forest|grass|meadow|recreation_ground"];
  way(around:${r},${lat},${lon})["natural"~"wood|scrub|heath"];
  ${buildingClause}
);
out tags center geom;`;
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
    const sameExtent = cached?.place?.radiusMeters === place.radiusMeters &&
      cached?.place?.center?.lat === place.center.lat &&
      cached?.place?.center?.lon === place.center.lon;
    if (cached && sameExtent) return { payload: cached, cacheHit: true, durationMs: 0 };
  }

  const query = buildOverpassQuery(place);
  let lastError;
  const started = performance.now();
  for (const endpoint of ENDPOINTS) {
    try {
      const body = new URLSearchParams({ data: query });
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "User-Agent": "travel-atlas-experiment/0.1 (personal cartography prototype)"
        },
        body,
        signal: AbortSignal.timeout(150000)
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const data = await response.json();
      if (!Array.isArray(data.elements)) throw new Error("Overpass response has no elements array.");
      const payload = {
        fetchedAt: new Date().toISOString(),
        source: endpoint,
        place: { id: place.id, center: place.center, radiusMeters: place.radiusMeters },
        elements: data.elements
      };
      const path = cachePath(place.id);
      await mkdir(resolve(path, ".."), { recursive: true });
      await writeFile(path, `${JSON.stringify(payload)}\n`);
      return { payload, cacheHit: false, durationMs: performance.now() - started };
    } catch (error) {
      lastError = new Error(`${endpoint}: ${error.message}`);
    }
  }
  throw new Error(`Could not fetch OSM data. ${lastError?.message ?? "Unknown Overpass error."}`);
}

export function summarizeOsm(payload) {
  const summary = { elements: payload.elements.length, roads: 0, rail: 0, water: 0, green: 0, buildings: 0, pois: 0 };
  for (const element of payload.elements) {
    const tags = element.tags ?? {};
    if (tags.highway) summary.roads++;
    if (tags.railway) summary.rail++;
    if (tags.waterway || tags.natural === "water" || tags.water) summary.water++;
    if (
      tags.leisure === "park" ||
      ["forest", "grass", "meadow", "recreation_ground"].includes(tags.landuse) ||
      ["wood", "scrub", "heath"].includes(tags.natural)
    ) summary.green++;
    if (tags.building) summary.buildings++;
    if (tags.historic || tags.tourism) summary.pois++;
  }
  return summary;
}
