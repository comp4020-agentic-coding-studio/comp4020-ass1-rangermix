// The shared 12-node toy graph every /how/ chapter draws on top of — built
// with the SAME toyGraph/dijkstra/createContractor code that runs the real
// Canberra race, just small enough to animate by hand. Three rows of four:
// a "highway" runs through the middle (weight 4 per hop — cheaper than the
// weight-6 local streets top and bottom), with weight-3 cross streets tying
// the rows together. That asymmetry is deliberate: it's what makes the
// highway worth cutting through later chapters, exactly like the real map.
//
//   A --- B --- C --- D      (local street, north)
//   |     |     |     |
//   E --- F --- G --- H      (the highway)
//   |     |     |     |
//   I --- J --- K --- L      (local street, south)

import { buildCsr, toyGraph, type Graph } from "../algos/graph";

export const VIEWBOX_W = 460;
export const VIEWBOX_H = 280;
export const VIEWBOX = `0 0 ${VIEWBOX_W} ${VIEWBOX_H}`;

const NAMES = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];

// [from, to, weight] — every entry listed lower-index-first so
// minitownEdges() below can recover this exact list from the built graph.
const EDGES: [number, number, number][] = [
  // top row: local street
  [0, 1, 6], [1, 2, 6], [2, 3, 6],
  // middle row: the highway (cheaper per hop)
  [4, 5, 4], [5, 6, 4], [6, 7, 4],
  // bottom row: local street
  [8, 9, 6], [9, 10, 6], [10, 11, 6],
  // cross streets, top <-> highway
  [0, 4, 3], [1, 5, 3], [2, 6, 3], [3, 7, 3],
  // cross streets, highway <-> bottom
  [4, 8, 3], [5, 9, 3], [6, 10, 3], [7, 11, 3],
];

export const MINITOWN: { graph: Graph; xy: [number, number][]; names: string[] } = {
  graph: toyGraph(12, EDGES, { undirected: true }),
  xy: [
    [60, 60], [180, 60], [300, 60], [420, 60],
    [60, 140], [180, 140], [300, 140], [420, 140],
    [60, 220], [180, 220], [300, 220], [420, 220],
  ],
  names: NAMES,
};

const HIGHWAY_ROW = new Set([4, 5, 6, 7]);

export interface MinitownEdge {
  a: number;
  b: number;
  w: number;
  highway: boolean;
}

/**
 * The undirected edge list, each edge exactly once (a < b), reconstructed
 * from the built graph's CSR rather than kept as a second source of truth —
 * toys draw lines/paths from this instead of re-deriving it themselves.
 */
export function minitownEdges(): MinitownEdge[] {
  const { fwd, n } = MINITOWN.graph;
  const edges: MinitownEdge[] = [];
  for (let u = 0; u < n; u++) {
    for (let s = fwd.firstOut[u]; s < fwd.firstOut[u + 1]; s++) {
      const v = fwd.head[s];
      if (v <= u) continue; // each undirected edge appears twice; keep a<b once
      edges.push({ a: u, b: v, w: fwd.weight[s], highway: HIGHWAY_ROW.has(u) && HIGHWAY_ROW.has(v) });
    }
  }
  return edges;
}

/** Builds a fresh Graph over the 12 minitown nodes from an arbitrary directed edge list — used by toys that need to mutate/replay the graph (e.g. the contraction toy's live shortcut mirror) without touching MINITOWN.graph itself. */
export function graphFromEdges(edges: { from: number; to: number; w: number }[]): Graph {
  return {
    n: MINITOWN.graph.n,
    lon: new Float64Array(MINITOWN.graph.n),
    lat: new Float64Array(MINITOWN.graph.n),
    fwd: buildCsr(MINITOWN.graph.n, edges),
  };
}
