import { MinHeap } from "./heap.ts";
import type { Csr, Graph } from "./graph";
import type { SearchResult } from "./dijkstra";
import { routeCost } from "./astar";
import { makeHeuristic, type HeuristicKind } from "./astarVariants";

// Scratch — IDENTICAL shape/discipline to bidijkstra.ts's own `Scratch`
// (see that file's header comment for the full rationale: two independent
// directions, since climb-from-`from` reads the OTHER direction's
// dist/done mid-search for the meeting-point check while writing its own),
// but its own module-level pool — bidiAstar races alongside bidijkstra,
// astar/astarVariant, and CH in the same worker and must pay its own
// honest allocation cost exactly once, never share buffers with (or
// free-ride on) any other algorithm's pool.
interface Scratch {
  dist: Float64Array; parent: Int32Array;
  touchGen: Int32Array; doneGen: Int32Array; heap: MinHeap;
}

function makeScratch(n: number): Scratch {
  return {
    dist: new Float64Array(n), parent: new Int32Array(n),
    touchGen: new Int32Array(n), doneGen: new Int32Array(n),
    heap: new MinHeap(n),
  };
}

let scratchN = 0;
let fwdS = makeScratch(0);
let bwdS = makeScratch(0);
let gen = 0;

function ensureScratch(n: number): void {
  if (n <= scratchN) return;
  scratchN = n;
  fwdS = makeScratch(n);
  bwdS = makeScratch(n);
}

function getDist(s: Scratch, v: number): number { return s.touchGen[v] === gen ? s.dist[v] : Infinity; }
function getParent(s: Scratch, v: number): number { return s.touchGen[v] === gen ? s.parent[v] : -1; }
function isDone(s: Scratch, v: number): boolean { return s.doneGen[v] === gen; }

/** Identical trick to bidijkstra.ts's own peekKey — see that file's doc for
 * why pop-read-reinsert reads a MinHeap's minimum key without consuming it
 * (MinHeap has no native peek), and why O(log n) here is fine (runs at
 * most twice per outer-loop iteration, never inside the per-edge relax
 * loop). */
function peekKey(h: MinHeap): number {
  if (h.size === 0) return Infinity;
  const id = h.pop();
  const k = h.key(id);
  h.update(id, k);
  return k;
}

/**
 * One direction's settle step — structurally IDENTICAL to bidijkstra.ts's
 * own step() for everything that keeps `best.d` honest: the settle-time
 * and relax-time meeting checks always compare `getDist(...)`, the TRUE
 * accumulated g on each side, NEVER a potential-shifted key (same
 * "dist[] holds truth, key holds priority" split astarVariant.ts's greedy
 * form relies on) — so `best.d` is always a real route's real cost, for
 * every `kind`, exact or not. The ONLY difference from bidijkstra's
 * step(): what gets handed to `heap.update` — `g + potential(v)` normally,
 * or `potential(v)` ALONE when `greedy` (mirroring astarVariant's own
 * greedy: `g` still gates whether a relaxation improves a node, it just
 * never enters the heap's priority).
 */
function step(
  csr: Csr, s: Scratch, other: Scratch, settled: number[],
  best: { d: number; meet: number }, counters: { relaxed: number },
  potential: (v: number) => number, greedy: boolean,
): void {
  const u = s.heap.pop();
  if (isDone(s, u)) return; // defensive: this MinHeap never actually re-queues a done id
  s.doneGen[u] = gen;
  settled.push(u);
  if (isDone(other, u) && getDist(s, u) + getDist(other, u) < best.d) {
    best.d = getDist(s, u) + getDist(other, u);
    best.meet = u;
  }
  for (let e = csr.firstOut[u]; e < csr.firstOut[u + 1]; e++) {
    const v = csr.head[e];
    if (isDone(s, v)) continue;
    const d = getDist(s, u) + csr.weight[e];
    counters.relaxed++;
    if (d < getDist(s, v)) {
      s.dist[v] = d; s.parent[v] = u; s.touchGen[v] = gen;
      s.heap.update(v, greedy ? potential(v) : d + potential(v));
      if (isDone(other, v) && d + getDist(other, v) < best.d) {
        best.d = d + getDist(other, v);
        best.meet = v;
      }
    }
  }
}

/**
 * Balanced bidirectional A* (Ikeda et al.'s "average function" method):
 * forward search over `g.fwd` from `from`, backward over `gRev` from `to`,
 * TRUE interleaving exactly like bidijkstra() (see that function's own doc
 * for why sequential-then-merge would settle needlessly many nodes here,
 * unlike chQuery.ts's CH, which has rank-hierarchy pruning bidijkstra/
 * bidiAstar don't). The trick that makes a NAIVE pair of forward/backward
 * heuristics viable together: rather than running plain A* twice (forward
 * toward `to`, backward toward `from`) with two heuristics that pull
 * against each other in the middle of the graph, both directions share ONE
 * pair of POTENTIALS built from the SAME two base estimates:
 *
 *   h_t(v) = kind-scaled estimate of v's remaining distance to `to`
 *            (astarVariants.ts's own makeHeuristic, called with `to`)
 *   h_s(v) = the SYMMETRIC estimate of v's distance FROM `from` (the same
 *            makeHeuristic, called with `from` standing in for "the
 *            target" — valid because the underlying haversine/vMax
 *            estimate is symmetric in its two endpoints: "estimated time
 *            from v to X" and "estimated time from X to v" are the same
 *            expression either way round)
 *   p_f(v) = (h_t(v) - h_s(v)) / 2      -- forward potential
 *   p_b(v) = (h_s(v) - h_t(v)) / 2      -- backward potential, = -p_f(v)
 *
 * forward key = g_f(v) + p_f(v); backward key = g_b(v) + p_b(v) (or, for
 * `kind === "greedy"`, the potential alone — see step()'s own doc). This is
 * "Ikeda's average function": p_f and p_b are mirror images of each other
 * (p_b = -p_f pointwise, by construction, for every node, not just at `from`
 * /`to`) rather than two independently-built heuristics, and that single
 * fact is what the termination proof below turns on.
 *
 * PROOF NOTE — exactness for kind="straight", and why the termination check
 * needs NO correction term added to `best.d` (unlike a naively-paired
 * potential might), mirroring bidijkstra.ts's own proof-note in structure:
 *
 * Consistency of p_f/p_b: for kind="straight", h_t and h_s are both
 * haversine(v, X)/vMax for some fixed X (`to` or `from`). Great-circle
 * distance is a true metric (triangle inequality), so for any edge (u,v):
 * |h_t(v) - h_t(u)| <= haversine(u,v)/vMax, and that same quantity is <=
 * w(u,v) by construction (vMax is a per-graph speed CEILING — see astar.ts's
 * own doc on maxEdgeSpeedMps for why that makes haversine/vMax admissible).
 * The identical bound holds for h_s. Combining both for p_f(v) - p_f(u) =
 * ((h_t(v)-h_t(u)) - (h_s(v)-h_s(u))) / 2 <= (w(u,v) + w(u,v)) / 2 = w(u,v):
 * p_f is therefore a CONSISTENT heuristic for the forward search in exactly
 * astar.ts's own sense, and p_b is consistent for the backward search over
 * `gRev` by the symmetric argument. Consistency is what makes the standard
 * A* fact apply to EACH direction on its own: when a node is popped, its
 * accumulated g already equals its true shortest-path distance (same
 * guarantee astar.ts's own equivalence tests already exercise for plain
 * astar()); and for any node v NOT YET popped on that side, its TRUE
 * reduced distance (true-g(v) + potential(v)) is >= that side's current
 * top key — because if the search continued until v was eventually popped,
 * that pop's key would equal true-g(v)+potential(v) exactly (consistency),
 * and successive pops' keys never decrease, so that eventual value can't be
 * below the CURRENT top.
 *
 * Now let m be ANY node on some shortest `from`->`to` path (so
 * d_f(m) + d_b(m) = d* exactly, shortest-path subpaths are shortest), chosen
 * — whenever the loop hasn't already terminated via the "both done" case
 * below — to be NOT YET done on EITHER side (such an m must exist: if every
 * path node were done on both sides, the settle-time check inside step()
 * already forced best.d <= d* the moment the second side finished it,
 * combined with best.d always being a real path's cost i.e. >= d*, giving
 * best.d = d* immediately, same "best is a real path, can't beat optimal"
 * argument bidijkstra.ts's own proof uses). Applying the not-yet-popped
 * bound to m on BOTH sides and summing:
 *
 *   (d_f(m) + p_f(m)) >= topF        (m undone forward)
 *   (d_b(m) + p_b(m)) >= topB        (m undone backward)
 *   ---------------------------------------------------
 *   (d_f(m)+d_b(m)) + (p_f(m)+p_b(m)) >= topF + topB
 *
 * p_f(m) + p_b(m) = 0 EXACTLY, for every m, by construction (p_b := -p_f
 * pointwise — this cancellation, not any per-query coincidence, is the
 * entire point of building the pair as an "average function" rather than
 * two independent heuristics) — so the left side collapses to plain d*:
 *
 *   d* >= topF + topB,  i.e. topF + topB <= d*  ALWAYS.
 *
 * Combined with best.d >= d* always (best.d is only ever a real path's
 * cost through some done-both node), the loop's `topF + topB >= best.d`
 * check can only pass once best.d has already reached d* exactly (three-way
 * sandwich: d* >= topF+topB, and topF+topB >= best.d >= d*, forces
 * equality throughout) — never before. No correction term is added because
 * none is needed: a NAIVELY paired p_f/p_b (built independently rather than
 * as negatives of each other) would generally leave a nonzero
 * p_f(m)+p_b(m) residue here, and WOULD need one; the symmetric
 * construction is specifically what makes it vanish, so this reduces to
 * exactly bidijkstra.ts's own unmodified stopping rule.
 *
 * kind="weighted"/"greedy": h_t/h_s get WEIGHTED_FACTOR-scaled (weighted)
 * or the search key drops g (greedy) — either way p_f is no longer
 * consistent (weighted: the |...| <= w(u,v) bound above no longer holds
 * once scaled past 1x; greedy: the proof above assumes a g+potential key
 * throughout). Exactness is NOT claimed for either — this function still
 * terminates (the `while` guard is the same "both heaps eventually empty"
 * safety net bidijkstra.ts has, independent of the proof above) and still
 * returns a real, connected route, just not necessarily the shortest one;
 * `dist` is independently recomputed from the returned path (routeCost,
 * below) rather than trusted from `best.d`'s own bookkeeping, so a
 * suboptimal bidi variant's reported number is still honest even though
 * it isn't optimal (spec §18.4's honesty rule; disclosure itself is
 * controller.ts's job, computed by comparing this `dist` against
 * dijkstra/CH's).
 */
export function bidiAstar(
  kind: HeuristicKind, g: Graph, gRev: Csr, from: number, to: number, vMax: number,
): SearchResult {
  ensureScratch(g.n);
  gen++;
  fwdS.heap.reset();
  bwdS.heap.reset();
  const settled: number[] = [];
  const counters = { relaxed: 0 };
  const best = { d: Infinity, meet: -1 };
  const greedy = kind === "greedy";

  const hT = makeHeuristic(kind, g, vMax, to);
  const hS = makeHeuristic(kind, g, vMax, from);
  const pf = (v: number) => (hT(v) - hS(v)) / 2;
  const pb = (v: number) => (hS(v) - hT(v)) / 2; // = -pf(v) pointwise — see this function's own proof note

  fwdS.dist[from] = 0; fwdS.parent[from] = -1; fwdS.touchGen[from] = gen;
  fwdS.heap.update(from, pf(from)); // g=0 at the seed, so g+pf(from) === pf(from) either way (greedy or not)
  bwdS.dist[to] = 0; bwdS.parent[to] = -1; bwdS.touchGen[to] = gen;
  bwdS.heap.update(to, pb(to));

  while (fwdS.heap.size > 0 || bwdS.heap.size > 0) {
    if (best.d < Infinity) {
      const topF = peekKey(fwdS.heap);
      const topB = peekKey(bwdS.heap);
      if (topF + topB >= best.d) break;
    }
    const sizeF = fwdS.heap.size;
    const sizeB = bwdS.heap.size;
    const useForward = sizeB === 0 ? true : sizeF === 0 ? false : sizeF <= sizeB;
    if (useForward) step(g.fwd, fwdS, bwdS, settled, best, counters, pf, greedy);
    else step(gRev, bwdS, fwdS, settled, best, counters, pb, greedy);
  }

  let path: number[] = [];
  if (best.meet !== -1) {
    // Same up/down reconstruction as bidijkstra.ts's own (see that
    // function's comment): forward half needs reversing (parentF points
    // "backward"), backward half doesn't (built over gRev, so parentB
    // already points TOWARD `to` in original-graph order).
    const up: number[] = [];
    for (let v = best.meet; v !== -1; v = getParent(fwdS, v)) up.push(v);
    up.reverse();
    const dn: number[] = [];
    let v = best.meet;
    while (v !== to) {
      const next = getParent(bwdS, v);
      if (next === -1) break; // defensive: shouldn't happen for a valid meet
      dn.push(next);
      v = next;
    }
    path = [...up, ...dn];
  }

  // dist: ALWAYS the recomputed true cost of the returned path, never
  // best.d's own meeting-point bookkeeping directly — see routeCost's doc
  // and this function's proof note above. `path.length < 2` covers both
  // "no meet found" (empty path — must stay best.d, which is Infinity
  // there) and the trivial from===to case (single-node path, cost 0
  // either way).
  const dist = path.length >= 2 ? routeCost(g.fwd, path) : best.d;
  return { dist, path, settled: Uint32Array.from(settled), relaxed: counters.relaxed };
}
