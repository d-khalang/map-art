import { Resvg } from "@resvg/resvg-js";

export function rasterizeSvg(svg, width = 2048) {
  const renderer = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    font: { loadSystemFonts: true }
  });
  return renderer.render().asPng();
}
