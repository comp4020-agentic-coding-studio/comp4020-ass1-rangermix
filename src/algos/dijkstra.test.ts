import { describe, expect, it } from "vitest";
import { dijkstra } from "./dijkstra";
import { toyGraph, transpose, buildCsr } from "./graph";

// mulberry32 — seeded RNG so failures reproduce
function rng(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Brute-force Bellman-Ford as the oracle
function oracle(n: number, edges: [number, number, number][], s: number): number[] {
  const d = Array.from({ length: n }, () => Infinity);
  d[s] = 0;
  for (let i = 0; i < n; i++)
    for (const [u, v, w] of edges) if (d[u] + w < d[v]) d[v] = d[u] + w;
  return d;
}

describe("dijkstra", () => {
  it("finds the known path on a diamond", () => {
    // 0 -> 1 (1), 0 -> 2 (4), 1 -> 2 (1), 2 -> 3 (1), 1 -> 3 (5)
    const g = toyGraph(4, [[0, 1, 1], [0, 2, 4], [1, 2, 1], [2, 3, 1], [1, 3, 5]]);
    const r = dijkstra(g, 0, 3);
    expect(r.dist).toBe(3);
    expect(r.path).toEqual([0, 1, 2, 3]);
    expect(r.settled[0]).toBe(0); // settles source first
  });

  it("reports unreachable as Infinity with empty path", () => {
    const g = toyGraph(3, [[0, 1, 1]]);
    const r = dijkstra(g, 0, 2);
    expect(r.dist).toBe(Infinity);
    expect(r.path).toEqual([]);
  });

  it("matches Bellman-Ford on 30 random graphs", () => {
    const rand = rng(42);
    for (let trial = 0; trial < 30; trial++) {
      const n = 2 + Math.floor(rand() * 30);
      const edges: [number, number, number][] = [];
      for (let e = 0; e < n * 3; e++)
        edges.push([
          Math.floor(rand() * n), Math.floor(rand() * n),
          1 + Math.floor(rand() * 9),
        ]);
      const g = toyGraph(n, edges);
      const want = oracle(n, edges, 0);
      for (let t = 0; t < n; t++)
        expect(dijkstra(g, 0, t).dist, `trial ${trial} target ${t}`).toBe(want[t]);
    }
  });

  it("transpose preserves edge identity", () => {
    const c = buildCsr(3, [{ from: 0, to: 1, w: 5 }, { from: 1, to: 2, w: 7 }]);
    const t = transpose(3, c);
    // edge 1->2 becomes 2->1 slot; its edge index must still be 1
    const slot = t.firstOut[2];
    expect(t.head[slot]).toBe(1);
    expect(t.weight[slot]).toBe(7);
    expect(t.edge[slot]).toBe(1);
  });
});
