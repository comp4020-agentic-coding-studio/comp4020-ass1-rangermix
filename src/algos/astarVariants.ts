// Multi-heuristic A* roster (spec §18.4, weighted removed by spec §20.2):
// two named variants sharing ONE admissible base estimate (haversine-to-
// target / a per-graph speed ceiling — see astar.ts's own doc for why the
// ceiling is graph-derived, not a fixed constant), differing only in how
// that estimate is USED:
//
//   straight  — astar.ts's existing astar(), unchanged: key = g + h,
//               h admissible -> exact (equivalence-tested against dijkstra).
//   greedy    — the SAME admissible h as straight, but the search key is h
//               ALONE: `g` is still tracked (needed to report the found
//               route's true cost) but never enters the priority the heap
//               orders by. This genuinely is a different search loop from
//               astar() (greedySearch below), not just a different h, so it
//               keeps its own persistent scratch pool.
//
// bidiAstar.ts reuses makeHeuristic to build its own bidirectional forms:
// straight through the balanced (Ikeda average-function) framework, greedy
// through FIRST-FRONTIER-MEET instead (spec §20.4 — see that file's header
// for why the balanced framework's termination proof needs g+potential
// lower-bound keys throughout, which greedy's h-only key doesn't provide).
import { MinHeap } from "./heap.ts";
import { astar, routeCost } from "./astar";
import type { Graph } from "./graph";
import type { SearchResult } from "./dijkstra";
import { haversine } from "../snap";

export type HeuristicKind = "straight" | "greedy";

/**
 * Builds the heuristic function for one A* variant, bound to a specific
 * query's `to` — same haversine/vMax shape astar.ts's own worker.ts-built
 * `h` always has (`vMax` is the caller's per-graph speed ceiling: worker.ts
 * passes its cached `maxEdgeSpeedMps(graph) * VMAX_SAFETY_MARGIN`;
 * variants.test.ts's synthetic graphs pass the fixed `MAX_SPEED_MPS` they
 * also build their OWN weights from — see astar.ts's doc on why a fixed
 * ceiling isn't safe enough for the real graph but is fine, by
 * construction, for those). "straight" and "greedy" share this IDENTICAL
 * admissible estimate — greedy's disclosed suboptimality comes entirely
 * from astarVariant's h-only priority key (see greedySearch's own doc
 * below) or bidiGreedyFirstMeet's own stopping rule (bidiAstar.ts), never
 * from a different h value here, matching spec §18.4's "direction guided"
 * framing: it still knows the honest direction, it just stops caring how
 * far it has already come. (Before spec §20.2 removed weighted A*, this
 * function's return value DID depend on which kind was passed — scaling h
 * by WEIGHTED_FACTOR for "weighted". With that kind gone, straight and
 * greedy compute the exact same expression, but every caller still passes
 * its kind through the same call shape the roster dispatches on elsewhere.)
 */
export function makeHeuristic(graph: Graph, vMax: number, to: number): (v: number) => number {
  return (v: number) => haversine(graph.lon[v], graph.lat[v], graph.lon[to], graph.lat[to]) / vMax;
}

// Own persistent scratch for greedySearch ONLY — straight delegates to
// astar.ts's astar(), which already has its own pool; this one is
// independent of that (and of dijkstra.ts's, bidijkstra.ts's, bidiAstar.ts's)
// for the same reason every algorithm racing in the same worker keeps its
// own pool (see astar.ts's header comment): greedySearch can run in the
// SAME race as astar-straight (a family bezel may have several active rows
// at once), so sharing a pool would mean one overwriting the other's
// in-flight generation.
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
 * Greedy best-first search: identical relax/settle discipline to astar.ts's
 * astar() (same generation-stamped scratch pattern, same "settle in pop
 * order, never reopen" rule, same relaxed-count semantic: attempted
 * relaxations on not-yet-settled neighbours), but the heap key is h(v)
 * ALONE. `g` (== `dist[v]` here) is still tracked and still gates whether a
 * relaxation improves a node (`d < getDist(v)`) — so `dist[to]` at the end
 * is still a real accumulated edge-weight sum along SOME actual path, never
 * a heuristic value — it just never enters the PRIORITY the heap orders by.
 * That is the entire behavioural difference from astar(): this explores in
 * pure "closest to the target by estimate" order, oblivious to how much it
 * already cost to get there, so it can (and, by design, sometimes does)
 * settle `to` via a longer-than-optimal route — spec §18.4's disclosed
 * "A* — greedy" racer. Kept as its own small function rather than a flag on
 * astar() itself so astar()'s own hot loop — which the EXACT astar-straight
 * variant and every dijkstra-equivalence test depend on staying exactly as
 * it is — never has to branch on it.
 */
function greedySearch(g: Graph, from: number, to: number, h: (v: number) => number): SearchResult {
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
        heap.update(v, h(v)); // priority: h ALONE, never d+h — see this function's own doc
      }
    }
  }
  const path: number[] = [];
  if (to >= 0 && getDist(to) < Infinity) {
    for (let v = to; v !== -1; v = getParent(v)) path.push(v);
    path.reverse();
  }
  return { dist: to >= 0 ? getDist(to) : NaN, path, settled: Uint32Array.from(settled), relaxed };
}

/** `path.length < 2` covers both the unreachable case (empty path — must
 * stay Infinity, and routeCost's own empty-loop would wrongly return 0) and
 * the trivial from===to case (single-node path, cost 0 either way) — in
 * both, there is nothing routeCost needs to recompute. */
function withRecomputedDist(g: Graph, r: SearchResult): SearchResult {
  if (r.path.length < 2) return r;
  return { ...r, dist: routeCost(g.fwd, r.path) };
}

/**
 * Runs one named A* variant and returns its SearchResult, `dist` ALWAYS
 * being the returned route's true recomputed cost (see routeCost and
 * withRecomputedDist above) — never a heap key, for either kind: straight
 * delegates to astar.ts's own astar() (identical search loop — see this
 * file's header comment), greedy uses greedySearch above. Suboptimality is
 * never hidden: for "greedy", `dist` is whatever route THIS variant
 * actually found, exactly as measured — the caller (worker.ts /
 * controller.ts) is what compares it against the always-exact dijkstra/CH
 * result and discloses the gap (spec §18.4's honesty rule).
 */
export function astarVariant(
  kind: HeuristicKind, g: Graph, from: number, to: number, h: (v: number) => number,
): SearchResult {
  const r = kind === "greedy" ? greedySearch(g, from, to, h) : astar(g, from, to, h);
  return withRecomputedDist(g, r);
}
