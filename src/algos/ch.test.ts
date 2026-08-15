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

describe("ChResult.usesShortcut: honestly reports the WINNING PATH, not just the search frontier", () => {
  // A 5-node path, 0-1-2-3-4 (undirected, weight 4 per hop). Contracting
  // node 3 (which the heuristic does early — verified below) removes it
  // and adds a 2<->4 shortcut of weight 8, since no witness bypass exists.
  // Node ranks came out as [0,3,4,1,2] when this fixture was built (node 0
  // contracted first, node 2 last) — queries that only ever stay within
  // the low-rank end (e.g. 0->1) never touch the shortcut; queries that
  // have to cross past the contracted node 3 to reach node 4 do.
  const g = toyGraph(
    5,
    [
      [0, 1, 4],
      [1, 2, 4],
      [2, 3, 4],
      [3, 4, 4],
    ],
    { undirected: true },
  );
  const ch = buildCh(g);

  it("node 3 is contracted early and creates exactly the expected 2<->4 shortcut", () => {
    expect(ch.rank[3]).toBeLessThan(ch.rank[2]); // sanity: 3 is contracted well before 2
    const shortcut = ch.edges.find(
      (e) => e.childA !== -1 && ((e.from === 2 && e.to === 4) || (e.from === 4 && e.to === 2)),
    );
    expect(shortcut).toBeTruthy();
    expect(shortcut?.w).toBe(8);
  });

  it("false for a query whose winning path is a single direct original edge", () => {
    const r = chQuery(ch, 0, 1);
    expect(r.path).toEqual([0, 1]);
    expect(r.usesShortcut).toBe(false);
  });

  it("true for a query whose winning path is actually built via the 2<->4 shortcut", () => {
    const r = chQuery(ch, 0, 4);
    // The unpacked node sequence looks like a plain walk down every original
    // edge — exactly why usesShortcut can't be inferred from `path` alone
    // (see ChResult.usesShortcut's own doc comment): the search itself
    // resolved this query via the shortcut, which happens to expand back to
    // this same sequence.
    expect(r.path).toEqual([0, 1, 2, 3, 4]);
    expect(r.usesShortcut).toBe(true);
  });

  it("false for an unreachable pair (the early-return branch)", () => {
    const disconnected = toyGraph(6, [
      [0, 1, 4],
      [1, 2, 4],
      [2, 3, 4],
      [3, 4, 4],
      // node 5 has no edges at all
    ], { undirected: true });
    const chD = buildCh(disconnected);
    const r = chQuery(chD, 0, 5);
    expect(r.dist).toBe(Infinity);
    expect(r.usesShortcut).toBe(false);
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
