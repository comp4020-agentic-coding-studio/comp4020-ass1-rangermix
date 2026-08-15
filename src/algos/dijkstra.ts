import { MinHeap } from "./heap.ts";
import type { Csr, Graph } from "./graph";

export interface SearchResult {
  dist: number; path: number[]; settled: Uint32Array; relaxed: number;
}

// Module-held scratch, reused across every dijkstraCsr call instead of
// allocating dist/parent/done + a MinHeap fresh each time. The race worker
// calls this once per query on a 27k-node graph; the old per-call
// `new Float64Array(n).fill(Infinity)` (+ two more n-sized arrays, + a heap
// with three more of its own) was real garbage every time — enough that GC
// pauses swamped the wall-clock difference the race is supposed to show
// honestly. See chQuery.ts for the CH-side twin of this.
//
// Generation-stamped instead of re-filled: `touchGen[v] === gen` means
// "dist[v]/parent[v] are valid for THIS call"; an unstamped read returns the
// same virgin value a freshly-`new`-ed, filled array would have held
// (Infinity / -1). That makes starting a new search O(1) (bump `gen`) rather
// than O(n) (re-fill), while behaving identically from the caller's side.
// Arrays only ever GROW (never shrink) so the same pool is correct whether
// it's serving a 12-node toy-town graph or the real Canberra one.
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

export function dijkstraCsr(
  n: number, csr: Csr, from: number, to: number,
): SearchResult {
  ensureScratch(n);
  gen++;
  heap.reset();
  const settled: number[] = [];
  let relaxed = 0;
  dist[from] = 0; parent[from] = -1; touchGen[from] = gen;
  heap.update(from, 0);
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
      if (d < getDist(v)) { dist[v] = d; parent[v] = u; touchGen[v] = gen; heap.update(v, d); }
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

export function dijkstra(g: Graph, from: number, to: number): SearchResult {
  return dijkstraCsr(g.n, g.fwd, from, to);
}
