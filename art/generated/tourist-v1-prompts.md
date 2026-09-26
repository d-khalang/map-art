# Tourist v1 image-generation prompts

Mode: built-in image generation, with four local reference images per place.

## Shared prompt

Use case: stylized-concept

Asset type: printable illustrated tourist-map underlay

Style/medium: refined hand-painted gouache and ink travel-poster illustration, warm ivory paper, restrained sage green, muted blue, charcoal, and sparing coral accents; elegant European tourist-map aesthetic; the same visual system must work as a repeatable city series.

Composition/framing: top-down map occupying the same page and geographic footprint as Image 1. Use Image 1 as the authoritative spatial reference. Image 2 is a protected road-corridor mask: preserve the road pattern and leave those corridors visually quiet enough for exact vector streets to be restored above. Image 3 identifies water placement; Image 4 identifies green areas.

Constraints: no title, labels, typography, legend, attribution, pins, border, or watermark. Do not invent or relocate waterways, roads, or city blocks. Keep ornament subtle and subordinate to geographic legibility.

Input images: Image 1 = authoritative OSM reference map; Image 2 = road-mask constraint; Image 3 = water-mask constraint; Image 4 = green-area constraint.

## Utrecht

Create the dense Dutch city illustrated underlay for Utrecht. Give Utrecht a compact urban texture with subtle canal-side roofs, tiny tree clusters, and a restrained Dom Tower-like landmark vignette near the historic core; keep all features small and map-like.

## Domodossola

Create the compact Italian Alpine town illustrated underlay for Domodossola. Give Domodossola warm stone-roof town texture around the old center and subtle Alpine ridge, woodland, and contour-like brush textures toward the outer edges; keep the railway corridor legible and do not turn this into a perspective landscape.

### Corrected crop, v2

The Domodossola asset was regenerated after the map extent changed. The corrected prompt required the compact historic centre in the upper-left, the railway through the middle, Sacro Monte toward the lower-left, and the Toce as the only dominant north-south river on the right. It explicitly prohibited additional broad rivers, lakes, roads, railways, bridges, labels, compass marks, and scale bars. The four updated OSM reference and mask images remained authoritative.

## Zaltbommel

Create the small Dutch fortified river town illustrated underlay for Zaltbommel. Emphasize Zaltbommel's intimate historic core, moat-like water geometry, green ramparts, small brick-roof textures, and river landscape; keep the old town clearly enclosed by its real water shape.
