import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { resolveProjectPath, visitState } from "./config.mjs";
import { UNITS_PER_MM, hashString, insideRings, pathData, rectsOverlap, ringsPath, seededRandom } from "./geo.mjs";
import { ROAD_ORDER, buildFeatures } from "./features.mjs";

// Procedural illustrated renderer. Every mark is drawn from projected OSM
// geometry, so the illustration cannot drift away from the real map.

const mm = (value) => value * UNITS_PER_MM;
const f1 = (n) => n.toFixed(1);

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function pick(list, key) {
  return Array.isArray(list) ? list[hashString(key) % list.length] : list;
}

function circle(x, y, r) {
  return `M${f1(x - r)},${f1(y)}a${f1(r)},${f1(r)} 0 1,0 ${f1(r * 2)},0a${f1(r)},${f1(r)} 0 1,0 ${f1(-r * 2)},0Z`;
}

function ellipse(x, y, rx, ry) {
  return `M${f1(x - rx)},${f1(y)}a${f1(rx)},${f1(ry)} 0 1,0 ${f1(rx * 2)},0a${f1(rx)},${f1(ry)} 0 1,0 ${f1(-rx * 2)},0Z`;
}

// Line weights are given in mm for a ~25 m/mm town map; wider city sheets
// scale them down so streets stay legible instead of merging.
function lineScale(scene) {
  const metresPerMm = UNITS_PER_MM / scene.unitsPerMeter;
  return Math.min(1.15, Math.max(0.55, Math.sqrt(25 / metresPerMm)));
}

// resvg needs absolute filter regions: relative ones crash on large paths.
function defs(style, scene) {
  const p = style.palette;
  const { map, width, height } = scene.layout;
  const whole = `filterUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}"`;
  const mapRegion = `filterUnits="userSpaceOnUse" x="${map.x}" y="${map.y}" width="${map.width}" height="${map.height}"`;
  const hatch = [0, 45, 90, 135].map((angle) => `<pattern id="hatch-${angle}" patternUnits="userSpaceOnUse" width="7" height="7" patternTransform="rotate(${angle})">
      <path d="M0,0 L0,7" stroke="${p.fieldLine}" stroke-opacity="${style.fields.lineOpacity}" stroke-width="2.2" />
    </pattern>`).join("");
  return `<defs>
    <clipPath id="map-clip"><rect x="${map.x}" y="${map.y}" width="${map.width}" height="${map.height}" rx="${mm(style.frame.radiusMm)}" /></clipPath>
    ${hatch}
    <filter id="wash" ${mapRegion}>
      <feTurbulence type="fractalNoise" baseFrequency="0.03" numOctaves="3" seed="11" result="noise" />
      <feDisplacementMap in="SourceGraphic" in2="noise" scale="${style.texture.watercolor}" xChannelSelector="R" yChannelSelector="G" />
    </filter>
    <filter id="soft" ${whole}><feGaussianBlur stdDeviation="${style.texture.shadowBlur}" /></filter>
    <filter id="grain" ${whole}>
      <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="4" result="n" />
      <feColorMatrix in="n" type="matrix" values="0 0 0 0 0.25  0 0 0 0 0.2  0 0 0 0 0.12  1.6 0 0 0 -0.78" />
    </filter>
    <filter id="mottle" ${mapRegion}>
      <feTurbulence type="fractalNoise" baseFrequency="0.012" numOctaves="4" seed="9" result="n" />
      <feColorMatrix in="n" type="matrix" values="0 0 0 0 0.45  0 0 0 0 0.3  0 0 0 0 0.15  0 0 1.4 0 -0.62" />
    </filter>
    <filter id="sticker" ${whole}>
      <feMorphology in="SourceAlpha" operator="dilate" radius="${style.stickers.edge}" result="grown" />
      <feFlood flood-color="${p.stickerEdge}" />
      <feComposite in2="grown" operator="in" result="edge" />
      <feOffset in="grown" dx="1.5" dy="2" result="drop" />
      <feColorMatrix in="drop" type="matrix" values="0 0 0 0 0.2  0 0 0 0 0.15  0 0 0 0 0.1  0 0 0 0.3 0" result="dropSoft" />
      <feMerge><feMergeNode in="dropSoft" /><feMergeNode in="edge" /><feMergeNode in="SourceGraphic" /></feMerge>
    </filter>
    <radialGradient id="light" cx="0.25" cy="0.2" r="0.95">
      <stop offset="0" stop-color="#FFF6D8" stop-opacity="${style.texture.light}" />
      <stop offset="0.6" stop-color="#FFF6D8" stop-opacity="0" />
      <stop offset="1" stop-color="#3A2A10" stop-opacity="${style.texture.vignette}" />
    </radialGradient>
  </defs>`;
}

function landLayer(scene, style) {
  const p = style.palette;
  let fills = "";
  let hatches = "";
  for (const feature of scene.land) {
    const colour = feature.kind === "farmland" ? pick(p.farmland, feature.id) : p[feature.kind];
    if (!colour) continue;
    const d = ringsPath(feature.rings);
    fills += `<path d="${d}" fill="${colour}" fill-rule="evenodd" />`;
    if (feature.kind === "farmland") hatches += `<path d="${d}" fill="url(#hatch-${[0, 45, 90, 135][hashString(feature.id) % 4]})" fill-rule="evenodd" />`;
  }
  return `<g class="land" filter="url(#wash)">${fills}${hatches}</g>`;
}

function waterLayer(scene, style, ls) {
  const p = style.palette;
  const edge = mm(style.lines.waterEdgeMm) * ls;
  const widths = style.lines.waterwaysMm;
  const areas = scene.water.map((f) => ringsPath(f.rings)).join("");
  const lines = (stroke, extra) => scene.waterways.map((w) => {
    const width = mm(widths[w.kind] ?? widths.stream) * ls + extra;
    return `<path d="${pathData(w.points)}" fill="none" stroke="${stroke}" stroke-width="${f1(width)}" stroke-linecap="round" stroke-linejoin="round" />`;
  }).join("");
  // Edge first, fill second: the outline then follows the union of all
  // water so rivers and their banks merge cleanly.
  let svg = `<g class="water">
    <g class="water-edge">${areas ? `<path d="${areas}" fill="${p.waterEdge}" stroke="${p.waterEdge}" stroke-width="${f1(edge * 2)}" stroke-linejoin="round" fill-rule="evenodd" />` : ""}${lines(p.waterEdge, edge * 2)}</g>
    <g class="water-fill">${areas ? `<path d="${areas}" fill="${p.water}" fill-rule="evenodd" />` : ""}${lines(p.water, 0)}</g>`;
  if (areas) {
    // A blurred light band inside the shore gives the painted-water glow.
    const band = mm(style.lines.shoreMm) * ls;
    svg += `<clipPath id="water-shape"><path d="${areas}" fill-rule="evenodd" /></clipPath>
      <g clip-path="url(#water-shape)"><path d="${areas}" fill="none" stroke="${p.waterShore}" stroke-width="${f1(band * 2)}" stroke-linejoin="round" filter="url(#soft)" /></g>`;
  }
  return `${svg}</g>`;
}

// Scatters trees on a jittered grid inside wooded areas, skipping water
// and buildings, so vegetation only ever appears where OSM says it is.
function scatterTrees(scene, style, ls) {
  const spec = style.trees;
  const blockers = [...scene.water, ...scene.buildings];
  const v = scene.view;
  const trees = [];
  for (const feature of scene.land) {
    const density = spec.density[feature.kind];
    if (!density) continue;
    const spacing = mm(spec.spacingMm) * Math.max(ls, 0.75) / Math.sqrt(density);
    const rnd = seededRandom(feature.id);
    const box = feature.box;
    const minX = Math.max(box.minX, v.minX), maxX = Math.min(box.maxX, v.maxX);
    const minY = Math.max(box.minY, v.minY), maxY = Math.min(box.maxY, v.maxY);
    if (minX >= maxX || minY >= maxY) continue;
    const nearby = blockers.filter((b) => rectsOverlap(b.box, { minX, minY, maxX, maxY }));
    const jitter = feature.kind === "orchard" ? 0.08 : spec.jitter;
    for (let y = minY + spacing / 2; y < maxY; y += spacing) {
      for (let x = minX + spacing / 2; x < maxX; x += spacing) {
        const point = { x: x + (rnd() - 0.5) * spacing * jitter, y: y + (rnd() - 0.5) * spacing * jitter };
        const size = mm(spec.sizeMm) * Math.max(ls, 0.7) * (0.8 + rnd() * 0.4) * (feature.kind === "scrub" ? 0.65 : 1);
        if (!insideRings(point, feature.rings)) continue;
        if (nearby.some((b) => point.x >= b.box.minX - size && point.x <= b.box.maxX + size && point.y >= b.box.minY - size && point.y <= b.box.maxY + size && insideRings(point, b.rings))) continue;
        trees.push({ ...point, r: size / 2, tone: rnd() });
      }
    }
  }
  return trees.sort((a, b) => a.y - b.y);
}

// Standing trees: the trunk foot sits on the true position, the painted
// crown is lifted above it, and a soft shadow falls on the ground.
function treeLayer(trees, style) {
  if (!trees.length) return "";
  const p = style.palette;
  let shadows = "";
  let crowns = "";
  for (const t of trees) {
    const g = p.trees[Math.floor(t.tone * p.trees.length)];
    const cy = t.y - t.r * 1.15;
    shadows += ellipse(t.x + t.r * 0.9, t.y, t.r * 1.1, t.r * 0.45);
    crowns += `<path d="M${f1(t.x)},${f1(t.y)}L${f1(t.x)},${f1(cy)}" stroke="${p.trunk}" stroke-width="${f1(t.r * 0.35)}" stroke-linecap="round" />`
      + `<path d="${circle(t.x, cy, t.r)}" fill="${p.treeShade}" />`
      + `<path d="${circle(t.x - t.r * 0.16, cy - t.r * 0.18, t.r * 0.8)}" fill="${g}" />`
      + `<path d="${circle(t.x - t.r * 0.36, cy - t.r * 0.4, t.r * 0.36)}" fill="${p.treeLight}" fill-opacity="0.85" />`;
  }
  return `<g class="trees"><path d="${shadows}" fill="${p.shadow}" fill-opacity="${style.trees.shadowOpacity}" filter="url(#soft)" />${crowns}</g>`;
}

function roadLayer(scene, style, ls) {
  const p = style.palette;
  const widths = style.lines.roadsMm;
  const casing = mm(style.lines.casingMm) * ls;
  const visible = scene.roads.filter((r) => !r.tunnel && widths[r.kind] > 0);
  const fillFor = (kind) => kind === "motorway" ? p.roadMotorway : kind === "primary" || kind === "secondary" ? p.roadMajor : p.road;
  const width = (kind) => mm(widths[kind]) * ls;
  const dashed = (d, w) => `<path d="${d}" fill="none" stroke="${p.path}" stroke-width="${f1(w)}" stroke-dasharray="${f1(w * 3)} ${f1(w * 2.5)}" stroke-linecap="round" stroke-opacity="0.75" />`;
  let casings = "";
  let fills = "";
  for (const kind of ROAD_ORDER) {
    const group = visible.filter((r) => r.kind === kind && !r.bridge);
    if (!group.length) continue;
    const d = group.map((r) => pathData(r.points)).join("");
    if (kind === "path") { fills += dashed(d, width(kind)); continue; }
    casings += `<path d="${d}" fill="none" stroke="${p.roadCasing}" stroke-width="${f1(width(kind) + casing * 2)}" stroke-linecap="round" stroke-linejoin="round" />`;
    fills += `<path d="${d}" fill="none" stroke="${fillFor(kind)}" stroke-width="${f1(width(kind))}" stroke-linecap="round" stroke-linejoin="round" />`;
  }
  // Bridges are redrawn on top with butt caps so they read as crossing.
  const bridges = visible.filter((r) => r.bridge).map((r) => {
    const d = pathData(r.points);
    if (r.kind === "path") return dashed(d, width("path") * 1.6);
    return `<path d="${d}" fill="none" stroke="${p.roadCasing}" stroke-width="${f1(width(r.kind) + casing * 3.5)}" stroke-linejoin="round" />
      <path d="${d}" fill="none" stroke="${fillFor(r.kind)}" stroke-width="${f1(width(r.kind))}" stroke-linejoin="round" />`;
  }).join("");
  return `<g class="roads">${casings}${fills}${bridges}</g>`;
}

function railLayer(scene, style, ls) {
  const p = style.palette;
  const w = mm(style.lines.railMm) * ls;
  const d = scene.rail.filter((r) => !r.tunnel && r.kind !== "tram").map((r) => pathData(r.points)).join("");
  const td = scene.rail.filter((r) => !r.tunnel && r.kind === "tram").map((r) => pathData(r.points)).join("");
  return `<g class="rail">
    ${d ? `<path d="${d}" fill="none" stroke="${p.rail}" stroke-width="${f1(w)}" stroke-linejoin="round" />
    <path d="${d}" fill="none" stroke="${p.railTie}" stroke-width="${f1(w * 0.45)}" stroke-dasharray="${f1(w * 1.4)} ${f1(w * 1.4)}" stroke-linejoin="round" />` : ""}
    ${td ? `<path d="${td}" fill="none" stroke="${p.rail}" stroke-width="${f1(w * 0.3)}" stroke-opacity="0.7" />` : ""}
  </g>`;
}

function buildingLayer(scene, style, ls) {
  if (!scene.buildings.length) return "";
  const p = style.palette;
  const spec = style.buildings;
  const byColour = new Map();
  for (const b of scene.buildings) {
    const colour = pick(p.roof, b.id);
    byColour.set(colour, (byColour.get(colour) ?? "") + ringsPath(b.rings));
  }
  const all = scene.buildings.map((b) => ringsPath(b.rings)).join("");
  const offset = mm(spec.shadowMm) * ls;
  const shadow = `<path d="${all}" fill="${p.shadow}" fill-opacity="${spec.shadowOpacity}" fill-rule="evenodd" transform="translate(${f1(offset)} ${f1(offset)})" filter="url(#soft)" />`;
  const fills = [...byColour].map(([colour, d]) => `<path d="${d}" fill="${colour}" fill-rule="evenodd" stroke="${p.buildingInk}" stroke-width="${f1(mm(spec.inkMm) * ls)}" stroke-linejoin="round" />`).join("");
  return `<g class="buildings">${shadow}${fills}</g>`;
}

async function asset(path) {
  const file = resolveProjectPath(path);
  const data = await readFile(file);
  const ext = extname(file).toLowerCase();
  const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
  return `data:${mime};base64,${data.toString("base64")}`;
}

function haloText(x, y, text, style, size) {
  const p = style.palette;
  const font = style.fonts;
  return `<text x="${f1(x)}" y="${f1(y + size * 0.36)}" text-anchor="middle" font-family="${font.label}" font-weight="${font.labelWeight}" font-size="${f1(size)}" fill="${p.ink}" paint-order="stroke" stroke="${p.labelBg}" stroke-width="${f1(size * 0.32)}" stroke-linejoin="round">${xml(text)}</text>`;
}

// Landmark stickers: the art may be nudged with artDxMm/artDyMm, but the
// dot always marks the true coordinate.
async function landmarkLayer(place, scene, style) {
  const p = style.palette;
  const s = style.stickers;
  const v = scene.view;
  const size = mm(s.labelMm);
  const out = await Promise.all((place.landmarks ?? []).map(async (lm) => {
    const pt = scene.project(lm);
    if (pt.x < v.minX || pt.x > v.maxX || pt.y < v.minY || pt.y > v.maxY) return "";
    const dot = `<circle cx="${f1(pt.x)}" cy="${f1(pt.y)}" r="${f1(mm(0.3))}" fill="${p.accent}" stroke="${p.labelBg}" stroke-width="${f1(mm(0.08))}" />`;
    if (!lm.art) return `<g class="landmark">${dot}${haloText(pt.x, pt.y + mm(0.9), lm.name, style, size)}</g>`;
    const width = mm(lm.artWidthMm ?? (place.format === "A7" ? s.widthMmA7 : s.widthMmA6));
    const dx = mm(lm.artDxMm ?? 0);
    const dy = mm(lm.artDyMm ?? 0);
    const href = await asset(lm.art);
    const leader = dx || dy ? `<path d="M${f1(pt.x)},${f1(pt.y)}L${f1(pt.x + dx)},${f1(pt.y + dy - mm(0.3))}" stroke="${p.ink}" stroke-width="${f1(mm(0.1))}" stroke-linecap="round" />` : "";
    return `<g class="landmark">${leader}
      <image href="${href}" x="${f1(pt.x - width / 2 + dx)}" y="${f1(pt.y - width + dy)}" width="${f1(width)}" height="${f1(width)}" preserveAspectRatio="xMidYMax meet" filter="url(#sticker)" />
      ${dot}${haloText(pt.x + dx, pt.y + dy + mm(0.9), lm.name, style, size)}</g>`;
  }));
  return out.join("");
}

function furniture(scene, style) {
  const p = style.palette;
  const v = scene.view;
  const font = style.fonts;
  const metresPerMm = UNITS_PER_MM / scene.unitsPerMeter;
  const nice = [100, 200, 250, 500, 1000, 2000, 5000];
  const barMetres = nice.reduce((best, m) => (m / metresPerMm <= 14 ? m : best), nice[0]);
  const barW = barMetres * scene.unitsPerMeter;
  const sx = v.minX + mm(3);
  const sy = v.maxY - mm(2.5);
  const t = mm(0.5);
  const label = barMetres >= 1000 ? `${barMetres / 1000} km` : `${barMetres} m`;
  const cx = v.maxX - mm(4.2);
  const cy = v.minY + mm(4.4);
  const r = mm(2.4);
  return `<g class="furniture">
    <g class="scale-bar">
      <rect x="${f1(sx - mm(1))}" y="${f1(sy - mm(3.6))}" width="${f1(barW + mm(2))}" height="${f1(mm(4.6))}" rx="${f1(mm(0.9))}" fill="${p.labelBg}" fill-opacity="0.85" stroke="${p.ink}" stroke-width="${f1(mm(0.1))}" />
      <rect x="${f1(sx)}" y="${f1(sy - t)}" width="${f1(barW / 2)}" height="${f1(t)}" fill="${p.ink}" />
      <rect x="${f1(sx + barW / 2)}" y="${f1(sy - t)}" width="${f1(barW / 2)}" height="${f1(t)}" fill="${p.labelBg}" stroke="${p.ink}" stroke-width="${f1(mm(0.08))}" />
      <text x="${f1(sx + barW / 2)}" y="${f1(sy - mm(1.3))}" text-anchor="middle" font-family="${font.label}" font-weight="${font.labelWeight}" font-size="${f1(mm(1.3))}" fill="${p.ink}">${label}</text>
    </g>
    <g class="compass" transform="translate(${f1(cx)} ${f1(cy)})">
      <circle r="${f1(r)}" fill="${p.labelBg}" fill-opacity="0.9" stroke="${p.ink}" stroke-width="${f1(mm(0.12))}" />
      <path d="M0,${f1(-r * 0.8)}L${f1(r * 0.32)},0L0,${f1(r * 0.15)}Z" fill="${p.accent}" />
      <path d="M0,${f1(-r * 0.8)}L${f1(-r * 0.32)},0L0,${f1(r * 0.15)}Z" fill="${p.ink}" />
      <text y="${f1(r * 0.78)}" text-anchor="middle" font-family="${font.label}" font-weight="700" font-size="${f1(r * 0.62)}" fill="${p.ink}">N</text>
    </g>
  </g>`;
}

// The two travellers as conceptual stickers, drawn in a 100-unit box.
function sunIcon(p) {
  let rays = "";
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const tip = { x: Math.cos(a) * 47, y: Math.sin(a) * 47 };
    const l = { x: Math.cos(a - 0.2) * 31, y: Math.sin(a - 0.2) * 31 };
    const r = { x: Math.cos(a + 0.2) * 31, y: Math.sin(a + 0.2) * 31 };
    rays += `M${f1(l.x)},${f1(l.y)}L${f1(tip.x)},${f1(tip.y)}L${f1(r.x)},${f1(r.y)}Z`;
  }
  return `<path d="${rays}" fill="${p.sunRay}" stroke="${p.ink}" stroke-width="1.6" stroke-linejoin="round" />
    <path d="${circle(0, 0, 30)}" fill="${p.sun}" stroke="${p.ink}" stroke-width="1.8" />
    <path d="${circle(-9, -10, 10)}" fill="#FFFFFF" fill-opacity="0.4" />
    <path d="M-12,8 Q0,17 12,8" fill="none" stroke="${p.ink}" stroke-width="2.2" stroke-linecap="round" />
    <path d="${circle(-10, -2, 2.6)}${circle(10, -2, 2.6)}" fill="${p.ink}" />`;
}

function moonIcon(p) {
  // Crescent: outer circle minus an offset circle, joined at the two
  // circles' intersection points.
  const R = 38, r = 32, ox = 17, oy = -12;
  const d = Math.hypot(ox, oy);
  const a = (R * R - r * r + d * d) / (2 * d);
  const h = Math.sqrt(R * R - a * a);
  const mx = (a * ox) / d, my = (a * oy) / d;
  const p1 = { x: mx + (h * oy) / d, y: my - (h * ox) / d };
  const p2 = { x: mx - (h * oy) / d, y: my + (h * ox) / d };
  const crescent = `M${f1(p1.x)},${f1(p1.y)}A${R},${R} 0 1,0 ${f1(p2.x)},${f1(p2.y)}A${r},${r} 0 0,1 ${f1(p1.x)},${f1(p1.y)}Z`;
  const star = (x, y, s) => `M${x},${y - s}L${x + s * 0.3},${y - s * 0.3}L${x + s},${y}L${x + s * 0.3},${y + s * 0.3}L${x},${y + s}L${x - s * 0.3},${y + s * 0.3}L${x - s},${y}L${x - s * 0.3},${y - s * 0.3}Z`;
  return `<path d="${crescent}" fill="${p.moon}" stroke="${p.ink}" stroke-width="1.8" stroke-linejoin="round" />
    <path d="${circle(-24, -6, 4.5)}${circle(-14, 18, 3.2)}" fill="${p.moonShade}" />
    <path d="${star(30, 22, 8)}" fill="${p.sun}" stroke="${p.ink}" stroke-width="1.2" stroke-linejoin="round" />`;
}

// Header stickers: sun for "me", moon for "partner". When the city was a
// shared trip the two are joined by a dotted thread with a small heart.
function travellerStickers(place, scene, style) {
  const p = style.palette;
  const { layout } = scene;
  const state = visitState(place.visits);
  if (state === "none") return "";
  const size = mm(place.format === "A7" ? 8 : 10);
  const k = (size / 100).toFixed(4);
  const cy = layout.map.y / 2 + mm(place.format === "A7" ? 0.6 : 1.5);
  const right = layout.width - layout.margin - size / 2;
  // The filter sits on an untransformed wrapper so its region stays in card units.
  const icon = (x, body) => `<g filter="url(#sticker)"><g transform="translate(${f1(x)} ${f1(cy)}) scale(${k})">${body}</g></g>`;
  if (state === "me") return `<g class="travellers">${icon(right, sunIcon(p))}</g>`;
  if (state === "partner") return `<g class="travellers">${icon(right, moonIcon(p))}</g>`;
  const sunX = right - size * (state === "together" ? 1.3 : 1.05);
  let thread = "";
  if (state === "together") {
    const x1 = sunX + size * 0.4;
    const x2 = right - size * 0.4;
    const mid = (x1 + x2) / 2;
    const sag = size * 0.22;
    const hy = cy + sag;
    const hs = size * 0.1;
    thread = `<path d="M${f1(x1)},${f1(cy)}Q${f1(mid)},${f1(cy + sag * 2)} ${f1(x2)},${f1(cy)}" fill="none" stroke="${p.ink}" stroke-width="${f1(mm(0.15))}" stroke-dasharray="${f1(mm(0.4))} ${f1(mm(0.35))}" stroke-linecap="round" />
      <path d="M${f1(mid)},${f1(hy + hs)}C${f1(mid - hs * 1.7)},${f1(hy - hs * 0.1)} ${f1(mid - hs * 0.9)},${f1(hy - hs * 1.4)} ${f1(mid)},${f1(hy - hs * 0.5)}C${f1(mid + hs * 0.9)},${f1(hy - hs * 1.4)} ${f1(mid + hs * 1.7)},${f1(hy - hs * 0.1)} ${f1(mid)},${f1(hy + hs)}Z" fill="${p.accent}" stroke="${p.ink}" stroke-width="${f1(mm(0.08))}" />`;
  }
  return `<g class="travellers">${thread}${icon(sunX, sunIcon(p))}${icon(right, moonIcon(p))}</g>`;
}

function header(place, scene, style) {
  const p = style.palette;
  const font = style.fonts;
  const { layout } = scene;
  const small = place.format === "A7";
  const top = layout.map.y;
  const x = layout.margin;
  const title = `<text x="${x}" y="${f1(top - mm(small ? 5.2 : 8.6))}" font-family="${font.title}" font-weight="${font.titleWeight}" font-size="${f1(mm(small ? 7 : 9.5))}" fill="${p.ink}">${xml(place.name)}</text>`;
  const meta = `<text x="${x}" y="${f1(top - mm(small ? 1.9 : 3.2))}" font-family="${font.label}" font-weight="${font.labelWeight}" font-size="${f1(mm(small ? 1.7 : 2))}" letter-spacing="${f1(mm(0.15))}" fill="${p.muted}">${xml(place.country.toUpperCase())} · ${place.center.lat.toFixed(3)}°N ${place.center.lon.toFixed(3)}°E</text>`;
  return `<g class="header">${title}${meta}${travellerStickers(place, scene, style)}</g>`;
}

function frame(scene, style) {
  const p = style.palette;
  const { map } = scene.layout;
  const radius = mm(style.frame.radiusMm);
  const width = mm(style.frame.inkMm);
  const outer = mm(0.9);
  return `<rect x="${map.x}" y="${map.y}" width="${map.width}" height="${map.height}" rx="${f1(radius)}" fill="none" stroke="${p.ink}" stroke-width="${f1(width)}" />
    <rect x="${f1(map.x - outer)}" y="${f1(map.y - outer)}" width="${f1(map.width + outer * 2)}" height="${f1(map.height + outer * 2)}" rx="${f1(radius + outer)}" fill="none" stroke="${p.ink}" stroke-width="${f1(width * 0.4)}" />`;
}

export async function renderMap(place, style, payload) {
  const scene = buildFeatures(place, payload);
  const { layout } = scene;
  const { map } = layout;
  const p = style.palette;
  const t = style.texture;
  const ls = lineScale(scene);
  const trees = scatterTrees(scene, style, ls);
  const mapRect = `x="${map.x}" y="${map.y}" width="${map.width}" height="${map.height}"`;
  const footer = `<text x="${layout.margin}" y="${f1(layout.height - mm(place.format === "A7" ? 2.6 : 3.2))}" font-family="${style.fonts.label}" font-size="${f1(mm(1.35))}" fill="${p.muted}">© OpenStreetMap contributors · ODbL</text>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.format.widthMm}mm" height="${layout.format.heightMm}mm" viewBox="0 0 ${layout.width} ${layout.height}" role="img" aria-label="${xml(`${place.name} illustrated map`)}">
  ${defs(style, scene)}
  <rect width="${layout.width}" height="${layout.height}" fill="${p.paper}" />
  <g clip-path="url(#map-clip)">
    <rect ${mapRect} fill="${p.land}" />
    ${landLayer(scene, style)}
    ${waterLayer(scene, style, ls)}
    ${roadLayer(scene, style, ls)}
    ${railLayer(scene, style, ls)}
    ${treeLayer(trees, style)}
    ${buildingLayer(scene, style, ls)}
    <rect ${mapRect} filter="url(#mottle)" opacity="${t.mottle}" />
    <rect ${mapRect} fill="url(#light)" />
  </g>
  ${frame(scene, style)}
  ${furniture(scene, style)}
  ${await landmarkLayer(place, scene, style)}
  ${header(place, scene, style)}
  ${footer}
  <rect width="${layout.width}" height="${layout.height}" filter="url(#grain)" opacity="${t.grain}" />
</svg>\n`;
  return { svg, stats: { trees: trees.length, buildings: scene.buildings.length, roads: scene.roads.length, water: scene.water.length + scene.waterways.length, land: scene.land.length } };
}
