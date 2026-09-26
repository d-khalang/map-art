import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const FORMAT_SPECS = {
  A6: { widthMm: 105, heightMm: 148, headerMm: 23, footerMm: 8, marginMm: 4 },
  A7: { widthMm: 105, heightMm: 74, headerMm: 16, footerMm: 7, marginMm: 3 }
};

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Missing file: ${path}`);
    throw new Error(`Cannot read ${path}: ${error.message}`);
  }
}

function assertNumber(value, label, min, max) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
}

export function validatePlace(place) {
  if (!place || typeof place !== "object") throw new Error("Place config must be an object.");
  if (!/^[a-z0-9-]+$/.test(place.id ?? "")) throw new Error("Place id must be lowercase kebab-case.");
  if (!place.name || !place.country) throw new Error("Place name and country are required.");
  if (!FORMAT_SPECS[place.format]) throw new Error("Place format must be A6 or A7.");
  assertNumber(place.center?.lat, "center.lat", -90, 90);
  assertNumber(place.center?.lon, "center.lon", -180, 180);
  assertNumber(place.radiusMeters, "radiusMeters", 300, 15000);
  for (const key of ["me", "partner", "shared"]) {
    if (!Array.isArray(place.visits?.[key])) throw new Error(`visits.${key} must be an array.`);
  }
  if ((place.landmarks?.length ?? 0) > 5) throw new Error("Use at most five landmarks.");
  for (const landmark of place.landmarks ?? []) {
    if (!landmark.name) throw new Error("Every landmark needs a name.");
    assertNumber(landmark.lat, `${landmark.name}.lat`, -90, 90);
    assertNumber(landmark.lon, `${landmark.name}.lon`, -180, 180);
  }
  if ((place.visitedPlaces?.length ?? 0) > 8) throw new Error("Use at most eight visited places.");
  for (const visited of place.visitedPlaces ?? []) {
    if (!visited.name) throw new Error("Every visited place needs a name.");
    if (!["me", "partner", "both"].includes(visited.by)) throw new Error(`${visited.name}.by must be me, partner, or both.`);
    assertNumber(visited.lat, `${visited.name}.lat`, -90, 90);
    assertNumber(visited.lon, `${visited.name}.lon`, -180, 180);
  }
  return place;
}

export function validateStyle(style) {
  if (!style?.id) throw new Error("Style id is required.");
  for (const key of ["paper", "ink", "muted", "water", "park", "building", "accent"]) {
    if (!/^#[0-9a-f]{6}$/i.test(style.palette?.[key] ?? "")) {
      throw new Error(`Style ${style.id}: palette.${key} must be a six-digit hex colour.`);
    }
  }
  for (const key of ["motorway", "primary", "secondary", "local", "minor", "rail"]) {
    if (!Number.isFinite(style.roadWidths?.[key]) || style.roadWidths[key] < 0) {
      throw new Error(`Style ${style.id}: roadWidths.${key} must be non-negative.`);
    }
  }
  for (const key of ["river", "canal", "stream"]) {
    if (!Number.isFinite(style.waterWidths?.[key]) || style.waterWidths[key] < 0) {
      throw new Error(`Style ${style.id}: waterWidths.${key} must be non-negative.`);
    }
  }
  if (!style.ai?.prompt) throw new Error(`Style ${style.id}: ai.prompt is required.`);
  if (style.ai.underlaySaturation !== undefined) {
    assertNumber(style.ai.underlaySaturation, `Style ${style.id}: ai.underlaySaturation`, 0, 1);
  }
  return style;
}

export async function loadPlace(id) {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Invalid place id: ${id}`);
  return validatePlace(await readJson(resolve(ROOT, "places", `${id}.json`)));
}

export async function loadStyle(id) {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Invalid style id: ${id}`);
  return validateStyle(await readJson(resolve(ROOT, "styles", `${id}.json`)));
}

export function companionState(visits) {
  const me = visits.me.length > 0 || visits.shared.length > 0;
  const partner = visits.partner.length > 0 || visits.shared.length > 0;
  if (me && partner) return { value: "both", shared: visits.shared.length > 0 };
  if (me) return { value: "me", shared: false };
  if (partner) return { value: "partner", shared: false };
  return { value: "none", shared: false };
}

export function resolveProjectPath(path) {
  return resolve(ROOT, path);
}
