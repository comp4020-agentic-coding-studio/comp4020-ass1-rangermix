import { MinHeap } from "./heap.ts";
import type { SearchResult } from "./dijkstra";
import type { Ch, ChEdge } from "./chBuild";

export interface ChResult extends SearchResult { settledB: Uint32Array; meet: number }

// Module-held scratch, reused across every chQuery call instead of
// allocating dist/parent/done + a MinHeap (six n-sized arrays total,
// roughly 1.3 MB on the real 27k-node Canberra graph) fresh on every query.
// CH's whole point is that it only ever touches ~1% of the graph per
// query — an allocate-and-fill of the OTHER 99% every time was pure GC
// noise, and enough of it to swamp the wall-clock gap the race is supposed
// to show honestly against Dijkstra (which has the same fix, for fairness:
// see dijkstra.ts).
//
// Bidirectional, so there are two independent scratch sets (`fwd`/`bwd`):
// climb() reads the OTHER direction's dist/done mid-search (the
// meeting-point check) while writing its own, so they can't share storage
// within one query — but both directions always start fresh together, so
// one shared generation counter covers both.
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
let fwd = makeScratch(0);
let bwd = makeScratch(0);
let gen = 0;

function ensureScratch(n: number): void {
  if (n <= scratchN) return;
  scratchN = n;
  fwd = makeScratch(n);
  bwd = makeScratch(n);
}

function getDist(s: Scratch, v: number): number { return s.touchGen[v] === gen ? s.dist[v] : Infinity; }
function getParent(s: Scratch, v: number): number { return s.touchGen[v] === gen ? s.parent[v] : -1; }
function isDone(s: Scratch, v: number): boolean { return s.doneGen[v] === gen; }

function climb(
  ch: Ch, dir: "up" | "downRev", from: number,
  s: Scratch, other: Scratch, settled: number[],
  best: { d: number; meet: number }, counters: { relaxed: number },
): void {
  const csr = ch[dir];
  s.heap.reset();
  s.dist[from] = 0; s.parent[from] = -1; s.touchGen[from] = gen;
  s.heap.update(from, 0);
  while (s.heap.size > 0) {
    const u = s.heap.pop();
    if (isDone(s, u)) continue;
    if (getDist(s, u) > best.d) break; // termination: frontier beyond best meeting
    s.doneGen[u] = gen; settled.push(u);
    if (isDone(other, u) && getDist(s, u) + getDist(other, u) < best.d) {
      best.d = getDist(s, u) + getDist(other, u); best.meet = u;
    }
    for (let e = csr.firstOut[u]; e < csr.firstOut[u + 1]; e++) {
      const v = csr.head[e];
      const d = getDist(s, u) + csr.weight[e];
      counters.relaxed++;
      if (d < getDist(s, v)) {
        s.dist[v] = d; s.parent[v] = csr.edge[e]; s.touchGen[v] = gen;
        s.heap.update(v, d);
        if (isDone(other, v) && d + getDist(other, v) < best.d) {
          best.d = d + getDist(other, v); best.meet = v;
        }
      }
    }
  }
}

function expand(edges: ChEdge[], ei: number, acc: number[]): void {
  const e = edges[ei];
  if (e.childA === -1) { acc.push(ei); return; }
  expand(edges, e.childA, acc);
  expand(edges, e.childB, acc);
}

export function chQuery(ch: Ch, from: number, to: number): ChResult {
  const INF = Infinity;
  ensureScratch(ch.n);
  gen++;
  const sF: number[] = []; const sB: number[] = [];
  const best = { d: INF, meet: -1 };
  const counters = { relaxed: 0 };
  // NOTE: the two climbs must interleave for correct early termination in
  // adversarial graphs; sequential is exact too (termination check is
  // conservative: frontier-min > best), just occasionally settles more.
  climb(ch, "up", from, fwd, bwd, sF, best, counters);
  climb(ch, "downRev", to, bwd, fwd, sB, best, counters);
  // meeting scan (covers nodes settled by only one side)
  for (let v = 0; v < ch.n; v++) {
    const d = getDist(fwd, v) + getDist(bwd, v);
    if (d < best.d) { best.d = d; best.meet = v; }
  }
  if (best.meet === -1)
    return { dist: INF, path: [], settled: Uint32Array.from(sF), settledB: Uint32Array.from(sB), relaxed: counters.relaxed, meet: -1 };
  // reconstruct: forward chain of up-edges to meet, then backward chain
  const upSeq: number[] = [];
  for (let v = best.meet; v !== from && getParent(fwd, v) !== -1; ) {
    const pe = getParent(fwd, v);
    upSeq.push(pe); v = ch.edges[pe].from;
  }
  upSeq.reverse();
  const dnSeq: number[] = [];
  for (let v = best.meet; v !== to && getParent(bwd, v) !== -1; ) {
    const pe = getParent(bwd, v);
    dnSeq.push(pe); v = ch.edges[pe].to; // downRev edges stored reversed
  }
  const originalEdges: number[] = [];
  for (const ei of upSeq) expand(ch.edges, ei, originalEdges);
  for (const ei of dnSeq) expand(ch.edges, ei, originalEdges);
  const path: number[] = [from];
  let cur = from;
  for (const ei of originalEdges) {
    const e = ch.edges[ei];
    if (e.from !== cur) throw new Error(`unpack discontinuity at edge ${ei}`);
    cur = e.to;
    path.push(cur);
  }
  return {
    dist: best.d, path,
    settled: Uint32Array.from(sF), settledB: Uint32Array.from(sB),
    relaxed: counters.relaxed, meet: best.meet,
  };
}
