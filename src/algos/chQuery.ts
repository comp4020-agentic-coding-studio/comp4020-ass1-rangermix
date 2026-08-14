import { MinHeap } from "./heap";
import type { SearchResult } from "./dijkstra";
import type { Ch, ChEdge } from "./chBuild";

export interface ChResult extends SearchResult { settledB: Uint32Array; meet: number }

function climb(
  ch: Ch, dir: "up" | "downRev", from: number,
  dist: Float64Array, parentEdge: Int32Array, done: Uint8Array,
  settled: number[], other: Float64Array, otherDone: Uint8Array,
  best: { d: number; meet: number }, counters: { relaxed: number },
): void {
  const csr = ch[dir];
  const heap = new MinHeap(ch.n);
  dist[from] = 0; heap.update(from, 0);
  while (heap.size > 0) {
    const u = heap.pop();
    if (done[u]) continue;
    if (dist[u] > best.d) break; // termination: frontier beyond best meeting
    done[u] = 1; settled.push(u);
    if (otherDone[u] && dist[u] + other[u] < best.d) {
      best.d = dist[u] + other[u]; best.meet = u;
    }
    for (let s = csr.firstOut[u]; s < csr.firstOut[u + 1]; s++) {
      const v = csr.head[s];
      const d = dist[u] + csr.weight[s];
      counters.relaxed++;
      if (d < dist[v]) {
        dist[v] = d; parentEdge[v] = csr.edge[s]; heap.update(v, d);
        if (otherDone[v] && d + other[v] < best.d) { best.d = d + other[v]; best.meet = v; }
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
  const dF = new Float64Array(ch.n).fill(INF);
  const dB = new Float64Array(ch.n).fill(INF);
  const pF = new Int32Array(ch.n).fill(-1);
  const pB = new Int32Array(ch.n).fill(-1);
  const doneF = new Uint8Array(ch.n);
  const doneB = new Uint8Array(ch.n);
  const sF: number[] = []; const sB: number[] = [];
  const best = { d: INF, meet: -1 };
  const counters = { relaxed: 0 };
  // NOTE: the two climbs must interleave for correct early termination in
  // adversarial graphs; sequential is exact too (termination check is
  // conservative: frontier-min > best), just occasionally settles more.
  climb(ch, "up", from, dF, pF, doneF, sF, dB, doneB, best, counters);
  climb(ch, "downRev", to, dB, pB, doneB, sB, dF, doneF, best, counters);
  // meeting scan (covers nodes settled by only one side)
  for (let v = 0; v < ch.n; v++)
    if (dF[v] + dB[v] < best.d) { best.d = dF[v] + dB[v]; best.meet = v; }
  if (best.meet === -1)
    return { dist: INF, path: [], settled: Uint32Array.from(sF), settledB: Uint32Array.from(sB), relaxed: counters.relaxed, meet: -1 };
  // reconstruct: forward chain of up-edges to meet, then backward chain
  const upSeq: number[] = [];
  for (let v = best.meet; v !== from && pF[v] !== -1; ) {
    upSeq.push(pF[v]); v = ch.edges[pF[v]].from;
  }
  upSeq.reverse();
  const dnSeq: number[] = [];
  for (let v = best.meet; v !== to && pB[v] !== -1; ) {
    dnSeq.push(pB[v]); v = ch.edges[pB[v]].to; // downRev edges stored reversed
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
