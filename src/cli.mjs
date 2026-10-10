import { mkdir, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { FORMAT_SPECS, ROOT, loadPlace, loadStyle } from "./config.mjs";
import { renderMap } from "./illustrate.mjs";
import { fetchOsm, summarizeOsm } from "./osm.mjs";
import { printWidthPx, rasterizeSvg } from "./rasterize.mjs";

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function positional(args) {
  return args.filter((arg, i) => !arg.startsWith("--") && !args[i - 1]?.startsWith("--"));
}

function usage() {
  return `Travel Atlas

Usage:
  node atlas.mjs fetch <place> [<place> ...] [--refresh]
  node atlas.mjs render <place> [<place> ...] [--dpi 600] [--style anime]
  node atlas.mjs wall [<place> ...] [--dpi 600] [--style anime]

render writes output/<place>.svg and a print PNG. wall renders every place
(or the ones listed) and writes output/index.html, a wall-grid preview.`;
}

async function allPlaceIds() {
  const files = await readdir(resolve(ROOT, "places"));
  return files.filter((f) => f.endsWith(".json") && !f.startsWith("_")).map((f) => f.replace(/\.json$/, "")).sort();
}

async function renderPlace(placeId, style, dpi) {
  const place = await loadPlace(placeId);
  const started = performance.now();
  const { payload } = await fetchOsm(place);
  const { svg, stats } = await renderMap(place, style, payload);
  const directory = resolve(ROOT, "output");
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, `${place.id}.svg`), svg);
  await writeFile(resolve(directory, `${place.id}.png`), rasterizeSvg(svg, printWidthPx(FORMAT_SPECS[place.format].widthMm, dpi)));
  console.log(`${place.id}: ${place.format}, ${stats.buildings} buildings, ${stats.trees} trees, ${Math.round(performance.now() - started)} ms`);
  return place;
}

function wallHtml(places) {
  const cards = places.map((p) => {
    const f = FORMAT_SPECS[p.format];
    return `<a href="${p.id}.png" style="width:${f.widthMm}mm;height:${f.heightMm}mm"><img src="${p.id}.png" alt="${p.name}" /></a>`;
  }).join("\n    ");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Travel Atlas wall</title>
  <style>
    body { margin: 0; padding: 32px; background: #2b2a27; }
    main { display: flex; flex-wrap: wrap; gap: 6mm; align-items: flex-start; zoom: 0.9; }
    a { display: block; box-shadow: 0 6px 18px #0006; }
    img { display: block; width: 100%; height: 100%; }
  </style>
</head>
<body>
  <main>
    ${cards}
  </main>
</body>
</html>\n`;
}

export async function run(args) {
  const [command, ...rest] = args;
  if (!command || ["help", "--help", "-h"].includes(command)) {
    console.log(usage());
    return;
  }
  const ids = positional(rest);
  const dpi = Number(option(rest, "--dpi", "600"));
  if (command === "fetch") {
    if (!ids.length) throw new Error(`${usage()}\n\nA place id is required.`);
    for (const id of ids) {
      const result = await fetchOsm(await loadPlace(id), { refresh: rest.includes("--refresh") });
      console.log(id, JSON.stringify({ cacheHit: result.cacheHit, durationMs: Math.round(result.durationMs), ...summarizeOsm(result.payload) }));
    }
    return;
  }
  if (command === "render" || command === "wall") {
    const style = await loadStyle(option(rest, "--style"));
    const targets = ids.length ? ids : command === "wall" ? await allPlaceIds() : [];
    if (!targets.length) throw new Error(`${usage()}\n\nA place id is required.`);
    const places = [];
    for (const id of targets) {
      try {
        places.push(await renderPlace(id, style, dpi));
      } catch (error) {
        console.error(`${id}: ${error.message}`);
      }
    }
    if (command === "wall") {
      const path = resolve(ROOT, "output", "index.html");
      await writeFile(path, wallHtml(places));
      console.log(path);
    }
    return;
  }
  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}
