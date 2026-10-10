import { Resvg } from "@resvg/resvg-js";

export function rasterizeSvg(svg, widthPx) {
  if (!Number.isInteger(widthPx) || widthPx <= 0) throw new Error("Raster width must be a positive integer.");
  const renderer = new Resvg(svg, {
    fitTo: { mode: "width", value: widthPx },
    font: { loadSystemFonts: true }
  });
  return renderer.render().asPng();
}

// Pixel width of a card printed at the given resolution.
export function printWidthPx(widthMm, dpi) {
  return Math.round(widthMm / 25.4 * dpi);
}
