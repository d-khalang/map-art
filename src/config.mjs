import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// A6 for cities, A7 for towns. Both are 105 mm wide, so two landscape A7
// cards stack into exactly one portrait A6 on the wall grid.
export const FORMAT_SPECS = {
  A6: { widthMm: 105, heightMm: 148, headerMm: 23, footerMm: 8, marginMm: 4 },
  A7: { widthMm: 105, heightMm: 74, headerMm: 16, footerMm: 7, marginMm: 3 }
};

export const DEFAULT_STYLE = "anime";

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
    if (landmark.artWidthMm !== undefined) assertNumber(landmark.artWidthMm, `${landmark.name}.artWidthMm`, 2, 30);
    if (landmark.artDxMm !== undefined) assertNumber(landmark.artDxMm, `${landmark.name}.artDxMm`, -30, 30);
    if (landmark.artDyMm !== undefined) assertNumber(landmark.artDyMm, `${landmark.name}.artDyMm`, -30, 30);
  }
  return place;
}

export function validateStyle(style) {
  if (!style?.id) throw new Error("Style id is required.");
  for (const section of ["palette", "lines", "fields", "trees", "buildings", "stickers", "texture", "fonts", "frame"]) {
    if (!style[section] || typeof style[section] !== "object") throw new Error(`Style ${style.id}: ${section} is required.`);
  }
  for (const [key, value] of Object.entries(style.palette)) {
    const colours = Array.isArray(value) ? value : [value];
    if (!colours.every((c) => /^#[0-9a-f]{6}$/i.test(c))) throw new Error(`Style ${style.id}: palette.${key} must be six-digit hex colour(s).`);
  }
  return style;
}

export async function loadPlace(id) {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Invalid place id: ${id}`);
  return validatePlace(await readJson(resolve(ROOT, "places", `${id}.json`)));
}

export async function loadStyle(id = DEFAULT_STYLE) {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Invalid style id: ${id}`);
  return validateStyle(await readJson(resolve(ROOT, "styles", `${id}.json`)));
}

// "together" = a shared trip; "both" = each visited, but at different times.
export function visitState(visits) {
  if (visits.shared.length) return "together";
  const me = visits.me.length > 0;
  const partner = visits.partner.length > 0;
  if (me && partner) return "both";
  if (me) return "me";
  if (partner) return "partner";
  return "none";
}

export function resolveProjectPath(path) {
  return resolve(ROOT, path);
}
