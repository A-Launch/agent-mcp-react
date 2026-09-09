import { useMcpTool } from 'agent-mcp-react';
import type { ReactNode } from 'react';
import { actionName, PANEL_ACTION } from '../../catalog/kinds.ts';
import {
  DATA_SOURCE,
  isMapFocus,
  MAP_FOCUS,
  MAP_FOCUSES,
  type MapFocus,
  type PANEL_KIND,
} from '../../catalog/vocabulary.ts';
import { WORLD_ARCS, WORLD_BORDERS, WORLD_LAND } from '../../data/generated/world.ts';
import { measuresOf, type Row, rowsOf } from '../../data/sources.ts';
import type { Panel } from '../../state/board.ts';
import { updateSettings } from '../../state/board.ts';

// Where things are, drawn as hand-written SVG on an equirectangular projection.
//
// **Real geography, and still no mapping library and no tiles.** The coastlines and borders are Natural
// Earth 1:110m — public domain — decoded once from world-atlas' TopoJSON into
// `../../data/generated/world.ts` by `scripts/build-world-map.mjs`, so nothing is fetched at run time
// and the panel draws the same map on a plane as on a desk. A tile layer would put a third party inside
// a demonstration about composition and would go blank without a network.
//
// **The arcs are shared, which is why they are stored apart from the rings.** A land ring is a list of
// arc INDICES, negative meaning walked backwards, exactly as TopoJSON encodes it: the border between
// two countries is one polyline held once rather than two identical ones drawn over each other.
//
// **A focus is a MEMBER of a closed set, never a bounding box.** The agent says `emea`, not four
// numbers, so "show me EMEA" stays an intent rather than a calculation an agent can get subtly wrong —
// and the viewport arithmetic stays here, where a person can see it.
//
// **Coordinates come from the data, or from a region centroid this file holds.** `sites` carries `lat`
// and `lon` as ordinary numeric columns; `revenue_by_region` does not, and the five region points below
// are a build-time fact about five named regions rather than a geocoder.
//
// What this component owns: the projection, the drawing, and its two actions. It owns no data and no
// board state.

export type MapPanelModel = Extract<Panel, { kind: typeof PANEL_KIND.map }>;

const WIDTH = 720;
const HEIGHT = 340;

/** Latitude and longitude of each named region, for a source that names regions and not places. */
const REGION_POINT: Readonly<Record<string, { readonly lat: number; readonly lon: number }>> = {
  amer: { lat: 40, lon: -98 },
  emea: { lat: 50, lon: 10 },
  apac: { lat: 20, lon: 110 },
  latam: { lat: -15, lon: -60 },
  mea: { lat: 15, lon: 35 },
};

/** What each focus looks at, as a lon/lat window. `world` is the whole projection. */
const FOCUS_WINDOW: Readonly<
  Record<
    MapFocus,
    { readonly lon: readonly [number, number]; readonly lat: readonly [number, number] }
  >
> = {
  [MAP_FOCUS.world]: { lon: [-180, 180], lat: [-60, 85] },
  [MAP_FOCUS.amer]: { lon: [-170, -50], lat: [10, 75] },
  [MAP_FOCUS.emea]: { lon: [-25, 45], lat: [33, 72] },
  [MAP_FOCUS.apac]: { lon: [60, 180], lat: [-45, 55] },
  [MAP_FOCUS.latam]: { lon: [-120, -30], lat: [-56, 30] },
  [MAP_FOCUS.mea]: { lon: [-20, 65], lat: [-40, 40] },
};

/** One arc's points, walked forwards or backwards as the ring asks. */
function arcPoints(index: number): readonly (readonly [number, number])[] {
  const arc = WORLD_ARCS[index < 0 ? ~index : index] ?? [];
  return index < 0 ? [...arc].reverse() : arc;
}

/** Every point of one land ring, in order, with the shared arcs stitched together. */
function ringPoints(ring: readonly number[]): readonly (readonly [number, number])[] {
  return ring.flatMap(arcPoints);
}

/**
 * Rewrites a ring's longitudes so consecutive points never jump the antimeridian.
 *
 * **A ring that steps from +179° to −179° has moved one degree and 358 degrees of longitude**, and an
 * equirectangular projection draws that as a line straight across the map. Russia does it, and so does
 * Antarctica; the result was pale bands lying across the Arctic. Adding or subtracting whole turns keeps
 * the path continuous, so it simply runs off the side of the canvas and is clipped.
 *
 * **Splitting the ring instead was tried and looked worse.** Each piece still has to be a filled polygon,
 * and SVG closes a polygon from its last point back to its first — which drew a diagonal seam from
 * Siberia to the South Pacific. Visible in a screenshot, invisible to every test, because nothing about
 * the DOM was wrong.
 */
function unwrap(
  points: readonly (readonly [number, number])[],
): readonly (readonly [number, number])[] {
  let turns = 0;
  let previous: number | undefined;
  return points.map(([lon, lat]) => {
    let shifted = lon + turns * 360;
    if (previous !== undefined) {
      while (shifted - previous > 180) {
        turns -= 1;
        shifted = lon + turns * 360;
      }
      while (shifted - previous < -180) {
        turns += 1;
        shifted = lon + turns * 360;
      }
    }
    previous = shifted;
    return [shifted, lat] as const;
  });
}

/**
 * The horizontal copies one shape needs to be complete.
 *
 * A ring that unwrapping pushed past ±180 is still whole — it is just off the edge, and the part that
 * belongs on the other side of the map would be missing. Drawing the same points again a full turn away
 * puts it back. Only shapes that actually cross pay for the second copy.
 */
function turnsFor(points: readonly (readonly [number, number])[]): readonly number[] {
  const longitudes = points.map(([lon]) => lon);
  const shifts = [0];
  if (Math.max(...longitudes) > 180) shifts.push(-360);
  if (Math.min(...longitudes) < -180) shifts.push(360);
  return shifts;
}

/** Meridians and parallels every 30°, so a projection reads as one rather than as a drawing. */
const GRATICULE = {
  meridians: [-150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150],
  parallels: [-60, -30, 0, 30, 60],
} as const;

/** The value that sizes a marker, and the label under it. */
interface Marker {
  readonly key: string;
  readonly label: string;
  readonly lat: number;
  readonly lon: number;
  readonly value: number;
}

/** Reads one row as a marker, or reports that it has no position. */
function toMarker(row: Row, source: MapPanelModel['source'], measure: string): Marker | undefined {
  const value = Number(row[measure] ?? 0);
  if (source === DATA_SOURCE.sites) {
    const lat = Number(row.lat ?? Number.NaN);
    const lon = Number(row.lon ?? Number.NaN);
    if (Number.isNaN(lat) || Number.isNaN(lon)) return undefined;
    return { key: String(row.site ?? ''), label: String(row.site ?? ''), lat, lon, value };
  }
  const point = REGION_POINT[String(row.region ?? '')];
  if (point === undefined) return undefined;
  return { key: String(row.region ?? ''), label: String(row.region ?? ''), ...point, value };
}

export function MapPanel({ panel }: { readonly panel: MapPanelModel }): ReactNode {
  const measures = measuresOf(panel.source);

  // Where the map is looking. The descriptor depends only on `panel.id`, so changing focus redraws and
  // touches the registry not at all.
  useMcpTool({
    name: actionName(panel.id, PANEL_ACTION.set_focus),
    title: `Point ${panel.id} at a region`,
    description:
      `Points the "${panel.id}" map at one region, or back at the whole world. The focus is one of a ` +
      'fixed set of named regions — there is no free-form viewport.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['focus'],
      properties: { focus: { type: 'string', enum: MAP_FOCUSES as readonly string[] } },
    },
    handler: async (input, context) => {
      const requested = input.focus;
      // Not redundant with the declared enum: this turns a validated string into the union type without
      // an `as`-cast onto a type that does not admit it.
      if (!isMapFocus(requested)) {
        throw new Error(
          `"${String(requested)}" is not a map focus — use: ${MAP_FOCUSES.join(', ')}`,
        );
      }
      updateSettings<typeof PANEL_KIND.map>(panel.id, { ...panel.settings, focus: requested });
      await context.afterRender();
      return { focus: requested };
    },
  });

  // Which number the markers are sized by. The same verb the metric tile uses, because it is the same
  // intent: choose what this panel is about.
  useMcpTool({
    name: actionName(panel.id, PANEL_ACTION.set_measure),
    title: `Choose what ${panel.id} sizes its markers by`,
    description: `Sizes the markers on the "${panel.id}" map by one of its source's numeric columns.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['measure'],
      properties: {
        measure: { type: 'string', enum: measures.map((column) => column.key) },
      },
    },
    handler: async (input, context) => {
      const requested = input.measure;
      const known = measures.some((column) => column.key === requested);
      if (typeof requested !== 'string' || !known) {
        throw new Error(
          `"${String(requested)}" is not a measure of ${panel.source} — use: ${measures
            .map((column) => column.key)
            .join(', ')}`,
        );
      }
      updateSettings<typeof PANEL_KIND.map>(panel.id, { ...panel.settings, measure: requested });
      await context.afterRender();
      return { measure: requested };
    },
  });

  // Named `view` rather than `window`: a local called `window` shadows the global one for the whole
  // component, which is a trap for the next person to add a browser call here.
  const view = FOCUS_WINDOW[panel.settings.focus];
  const [lonMin, lonMax] = view.lon;
  const [latMin, latMax] = view.lat;
  const project = (lat: number, lon: number): { x: number; y: number } => ({
    x: ((lon - lonMin) / (lonMax - lonMin)) * WIDTH,
    y: ((latMax - lat) / (latMax - latMin)) * HEIGHT,
  });

  /** One polyline's points, projected and rounded, as an SVG `points` attribute. */
  const path = (points: readonly (readonly [number, number])[], shift = 0): string =>
    points
      .map(([lon, lat]) => {
        const at = project(lat, lon + shift);
        return `${String(Math.round(at.x * 10) / 10)},${String(Math.round(at.y * 10) / 10)}`;
      })
      .join(' ');

  const markers = rowsOf(panel.source)
    .map((row) => toMarker(row, panel.source, panel.settings.measure))
    .filter((marker): marker is Marker => marker !== undefined);

  // Guarded rather than assumed: with no markers the largest value would be `-Infinity` and every radius
  // `NaN`, which renders as an empty map with nothing to say why.
  const largest = markers.length === 0 ? 0 : Math.max(...markers.map((marker) => marker.value));
  const radius = (value: number): number =>
    largest === 0 ? 4 : 4 + Math.sqrt(value / largest) * 18;

  const inWindow = markers.filter(
    (marker) =>
      marker.lon >= lonMin && marker.lon <= lonMax && marker.lat >= latMin && marker.lat <= latMax,
  );

  /**
   * Which markers get a label.
   *
   * **Biggest first, and a label is dropped when it would collide with one already placed.** At world
   * zoom London, Berlin and Stockholm sit within a few pixels of each other and their labels rendered
   * as "LondonBerlin" — a label nobody can read is not information, and drawing it anyway costs the
   * legibility of the one underneath. Every marker is still DRAWN and still carries its name on hover;
   * only the printed label is rationed.
   */
  const placed = [...inWindow]
    .sort((left, right) => right.value - left.value)
    .reduce<{ marker: Marker; labelled: boolean }[]>((taken, marker) => {
      const at = project(marker.lat, marker.lon);
      const clash = taken.some(({ marker: other, labelled }) => {
        if (!labelled) return false;
        const there = project(other.lat, other.lon);
        return Math.abs(there.x - at.x) < 60 && Math.abs(there.y - at.y) < 14;
      });
      taken.push({ marker, labelled: !clash });
      return taken;
    }, []);

  return (
    <div className="panel map" data-testid={`panel-${panel.id}`} data-panel-kind={panel.kind}>
      <div className="panel-head">
        <h3>{panel.source.replace(/_/g, ' ')} on the map</h3>
        <span className="panel-id">{panel.id}</span>
        <span className="count" data-testid={`focus-${panel.id}`}>
          {panel.settings.focus}
        </span>
        <span className="count" data-testid={`measure-${panel.id}`}>
          by {panel.settings.measure}
        </span>
        <span className="count" data-testid={`plotted-${panel.id}`}>
          {inWindow.length} plotted
        </span>
      </div>
      <div className="panel-body">
        <svg
          viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
          role="img"
          aria-label={`map of ${panel.source} focused on ${panel.settings.focus}`}
        >
          <rect className="sea" x={0} y={0} width={WIDTH} height={HEIGHT} />

          {/* The graticule first, so land sits on top of it rather than under a grid. */}
          {GRATICULE.meridians.map((lon) => {
            const top = project(90, lon);
            const bottom = project(-90, lon);
            return (
              <line
                key={`meridian-${String(lon)}`}
                className="graticule"
                x1={top.x}
                y1={top.y}
                x2={bottom.x}
                y2={bottom.y}
              />
            );
          })}
          {GRATICULE.parallels.map((lat) => {
            const left = project(lat, -180);
            const right = project(lat, 180);
            return (
              <line
                key={`parallel-${String(lat)}`}
                className="graticule"
                x1={left.x}
                y1={left.y}
                x2={right.x}
                y2={right.y}
              />
            );
          })}

          {WORLD_LAND.flatMap((ring, index) => {
            const points = unwrap(ringPoints(ring));
            return turnsFor(points).map((shift) => (
              <polygon
                // The index IS the identity: this list is a build-time constant that never reorders,
                // which is the one case where an index key means what it says.
                key={`land-${String(index)}-${String(shift)}`}
                className="land"
                points={path(points, shift)}
              />
            ));
          })}

          {/* Internal borders, stroked on top. Each arc is drawn once — the coastline already drew the
              rest, and two countries sharing a border do not each get to draw it. */}
          {WORLD_BORDERS.flatMap((index) => {
            const points = unwrap(arcPoints(index));
            return turnsFor(points).map((shift) => (
              <polyline
                key={`border-${String(index)}-${String(shift)}`}
                className="border"
                points={path(points, shift)}
              />
            ));
          })}

          {placed.map(({ marker, labelled }) => {
            const at = project(marker.lat, marker.lon);
            return (
              <g key={marker.key} data-testid={`marker-${panel.id}-${marker.key}`}>
                <circle className="marker" cx={at.x} cy={at.y} r={radius(marker.value)}>
                  <title>{`${marker.label}: ${marker.value.toLocaleString('en-US')} ${panel.settings.measure}`}</title>
                </circle>
                {labelled && (
                  <text
                    className="label"
                    x={at.x}
                    y={at.y - radius(marker.value) - 4}
                    textAnchor="middle"
                  >
                    {marker.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
