// The toytown artifact area — a Canberra city-centre drivable subgraph
// every /how/ toy runs on — F5 rewired all four toys onto this;
// minitown.ts's old hand-made 12-node graph is gone. Cut from the SAME
// cached Overpass extract as the main Canberra graph
// (scripts/data/build.ts's emitToytown()), through the identical
// drivable-filter -> largest-SCC -> chain-contraction pipeline, just
// bboxed down first — see that function's own comment for the bbox tuning
// story and node/edge counts.
//
// Unlike MINITOWN (a hand-built, always-undirected toy graph — see
// minitown.ts's `toyGraph(..., { undirected: true })`), this is a REAL
// subgraph: one-ways are real, so the graph this module builds is
// DIRECTED. Every toy algorithm in src/algos/ (dijkstra, chBuild, chQuery)
// already handles directed graphs fine — MINITOWN's undirected-ness was a
// simplification for a hand-drawn graph, never a requirement of the
// algorithms — so decodeToytown below does not symmetrize the edge list.

import { buildCsr, type Graph } from "../algos/graph";
import { fitTransform, projectPoint, type Transform } from "../viz/mapRenderer";
import { loadToytown as fetchToytownArtifact, type ToytownArtifact } from "../data";

export type { ToytownArtifact };

export const VIEWBOX_W = 460;
export const VIEWBOX_H = 300;
export const VIEWBOX = `0 0 ${VIEWBOX_W} ${VIEWBOX_H}`;
// Matches src/viz/mapRenderer.ts's own (private) PAD — the real map's
// margin convention, reused here so the toy reads consistently with it.
const PAD = 24;

const COORD_SCALE = 1e5; // matches scripts/data/build.ts's emitToytown + routing.json's scheme

/** What F5's toys need: the routable directed Graph, a screen-space layout
 * (`xy`, one point per node, fitted into a VIEWBOX_W x VIEWBOX_H viewBox),
 * per-edge projected geometry for drawing real street shapes (parallel to
 * `graph.fwd`'s edge order is NOT assumed — index into this by the same
 * position you'd index the original artifact's `edges` array, i.e. this
 * mirrors `graph`'s edges 1:1 in the ORIGINAL (pre-CSR-reordering) order),
 * and the geographic `bbox` the layout was fitted from (so a caller can
 * re-derive the same projection, e.g. to place a click target). */
export interface Toytown {
  graph: Graph;
  xy: [number, number][];
  edgeGeometry: [number, number][][];
  bbox: [number, number, number, number];
}

/** Pure decode: dequantizes a ToytownArtifact into a ready-to-use directed
 * Graph, PLUS a screen-space layout (xy per node, projected edge geometry)
 * fitted into a 460x300 viewBox via mapRenderer's own fitTransform /
 * projectPoint — the exact same projection math the home page's real map
 * uses, so there's no second geo -> screen implementation to keep in sync.
 * No fetch, no DOM: unit-tested directly in toytown.test.ts against an
 * in-memory artifact, and reused by spec/data.test.ts's toytown sensors on
 * the Node side against the real committed artifact. */
export function decodeToytown(a: ToytownArtifact): Toytown {
  const [minLon, minLat] = a.bbox;
  const lon = new Float64Array(a.n);
  const lat = new Float64Array(a.n);
  for (let i = 0; i < a.n; i++) {
    lon[i] = minLon + a.lon[i] / COORD_SCALE;
    lat[i] = minLat + a.lat[i] / COORD_SCALE;
  }
  const csrEdges = a.edges.map((e) => ({ from: e.from, to: e.to, w: e.w / 10 }));
  const graph: Graph = { n: a.n, lon, lat, fwd: buildCsr(a.n, csrEdges) };

  const fit: Transform = fitTransform(a.bbox, VIEWBOX_W, VIEWBOX_H, PAD);
  // Dequantize-then-project a raw [qx, qy] pair from the artifact's integer
  // grid straight to screen space, in one step — used for both node coords
  // (a.lon/a.lat) and edge geometry points (a.edges[i].geometry), which
  // share the exact same quantization scheme (see build.ts's emitToytown).
  const toScreen = (qx: number, qy: number): [number, number] =>
    projectPoint(a.bbox, fit, minLon + qx / COORD_SCALE, minLat + qy / COORD_SCALE);

  const xy: [number, number][] = [];
  for (let i = 0; i < a.n; i++) xy.push(toScreen(a.lon[i], a.lat[i]));
  const edgeGeometry: [number, number][][] = a.edges.map((e) => e.geometry.map(([qx, qy]) => toScreen(qx, qy)));

  return { graph, xy, edgeGeometry, bbox: a.bbox };
}

/** Fetches + decodes public/data/toytown.json in one call — the loader F5's
 * toys will import. Thin composition of src/data.ts's raw fetch
 * (loadToytown there, aliased on import above to avoid shadowing this
 * module's own export of the same name) and decodeToytown above; kept as
 * two steps so decodeToytown stays fetch-free and directly unit-testable. */
export async function loadToytown(base = "./data/"): Promise<Toytown> {
  return decodeToytown(await fetchToytownArtifact(base));
}
