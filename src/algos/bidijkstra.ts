import { MinHeap } from "./heap.ts";
import type { Csr, Graph } from "./graph";
import type { SearchResult } from "./dijkstra";

// Same persistent-scratch shape as chQuery.ts's `Scratch` (two independent
// directions, since climb-from-`from` reads the OTHER direction's
// dist/done mid-search for the meeting-point check while writing its own),
// but its own module-level pool — bidijkstra races Dijkstra/A*/CH in the
// same worker and must pay its own honest allocation cost exactly once,
// not share buffers with (or free-ride on) any other algorithm's pool.
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

/** MinHeap (heap.ts) has no native peek — only `pop()` (removes-and-returns
 * the top id) and `key(id)` (reads any id's last-set key, including one
 * just popped: `pop()` clears membership, not the keys array). Composing
 * those into pop-read-reinsert reads the minimum WITHOUT consuming it:
 * `update()`'s "absent -> fresh insert" path (the id is momentarily absent
 * right after the pop) restores an equivalent heap — same members, same
 * keys — since MinHeap only ever promises pop ORDER, never a stable
 * internal layout. O(log n) instead of O(1), but this runs at most twice
 * per outer-loop iteration (see the termination check below), never inside
 * the per-edge relax loop, so it's not the hot path. */
function peekKey(h: MinHeap): number {
  if (h.size === 0) return Infinity;
  const id = h.pop();
  const k = h.key(id);
  h.update(id, k);
  return k;
}

/** Pops and settles one node from one direction's frontier: marks it done,
 * checks it (and every neighbour it relaxes) against the OTHER direction's
 * already-settled nodes for a new best meeting distance, same two check
 * points chQuery.ts's `climb()` uses (at settle time and at relax time) —
 * mirrored here over the plain graph/gRev CSRs instead of CH's up/downRev,
 * so `parent` stores a NODE id (this algorithm needs no shortcut-unpacking
 * step the way CH does, so there's nothing an edge id would buy here).
 *
 * PROOF NOTE — why requiring BOTH sides done (not just one, not just
 * "touched") never misses the true optimum, given bidijkstra's own
 * `topF + topB >= best` termination (see that function's doc):
 *
 * `best` is always an upper bound on the true distance d*: every value
 * ever assigned to it is `distF(x) + distB(x)` for a node x already done
 * on both sides — i.e. the length of a REAL from->x->to path — so
 * `best >= d*` always (nothing shorter than shortest can exist).
 *
 * Let m be ANY node on SOME shortest from->to path, so
 * `distF(m) + distB(m) = d*` exactly. Two cases, every time the
 * termination check runs:
 *   - m is already done on BOTH sides -> this function already caught it
 *     (at m's own settle time, or the moment the second side relaxed an
 *     edge into it) and set `best <= d*`. Combined with `best >= d*`
 *     above, `best = d*` exactly from that point on.
 *   - m is NOT yet done on both sides -> by Dijkstra's own settle-order
 *     invariant (a side only ever pops nodes in non-decreasing true
 *     distance), whichever side hasn't finished with m has
 *     `trueDist(m) >= that side's current top`. So
 *     `d* = distF(m) + distB(m) >= topF + topB`. Since `best >= d*` too,
 *     this gives `topF + topB <= d* <= best` — so the moment `best` is
 *     STILL strictly above `d*`, `topF + topB` is STILL strictly below
 *     `best`, and the loop correctly keeps going instead of stopping short.
 *
 * Together: `topF + topB >= best` can only become true once `best` has
 * already reached `d*` — termination is exact, not approximate, no
 * post-hoc full-graph scan needed (unlike chQuery.ts's, which exists
 * specifically to cover ITS sequential-not-interleaved shortcut).
 *
 * One more thing worth making explicit (I3 gate note) — it's easy to read
 * the case split above as if `best` only reaches `d*` once some single
 * node becomes doubly settled, but that's not what typically happens.
 * Suppose forward settles some node `u` that lies on a shortest path, and
 * `u`'s immediate successor `v` on that same path (joined by the real edge
 * `(u, v)`) is ALREADY done on the backward side — while `u` itself is NOT
 * done backward and `v` is NOT done forward, so no node is done on both
 * sides yet at all; the two frontiers are simply adjacent across this one
 * boundary edge, with no shared settled node between them. The settle-time
 * check (`isDone(other, u)`) does not fire for `u` here. But settling `u`
 * immediately walks its out-edges, including `(u, v)`: `d = distF(u) +
 * w(u, v)`, which equals `distF(v)` exactly (`u`, `v` are consecutive on a
 * shortest path, and `u`'s own dist is already final by the time it's
 * settled — relaxing along the path edge lands precisely on the true
 * successor distance), and `isDone(other, v)` is true — so the RELAX-time
 * check (inside the very same `for` loop, on `v`) fires with candidate
 * `distF(v) + distB(v) = d*` exactly. A relax across the boundary edge,
 * not a doubly-settled node, is the typical way `best` reaches `d*` in
 * practice; it's exactly why the check lives at BOTH settle time and relax
 * time (this function's two check points, named in its own opening
 * paragraph) rather than settle time alone, and it's what lets
 * bidirectional search stop right where the frontiers actually meet
 * instead of needing to push either one past it.
 *
 * One more thing worth knowing, not load-bearing for the proof above but
 * useful for reasoning about the common case: `from` becomes done on the
 * forward side on the very FIRST outer-loop iteration (both heaps start
 * at size 1, the size-tie-break in bidijkstra() below favours forward,
 * and `from` is forward's only — and cheapest possible, key 0 — entry),
 * and `to` becomes done on the backward side similarly early. So the
 * simplest candidates (from or to itself lying on an optimal path) are
 * typically found almost immediately, well before the tight bound above
 * is the thing doing the work. */
function step(
  csr: Csr, s: Scratch, other: Scratch, settled: number[],
  best: { d: number; meet: number }, counters: { relaxed: number },
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
      s.heap.update(v, d);
      if (isDone(other, v) && d + getDist(other, v) < best.d) {
        best.d = d + getDist(other, v);
        best.meet = v;
      }
    }
  }
}

/**
 * Bidirectional Dijkstra: a forward search over `g.fwd` from `from` and a
 * backward search over `gRev` (the caller's transpose of `g.fwd` — built
 * ONCE, reused every query; see worker.ts) from `to`, TRUE interleaving
 * (not run-one-then-the-other — see chQuery.ts's own comment on why its
 * sequential shortcut is fine for CH but would settle needlessly many
 * nodes here, where there's no rank hierarchy pruning the search to begin
 * with): each outer step advances whichever frontier currently holds
 * fewer queued nodes (ties favour forward), and the loop stops once
 * `topF + topB >= best` — the standard tight bidirectional-Dijkstra
 * termination, checked only once a real candidate exists (`best.d <
 * Infinity`): before any candidate is found, comparing against a still-
 * Infinity `best` would let an exhausted frontier's `Infinity` peek
 * trivially satisfy `>= Infinity` and stop the OTHER side prematurely, so
 * the check is skipped until there is something real to compare against.
 * With that guard in place, no post-hoc full-graph meeting scan is needed
 * (unlike chQuery.ts's, which exists specifically to cover its sequential
 * shortcut) — every node settled by both directions by termination time is
 * already covered by the settle-time/relax-time checks inside `step`.
 */
export function bidijkstra(g: Graph, gRev: Csr, from: number, to: number): SearchResult {
  ensureScratch(g.n);
  gen++;
  fwdS.heap.reset();
  bwdS.heap.reset();
  const settled: number[] = [];
  const counters = { relaxed: 0 };
  const best = { d: Infinity, meet: -1 };

  fwdS.dist[from] = 0; fwdS.parent[from] = -1; fwdS.touchGen[from] = gen;
  fwdS.heap.update(from, 0);
  bwdS.dist[to] = 0; bwdS.parent[to] = -1; bwdS.touchGen[to] = gen;
  bwdS.heap.update(to, 0);

  while (fwdS.heap.size > 0 || bwdS.heap.size > 0) {
    if (best.d < Infinity) {
      const topF = peekKey(fwdS.heap);
      const topB = peekKey(bwdS.heap);
      if (topF + topB >= best.d) break;
    }
    const sizeF = fwdS.heap.size;
    const sizeB = bwdS.heap.size;
    const useForward = sizeB === 0 ? true : sizeF === 0 ? false : sizeF <= sizeB;
    if (useForward) step(g.fwd, fwdS, bwdS, settled, best, counters);
    else step(gRev, bwdS, fwdS, settled, best, counters);
  }

  let path: number[] = [];
  if (best.meet !== -1) {
    // forward half: walk the parent chain from the meet node back to
    // `from` (parentF points "backward", so this needs a reverse); backward
    // half: walk from the meet node via parentB, which (built over gRev,
    // the transposed graph) already points TOWARD `to` in original-graph
    // order — see chQuery.ts's identical "downRev edges stored reversed"
    // note — so no reversal needed there, only concatenation.
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

  return { dist: best.d, path, settled: Uint32Array.from(settled), relaxed: counters.relaxed };
}
