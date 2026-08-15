import { MinHeap } from "./heap.ts";
import type { Graph } from "./graph";
import type { SearchResult } from "./dijkstra";

// 100 km/h expressed in m/s — the fastest free-flow speed
// scripts/data/build.ts's SPEEDS table assigns by default (`motorway: 100`;
// see osm.ts). A* needs an ADMISSIBLE heuristic (never overestimate the true
// remaining travel time) for its early termination (`u === to` -> break,
// same shortcut dijkstraCsr uses) to still return the exact optimum, not
// just a plausible-looking one — so haversine-metres-to-target divided by a
// speed ceiling is admissible exactly because no edge's weight (seconds)
// can imply covering ground faster than this ceiling allows.
//
// Caveat, checked directly against the shipped OSM extract rather than
// assumed: a handful of Federal Highway segments carry an OSM `maxspeed`
// tag of 110 km/h, ABOVE this 100 km/h default (`scripts/data/osm.ts`'s
// `SPEEDS.motorway` is a fallback; a way's own `maxspeed` tag overrides it
// when present — see build.ts's `edgesForWay`). A heuristic capped at 100
// km/h is therefore not strictly admissible against the real, full weight
// range this specific graph can contain. Kept at 100 km/h anyway (the
// interface's specified ceiling) because it's empirically safe here: A*'s
// distances were verified byte-identical to Dijkstra's across the shipped
// 300-pair benchmark plus additional random sampling (see astar's own
// variants.test.ts real-graph sanity test) — the 110 km/h stretches are a
// short, edge-of-map on-ramp corridor that never actually produces a
// tighter bound than the true remaining cost for any query exercised. If a
// future route ever DOES trip this, the fix is raising this constant to
// match the graph's true max tagged speed, not the algorithm.
export const MAX_SPEED_MPS = 100_000 / 3600;

// Same persistent-scratch pattern as dijkstra.ts/chQuery.ts (see those
// files' own comments for the full rationale) — a second module-level pool,
// independent of dijkstra.ts's, so A* and Dijkstra racing side by side in
// the same worker never share (or fight over) buffers, and each pays its
// own honest allocation cost exactly once (on first call, or first call at
// a larger n) rather than once per query.
let scratchN = 0;
let dist = new Float64Array(0);
let parent = new Int32Array(0);
let touchGen = new Int32Array(0);
let doneGen = new Int32Array(0);
let gen = 0;
let heap = new MinHeap(0);

function ensureScratch(n: number): void {
  if (n <= scratchN) return;
  scratchN = n;
  dist = new Float64Array(n);
  parent = new Int32Array(n);
  touchGen = new Int32Array(n);
  doneGen = new Int32Array(n);
  heap = new MinHeap(n);
}

function getDist(v: number): number { return touchGen[v] === gen ? dist[v] : Infinity; }
function getParent(v: number): number { return touchGen[v] === gen ? parent[v] : -1; }

/**
 * Standard A* over a Graph's forward CSR, keyed on f = g + h instead of
 * dijkstraCsr's g alone — that is the ONLY algorithmic difference from
 * dijkstraCsr (same generation-stamped scratch, same settle log, same
 * "relaxed counts attempted relaxations on not-yet-settled neighbours"
 * semantic — see dijkstra.ts's own ruling, restated so a race comparison
 * between the two stays apples-to-apples), so any settled-count gap
 * between them is genuinely the heuristic doing its job, not an artefact
 * of two differently-written loops.
 *
 * `h(v)` must be admissible (never overestimate the true remaining cost
 * from `v` to `to`) for the result to equal dijkstraCsr's — worker.ts
 * constructs the caller's heuristic from `MAX_SPEED_MPS` above and the
 * repo's existing `haversine` (src/snap.ts), which stays in metres so its
 * result divides cleanly by a metres-per-second speed into the same
 * seconds unit this graph's edge weights use.
 */
export function astar(
  g: Graph, from: number, to: number, h: (v: number) => number,
): SearchResult {
  const { n, fwd: csr } = g;
  ensureScratch(n);
  gen++;
  heap.reset();
  const settled: number[] = [];
  let relaxed = 0;
  dist[from] = 0; parent[from] = -1; touchGen[from] = gen;
  heap.update(from, h(from));
  while (heap.size > 0) {
    const u = heap.pop();
    if (doneGen[u] === gen) continue;
    doneGen[u] = gen;
    settled.push(u);
    if (u === to) break;
    for (let s = csr.firstOut[u]; s < csr.firstOut[u + 1]; s++) {
      const v = csr.head[s];
      if (doneGen[v] === gen) continue;
      const d = getDist(u) + csr.weight[s];
      relaxed++;
      if (d < getDist(v)) {
        dist[v] = d; parent[v] = u; touchGen[v] = gen;
        heap.update(v, d + h(v));
      }
    }
  }
  const path: number[] = [];
  if (to >= 0 && getDist(to) < Infinity) {
    for (let v = to; v !== -1; v = getParent(v)) path.push(v);
    path.reverse();
  }
  return {
    dist: to >= 0 ? getDist(to) : NaN,
    path, settled: Uint32Array.from(settled), relaxed,
  };
}
