// Regenerates `src/data/generated/world.ts` from Natural Earth's 1:110m boundaries.
//
// Run it when the map needs different geography, and never edit the generated file by hand:
//
//   curl -sO https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json
//   node scripts/build-world-map.mjs countries-110m.json src/data/generated/world.ts
//
// **Why a generated module rather than a fetch or a mapping library.** The demonstrator has to run with
// no network and no runtime dependency — a tile layer would put a third party inside a demonstration
// about composition, and would go blank on a plane. TopoJSON's arcs are shared between neighbours, so
// decoding once and keeping the arcs apart from the rings is also the compact form: every border
// between two countries is one polyline rather than two.
//
// world-atlas is a TopoJSON build of Natural Earth, which is public domain — no attribution required,
// though it is named here because a reader deserves to know what the coastlines are.

import { readFileSync, writeFileSync } from 'node:fs';

const topo = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const {
  scale: [sx, sy],
  translate: [tx, ty],
} = topo.transform;

/** Delta-decoded, projected back to lon/lat, rounded to 2dp (~1 km — far finer than 720 px of map). */
const arcs = topo.arcs.map((arc) => {
  let x = 0;
  let y = 0;
  const points = [];
  for (const [dx, dy] of arc) {
    x += dx;
    y += dy;
    points.push([Math.round((x * sx + tx) * 100) / 100, Math.round((y * sy + ty) * 100) / 100]);
  }
  // Collapse consecutive duplicates that rounding produced.
  return points.filter((p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1]);
});

const ringsOf = (geometry) => {
  if (geometry.type === 'Polygon') return geometry.arcs;
  if (geometry.type === 'MultiPolygon') return geometry.arcs.flat();
  return [];
};

const land = topo.objects.land.geometries.flatMap(ringsOf);

// A ring is a list of arc indices; a negative index means that arc reversed (TopoJSON's ~i).
const pointCount = (ring) => ring.reduce((n, i) => n + arcs[i < 0 ? ~i : i].length, 0);
const kept = land.filter((ring) => pointCount(ring) >= 4);

const used = new Set();
for (const ring of kept) for (const i of ring) used.add(i < 0 ? ~i : i);

// Internal borders: every arc a country ring walks that the coastline does not. Each is held ONCE, so
// a border between two countries is one polyline rather than two identical ones drawn on top of each
// other — the reason the arcs are stored apart from the rings in the first place.
const borders = [];
const seen = new Set();
for (const geometry of topo.objects.countries.geometries) {
  for (const ring of ringsOf(geometry)) {
    for (const index of ring) {
      const arc = index < 0 ? ~index : index;
      if (used.has(arc) || seen.has(arc)) continue;
      if (arcs[arc].length < 2) continue;
      seen.add(arc);
      borders.push(arc);
    }
  }
}
for (const arc of borders) used.add(arc);

const body = `// The world, as coastlines and borders. GENERATED — do not edit by hand.
//
// Natural Earth 1:110m, by way of world-atlas' TopoJSON, decoded once into the two things this panel
// draws and rounded to two decimals (~1 km, far finer than 720 px of map can show). Natural Earth is
// public domain; there is no attribution requirement and no runtime dependency — the decoder ran once
// and is not shipped.
//
// **Arcs are shared between neighbours, and that is why they are stored separately.** A land ring is a
// list of arc INDICES, negative meaning that arc reversed, exactly as TopoJSON encodes it: every
// border between two countries is one polyline held once rather than drawn twice by both sides.

/** Every arc, as absolute [lon, lat] pairs. */
export const WORLD_ARCS: readonly (readonly (readonly [number, number])[])[] = ${JSON.stringify(arcs.map((a, i) => (used.has(i) ? a : [])))};

/** Land rings, as arc indices. A negative index \`i\` means arc \`~i\` walked backwards. */
export const WORLD_LAND: readonly (readonly number[])[] = ${JSON.stringify(kept)};

/** Internal country borders, as arc indices — the arcs no coastline already draws. */
export const WORLD_BORDERS: readonly number[] = ${JSON.stringify(borders)};
`;

writeFileSync(process.argv[3], body);
console.log(
  `arcs ${arcs.length} (used ${used.size}), land rings ${kept.length}, points ${arcs.reduce((n, a) => n + a.length, 0)}, bytes ${body.length}`,
);
