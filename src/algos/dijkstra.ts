import { MinHeap } from "./heap";
import type { Csr, Graph } from "./graph";

export interface SearchResult {
  dist: number; path: number[]; settled: Uint32Array; relaxed: number;
}

export function dijkstraCsr(
  n: number, csr: Csr, from: number, to: number,
): SearchResult {
  const dist = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const heap = new MinHeap(n);
  const settled: number[] = [];
  let relaxed = 0;
  dist[from] = 0;
  heap.update(from, 0);
  while (heap.size > 0) {
    const u = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    settled.push(u);
    if (u === to) break;
    for (let s = csr.firstOut[u]; s < csr.firstOut[u + 1]; s++) {
      const v = csr.head[s];
      if (done[v]) continue;
      const d = dist[u] + csr.weight[s];
      relaxed++;
      if (d < dist[v]) { dist[v] = d; parent[v] = u; heap.update(v, d); }
    }
  }
  const path: number[] = [];
  if (to >= 0 && dist[to] < Infinity) {
    for (let v = to; v !== -1; v = parent[v]) path.push(v);
    path.reverse();
  }
  return {
    dist: to >= 0 ? dist[to] : NaN,
    path, settled: Uint32Array.from(settled), relaxed,
  };
}

export function dijkstra(g: Graph, from: number, to: number): SearchResult {
  return dijkstraCsr(g.n, g.fwd, from, to);
}
