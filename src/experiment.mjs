import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { ROOT, loadStyle } from "./config.mjs";
import { fetchOsm, summarizeOsm } from "./osm.mjs";
import { renderMap, renderMask, renderReference } from "./render.mjs";
import { rasterizeSvg } from "./rasterize.mjs";

export const DEFAULT_STYLES = ["cartographic", "tourist", "storybook"];

function promptFor(place, style, payload) {
  const protectedList = style.ai.protectedGeometry.join(", ");
  return `Illustrate ${place.name}, ${place.country}, as a ${style.id} tourist map.

The supplied reference comes from OpenStreetMap data retrieved on ${payload.fetchedAt}. Treat its layout as authoritative. Use the masks to identify roads, water, and green space. The final deterministic overlay will restore protected cartography.

ART DIRECTION
${style.ai.prompt}

PROTECTED GEOMETRY
${protectedList}

OUTPUT RULES
- Preserve the supplied crop and orientation.
- Do not add typography, map labels, frames, legends, pins, or attribution.
- Do not invent or reconnect roads, rail, rivers, shorelines, or bridges.
- Keep the title and footer areas visually calm.
- Produce one flat illustration layer with no mockup, paper edge, or surrounding scene.
`;
}

function comparisonHtml(place, results, report) {
  const cards = results.map(({ styleId, svgFile }) => `<figure>
    <img src="${svgFile}" alt="${place.name} in the ${styleId} style" />
    <figcaption>${styleId}</figcaption>
  </figure>`).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${place.name} · Travel Atlas experiment</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; padding: 24px; background: #292824; color: #f5f0e5; }
    header { max-width: 1100px; margin: 0 auto 20px; }
    h1 { margin: 0; font-family: Georgia, serif; font-weight: 600; }
    p { color: #c8c1b4; }
    main { max-width: 1100px; margin: auto; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; align-items: start; }
    figure { margin: 0; }
    img { display: block; width: 100%; height: auto; box-shadow: 0 12px 30px #0007; }
    figcaption { padding-top: 8px; text-transform: capitalize; color: #ded6c8; }
    code { color: #fff; }
    @media (max-width: 760px) { main { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>${place.name}</h1>
    <p>${report.osm.elements.toLocaleString()} OSM elements · ${report.cacheHit ? "cached" : `${Math.round(report.fetchMs)} ms fetch`} · edit <code>styles/*.json</code> and refresh</p>
  </header>
  <main>${cards}</main>
</body>
</html>\n`;
}

export async function runExperiment(place, { refresh = false, styleIds = DEFAULT_STYLES } = {}) {
  const outputDir = resolve(ROOT, "output", place.id);
  await mkdir(outputDir, { recursive: true });
  const osmResult = await fetchOsm(place, { refresh });
  const report = {
    place: place.id,
    generatedAt: new Date().toISOString(),
    cacheHit: osmResult.cacheHit,
    fetchMs: Math.round(osmResult.durationMs * 10) / 10,
    osm: summarizeOsm(osmResult.payload),
    renders: []
  };
  const results = [];

  for (const styleId of styleIds) {
    const style = await loadStyle(styleId);
    const started = performance.now();
    const rendered = await renderMap(place, style, osmResult.payload);
    const svgFile = `${styleId}.svg`;
    const svgPath = resolve(outputDir, svgFile);
    await writeFile(svgPath, rendered.svg);
    if (style.id === "tourist") {
      await writeFile(resolve(outputDir, "tourist-preview.png"), rasterizeSvg(rendered.svg, 900));
    }

    const aiDir = resolve(outputDir, "ai", styleId);
    await mkdir(aiDir, { recursive: true });
    const protectedMap = await renderMap(place, style, osmResult.payload, { protectedOnly: true });
    const reference = renderReference(place, style, osmResult.payload);
    const roadsMask = renderMask(place, style, osmResult.payload, "roads");
    const waterMask = renderMask(place, style, osmResult.payload, "water");
    const greenMask = renderMask(place, style, osmResult.payload, "green");
    await writeFile(resolve(aiDir, "reference.svg"), reference);
    await writeFile(resolve(aiDir, "roads-mask.svg"), roadsMask);
    await writeFile(resolve(aiDir, "water-mask.svg"), waterMask);
    await writeFile(resolve(aiDir, "green-mask.svg"), greenMask);
    await writeFile(resolve(aiDir, "protected-overlay.svg"), protectedMap.svg);
    await writeFile(resolve(aiDir, "prompt.txt"), promptFor(place, style, osmResult.payload));

    // Rasterize only the default AI experiment style. The editable SVG bundle is
    // always emitted for every preset; duplicating five expensive PNG renders for
    // every palette made the iteration loop needlessly slow.
    const hasRasterInputs = style.id === "tourist";
    if (hasRasterInputs) {
      await writeFile(resolve(aiDir, "reference.png"), rasterizeSvg(reference, 1536));
      await writeFile(resolve(aiDir, "roads-mask.png"), rasterizeSvg(roadsMask, 1536));
      await writeFile(resolve(aiDir, "water-mask.png"), rasterizeSvg(waterMask, 1536));
      await writeFile(resolve(aiDir, "green-mask.png"), rasterizeSvg(greenMask, 1536));
    } else {
      for (const name of ["reference.png", "roads-mask.png", "water-mask.png", "green-mask.png", "protected-overlay.png"]) {
        await rm(resolve(aiDir, name), { force: true });
      }
    }
    const manifest = {
      place: place.id,
      style: style.id,
      format: place.format,
      physicalSizeMm: { width: rendered.scene.format.widthMm, height: rendered.scene.format.heightMm },
      osmFetchedAt: osmResult.payload.fetchedAt,
      inputFiles: hasRasterInputs
        ? ["reference.png", "roads-mask.png", "water-mask.png", "green-mask.png"]
        : ["reference.svg", "roads-mask.svg", "water-mask.svg", "green-mask.svg"],
      editableVectorInputs: ["reference.svg", "roads-mask.svg", "water-mask.svg", "green-mask.svg"],
      deterministicOverlay: "protected-overlay.svg",
      expectedGeneratedImage: `art/generated/${place.id}-${style.id}.png`,
      rule: "Generated art is composited below the deterministic overlay; it never replaces protected geography."
    };
    await writeFile(resolve(aiDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    const durationMs = performance.now() - started;
    const file = await stat(svgPath);
    report.renders.push({ style: style.id, durationMs: Math.round(durationMs * 10) / 10, bytes: file.size });
    results.push({ styleId, svgFile });
  }

  await writeFile(resolve(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(resolve(outputDir, "index.html"), comparisonHtml(place, results, report));
  return { outputDir, report };
}
