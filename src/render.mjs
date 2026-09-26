import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { FORMAT_SPECS, companionState, resolveProjectPath } from "./config.mjs";

const EARTH_RADIUS_M = 6371008.8;
const SCALE = 10;

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function geometryOf(element) {
  if (Array.isArray(element.geometry)) return element.geometry;
  if (Number.isFinite(element.lat) && Number.isFinite(element.lon)) return [{ lat: element.lat, lon: element.lon }];
  if (Number.isFinite(element.center?.lat) && Number.isFinite(element.center?.lon)) return [element.center];
  return [];
}

function roadKind(highway) {
  if (["motorway", "motorway_link", "trunk", "trunk_link"].includes(highway)) return "motorway";
  if (["primary", "primary_link"].includes(highway)) return "primary";
  if (["secondary", "secondary_link", "tertiary", "tertiary_link"].includes(highway)) return "secondary";
  if (["residential", "unclassified", "living_street"].includes(highway)) return "local";
  return "minor";
}

function isClosed(points) {
  if (points.length < 3) return false;
  const a = points[0];
  const b = points.at(-1);
  return Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
}

function pathData(points, close = false) {
  if (points.length < 2) return "";
  return `${points.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}${close ? " Z" : ""}`;
}

function classify(element) {
  const tags = element.tags ?? {};
  if (tags.highway) return { type: "road", kind: roadKind(tags.highway) };
  if (tags.railway) return { type: "rail" };
  if (tags.waterway || tags.natural === "water" || tags.water) {
    const kind = tags.waterway === "river" ? "river" : tags.waterway === "canal" ? "canal" : tags.waterway ? "stream" : "area";
    return { type: "water", kind };
  }
  if (
    tags.leisure === "park" ||
    ["forest", "grass", "meadow", "recreation_ground"].includes(tags.landuse) ||
    ["wood", "scrub", "heath"].includes(tags.natural)
  ) return { type: "green" };
  if (tags.building) return { type: "building" };
  if (tags.historic || tags.tourism) return { type: "poi" };
  return { type: "other" };
}

function buildScene(place, payload) {
  const format = FORMAT_SPECS[place.format];
  const width = format.widthMm * SCALE;
  const height = format.heightMm * SCALE;
  const margin = format.marginMm * SCALE;
  const mapTop = format.headerMm * SCALE;
  const mapBottom = height - format.footerMm * SCALE;
  const mapWidth = width - margin * 2;
  const mapHeight = mapBottom - mapTop - margin;
  const unitsPerMeter = mapWidth / (place.radiusMeters * 2);
  const lat0 = place.center.lat * Math.PI / 180;
  const centerX = width / 2;
  const centerY = mapTop + margin + mapHeight / 2;

  const project = ({ lat, lon }) => ({
    x: centerX + EARTH_RADIUS_M * ((lon - place.center.lon) * Math.PI / 180) * Math.cos(lat0) * unitsPerMeter,
    y: centerY - EARTH_RADIUS_M * ((lat - place.center.lat) * Math.PI / 180) * unitsPerMeter
  });

  const groups = { roads: [], rail: [], water: [], green: [], buildings: [], pois: [] };
  for (const element of payload.elements) {
    const category = classify(element);
    const geometry = geometryOf(element).map(project);
    if (!geometry.length || category.type === "other") continue;
    const feature = { element, geometry, closed: isClosed(geometry), ...category };
    if (category.type === "road") groups.roads.push(feature);
    else if (category.type === "rail") groups.rail.push(feature);
    else if (category.type === "building") groups.buildings.push(feature);
    else if (category.type === "poi") groups.pois.push(feature);
    else groups[category.type].push(feature);
  }
  groups.roads.sort((a, b) => ["minor", "local", "secondary", "primary", "motorway"].indexOf(a.kind) - ["minor", "local", "secondary", "primary", "motorway"].indexOf(b.kind));
  return { format, width, height, margin, mapTop: mapTop + margin, mapBottom, mapWidth, mapHeight, unitsPerMeter, project, groups };
}

function featurePaths(features, attributes, { polygonsOnly = false } = {}) {
  return features.map((feature) => {
    if (polygonsOnly && !feature.closed) return "";
    const d = pathData(feature.geometry, feature.closed && polygonsOnly);
    return d ? `<path d="${d}" ${attributes(feature)} />` : "";
  }).join("");
}

function roadLayer(scene, style, colour, mask = false) {
  const roads = scene.groups.roads.filter((road) => style.detail.showMinorRoads || road.kind !== "minor");
  const roadSvg = featurePaths(roads, (feature) => `fill="none" stroke="${colour}" stroke-width="${mask ? Math.max(5, style.roadWidths[feature.kind] * 2.2) : style.roadWidths[feature.kind]}" stroke-linecap="round" stroke-linejoin="round"`);
  const railSvg = featurePaths(scene.groups.rail, () => `fill="none" stroke="${colour}" stroke-width="${mask ? 5 : style.roadWidths.rail}" stroke-dasharray="${mask ? "none" : "5 4"}" stroke-linecap="round"`);
  return roadSvg + railSvg;
}

function areaLayer(features, fill, opacity = 1) {
  return featurePaths(features, () => `fill="${fill}" fill-opacity="${opacity}" stroke="none"`, { polygonsOnly: true });
}

function waterLayer(scene, style, { mask = false } = {}) {
  const polygons = scene.groups.water.filter((feature) => feature.closed);
  const lines = scene.groups.water.filter((feature) => !feature.closed);
  const polygonLayer = featurePaths(polygons, () => mask
    ? `fill="#FFFFFF" stroke="#FFFFFF" stroke-width="4"`
    : `fill="${style.palette.water}" stroke="${style.palette.ink}" stroke-width="1.2"`, { polygonsOnly: true });
  const lineLayer = lines.map((feature) => {
    const width = style.waterWidths[feature.kind] ?? style.waterWidths.stream;
    const d = pathData(feature.geometry);
    if (!d) return "";
    if (mask) return `<path d="${d}" fill="none" stroke="#FFFFFF" stroke-width="${width + 4}" stroke-linecap="round" stroke-linejoin="round" />`;
    return `<path d="${d}" fill="none" stroke="${style.palette.ink}" stroke-width="${width + 2.4}" stroke-linecap="round" stroke-linejoin="round" />
      <path d="${d}" fill="none" stroke="${style.palette.water}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" />`;
  }).join("");
  return polygonLayer + lineLayer;
}

function visitorMark(place, scene, style) {
  const state = companionState(place.visits);
  if (state.value === "none") return "";
  const x = scene.width - scene.margin - 54;
  const y = 52;
  const circle = `<circle cx="${x}" cy="${y}" r="12" fill="${style.palette.accent}" />`;
  const diamond = `<rect x="${x + 24}" y="${y - 9}" width="18" height="18" rx="2" fill="${style.palette.accent}" transform="rotate(45 ${x + 33} ${y})" />`;
  const link = state.shared ? `<path d="M${x + 11},${y} L${x + 23},${y}" stroke="${style.palette.accent}" stroke-width="4" />` : "";
  if (state.value === "me") return circle;
  if (state.value === "partner") return diamond;
  return link + circle + diamond;
}

async function embeddedIllustration(place, styleId) {
  const illustration = place.illustrations?.[styleId] ?? place.illustration;
  const image = illustration?.image;
  if (!image) return null;
  try {
    const path = resolveProjectPath(image);
    const data = await readFile(path);
    const extension = extname(path).toLowerCase();
    const mime = extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : extension === ".webp" ? "image/webp" : "image/png";
    return { href: `data:${mime};base64,${data.toString("base64")}`, opacity: illustration.opacity ?? 1 };
  } catch (error) {
    throw new Error(`Cannot embed illustration ${image}: ${error.message}`);
  }
}

function annotationLabel(item, index, scene, style, marker, className) {
    const point = scene.project(item);
    const outsideMap = point.x < scene.margin || point.x > scene.margin + scene.mapWidth || point.y < scene.mapTop || point.y > scene.mapBottom;
    if (outsideMap) return "";
    const labelAbove = index % 2 === 0;
    const nearRightEdge = point.x > scene.margin + scene.mapWidth * 0.68;
    const labelDx = item.labelDx ?? (nearRightEdge ? -16 : 16);
    const labelDy = item.labelDy ?? (labelAbove ? -22 : 34);
    const labelX = point.x + labelDx;
    const labelY = Math.min(scene.mapBottom - 10, Math.max(scene.mapTop + 18, point.y + labelDy));
    const anchor = labelDx < 0 ? "end" : "start";
    const fontSize = scene.format.widthMm === 105 && scene.format.heightMm === 74 ? 13 : 15;
    return `<g class="${className}">
      ${marker(point)}
      <text x="${labelX.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="${anchor}" fill="${style.palette.ink}" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="600" paint-order="stroke" stroke="${style.palette.paper}" stroke-width="5">${xml(item.name)}</text>
    </g>`;
}

function landmarks(place, scene, style) {
  return (place.landmarks ?? []).map((landmark, index) => annotationLabel(
    landmark,
    index,
    scene,
    style,
    (point) => `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="9" fill="${style.palette.paper}" stroke="${style.palette.accent}" stroke-width="4" />`,
    "landmark"
  )).join("");
}

function visitedPlaces(place, scene, style) {
  return (place.visitedPlaces ?? []).map((visited, index) => annotationLabel(
    visited,
    (place.landmarks?.length ?? 0) + index,
    scene,
    style,
    (point) => {
      const x = point.x;
      const y = point.y;
      if (visited.by === "me") return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="8" fill="${style.palette.accent}" stroke="${style.palette.paper}" stroke-width="3" />`;
      if (visited.by === "partner") return `<rect x="${(x - 6).toFixed(1)}" y="${(y - 6).toFixed(1)}" width="12" height="12" rx="1.5" fill="${style.palette.accent}" stroke="${style.palette.paper}" stroke-width="3" transform="rotate(45 ${x.toFixed(1)} ${y.toFixed(1)})" />`;
      return `<path d="M${(x - 1).toFixed(1)},${y.toFixed(1)} L${(x + 3).toFixed(1)},${y.toFixed(1)}" stroke="${style.palette.accent}" stroke-width="3" />
        <circle cx="${(x - 7).toFixed(1)}" cy="${y.toFixed(1)}" r="7" fill="${style.palette.accent}" stroke="${style.palette.paper}" stroke-width="2.5" />
        <rect x="${(x + 1).toFixed(1)}" y="${(y - 5).toFixed(1)}" width="10" height="10" rx="1" fill="${style.palette.accent}" stroke="${style.palette.paper}" stroke-width="2.5" transform="rotate(45 ${(x + 6).toFixed(1)} ${y.toFixed(1)})" />`;
    },
    "visited-place"
  )).join("");
}

function mapFurniture(place, scene, style) {
  const p = style.palette;
  const compassX = scene.margin + scene.mapWidth - 26;
  const compassY = scene.mapTop + 30;
  const barMeters = place.radiusMeters <= 1600 ? 500 : place.radiusMeters <= 4000 ? 1000 : 2000;
  const barWidth = barMeters * scene.unitsPerMeter;
  const scaleX = scene.margin + 16;
  const scaleY = scene.mapBottom - 22;
  const scaleLabel = barMeters >= 1000 ? `${barMeters / 1000} km` : `${barMeters} m`;
  return `<g class="map-furniture" font-family="Arial, sans-serif" fill="${p.ink}">
    <g transform="translate(${compassX} ${compassY})">
      <circle r="20" fill="${p.paper}" fill-opacity="0.88" stroke="${p.ink}" stroke-width="1.2" />
      <text x="0" y="-7" text-anchor="middle" font-size="10" font-weight="700">N</text>
      <path d="M0,-4 L-6,11 L0,7 L6,11 Z" fill="${p.accent}" stroke="${p.ink}" stroke-width="1" />
    </g>
    <g transform="translate(${scaleX} ${scaleY})">
      <rect x="-8" y="-25" width="${barWidth + 16}" height="35" rx="4" fill="${p.paper}" fill-opacity="0.88" />
      <text x="${barWidth / 2}" y="-10" text-anchor="middle" font-size="10" font-weight="600">${scaleLabel}</text>
      <path d="M0,0 L${barWidth},0 M0,-5 L0,5 M${barWidth},-5 L${barWidth},5" fill="none" stroke="${p.ink}" stroke-width="2" />
    </g>
  </g>`;
}

function svgShell(scene, body, { background = "transparent", label = "Map" } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${scene.format.widthMm}mm" height="${scene.format.heightMm}mm" viewBox="0 0 ${scene.width} ${scene.height}" role="img" aria-label="${xml(label)}">
  <rect width="${scene.width}" height="${scene.height}" fill="${background}" />
  ${body}
</svg>\n`;
}

export async function renderMap(place, style, payload, { protectedOnly = false } = {}) {
  const scene = buildScene(place, payload);
  const p = style.palette;
  const saturation = style.ai.underlaySaturation ?? 1;
  const clip = `<defs>
    <clipPath id="map-clip"><rect x="${scene.margin}" y="${scene.mapTop}" width="${scene.mapWidth}" height="${scene.mapHeight}" /></clipPath>
    <filter id="art-tone" color-interpolation-filters="sRGB"><feColorMatrix type="saturate" values="${saturation}" /></filter>
  </defs>`;
  const protectedGeometry = `<g clip-path="url(#map-clip)">${waterLayer(scene, style)}${roadLayer(scene, style, p.ink)}</g>`;
  const title = `<text x="${scene.margin}" y="58" fill="${p.ink}" font-family="Georgia, serif" font-size="${place.format === "A7" ? 30 : 40}" font-weight="600" letter-spacing="-1">${xml(place.name.toUpperCase())}</text>`;
  const meta = `<text x="${scene.margin}" y="88" fill="${p.muted}" font-family="Arial, sans-serif" font-size="13" letter-spacing="1.4">${xml(place.country.toUpperCase())} · ${place.center.lat.toFixed(4)}°, ${place.center.lon.toFixed(4)}°</text>`;
  const footerY = scene.height - 25;
  const footer = `<text x="${scene.margin}" y="${footerY}" fill="${p.muted}" font-family="Arial, sans-serif" font-size="11">© OpenStreetMap contributors · ODbL · openstreetmap.org/copyright</text>`;
  const foreground = `${title}${meta}${visitorMark(place, scene, style)}${protectedGeometry}${mapFurniture(place, scene, style)}${landmarks(place, scene, style)}${visitedPlaces(place, scene, style)}${footer}`;
  if (protectedOnly) {
    return { svg: svgShell(scene, clip + foreground, { label: `${place.name} protected map geometry` }), scene };
  }

  const art = await embeddedIllustration(place, style.id);
  const baseAreas = `<g clip-path="url(#map-clip)">
    ${areaLayer(scene.groups.green, p.park)}
    ${style.detail.showBuildings ? areaLayer(scene.groups.buildings, p.building) : ""}
    ${areaLayer(scene.groups.water, p.water)}
    ${art ? `<image href="${art.href}" x="0" y="0" width="${scene.width}" height="${scene.height}" preserveAspectRatio="none" opacity="${art.opacity}" filter="url(#art-tone)" />` : ""}
    ${art ? areaLayer(scene.groups.green, p.park, 0.34) : ""}
    ${art ? areaLayer(scene.groups.water, p.water) : ""}
    ${art ? roadLayer(scene, style, p.paper, true) : ""}
  </g>`;
  return { svg: svgShell(scene, clip + baseAreas + foreground, { background: p.paper, label: `${place.name} ${style.id} travel map` }), scene };
}

export function renderMask(place, style, payload, type) {
  const scene = buildScene(place, payload);
  let content = "";
  if (type === "roads") content = roadLayer(scene, style, "#FFFFFF", true);
  if (type === "water") content = waterLayer(scene, style, { mask: true });
  if (type === "green") content = areaLayer(scene.groups.green, "#FFFFFF");
  const body = `<defs><clipPath id="mask-clip"><rect x="${scene.margin}" y="${scene.mapTop}" width="${scene.mapWidth}" height="${scene.mapHeight}" /></clipPath></defs><g clip-path="url(#mask-clip)">${content}</g>`;
  return svgShell(scene, body, { background: "#000000", label: `${place.name} ${type} mask` });
}

export function renderReference(place, style, payload) {
  const scene = buildScene(place, payload);
  const p = style.palette;
  const body = `<defs><clipPath id="reference-clip"><rect x="${scene.margin}" y="${scene.mapTop}" width="${scene.mapWidth}" height="${scene.mapHeight}" /></clipPath></defs>
  <g clip-path="url(#reference-clip)">
    ${areaLayer(scene.groups.green, p.park)}
    ${areaLayer(scene.groups.buildings, p.building)}
    ${waterLayer(scene, style)}
    ${roadLayer(scene, style, p.ink)}
  </g>`;
  return svgShell(scene, body, { background: p.paper, label: `${place.name} AI illustration reference` });
}
