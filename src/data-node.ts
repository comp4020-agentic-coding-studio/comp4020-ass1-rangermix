// Pure decode functions for the routing.json artifact — no fetch, no DOM.
// Shared by spec/data.test.ts (this repo's own equivalence/budget sensors)
// and, from Task 6 onward, the browser loader (src/data.ts): both just hand
// the already-parsed JSON to graphFromArtifact/chFromArtifact and get back
// the same typed, CSR-backed Graph/Ch the algorithms in src/algos/ expect.
//
// routing.json's parallel arrays (from/to/w/childA/childB/src/rank/renderOf)
// hold the FULL augmented ChEdge list build.ts's emit() produced: originals
// first (childA < 0, src = index into render.json's `lines`), then CH
// shortcuts (childA/childB = indices of their two child edges within this
// SAME array, src = -1). `n`, `rank`, and `renderOf` are parallel to that
// same array too, except `renderOf` (see graphFromArtifact's comment).
//
// Coordinates ship as integers on a 1e-5°-per-unit grid relative to
// routing.bbox's [minLon, minLat] corner — the exact scheme render.json's
// `lines` use for their own points (see build.ts's emit()), so a routed
// path's node coordinates land on the same pixels as the rendered road
// network. Dequantizing needs that bbox, which is why routing.json carries
// its own copy rather than only render.json.

import { buildCsr, type Graph } from "./algos/graph";
import type { Ch, ChEdge } from "./algos/chBuild";

/** The exact shape build.ts's emit() writes to public/data/routing.json. */
export interface RoutingArtifact {
  n: number;
  bbox: [number, number, number, number];
  lon: number[];
  lat: number[];
  from: number[];
  to: number[];
  w: number[];
  childA: number[];
  childB: number[];
  src: number[];
  rank: number[];
  renderOf: number[];
}

const COORD_SCALE = 1e5;

/** Rebuilds the original-edges-only Graph (the one Dijkstra, and the CH
 * build itself, ran on) from the `childA < 0` rows of the augmented arrays.
 *
 * `fwd.edge[]` normally means "index into whatever edge list buildCsr was
 * given" — here that's deliberately NOT a fresh 0..originalCount-1
 * range, but the row's index within the FULL AUGMENTED arrays (routing.from
 * etc.), i.e. exactly what routing.src[]/routing.renderOf[] are keyed by.
 * That keeps one index space for "which original edge is this", so e.g. a
 * renderer walking a Dijkstra path's edges can look up
 * `routing.renderOf[graph.fwd.edge[slot]]` directly, with no separate
 * remapping table. */
export function graphFromArtifact(routing: RoutingArtifact): Graph {
  const { n } = routing;
  const [minLon, minLat] = routing.bbox;
  const lon = new Float64Array(n);
  const lat = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    lon[i] = minLon + routing.lon[i] / COORD_SCALE;
    lat[i] = minLat + routing.lat[i] / COORD_SCALE;
  }

  const originalIdx: number[] = [];
  for (let i = 0; i < routing.childA.length; i++)
    if (routing.childA[i] < 0) originalIdx.push(i);
  const csrInput = originalIdx.map((i) => ({
    from: routing.from[i], to: routing.to[i], w: routing.w[i] / 10,
  }));
  const fwd = buildCsr(n, csrInput);
  // buildCsr numbered edges 0..originalIdx.length-1 in csrInput order; remap
  // those back to augmented-array indices per the comment above.
  const remapped = new Int32Array(fwd.edge.length);
  for (let s = 0; s < fwd.edge.length; s++) remapped[s] = originalIdx[fwd.edge[s]];

  return { n, lon, lat, fwd: { ...fwd, edge: remapped } };
}

/** Rebuilds the Ch (rank + up/downRev CSRs over ALL augmented edges),
 * partitioned EXACTLY as buildChOrdered's own post-contraction loop does in
 * src/algos/chBuild.ts — skip self-loops; rank[to] > rank[from] -> up
 * (forward orientation); otherwise -> downRev (stored reversed, keyed by
 * `to`). Mirrored verbatim (not just "equivalent logic") so the builder and
 * this loader can never quietly disagree about which edge goes where. */
export function chFromArtifact(routing: RoutingArtifact): Ch {
  const { n } = routing;
  const rank = Int32Array.from(routing.rank);
  const edges: ChEdge[] = routing.from.map((from, i) => ({
    from,
    to: routing.to[i],
    w: routing.w[i] / 10,
    childA: routing.childA[i],
    childB: routing.childB[i],
    src: routing.src[i],
  }));

  // --- verbatim copy of buildChOrdered's partition loop (chBuild.ts) ---
  const upE: { from: number; to: number; w: number }[] = [];
  const upIdx: number[] = [];
  const dnE: { from: number; to: number; w: number }[] = [];
  const dnIdx: number[] = [];
  edges.forEach((e, i) => {
    if (e.from === e.to) return;
    if (rank[e.to] > rank[e.from]) { upE.push({ from: e.from, to: e.to, w: e.w }); upIdx.push(i); }
    else { dnE.push({ from: e.to, to: e.from, w: e.w }); dnIdx.push(i); } // reversed
  });
  const up = buildCsr(n, upE);
  const upEdge = new Int32Array(up.edge.length);
  for (let i = 0; i < up.edge.length; i++) upEdge[i] = upIdx[up.edge[i]];
  const downRev = buildCsr(n, dnE);
  const dnEdge = new Int32Array(downRev.edge.length);
  for (let i = 0; i < downRev.edge.length; i++) dnEdge[i] = dnIdx[downRev.edge[i]];
  // --- end verbatim copy ---

  return { n, rank, edges, up: { ...up, edge: upEdge }, downRev: { ...downRev, edge: dnEdge } };
}
