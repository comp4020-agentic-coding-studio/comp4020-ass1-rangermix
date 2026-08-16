import { MinHeap } from "./heap.ts";
import type { Csr, Graph } from "./graph";
import type { SearchResult } from "./dijkstra";
import { haversine } from "../snap";

// 100 km/h expressed in m/s. A* needs an ADMISSIBLE heuristic (never
// overestimate the true remaining travel time) for its early termination
// (`u === to` -> break, same shortcut dijkstraCsr uses) to still return the
// exact optimum, not just a plausible-looking one — so haversine-metres-
// to-target divided by a speed ceiling is admissible exactly because no
// edge's weight (seconds) can imply covering ground faster than that
// ceiling allows — PROVIDED the ceiling is actually true for every edge.
//
// A fixed 100 km/h is NOT that, on the real shipped graph: an exhaustive
// scan of every one of routing.json's 59,961 original edges found 66
// exceeding 100 km/h — a genuine 110 km/h Federal Highway corridor (OSM
// `maxspeed` tags override `scripts/data/osm.ts`'s `SPEEDS.motorway`
// default; see build.ts's `edgesForWay`), plus a coordinate-quantization
// artifact peaking near 153 km/h on one 4.3 m segment (short enough that
// its rounded-to-the-shipped-grid endpoints distort the implied speed).
// Worst-case single-edge heuristic overestimate against a fixed 100 km/h
// ceiling: 5.36 s — small, but a real, provable inadmissibility, not a
// theoretical one. So this constant is NOT what the real graph uses
// (worker.ts derives a per-graph ceiling from `maxEdgeSpeedMps` below
// instead, which is provably safe against whatever the data actually
// contains). MAX_SPEED_MPS stays exported and useful for exactly the case
// where a fixed constant IS safe: a caller who builds BOTH a toy graph's
// weights AND its heuristic from the same assumed ceiling (variants.test.ts's
// synthetic oracle graphs do this — admissible by construction, no real-
// world speed data involved, so a fixed constant can't go stale on them).
export const MAX_SPEED_MPS = 100_000 / 3600;

// Safety margin multiplied onto a graph's own observed max edge speed
// before using it as a heuristic ceiling (see maxEdgeSpeedMps) — guards
// against the ceiling landing exactly ON the true max, which would still
// be admissible in exact arithmetic but leaves zero room for the
// haversine/weight division's own floating-point rounding.
export const VMAX_SAFETY_MARGIN = 1.01;

/**
 * The fastest true speed (great-circle metres between an edge's two
 * endpoints, divided by the edge's own weight-in-seconds) among every edge
 * in `g.fwd` — a per-graph heuristic ceiling that's PROVABLY safe against
 * THAT graph's actual data, rather than an assumed constant (see
 * MAX_SPEED_MPS's doc above for why a fixed 100 km/h measurably wasn't).
 * `g.fwd` is always original-edges-only for the real graph (data-node.ts's
 * `graphFromArtifact` drops CH shortcuts before building the CSR), so no
 * separate origin/shortcut filtering is needed here — every edge in
 * `g.fwd` already IS an original one. Callers should compute this ONCE per
 * graph (a single O(edges) scan) and reuse it — worker.ts caches it
 * exactly the way it already caches `gRev`, next to it.
 */
export function maxEdgeSpeedMps(g: Graph): number {
  const { n, fwd: csr, lon, lat } = g;
  let max = 0;
  for (let u = 0; u < n; u++) {
    for (let s = csr.firstOut[u]; s < csr.firstOut[u + 1]; s++) {
      const w = csr.weight[s];
      if (w <= 0) continue; // guard: a zero/negative weight would divide-by-zero or invert the comparison
      const v = csr.head[s];
      const speed = haversine(lon[u], lat[u], lon[v], lat[v]) / w;
      if (speed > max) max = speed;
    }
  }
  return max;
}

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
 * from `v` to `to`) for the result to equal dijkstraCsr's — this function
 * takes `h` as a plain parameter and stays agnostic to how the caller
 * derives it. worker.ts builds it from `haversine` (src/snap.ts, stays in
 * metres so it divides cleanly by a metres-per-second speed into the same
 * seconds unit this graph's edge weights use) over a per-graph ceiling
 * from `maxEdgeSpeedMps` above (not the fixed `MAX_SPEED_MPS` — see that
 * constant's own doc for why a fixed ceiling isn't safe enough for the
 * real graph); variants.test.ts's synthetic oracle graphs use the fixed
 * `MAX_SPEED_MPS` instead, which is fine there since they also build
 * their OWN weights from it (admissible by construction either way).
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

/**
 * Recomputes a path's true cost by summing each hop's CHEAPEST original
 * edge weight straight from the CSR (parallel edges collapse to their
 * minimum — the same rule the relax loop above already applies, so this
 * can never disagree with what a correct search actually accumulated)
 * rather than trusting a value the search loop carried as a side effect of
 * its own priority-queue bookkeeping. `dist[]` inside astar() above (and,
 * built the same way, astarVariants.ts's greedySearch and bidiAstar.ts) is
 * ALREADY exactly this sum by construction — parent pointers are only ever
 * set alongside a real edge-weight addition, never a heap's key (g+h, or
 * for astarVariant's greedy form, h alone) — so routing an EXACT variant's
 * `dist` through this function changes nothing about its value. It exists
 * for the INEXACT variants (weighted/greedy, single- and bidirectional):
 * spec §18.4's honesty rule ("+X% longer route") depends on those numbers
 * being right, so astarVariants.ts and bidiAstar.ts both route their
 * returned `dist` through this rather than trust an upstream accumulator
 * that a future refactor could accidentally disconnect from the heap key
 * it's meant to be independent of. O(hops * avg out-degree) — negligible
 * next to the search itself, and routes stay short even on the real graph.
 */
export function routeCost(csr: Csr, path: readonly number[]): number {
  let total = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const u = path[i];
    const v = path[i + 1];
    let best = Infinity;
    for (let s = csr.firstOut[u]; s < csr.firstOut[u + 1]; s++) {
      if (csr.head[s] === v && csr.weight[s] < best) best = csr.weight[s];
    }
    total += best; // stays Infinity only if `path` used a non-existent edge — a bug elsewhere, not something to mask
  }
  return total;
}
