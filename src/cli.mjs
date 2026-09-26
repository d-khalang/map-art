import { watch } from "node:fs";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { loadPlace, loadStyle, ROOT } from "./config.mjs";
import { runExperiment } from "./experiment.mjs";
import { fetchOsm, summarizeOsm } from "./osm.mjs";
import { renderMap } from "./render.mjs";

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function has(args, name) {
  return args.includes(name);
}

function usage() {
  return `Travel Atlas experiment

Usage:
  node atlas.mjs fetch <place> [--refresh]
  node atlas.mjs render <place> [--style tourist] [--refresh]
  node atlas.mjs experiment <place> [--refresh]
  node atlas.mjs collection <place> [<place> ...]
  node atlas.mjs watch <place> [--port 4173]

Examples:
  node atlas.mjs fetch berlin
  node atlas.mjs experiment utrecht
  node atlas.mjs collection utrecht domodossola zaltbommel
  node atlas.mjs watch utrecht --port 4173`;
}

function collectionHtml(entries) {
  const cards = entries.map(({ place, report }) => `<article>
    <a href="${place.id}/index.html"><img src="${place.id}/storybook.svg" alt="${place.name} storybook-map preview" /></a>
    <div><h2>${place.name}</h2><p>${place.format} · ${report.osm.elements.toLocaleString()} OSM elements · storybook render ${Math.round(report.renders.find((item) => item.style === "storybook")?.durationMs ?? 0)} ms</p></div>
  </article>`).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Travel Atlas · Collection experiment</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 32px; background: #272723; color: #f4eee2; font: 15px/1.45 system-ui, sans-serif; }
    header, main { max-width: 1180px; margin: auto; }
    header { margin-bottom: 26px; }
    h1, h2 { font-family: Georgia, serif; font-weight: 600; }
    h1 { margin: 0 0 6px; }
    header p, article p { color: #bdb6a9; }
    main { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; align-items: start; }
    article { background: #32312d; border-radius: 3px; overflow: hidden; box-shadow: 0 14px 34px #0005; }
    article img { display: block; width: 100%; height: auto; background: #eee6d8; }
    article div { padding: 14px 16px 16px; }
    h2, p { margin: 0; }
    h2 { margin-bottom: 5px; font-size: 20px; }
    @media (max-width: 820px) { main { grid-template-columns: 1fr; } }
  </style>
</head>
<body><header><h1>Travel Atlas experiment</h1><p>The selected storybook direction across different city scales. Select a map to compare all three style presets.</p></header><main>${cards}</main></body>
</html>\n`;
}

async function runCollection(placeIds) {
  if (!placeIds.length) throw new Error(`${usage()}\n\nAt least one place id is required.`);
  const entries = [];
  for (const placeId of placeIds) {
    const place = await loadPlace(placeId);
    const { report } = await runExperiment(place);
    entries.push({ place, report });
  }
  const directory = resolve(ROOT, "output");
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, "index.html");
  await writeFile(path, collectionHtml(entries));
  console.log(path);
}

async function renderOne(place, styleId, refresh) {
  const style = await loadStyle(styleId);
  const osm = await fetchOsm(place, { refresh });
  const { svg } = await renderMap(place, style, osm.payload);
  const directory = resolve(ROOT, "output", place.id);
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, `${styleId}.svg`);
  await writeFile(path, svg);
  console.log(`${path}\n${JSON.stringify({ cacheHit: osm.cacheHit, osm: summarizeOsm(osm.payload) }, null, 2)}`);
}

function serve(directory, port) {
  const mime = { ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8" };
  const root = resolve(directory);
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      const requested = pathname === "/" ? "/index.html" : pathname;
      const path = resolve(root, `.${requested}`);
      if (!(path === root || path.startsWith(`${root}${sep}`))) throw new Error("Invalid path");
      const info = await stat(path);
      if (!info.isFile()) throw new Error("Not a file");
      response.writeHead(200, { "Content-Type": mime[extname(path)] ?? "application/octet-stream", "Cache-Control": "no-store" });
      response.end(await readFile(path));
    } catch {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("Not found");
    }
  });
  server.listen(port, "127.0.0.1", () => console.log(`Preview: http://127.0.0.1:${port}/`));
  return server;
}

async function watchExperiment(place, port) {
  let running = false;
  let pending = false;
  const rebuild = async () => {
    if (running) { pending = true; return; }
    running = true;
    try {
      const { report } = await runExperiment(place);
      console.log(`[${new Date().toLocaleTimeString()}] rebuilt ${place.id}: ${report.renders.map((r) => `${r.style} ${r.durationMs}ms`).join(", ")}`);
    } catch (error) {
      console.error(error.message);
    } finally {
      running = false;
      if (pending) { pending = false; void rebuild(); }
    }
  };
  await rebuild();
  serve(resolve(ROOT, "output", place.id), port);
  let timer;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void rebuild(), 120);
  };
  watch(resolve(ROOT, "styles"), schedule);
  watch(resolve(ROOT, "places"), schedule);
  console.log("Watching places/ and styles/. Press Ctrl+C to stop.");
}

export async function run(args) {
  const command = args[0];
  const placeId = args[1];
  if (!command || ["help", "--help", "-h"].includes(command)) {
    console.log(usage());
    return;
  }
  if (command === "collection") {
    await runCollection(args.slice(1));
    return;
  }
  if (!placeId) throw new Error(`${usage()}\n\nA place id is required.`);
  const place = await loadPlace(placeId);
  if (command === "fetch") {
    const result = await fetchOsm(place, { refresh: has(args, "--refresh") });
    console.log(JSON.stringify({ cacheHit: result.cacheHit, durationMs: Math.round(result.durationMs), summary: summarizeOsm(result.payload) }, null, 2));
    return;
  }
  if (command === "render") {
    await renderOne(place, option(args, "--style", "tourist"), has(args, "--refresh"));
    return;
  }
  if (command === "experiment") {
    const { outputDir, report } = await runExperiment(place, { refresh: has(args, "--refresh") });
    console.log(`${resolve(outputDir, "index.html")}\n${JSON.stringify(report, null, 2)}`);
    return;
  }
  if (command === "watch") {
    await watchExperiment(place, Number(option(args, "--port", "4173")));
    return;
  }
  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}
