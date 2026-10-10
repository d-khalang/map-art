import { assembleRings, bounds, cardLayout, clipLine, clipRing, makeProjection, rectsOverlap, thin } from "./geo.mjs";

const ROAD_KIND = {
  motorway: "motorway", motorway_link: "motorway", trunk: "motorway", trunk_link: "motorway",
  primary: "primary", primary_link: "primary",
  secondary: "secondary", secondary_link: "secondary", tertiary: "secondary", tertiary_link: "secondary",
  residential: "local", unclassified: "local", living_street: "local", pedestrian: "local",
  service: "service",
  footway: "path", path: "path", cycleway: "path", track: "path"
};

export const ROAD_ORDER = ["path", "service", "local", "secondary", "primary", "motorway"];

function landKind(tags) {
  if (tags.landuse === "forest" || tags.natural === "wood") return "forest";
  if (tags.natural === "scrub" || tags.natural === "heath") return "scrub";
  if (tags.leisure === "park" || tags.leisure === "garden" || tags.leisure === "nature_reserve" || tags.leisure === "playground") return "park";
  if (tags.leisure === "golf_course" || tags.leisure === "pitch") return "pitch";
  if (["grass", "meadow", "recreation_ground", "village_green"].includes(tags.landuse) || tags.natural === "grassland") return "grass";
  if (tags.landuse === "farmland") return "farmland";
  if (["orchard", "vineyard"].includes(tags.landuse)) return "orchard";
  if (tags.landuse === "allotments") return "allotments";
  if (tags.landuse === "cemetery" || tags.amenity === "grave_yard") return "cemetery";
  if (tags.landuse === "residential") return "residential";
  if (["commercial", "retail"].includes(tags.landuse)) return "commercial";
  if (["industrial", "railway"].includes(tags.landuse)) return "industrial";
  if (["beach", "sand"].includes(tags.natural)) return "sand";
  if (tags.natural === "wetland") return "wetland";
  if (["bare_rock", "scree", "glacier"].includes(tags.natural)) return "rock";
  return null;
}

function isWaterArea(tags) {
  return tags.natural === "water" || tags.waterway === "riverbank" || (tags.water && tags.natural !== "wetland") ||
    (tags.waterway === "dock");
}

function levels(tags) {
  const n = Number.parseFloat(tags["building:levels"]);
  if (Number.isFinite(n) && n > 0) return Math.min(n, 40);
  const h = Number.parseFloat(tags.height);
  if (Number.isFinite(h) && h > 0) return Math.min(h / 3.2, 40);
  if (["church", "cathedral"].includes(tags.building)) return 5;
  if (["garage", "garages", "shed", "hut", "carport", "roof"].includes(tags.building)) return 1;
  return null;
}

// Converts an Overpass payload into projected, render-ready layers.
// Everything downstream works in card units, so geography is fixed here once.
export function buildFeatures(place, payload) {
  const layout = cardLayout(place);
  const { project, unitsPerMeter } = makeProjection(place);
  const view = { minX: layout.map.x, minY: layout.map.y, maxX: layout.map.x + layout.map.width, maxY: layout.map.y + layout.map.height };
  const tolerance = 0.6;
  // Geometry is clipped to the map plus a margin wider than any stroke.
  const pad = 60;
  const clipRect = { minX: view.minX - pad, minY: view.minY - pad, maxX: view.maxX + pad, maxY: view.maxY + pad };
  const clipRings = (rings) => rings.map((r) => clipRing(r, clipRect)).filter(Boolean);

  const land = [];
  const water = [];
  const waterways = [];
  const buildings = [];
  const roads = [];
  const rail = [];

  const projectLine = (geometry) => thin(geometry.filter(Boolean).map(project), tolerance);
  const visible = (rings) => {
    if (!rings.length) return null;
    const box = bounds(rings);
    return rectsOverlap(box, view) ? box : null;
  };

  for (const element of payload.elements) {
    const tags = element.tags ?? {};
    let rings = null;
    if (element.type === "relation") {
      if (!Array.isArray(element.members)) continue;
      const assembled = assembleRings(element.members);
      if (!assembled.outer.length) continue;
      rings = [...assembled.outer, ...assembled.inner].map(projectLine);
    } else if (element.type === "way" && Array.isArray(element.geometry)) {
      const g = element.geometry;
      const closed = g.length > 3 && g[0] && g.at(-1) && g[0].lat === g.at(-1).lat && g[0].lon === g.at(-1).lon;
      if (closed) rings = [projectLine(g)];
      const line = projectLine(g);
      const box = visible([line]);
      if (!box) continue;

      if (tags.highway && ROAD_KIND[tags.highway] && !(closed && tags.area === "yes")) {
        for (const points of clipLine(line, clipRect)) roads.push({ kind: ROAD_KIND[tags.highway], points, bridge: tags.bridge && tags.bridge !== "no", tunnel: tags.tunnel && tags.tunnel !== "no", name: tags.name });
        continue;
      }
      if (tags.railway) {
        for (const points of clipLine(line, clipRect)) rail.push({ kind: tags.railway, points, bridge: tags.bridge && tags.bridge !== "no", tunnel: tags.tunnel && tags.tunnel !== "no" });
        continue;
      }
      if (tags.waterway && !isWaterArea(tags) && !closed) {
        const kind = tags.waterway === "river" ? "river" : tags.waterway === "canal" ? "canal" : ["ditch", "drain"].includes(tags.waterway) ? "ditch" : "stream";
        if (!(tags.tunnel && tags.tunnel !== "no")) for (const points of clipLine(line, clipRect)) waterways.push({ kind, points, name: tags.name });
        continue;
      }
    }
    if (!rings) continue;
    rings = clipRings(rings);
    const box = visible(rings);
    if (!box) continue;
    const id = `${element.type[0]}${element.id}`;
    if (isWaterArea(tags)) water.push({ id, rings, box });
    else if (tags.building) buildings.push({ id, rings, box, levels: levels(tags), type: tags.building });
    else {
      const kind = landKind(tags);
      if (kind) land.push({ id, kind, rings, box });
    }
  }

  // Big areas first so small parks sit on top of residential blocks.
  const area = (f) => (f.box.maxX - f.box.minX) * (f.box.maxY - f.box.minY);
  land.sort((a, b) => area(b) - area(a));
  roads.sort((a, b) => ROAD_ORDER.indexOf(a.kind) - ROAD_ORDER.indexOf(b.kind));
  // Back-to-front for any style that draws height.
  buildings.sort((a, b) => a.box.maxY - b.box.maxY);

  return { layout, project, unitsPerMeter, view, land, water, waterways, buildings, roads, rail };
}
