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
// free-ride on) any other algorithm's pool. Shared here between BOTH
// bidiAstarBalanced and bidiGreedyFirstMeet below (two genuinely different
// algorithms, see bidiAstar()'s own doc) since a query only ever runs one
// of them at a time, synchronously.
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
 * loop). Used only by bidiAstarBalanced's termination check below —
 * bidiGreedyFirstMeet needs no upper-bound peek at all (see its own doc). */
function peekKey(h: MinHeap): number {
  if (h.size === 0) return Infinity;
  const id = h.pop();
  const k = h.key(id);
  h.update(id, k);
  return k;
}

/**
 * One direction's settle step for the balanced framework — structurally
 * IDENTICAL to bidijkstra.ts's own step() for everything that keeps
 * `best.d` honest: the settle-time and relax-time meeting checks always
 * compare `getDist(...)`, the TRUE accumulated g on each side, NEVER a
 * potential-shifted key — so `best.d` is always a real route's real cost.
 * The ONLY difference from bidijkstra's step(): what gets handed to
 * `heap.update` is `g + potential(v)`, not `d` alone — the Ikeda-potential
 * key bidiAstarBalanced's own termination proof depends on throughout.
 * (Greedy's bidirectional form no longer calls this function at all, and
 * never did after spec §20.4's rewrite — see stepFirstMeet/
 * bidiGreedyFirstMeet below for its own, unrelated step function and key.)
 */
function step(
  csr: Csr, s: Scratch, other: Scratch, settled: number[],
  best: { d: number; meet: number }, counters: { relaxed: number },
  potential: (v: number) => number,
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
      s.heap.update(v, d + potential(v));
      if (isDone(other, v) && d + getDist(other, v) < best.d) {
        best.d = d + getDist(other, v);
        best.meet = v;
      }
    }
  }
}

/**
 * Balanced bidirectional A* (Ikeda et al.'s "average function" method), for
 * kind="straight" ONLY (spec §20.2/.4 — see bidiAstar()'s own doc below for
 * why greedy no longer reaches this function at all): forward search over
 * `g.fwd` from `from`, backward over `gRev` from `to`, TRUE interleaving
 * exactly like bidijkstra() (see that function's own doc for why sequential-
 * then-merge would settle needlessly many nodes here, unlike chQuery.ts's
 * CH, which has rank-hierarchy pruning bidijkstra/bidiAstar don't). The
 * trick that makes a NAIVE pair of forward/backward heuristics viable
 * together: rather than running plain A* twice (forward toward `to`,
 * backward toward `from`) with two heuristics that pull against each other
 * in the middle of the graph, both directions share ONE pair of POTENTIALS
 * built from the SAME two base estimates:
 *
 *   h_t(v) = the admissible estimate of v's remaining distance to `to`
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
 * forward key = g_f(v) + p_f(v); backward key = g_b(v) + p_b(v) —
 * unconditionally (see bidiGreedyFirstMeet below for greedy's own,
 * differently-shaped key). This is "Ikeda's average function": p_f and p_b
 * are mirror images of each other (p_b = -p_f pointwise, by construction,
 * for every node, not just at `from`/`to`) rather than two independently-
 * built heuristics, and that single fact is what the termination proof
 * below turns on.
 *
 * PROOF NOTE — exactness for kind="straight", and why the termination check
 * needs NO correction term added to `best.d` (unlike a naively-paired
 * potential might), mirroring bidijkstra.ts's own proof-note in structure:
 *
 * Consistency of p_f/p_b: h_t and h_s are both haversine(v, X)/vMax for
 * some fixed X (`to` or `from`). Great-circle distance is a true metric
 * (triangle inequality), so for any edge (u,v): |h_t(v) - h_t(u)| <=
 * haversine(u,v)/vMax, and that same quantity is <= w(u,v) by construction
 * (vMax is a per-graph speed CEILING — see astar.ts's own doc on
 * maxEdgeSpeedMps for why that makes haversine/vMax admissible). The
 * identical bound holds for h_s. Combining both for p_f(v) - p_f(u) =
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
 * (I3 gate note — the same adjacent-frontiers boundary case bidijkstra.ts's
 * own step() doc now spells out in full, restated here in this function's
 * own terms: best.d reaching d* does NOT require any node to be
 * independently settled on both sides. Suppose forward settles some node u
 * on a shortest from->to path whose immediate successor v (real edge
 * (u, v)) is ALREADY done backward, while u itself is not done backward
 * and v is not done forward — no node done on both sides yet at all, the
 * frontiers are merely adjacent across this one edge. step()'s settle-time
 * check (`isDone(other, u)`) does not fire for u here. But settling u
 * relaxes (u, v): the TRUE accumulated cost g_f(u) + w(u, v) equals v's
 * true forward cost exactly (consecutive nodes on a shortest path, u's own
 * g already final once settled), and `isDone(other, v)` is true, so the
 * RELAX-time check fires with a candidate that sums to d* exactly — same
 * mechanism, same conclusion. This is the typical way best.d reaches d* in
 * practice, here exactly as in bidijkstra.ts.)
 *
 * This function is now called ONLY for kind="straight" (spec §20.2/.4):
 * weighted was removed from the roster entirely, and greedy's bidirectional
 * form no longer runs through this framework at all — measured on the real
 * Canberra graph (K2's diagnosis, see the routes-round report), running
 * greedy's h-only key through THIS SAME g+potential-shaped termination
 * bound settled 101-103% of the graph's node count combined across both
 * directions (1.3x-4.4x more than plain dijkstra on the same query, 118x-
 * 308x more than the plain unidirectional greedy racer), because the
 * "Consistency of p_f/p_b" step above and everything built on it assumes a
 * g+potential key throughout — greedy's key is potential ALONE, so there is
 * no g term left for the not-yet-popped bound to anchor to, and
 * `topF + topB >= best.d` almost never fires before both frontiers have
 * nearly exhausted the graph. bidiGreedyFirstMeet, below, is greedy's
 * bidirectional form now — a DIFFERENT algorithm (first-meet, not balanced-
 * termination), not a `kind` branch on this one — see its own doc for the
 * replacement and why it makes no optimality claim either.
 */
function bidiAstarBalanced(g: Graph, gRev: Csr, from: number, to: number, vMax: number): SearchResult {
  ensureScratch(g.n);
  gen++;
  fwdS.heap.reset();
  bwdS.heap.reset();
  const settled: number[] = [];
  const counters = { relaxed: 0 };
  const best = { d: Infinity, meet: -1 };

  const hT = makeHeuristic(g, vMax, to);
  const hS = makeHeuristic(g, vMax, from);
  const pf = (v: number) => (hT(v) - hS(v)) / 2;
  const pb = (v: number) => (hS(v) - hT(v)) / 2; // = -pf(v) pointwise — see this function's own proof note

  fwdS.dist[from] = 0; fwdS.parent[from] = -1; fwdS.touchGen[from] = gen;
  fwdS.heap.update(from, pf(from)); // g=0 at the seed, so g+pf(from) === pf(from)
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
    if (useForward) step(g.fwd, fwdS, bwdS, settled, best, counters, pf);
    else step(gRev, bwdS, fwdS, settled, best, counters, pb);
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

/**
 * One direction's step for first-frontier-meet greedy (see
 * bidiGreedyFirstMeet's own doc for why this is a DIFFERENT function from
 * step() above, not a shared one): pops the frontier's next node, settles
 * it, and returns it as the meeting node the INSTANT it turns out to
 * already be settled on the OTHER side — that single check is the entire
 * stopping rule, no upper-bound bookkeeping (`best.d`, `peekKey`) at all,
 * because none is being proven optimal. Neighbour relaxation is otherwise
 * the same shape as step()'s own (same generation-stamped scratch, same "g
 * still gates whether a relaxation improves a node, never enters the heap
 * priority" split), using `potential` — this side's own h-only estimate,
 * hT forward / hS backward — as the ENTIRE heap key, exactly like
 * astarVariants.ts's greedySearch. Returns the meeting node id, or -1 if
 * this particular pop wasn't one (including the defensive re-pop guard).
 */
function stepFirstMeet(
  csr: Csr, s: Scratch, other: Scratch, settled: number[],
  counters: { relaxed: number }, potential: (v: number) => number,
): number {
  const u = s.heap.pop();
  if (isDone(s, u)) return -1; // defensive: this MinHeap never actually re-queues a done id
  s.doneGen[u] = gen;
  settled.push(u);
  if (isDone(other, u)) return u; // first-frontier-meet: the entire stopping rule
  for (let e = csr.firstOut[u]; e < csr.firstOut[u + 1]; e++) {
    const v = csr.head[e];
    if (isDone(s, v)) continue;
    const d = getDist(s, u) + csr.weight[e];
    counters.relaxed++;
    if (d < getDist(s, v)) {
      s.dist[v] = d; s.parent[v] = u; s.touchGen[v] = gen;
      s.heap.update(v, potential(v)); // h ALONE, never d+potential — see this function's own doc
    }
  }
  return -1;
}

/**
 * Bidirectional greedy, FIRST-FRONTIER-MEET semantics (spec §20.4) —
 * greedy's bidirectional form, and a DIFFERENT algorithm from
 * bidiAstarBalanced above, never a `kind` branch on it. It used to be one:
 * greedy ran through that exact same balanced framework, with its step()
 * dropping `g` from the heap key when `kind === "greedy"`. Measured on the
 * real Canberra graph before this rewrite (K2's diagnosis — see the
 * routes-round report for the full table): that reused the framework's
 * `topF + topB >= best.d` termination bound with h-only keys, and settled
 * 101-103% of the graph's node count combined across both directions —
 * 1.3x-4.4x MORE nodes than plain dijkstra on the SAME query, 118x-308x
 * more than the plain (unidirectional) greedy racer it's meant to be a
 * faster cousin of. The bound isn't approximately wrong there, it's
 * structurally inapplicable: bidiAstarBalanced's whole termination proof
 * (see its own PROOF NOTE) chains through "not-yet-popped nodes have
 * true-g + potential >= this side's current top", which only holds because
 * the key IS g + potential; greedy's key is potential ALONE, with no g term
 * for that chain to anchor to, so the bound almost never fires before both
 * frontiers have nearly exhausted the graph — a flood wearing a
 * bidirectional-search costume.
 *
 * This function does not attempt to patch that bound. It runs two
 * INDEPENDENT greedy best-first searches — forward from `from` toward `to`
 * via hT, backward from `to` toward `from` over `gRev` via hS, the SAME two
 * estimates bidiAstarBalanced builds, just used RAW instead of paired into
 * potentials — alternating whichever frontier is smaller (ties favour
 * forward: the identical tie-break bidijkstra() uses, hence "first-
 * FRONTIER-meet"), and stops the INSTANT any node is popped that the OTHER
 * side has already settled: the first point the two frontiers touch, full
 * stop.
 *
 * No optimality claim exists for the result, and none is implied anywhere
 * in this function's naming or return shape. Greedy's whole premise —
 * chase the estimate, ignore accumulated cost — means either side can walk
 * straight past a cheaper route toward a geometrically-closer one (exactly
 * astarVariants.ts's own greedySearch doc, and its hand-built trap test);
 * meeting at the FIRST shared node only compounds that, since neither side
 * has any reason to have found a good route to the meeting point, let alone
 * to `to` overall. The route returned is two possibly-suboptimal greedy
 * half-paths concatenated at whichever node they happen to touch first —
 * disclosed-suboptimal exactly like the plain (unidirectional) greedy
 * racer, never claimed otherwise. That honesty is why `dist` below is
 * ALWAYS the independently recomputed edge-sum of the returned path
 * (routeCost) — never derived from either side's heap keys or accumulated
 * `dist[]` directly — so a caller comparing this `dist` against
 * dijkstra/CH's always sees the true, disclosable gap (spec §18.4's
 * honesty rule), the same discipline astarVariant's own wrapper uses.
 */
function bidiGreedyFirstMeet(g: Graph, gRev: Csr, from: number, to: number, vMax: number): SearchResult {
  ensureScratch(g.n);
  gen++;
  fwdS.heap.reset();
  bwdS.heap.reset();
  const settled: number[] = [];
  const counters = { relaxed: 0 };

  const hT = makeHeuristic(g, vMax, to);
  const hS = makeHeuristic(g, vMax, from);

  fwdS.dist[from] = 0; fwdS.parent[from] = -1; fwdS.touchGen[from] = gen;
  fwdS.heap.update(from, hT(from));
  bwdS.dist[to] = 0; bwdS.parent[to] = -1; bwdS.touchGen[to] = gen;
  bwdS.heap.update(to, hS(to));

  let meet = -1;
  while (meet === -1 && (fwdS.heap.size > 0 || bwdS.heap.size > 0)) {
    const sizeF = fwdS.heap.size;
    const sizeB = bwdS.heap.size;
    const useForward = sizeB === 0 ? true : sizeF === 0 ? false : sizeF <= sizeB;
    meet = useForward
      ? stepFirstMeet(g.fwd, fwdS, bwdS, settled, counters, hT)
      : stepFirstMeet(gRev, bwdS, fwdS, settled, counters, hS);
  }

  let path: number[] = [];
  if (meet !== -1) {
    // Same up/down reconstruction as bidiAstarBalanced's own — see that
    // function's comment for why the forward half needs reversing and the
    // backward half doesn't.
    const up: number[] = [];
    for (let v = meet; v !== -1; v = getParent(fwdS, v)) up.push(v);
    up.reverse();
    const dn: number[] = [];
    let v = meet;
    while (v !== to) {
      const next = getParent(bwdS, v);
      if (next === -1) break; // defensive: shouldn't happen for a valid meet
      dn.push(next);
      v = next;
    }
    path = [...up, ...dn];
  }

  // dist: ALWAYS the recomputed true cost of the returned path — see this
  // function's own doc on why the meeting point carries no optimality (or
  // even consistency) guarantee worth trusting a bookkeeping total from.
  // path.length 0 (no meet -> unreachable) stays Infinity; length 1 (meet
  // === from === to, the trivial case) is 0; length >= 2 is recomputed.
  const dist = path.length >= 2 ? routeCost(g.fwd, path) : path.length === 1 ? 0 : Infinity;
  return { dist, path, settled: Uint32Array.from(settled), relaxed: counters.relaxed };
}

/**
 * Public entry point, dispatching by kind (spec §18.4/§20.4): "straight"
 * runs the balanced framework above (exact — its own PROOF NOTE stands
 * unchanged), "greedy" runs first-frontier-meet (disclosed-suboptimal, see
 * that function's own doc for why no optimality claim exists). These are
 * two GENUINELY DIFFERENT algorithms sharing this file's scratch pool and
 * path-reconstruction shape, not one algorithm branching internally on
 * `kind` — keeping that split at this single dispatch point, rather than
 * threading `kind` through one shared search loop the way this file used
 * to, is what keeps bidiAstarBalanced's termination proof honestly
 * untouched by greedy's redefinition.
 */
export function bidiAstar(
  kind: HeuristicKind, g: Graph, gRev: Csr, from: number, to: number, vMax: number,
): SearchResult {
  return kind === "greedy"
    ? bidiGreedyFirstMeet(g, gRev, from, to, vMax)
    : bidiAstarBalanced(g, gRev, from, to, vMax);
}
