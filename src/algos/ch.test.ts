import { describe, expect, it } from "vitest";
import { toyGraph } from "./graph";
import { dijkstra } from "./dijkstra";
import { buildCh, contractOne, orderedShortcutCount } from "./chBuild";
import { chQuery } from "./chQuery";

function rng(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("contractOne (the chapter-2 invariant)", () => {
  // A--E--C with a top path A-T-C that witnesses one pair, and no
  // alternative for the other. Weights match the mockup's toy town.
  //   A->E 4, E->C 3, A->T 3, T->C 3  (A..C via E = 7, via T = 6: witness)
  //   B->E 3, E->D 5                  (B..D via E = 8, no bypass: shortcut)
  const n = 6; // A=0 B=1 T=2 E=3 C=4 D=5
  const g = toyGraph(n, [
    [0, 3, 4], [3, 4, 3], [0, 2, 3], [2, 4, 3], [1, 3, 3], [3, 5, 5],
  ], { undirected: true });

  it("adds a shortcut only when no witness exists", () => {
    const res = contractOne(g, 3);
    const sc = res.shortcuts.map((s) => [s.from, s.to, s.w].join(","));
    expect(sc).toContain("1,5,8");        // B->D must be shortcut, w=3+5
    expect(sc).not.toContain("0,4,7");    // A->C witnessed via T (6 < 7)
    expect(res.witnessed.some((p) => p.from === 0 && p.to === 4)).toBe(true);
  });
});

describe("CH equals Dijkstra everywhere (the site's headline claim)", () => {
  it("matches on 25 random undirected graphs, all pairs", () => {
    const rand = rng(7);
    for (let trial = 0; trial < 25; trial++) {
      const n = 4 + Math.floor(rand() * 24);
      const edges: [number, number, number][] = [];
      for (let i = 1; i < n; i++) // spanning tree keeps it connected
        edges.push([Math.floor(rand() * i), i, 1 + Math.floor(rand() * 9)]);
      for (let e = 0; e < n; e++)
        edges.push([
          Math.floor(rand() * n), Math.floor(rand() * n),
          1 + Math.floor(rand() * 9),
        ]);
      const g = toyGraph(n, edges, { undirected: true });
      const ch = buildCh(g);
      for (let s = 0; s < n; s++)
        for (let t = 0; t < n; t++) {
          const want = dijkstra(g, s, t).dist;
          const got = chQuery(ch, s, t);
          expect(got.dist, `trial ${trial}: ${s}->${t}`).toBe(want);
        }
    }
  });

  it("matches on directed graphs too (one-ways)", () => {
    const rand = rng(99);
    for (let trial = 0; trial < 25; trial++) {
      const n = 4 + Math.floor(rand() * 16);
      const edges: [number, number, number][] = [];
      for (let e = 0; e < n * 3; e++)
        edges.push([
          Math.floor(rand() * n), Math.floor(rand() * n),
          1 + Math.floor(rand() * 9),
        ]);
      const g = toyGraph(n, edges);
      const ch = buildCh(g);
      for (let s = 0; s < n; s++)
        for (let t = 0; t < n; t++)
          expect(chQuery(ch, s, t).dist, `t${trial} ${s}->${t}`).toBe(
            dijkstra(g, s, t).dist,
          );
    }
  });
});

describe("unpacking", () => {
  it("returns a contiguous original-edge path with matching weight", () => {
    const rand = rng(5);
    const n = 20;
    const edges: [number, number, number][] = [];
    for (let i = 1; i < n; i++)
      edges.push([Math.floor(rand() * i), i, 1 + Math.floor(rand() * 9)]);
    for (let e = 0; e < 30; e++)
      edges.push([
        Math.floor(rand() * n), Math.floor(rand() * n),
        1 + Math.floor(rand() * 9),
      ]);
    const g = toyGraph(n, edges, { undirected: true });
    const ch = buildCh(g);
    // adjacency weight lookup for verification
    const wOf = new Map<string, number>();
    for (const [u, v, w] of edges) {
      const a = wOf.get(`${u},${v}`);
      wOf.set(`${u},${v}`, Math.min(w, a ?? Infinity));
      const b = wOf.get(`${v},${u}`);
      wOf.set(`${v},${u}`, Math.min(w, b ?? Infinity));
    }
    for (let t = 1; t < n; t++) {
      const r = chQuery(ch, 0, t);
      if (r.dist === Infinity) continue;
      expect(r.path[0]).toBe(0);
      expect(r.path[r.path.length - 1]).toBe(t);
      let sum = 0;
      for (let i = 0; i + 1 < r.path.length; i++) {
        const w = wOf.get(`${r.path[i]},${r.path[i + 1]}`);
        expect(w, `edge ${r.path[i]}->${r.path[i + 1]} must be original`)
          .toBeDefined();
        sum += w ?? 0;
      }
      expect(sum).toBe(r.dist);
    }
  });
});

describe("ordering matters (the chapter-4 claim)", () => {
  it("the heuristic order adds no more shortcuts than a bad fixed order", () => {
    // star-of-cliques shape where contracting hubs first is catastrophic
    const g = toyGraph(8, [
      [0, 1, 1], [0, 2, 1], [0, 3, 1], [0, 4, 1], [0, 5, 1], [0, 6, 1], [0, 7, 1],
    ], { undirected: true });
    const hubFirst = orderedShortcutCount(g, [0, 1, 2, 3, 4, 5, 6, 7]);
    const hubLast = orderedShortcutCount(g, [1, 2, 3, 4, 5, 6, 7, 0]);
    expect(hubLast).toBeLessThan(hubFirst);
    const ch = buildCh(g);
    // heuristic must contract the hub last (highest rank)
    expect(ch.rank[0]).toBe(7);
  });
});
