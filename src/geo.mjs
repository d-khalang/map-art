import { FORMAT_SPECS } from "./config.mjs";

const EARTH_RADIUS_M = 6371008.8;
const DEG = Math.PI / 180;

// SVG user units per printed millimetre. Every renderer shares this so
// physical sizes in style files (mm) stay meaningful.
export const UNITS_PER_MM = 10;

// The printed card layout in user units. The map rectangle is the only
// area that carries geography; header and footer hold typography.
export function cardLayout(place) {
  const f = FORMAT_SPECS[place.format];
  const u = UNITS_PER_MM;
  const width = f.widthMm * u;
  const height = f.heightMm * u;
  const margin = f.marginMm * u;
  const map = {
    x: margin,
    y: f.headerMm * u,
    width: width - margin * 2,
    height: height - f.headerMm * u - f.footerMm * u
  };
  return { format: f, width, height, margin, map };
}

// Half extents of the map rectangle on the ground, in metres.
// radiusMeters is the half-width; the half-height follows the card aspect.
export function groundExtent(place) {
  const { map } = cardLayout(place);
  const halfWidth = place.radiusMeters;
  return { halfWidth, halfHeight: halfWidth * map.height / map.width };
}

// Bounding box (south, west, north, east) that covers the whole map
// rectangle plus a small pad, so corners are never empty.
export function fetchBbox(place, pad = 1.08) {
  const { halfWidth, halfHeight } = groundExtent(place);
  const lat0 = place.center.lat * DEG;
  const dLat = (halfHeight * pad) / EARTH_RADIUS_M / DEG;
  const dLon = (halfWidth * pad) / (EARTH_RADIUS_M * Math.cos(lat0)) / DEG;
  return {
    south: place.center.lat - dLat,
    west: place.center.lon - dLon,
    north: place.center.lat + dLat,
    east: place.center.lon + dLon
  };
}

// Local equirectangular projection centred on the place. At city scale the
// distortion is far below print resolution.
export function makeProjection(place) {
  const { map } = cardLayout(place);
  const unitsPerMeter = map.width / (place.radiusMeters * 2);
  const lat0 = place.center.lat * DEG;
  const cx = map.x + map.width / 2;
  const cy = map.y + map.height / 2;
  const project = ({ lat, lon }) => ({
    x: cx + EARTH_RADIUS_M * (lon - place.center.lon) * DEG * Math.cos(lat0) * unitsPerMeter,
    y: cy - EARTH_RADIUS_M * (lat - place.center.lat) * DEG * unitsPerMeter
  });
  return { project, unitsPerMeter };
}

const samePoint = (a, b) => a.lat === b.lat && a.lon === b.lon;

// Joins the member ways of a multipolygon relation into closed rings.
// Returns { outer: [ring...], inner: [ring...] } in lat/lon.
export function assembleRings(members) {
  const result = { outer: [], inner: [] };
  for (const role of ["outer", "inner"]) {
    const pieces = members
      .filter((m) => m.type === "way" && Array.isArray(m.geometry) && m.geometry.length > 1 && (m.role || "outer") === role)
      .map((m) => m.geometry.filter(Boolean));
    while (pieces.length) {
      let ring = pieces.shift().slice();
      let extended = true;
      while (!samePoint(ring[0], ring.at(-1)) && extended) {
        extended = false;
        for (let i = 0; i < pieces.length; i++) {
          const piece = pieces[i];
          const end = ring.at(-1);
          if (samePoint(piece[0], end)) ring = ring.concat(piece.slice(1));
          else if (samePoint(piece.at(-1), end)) ring = ring.concat(piece.slice(0, -1).reverse());
          else if (samePoint(piece.at(-1), ring[0])) ring = piece.slice(0, -1).concat(ring);
          else if (samePoint(piece[0], ring[0])) ring = piece.slice(1).reverse().concat(ring);
          else continue;
          pieces.splice(i, 1);
          extended = true;
          break;
        }
      }
      if (ring.length > 2) result[role].push(ring);
    }
  }
  return result;
}

export function ringArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j].x - ring[i].x) * (ring[j].y + ring[i].y);
  }
  return sum / 2;
}

export function bounds(rings) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of rings) for (const p of ring) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

// Even-odd point-in-polygon across all rings, so holes work.
export function insideRings(point, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i];
      const b = ring[j];
      if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
  }
  return inside;
}

export function rectsOverlap(a, b) {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

// Small deterministic PRNG so every render of a place is identical.
export function seededRandom(seed) {
  let s = (typeof seed === "number" ? seed : hashString(String(seed))) >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

export function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function pathData(points, close = false) {
  if (points.length < 2) return "";
  let d = `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`;
  for (let i = 1; i < points.length; i++) d += `L${points[i].x.toFixed(1)},${points[i].y.toFixed(1)}`;
  return close ? `${d}Z` : d;
}

export function ringsPath(rings) {
  return rings.map((ring) => pathData(ring, true)).join("");
}

// Drops vertices closer than `tolerance` units; keeps paths light for
// dense cities without visible change at print scale.
export function thin(points, tolerance) {
  if (points.length < 3) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const last = out.at(-1);
    if (Math.abs(points[i].x - last.x) + Math.abs(points[i].y - last.y) >= tolerance) out.push(points[i]);
  }
  out.push(points.at(-1));
  return out;
}

// Sutherland–Hodgman clip of one ring to an axis-aligned rectangle. Rings
// from large relations (rivers, forests) can extend kilometres past the
// card; clipping keeps files small and coordinates sane for the rasterizer.
export function clipRing(ring, rect) {
  const edges = [
    (p) => p.x >= rect.minX, (p) => p.x <= rect.maxX,
    (p) => p.y >= rect.minY, (p) => p.y <= rect.maxY
  ];
  const cut = [
    (a, b) => ({ x: rect.minX, y: a.y + (b.y - a.y) * (rect.minX - a.x) / (b.x - a.x) }),
    (a, b) => ({ x: rect.maxX, y: a.y + (b.y - a.y) * (rect.maxX - a.x) / (b.x - a.x) }),
    (a, b) => ({ x: a.x + (b.x - a.x) * (rect.minY - a.y) / (b.y - a.y), y: rect.minY }),
    (a, b) => ({ x: a.x + (b.x - a.x) * (rect.maxY - a.y) / (b.y - a.y), y: rect.maxY })
  ];
  let out = ring;
  for (let e = 0; e < 4 && out.length; e++) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      const curIn = edges[e](cur);
      if (curIn) {
        if (!edges[e](prev)) out.push(cut[e](prev, cur));
        out.push(cur);
      } else if (edges[e](prev)) out.push(cut[e](prev, cur));
    }
  }
  return out.length > 2 ? out : null;
}

// Splits a polyline into the runs that touch the rectangle.
export function clipLine(points, rect) {
  const inside = (p) => p.x >= rect.minX && p.x <= rect.maxX && p.y >= rect.minY && p.y <= rect.maxY;
  const runs = [];
  let run = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const keep = inside(p) || (i > 0 && inside(points[i - 1])) || (i < points.length - 1 && inside(points[i + 1]));
    if (keep) run.push(p);
    else if (run.length) { if (run.length > 1) runs.push(run); run = []; }
  }
  if (run.length > 1) runs.push(run);
  return runs;
}
