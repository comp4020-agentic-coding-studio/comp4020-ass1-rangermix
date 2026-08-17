import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { astar, MAX_SPEED_MPS, maxEdgeSpeedMps, VMAX_SAFETY_MARGIN } from "./astar";
import { astarVariant, makeHeuristic } from "./astarVariants";
import { bidijkstra } from "./bidijkstra";
import { bidiAstar } from "./bidiAstar";
import { dijkstra, dijkstraCsr } from "./dijkstra";
import { chQuery } from "./chQuery";
import { toyGraph, transpose, type Csr, type Graph } from "./graph";
import type { Ch } from "./chBuild";
import { haversine } from "../snap";
import { chFromArtifact, graphFromArtifact, type RoutingArtifact } from "../data-node";

// mulberry32 — same seeded RNG as dijkstra.test.ts/ch.test.ts (Task 2's
// pattern), so failures reproduce.
function rng(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A random graph with REAL lon/lat coordinates (Task 2's oracle graphs have
 * none — toyGraph zero-fills them — so a haversine heuristic on one would
 * be meaningless, not just legal) and weights derived from those same
 * coordinates: every edge's weight is the heuristic's own lower bound for
 * that hop (great-circle metres / MAX_SPEED_MPS) times a randomised >=1
 * factor, standing in for "roads are never perfectly straight, flat, or
 * run at the free-flow ceiling". That makes `h` admissible BY
 * CONSTRUCTION — no edge can ever be cheaper than the heuristic assumes —
 * which is exactly the condition astar's dist has to equal dijkstra's.
 * Returns the raw edge list alongside the built Graph so callers that need
 * to verify a returned PATH's cost (not just its total distance) can look
 * up each hop's original weight without re-deriving it. `opts.undirected`
 * (bidiAstar's own sweep needs both directed and undirected coverage,
 * unlike astar/astarVariant's forward-only searches) is forwarded straight
 * to toyGraph — the returned `edges` list still only carries the ORIGINAL
 * (forward-declared) triples, not toyGraph's own auto-added reverses, so
 * callers combining `opts.undirected` with edgeWeightLookup/pathCost would
 * need to account for that; none of this file's undirected callers do
 * (they only check `.dist`, not path validity).
 */
function coordGraph(
  rand: () => number, n: number, edgeCount: number, opts: { undirected?: boolean } = {},
): { g: Graph; edges: [number, number, number][] } {
  const lon = Array.from({ length: n }, () => 149 + rand() * 0.3);
  const lat = Array.from({ length: n }, () => -35.3 + rand() * 0.3);
  const edges: [number, number, number][] = [];
  for (let e = 0; e < edgeCount; e++) {
    const u = Math.floor(rand() * n);
    const v = Math.floor(rand() * n);
    const w = (haversine(lon[u], lat[u], lon[v], lat[v]) / MAX_SPEED_MPS) * (1 + rand() * 4);
    edges.push([u, v, w]);
  }
  const g = toyGraph(n, edges, opts);
  for (let i = 0; i < n; i++) { g.lon[i] = lon[i]; g.lat[i] = lat[i]; }
  return { g, edges };
}

/** The haversine/speed heuristic astar's worker.ts caller builds, bound to
 * a fixed target — matches the interface binding's shape
 * (`h(v) = haversineMeters(v, to) / speed`). `speed` defaults to the fixed
 * `MAX_SPEED_MPS` for the synthetic/toy graphs above and below, which build
 * their OWN weights from that same constant (admissible by construction,
 * no real-world speed data involved). The real-graph section further down
 * passes a per-graph `maxEdgeSpeedMps`-derived ceiling instead — see
 * astar.ts's own doc on why a fixed constant measurably isn't safe enough
 * there. */
function haversineHeuristic(g: Graph, to: number, speed: number = MAX_SPEED_MPS): (v: number) => number {
  return (v: number) => haversine(g.lon[v], g.lat[v], g.lon[to], g.lat[to]) / speed;
}

/**
 * An 8-CONNECTED coordinate grid (diagonals included). Plain 4-connected
 * grids are a known worst case for a straight-line heuristic on a
 * corner-to-corner query — the true shortest path is forced into Manhattan
 * detours a Euclidean estimate badly underestimates, so A* ends up
 * settling every node (verified against this repo's own astar() while
 * writing this test: a 4-connected version of this exact grid settled
 * 36/36 nodes, no better than dijkstraCsr, for opposite corners). Adding
 * diagonal hops lets the heuristic's implicit straight-line assumption
 * actually hold, so it prunes for real. Weight per hop: haversine/MAX_SPEED
 * times a 1.2 safety-margin factor (keeps admissibility comfortably clear
 * of floating-point ties at the boundary).
 */
function coordGrid(
  rows: number, cols: number, stepDeg: number,
): { g: Graph; idOf: (r: number, c: number) => number } {
  const n = rows * cols;
  const idOf = (r: number, c: number): number => r * cols + c;
  const lon = new Float64Array(n);
  const lat = new Float64Array(n);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      lon[idOf(r, c)] = 149 + c * stepDeg;
      lat[idOf(r, c)] = -35.3 + r * stepDeg;
    }
  const edges: [number, number, number][] = [];
  const DIAG_DELTAS: [number, number][] = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const id = idOf(r, c);
      for (const [dr, dc] of DIAG_DELTAS) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        const nb = idOf(nr, nc);
        const w = (haversine(lon[id], lat[id], lon[nb], lat[nb]) / MAX_SPEED_MPS) * 1.2;
        edges.push([id, nb, w], [nb, id, w]);
      }
    }
  const g = toyGraph(n, edges);
  for (let i = 0; i < n; i++) { g.lon[i] = lon[i]; g.lat[i] = lat[i]; }
  return { g, idOf };
}

/** Min-weight-per-(u,v) lookup from a raw edge list (parallel edges collapse
 * to the cheapest, matching what dijkstra/astar/bidijkstra would actually
 * use) — same technique ch.test.ts's "unpacking" test uses. */
function edgeWeightLookup(edges: [number, number, number][]): Map<string, number> {
  const wOf = new Map<string, number>();
  for (const [u, v, w] of edges) {
    const prev = wOf.get(`${u},${v}`);
    wOf.set(`${u},${v}`, Math.min(w, prev ?? Infinity));
  }
  return wOf;
}

function pathCost(path: number[], wOf: Map<string, number>): number {
  let sum = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const w = wOf.get(`${path[i]},${path[i + 1]}`);
    expect(w, `path uses a non-original edge ${path[i]}->${path[i + 1]}`).toBeDefined();
    sum += w ?? 0;
  }
  return sum;
}

describe("astar", () => {
  it(
    "matches dijkstra distance on the seeded random-graph oracle sweep " +
      "(Task 2's mulberry32 pattern; nodes get real coords so h is " +
      "meaningful, weights stay >= the heuristic's own lower bound so h " +
      "stays admissible)",
    () => {
      const rand = rng(42);
      for (let trial = 0; trial < 30; trial++) {
        const n = 2 + Math.floor(rand() * 30);
        const { g } = coordGraph(rand, n, n * 3);
        for (let t = 0; t < n; t++) {
          const h = haversineHeuristic(g, t);
          expect(astar(g, 0, t, h).dist, `trial ${trial} target ${t}`).toBe(dijkstra(g, 0, t).dist);
        }
      }
    },
  );

  it("settles strictly fewer nodes than dijkstra for a far corner-to-corner pair on a coordinate-laid grid", () => {
    const { g, idOf } = coordGrid(10, 10, 0.01);
    const from = idOf(0, 0);
    const to = idOf(9, 9);
    const h = haversineHeuristic(g, to);
    const a = astar(g, from, to, h);
    const d = dijkstra(g, from, to);
    expect(a.dist).toBe(d.dist);
    expect(a.settled.length).toBeLessThan(d.settled.length);
  });
});

describe("astarVariant", () => {
  it(
    "kind='straight' matches dijkstra distance on the seeded random-graph oracle sweep " +
      "(same coordGraph/mulberry32 pattern as astar's own sweep above — straight is exactly " +
      "astar.ts's astar(), just called through astarVariant's dispatcher)",
    () => {
      const rand = rng(43);
      for (let trial = 0; trial < 30; trial++) {
        const n = 2 + Math.floor(rand() * 30);
        const { g } = coordGraph(rand, n, n * 3);
        for (let t = 0; t < n; t++) {
          const h = makeHeuristic(g, MAX_SPEED_MPS, t);
          expect(astarVariant("straight", g, 0, t, h).dist, `trial ${trial} target ${t}`).toBe(
            dijkstra(g, 0, t).dist,
          );
        }
      }
    },
  );

  it(
    "greedy returns a path whose recomputed edge-sum EXACTLY equals the " +
      "reported dist, on the seeded sweep (validity — spec §18.4's honesty rule depends on " +
      "this number being right whether or not the route itself is optimal; independently " +
      "recomputed here from the raw edge list, not by calling astar.ts's own routeCost, so " +
      "this can't be a tautology)",
    () => {
      const rand = rng(99);
      for (let trial = 0; trial < 20; trial++) {
        const n = 4 + Math.floor(rand() * 20);
        const { g, edges } = coordGraph(rand, n, n * 3);
        const wOf = edgeWeightLookup(edges);
        for (let t = 1; t < n; t++) {
          const h = makeHeuristic(g, MAX_SPEED_MPS, t);
          const r = astarVariant("greedy", g, 0, t, h);
          if (r.path.length < 2) continue; // unreachable this trial/target — nothing to validate
          expect(
            r.dist,
            `greedy trial ${trial} 0->${t}: reported dist vs independently-recomputed path cost`,
          ).toBeCloseTo(pathCost(r.path, wOf), 6);
        }
      }
    },
  );

  it(
    "greedy can find a genuinely longer-than-optimal route (proves the disclosure case exists " +
      "and is measured, spec §18.4) — a hand-built trap where the geometrically-closer " +
      "neighbour is a dead-end-expensive road: S->A is cheap and A is close to T by straight-" +
      "line distance, but A->T itself is a slow road; S->B->T is geometrically-further but " +
      "cheap overall. Greedy pops purely by h, so it explores A (smaller h) before B, and the " +
      "instant A relaxes T, T's OWN h is 0 (the smallest possible key) so T is popped and " +
      "settled via A's expensive route before B is ever reached — regardless of B's actual " +
      "cost. This is deterministic, not probabilistic, so it is verified by hand once here " +
      "(see the comment above each edge) rather than searched for across the seeded sweep.",
    () => {
      const g = toyGraph(4, [
        [0, 1, 1], // S->A: cheap to reach A
        [1, 2, 100], // A->T: expensive — A is the trap
        [0, 3, 3], // S->B: a bit more to reach B
        [3, 2, 3], // B->T: cheap — the true shortest route (total 6)
      ]);
      const lon = [149.0, 149.002, 149.002, 149.0];
      const lat = [-35.3, -35.299, -35.298, -35.298];
      for (let i = 0; i < 4; i++) { g.lon[i] = lon[i]; g.lat[i] = lat[i]; }
      const h = haversineHeuristic(g, 2);
      const greedy = astarVariant("greedy", g, 0, 2, h);
      const dj = dijkstra(g, 0, 2);
      expect(dj.dist).toBe(6);
      expect(dj.path).toEqual([0, 3, 2]);
      expect(greedy.dist).toBe(101);
      expect(greedy.path).toEqual([0, 1, 2]); // via the trap, not the true shortest
      expect(greedy.dist).toBeGreaterThan(dj.dist);
    },
  );
});

describe("bidijkstra", () => {
  it(
    "matches dijkstra distance on 30 seeded directed graphs, every pair " +
      "(Task 2's mulberry32 pattern, verbatim — bidijkstra takes no " +
      "heuristic, so unlike astar's sweep this needs no coords)",
    () => {
      const rand = rng(1234);
      for (let trial = 0; trial < 30; trial++) {
        const n = 2 + Math.floor(rand() * 30);
        const edges: [number, number, number][] = [];
        for (let e = 0; e < n * 3; e++)
          edges.push([Math.floor(rand() * n), Math.floor(rand() * n), 1 + Math.floor(rand() * 9)]);
        const g = toyGraph(n, edges);
        const gRev = transpose(n, g.fwd);
        for (let s = 0; s < n; s++)
          for (let t = 0; t < n; t++)
            expect(bidijkstra(g, gRev, s, t).dist, `trial ${trial} ${s}->${t}`).toBe(dijkstra(g, s, t).dist);
      }
    },
  );
});

describe("bidiAstar", () => {
  it(
    "kind='straight' matches dijkstra distance on the seeded DIRECTED random-graph sweep, " +
      "every pair (coordGraph's default — coordinates are needed here, unlike bidijkstra's " +
      "own sweep above, because bidiAstar's potentials are heuristic-derived)",
    () => {
      const rand = rng(555);
      for (let trial = 0; trial < 20; trial++) {
        const n = 2 + Math.floor(rand() * 25);
        const { g } = coordGraph(rand, n, n * 3);
        const gRev = transpose(n, g.fwd);
        for (let s = 0; s < n; s++)
          for (let t = 0; t < n; t++) {
            const djDist = dijkstra(g, s, t).dist;
            const baDist = bidiAstar("straight", g, gRev, s, t, MAX_SPEED_MPS).dist;
            // toBe (exact), not toBeCloseTo, specifically for the Infinity
            // case (an unreachable pair is common in a sparse directed
            // random graph) — toBeCloseTo's Infinity-Infinity subtraction
            // is NaN, which would fail a genuinely-correct match; reachable
            // pairs go through the tolerant branch below instead, since
            // bidiAstar sums via a meeting-point split (like bidijkstra),
            // which can land a ULP off plain accumulation.
            if (djDist === Infinity) expect(baDist, `trial ${trial} ${s}->${t}`).toBe(Infinity);
            else expect(baDist, `trial ${trial} ${s}->${t}`).toBeCloseTo(djDist, 6);
          }
      }
    },
  );

  it(
    "kind='straight' matches dijkstra distance on the seeded UNDIRECTED random-graph sweep, " +
      "every pair",
    () => {
      const rand = rng(777);
      for (let trial = 0; trial < 20; trial++) {
        const n = 2 + Math.floor(rand() * 25);
        const { g } = coordGraph(rand, n, n * 3, { undirected: true });
        const gRev = transpose(n, g.fwd);
        for (let s = 0; s < n; s++)
          for (let t = 0; t < n; t++) {
            const djDist = dijkstra(g, s, t).dist;
            const baDist = bidiAstar("straight", g, gRev, s, t, MAX_SPEED_MPS).dist;
            if (djDist === Infinity) expect(baDist, `trial ${trial} ${s}->${t}`).toBe(Infinity);
            else expect(baDist, `trial ${trial} ${s}->${t}`).toBeCloseTo(djDist, 6);
          }
      }
    },
  );

  it(
    "greedy (first-frontier-meet, spec §20.4) returns a path whose recomputed edge-sum " +
      "EXACTLY equals the reported dist, on the seeded sweep (validity — exactness is NOT " +
      "claimed for this bidi form, per bidiGreedyFirstMeet's own doc in bidiAstar.ts, but the " +
      "reported number must still be honest)",
    () => {
      const rand = rng(888);
      for (let trial = 0; trial < 15; trial++) {
        const n = 4 + Math.floor(rand() * 20);
        const { g, edges } = coordGraph(rand, n, n * 3);
        const gRev = transpose(n, g.fwd);
        const wOf = edgeWeightLookup(edges);
        for (let t = 1; t < n; t++) {
          const r = bidiAstar("greedy", g, gRev, 0, t, MAX_SPEED_MPS);
          if (r.path.length < 2) continue;
          expect(
            r.dist,
            `bidi greedy trial ${trial} 0->${t}: reported dist vs independently-recomputed path cost`,
          ).toBeCloseTo(pathCost(r.path, wOf), 6);
        }
      }
    },
  );

  it("is deterministic: repeated calls on the same query return identical dist/path/settled count", () => {
    const rand = rng(2021);
    const { g } = coordGraph(rand, 20, 60);
    const gRev = transpose(20, g.fwd);
    const a = bidiAstar("greedy", g, gRev, 0, 19, MAX_SPEED_MPS);
    const b = bidiAstar("greedy", g, gRev, 0, 19, MAX_SPEED_MPS);
    expect(b.dist).toBe(a.dist);
    expect(b.path).toEqual(a.path);
    expect(b.settled.length).toBe(a.settled.length);
    expect(Array.from(b.settled)).toEqual(Array.from(a.settled));
  });

  it("from === to: trivial single-node path, dist 0, no error", () => {
    const rand = rng(303);
    const { g } = coordGraph(rand, 12, 30);
    const gRev = transpose(12, g.fwd);
    const r = bidiAstar("greedy", g, gRev, 5, 5, MAX_SPEED_MPS);
    expect(r.path).toEqual([5]);
    expect(r.dist).toBe(0);
  });

  it("unreachable pair (disconnected components): empty path, dist Infinity, no crash", () => {
    // Two 2-node components (0<->1, 2<->3), no edges crossing between them —
    // both frontiers exhaust their own component and the loop ends with no
    // meet ever found.
    const g = toyGraph(4, [
      [0, 1, 1],
      [1, 0, 1],
      [2, 3, 1],
      [3, 2, 1],
    ]);
    const lon = [149.0, 149.001, 150.0, 150.001];
    const lat = [-35.3, -35.299, -34.0, -33.999];
    for (let i = 0; i < 4; i++) { g.lon[i] = lon[i]; g.lat[i] = lat[i]; }
    const gRev = transpose(4, g.fwd);
    const r = bidiAstar("greedy", g, gRev, 0, 2, MAX_SPEED_MPS);
    expect(r.path).toEqual([]);
    expect(r.dist).toBe(Infinity);
  });

  it(
    "greedy can find a genuinely longer-than-optimal route, and the reported dist reflects it " +
      "(disclosure math positive) — the SAME hand-built trap as astarVariant's own greedy trap " +
      "above (S->A is cheap and A is close to T by straight-line distance, but A->T is a slow " +
      "road; S->B->T is geometrically-further but cheap overall), run bidirectionally: forward " +
      "greedy from S is pulled toward A (smaller straight-line estimate) exactly as before, and " +
      "first-frontier-meet stops the instant the two searches share a settled node — verified by " +
      "running the actual implementation (deterministic, no seeded randomness involved) rather " +
      "than hand-derived, since which node meets first depends on the alternation order",
    () => {
      const g = toyGraph(4, [
        [0, 1, 1], // S->A: cheap to reach A
        [1, 2, 100], // A->T: expensive — A is the trap
        [0, 3, 3], // S->B: a bit more to reach B
        [3, 2, 3], // B->T: cheap — the true shortest route (total 6)
      ]);
      const lon = [149.0, 149.002, 149.002, 149.0];
      const lat = [-35.3, -35.299, -35.298, -35.298];
      for (let i = 0; i < 4; i++) { g.lon[i] = lon[i]; g.lat[i] = lat[i]; }
      const gRev = transpose(4, g.fwd);
      const dj = dijkstra(g, 0, 2);
      expect(dj.dist).toBe(6);
      const r = bidiAstar("greedy", g, gRev, 0, 2, MAX_SPEED_MPS);
      expect(r.path.length).toBeGreaterThanOrEqual(2);
      expect(r.path[0]).toBe(0);
      expect(r.path[r.path.length - 1]).toBe(2);
      expect(r.dist).toBeGreaterThan(dj.dist); // the disclosure gap itself
      const pctLonger = (r.dist / dj.dist - 1) * 100;
      expect(pctLonger).toBeGreaterThan(0); // disclosure math (controller.ts's "+X% longer") stays positive
    },
  );

  it(
    "first-frontier-meet: the meeting node can BE `to` itself, with the backward half of the " +
      "reconstruction empty (K4 gate reviewer finding — isolation coverage for that boundary " +
      "shape in the up/dn split). Hand-traced: a single directed edge from->to means forward's " +
      "very first pop settles `from`, its second pop settles `to` (relaxing straight into it), " +
      "and ONLY THEN does backward get a turn at all (ties always favour forward, and forward's " +
      "heap stays size<=1 throughout so it never yields) — backward's first action is popping " +
      "its OWN seed (`to`), which forward already marked done, so meet=`to` on backward's very " +
      "first step, before it ever relaxes an edge. dn's while loop (`v !== to`) is therefore " +
      "false immediately and the ENTIRE path comes from fwdS's parent chain alone.",
    () => {
      const g = toyGraph(2, [[0, 1, 4]]); // from(0) -> to(1), weight 4, no other edges
      const lon = [149.0, 149.001];
      const lat = [-35.3, -35.3];
      for (let i = 0; i < 2; i++) { g.lon[i] = lon[i]; g.lat[i] = lat[i]; }
      const gRev = transpose(2, g.fwd);
      const r = bidiAstar("greedy", g, gRev, 0, 1, MAX_SPEED_MPS);
      expect(r.path).toEqual([0, 1]);
      expect(r.dist).toBe(4);
    },
  );

  it(
    "first-frontier-meet: the meeting node can BE `from` itself, with the forward half of the " +
      "reconstruction trivial (single node) and the ENTIRE returned path built from bwdS's " +
      "parent chain (K4 gate reviewer finding — the other half of the up/dn boundary pair above). " +
      "Hand-traced: from(0) branches to two nodes (0->1, 0->2) so forward's first pop (of `from`) " +
      "relaxes TWO edges, growing fwdS's heap to size 2 — from then on sizeF(2) > sizeB(1) on " +
      "every comparison, so backward wins EVERY subsequent turn and forward never gets to act " +
      "again. Backward walks seed(to=3) -> 1 -> 0 across three straight backward turns (via the " +
      "1->3 edge's transpose, then the 0->1 edge's transpose), and the instant it pops `0`, " +
      "isDone(fwdS, 0) is already true (forward's very first action), so meet=`from`. The dead " +
      "branch to node 2 is never part of the discovered path.",
    () => {
      const g = toyGraph(4, [
        [0, 1, 5], // from -> branch node (also the eventual meet path)
        [0, 2, 7], // from -> dead branch (inflates fwdS heap so backward wins every turn)
        [1, 3, 3], // branch node -> to
      ]);
      const lon = [149.0, 149.001, 149.001, 149.002];
      const lat = [-35.3, -35.3, -35.301, -35.3];
      for (let i = 0; i < 4; i++) { g.lon[i] = lon[i]; g.lat[i] = lat[i]; }
      const gRev = transpose(4, g.fwd);
      const r = bidiAstar("greedy", g, gRev, 0, 3, MAX_SPEED_MPS);
      expect(r.path).toEqual([0, 1, 3]); // node 2 (the dead branch) never appears
      expect(r.dist).toBe(8); // 5 + 3, independently recomputed via routeCost
    },
  );
});

describe("path cost equivalence (both variants match dijkstra's path cost; the path itself may differ under ties)", () => {
  it("astar, astarVariant-straight, bidijkstra, and bidiAstar-straight all return a path whose summed edge weight equals dijkstra's distance", () => {
    const rand = rng(7);
    for (let trial = 0; trial < 15; trial++) {
      const n = 4 + Math.floor(rand() * 20);
      const { g, edges } = coordGraph(rand, n, n * 3);
      const gRev = transpose(n, g.fwd);
      const wOf = edgeWeightLookup(edges);
      for (let t = 1; t < n; t++) {
        const dj = dijkstra(g, 0, t);
        if (dj.dist === Infinity) continue;
        const h = haversineHeuristic(g, t);
        const a = astar(g, 0, t, h);
        const av = astarVariant("straight", g, 0, t, h);
        const bd = bidijkstra(g, gRev, 0, t);
        const ba = bidiAstar("straight", g, gRev, 0, t, MAX_SPEED_MPS);
        for (const [label, r] of [["astar", a], ["astarVariant-straight", av], ["bidijkstra", bd], ["bidiAstar-straight", ba]] as const) {
          // toBeCloseTo, not toBe: bidijkstra sums via a meeting-point split
          // (distF[meet] + distB[meet]) rather than dijkstra's single
          // linear accumulation, so floating-point (not integer) edge
          // weights can land the same true value a ULP apart — the same
          // reason spec/data.test.ts rounds CH's (also meeting-based)
          // distance rather than comparing it bit-exact.
          expect(r.dist, `${label} trial ${trial} 0->${t} dist`).toBeCloseTo(dj.dist, 6);
          expect(pathCost(r.path, wOf), `${label} trial ${trial} 0->${t} path cost`).toBeCloseTo(dj.dist, 6);
        }
      }
    }
  });
});

// Gated on the committed artifacts existing, same rationale and pattern as
// spec/data.test.ts: these need public/data/*.json, which a fresh clone
// won't have before the pipeline task has run.
const DATA = resolve("public/data");
const haveArtifacts = ["render.json", "routing.json", "meta.json"].every((f) =>
  existsSync(resolve(DATA, f)),
);

describe.skipIf(!haveArtifacts)("astar on the shipped Canberra graph (real-graph sanity)", () => {
  // describe.skipIf still EXECUTES this callback body while vitest collects
  // tests (only the `it`s inside are skipped) — so the artifact read lives
  // in beforeAll, not a top-level statement, exactly like spec/data.test.ts.
  let routing: RoutingArtifact;
  let graph: Graph;
  let ch: Ch;
  let vMax: number;

  beforeAll(() => {
    routing = JSON.parse(readFileSync(resolve(DATA, "routing.json"), "utf8"));
    graph = graphFromArtifact(routing);
    ch = chFromArtifact(routing);
    vMax = maxEdgeSpeedMps(graph) * VMAX_SAFETY_MARGIN;
  });

  it(
    "the derived heuristic ceiling covers every real edge's true speed, " +
      "independently re-checked straight against routing.json's raw arrays",
    () => {
      // A genuinely SEPARATE code path from maxEdgeSpeedMps's own CSR
      // traversal — a plain scan over routing.json's raw from/to/w arrays,
      // filtered to originals (childA < 0, same test graphFromArtifact
      // itself uses) — so this catches a scan bug in EITHER direction
      // (missed edges, double-counted ones), not just a rounding blip from
      // reusing the same computation twice.
      const [minLon, minLat] = routing.bbox;
      const lon = routing.lon.map((v) => minLon + v / 1e5);
      const lat = routing.lat.map((v) => minLat + v / 1e5);
      let independentMax = 0;
      for (let i = 0; i < routing.childA.length; i++) {
        if (routing.childA[i] >= 0) continue; // CH shortcut, not an original edge — skip
        const w = routing.w[i] / 10;
        if (w <= 0) continue;
        const u = routing.from[i];
        const v = routing.to[i];
        const speed = haversine(lon[u], lat[u], lon[v], lat[v]) / w;
        if (speed > independentMax) independentMax = speed;
      }

      const rawMax = maxEdgeSpeedMps(graph);
      expect(rawMax, "maxEdgeSpeedMps itself must already reach the independently-scanned max").toBeGreaterThanOrEqual(independentMax);
      expect(vMax, "the margin-applied ceiling must clear the independently-scanned max too").toBeGreaterThanOrEqual(independentMax);
      // Documents WHY this replaced a fixed constant: the real graph's
      // true ceiling is measurably above the naive 100 km/h assumption
      // (exhaustive scan found 66/59,961 original edges over it) — this
      // isn't a vacuous check, the derived value is genuinely different.
      expect(vMax, "the whole point of deriving this: it's above the old fixed 100 km/h assumption").toBeGreaterThan(MAX_SPEED_MPS);
    },
  );

  it(
    "astar, chQuery, and dijkstra agree on distance (decisecond rounding) " +
      "for 10 seeded pairs, and astar settles fewer nodes than dijkstra on every one",
    () => {
      const rand = rng(2026);
      for (let i = 0; i < 10; i++) {
        const from = Math.floor(rand() * graph.n);
        const to = Math.floor(rand() * graph.n);
        const label = `pair ${i} (${from}->${to})`;
        const h = haversineHeuristic(graph, to, vMax);
        const dj = dijkstraCsr(graph.n, graph.fwd, from, to);
        const a = astar(graph, from, to, h);
        const c = chQuery(ch, from, to);
        expect(Math.round(a.dist * 10), `${label} astar vs dijkstra`).toBe(Math.round(dj.dist * 10));
        expect(Math.round(c.dist * 10), `${label} chQuery vs dijkstra`).toBe(Math.round(dj.dist * 10));
        expect(a.settled.length, `${label} astar settled < dijkstra settled`).toBeLessThan(dj.settled.length);
      }
    },
  );
});

describe.skipIf(!haveArtifacts)("astarVariant / bidiAstar on the shipped Canberra graph (real-graph sanity)", () => {
  // Own beforeAll (not shared with the "astar on the shipped Canberra
  // graph" block above) — same "describe.skipIf still EXECUTES this
  // callback body" reasoning as that block's own comment; each gated
  // describe block in this file loads its own copy rather than reaching
  // into another describe's closure.
  let routing: RoutingArtifact;
  let graph: Graph;
  let ch: Ch;
  let gRev: Csr;
  let vMax: number;

  beforeAll(() => {
    routing = JSON.parse(readFileSync(resolve(DATA, "routing.json"), "utf8"));
    graph = graphFromArtifact(routing);
    ch = chFromArtifact(routing);
    gRev = transpose(graph.n, graph.fwd);
    vMax = maxEdgeSpeedMps(graph) * VMAX_SAFETY_MARGIN;
  });

  it(
    "astarVariant('straight'), bidiAstar('straight'), chQuery, and dijkstra all agree on " +
      "distance (decisecond rounding) for 10 seeded pairs",
    () => {
      const rand = rng(4040);
      for (let i = 0; i < 10; i++) {
        const from = Math.floor(rand() * graph.n);
        const to = Math.floor(rand() * graph.n);
        const label = `pair ${i} (${from}->${to})`;
        const h = makeHeuristic(graph, vMax, to);
        const dj = dijkstraCsr(graph.n, graph.fwd, from, to);
        const av = astarVariant("straight", graph, from, to, h);
        const ba = bidiAstar("straight", graph, gRev, from, to, vMax);
        const c = chQuery(ch, from, to);
        expect(Math.round(av.dist * 10), `${label} astarVariant vs dijkstra`).toBe(Math.round(dj.dist * 10));
        expect(Math.round(ba.dist * 10), `${label} bidiAstar vs dijkstra`).toBe(Math.round(dj.dist * 10));
        expect(Math.round(c.dist * 10), `${label} chQuery vs dijkstra`).toBe(Math.round(dj.dist * 10));
      }
    },
  );

  it(
    "bidiAstar('greedy') (first-frontier-meet, spec §20.4) settles a small fraction of " +
      "dijkstra's node count, for 10 seeded pairs — this is the numeric replacement for a " +
      "flood: the balanced-framework version this superseded settled 101-103% of the WHOLE " +
      "graph's node count on hand-picked long preset pairs, 1.3x-4.4x more than dijkstra on the " +
      "same query (K2's diagnosis, see the routes-round report's k2-report.md for the full " +
      "measured table); first-frontier-meet stops at the two frontiers' first shared node " +
      "instead, so it stays small even though it (like plain greedy) never claims optimality",
    () => {
      const rand = rng(5150);
      for (let i = 0; i < 10; i++) {
        const from = Math.floor(rand() * graph.n);
        const to = Math.floor(rand() * graph.n);
        const label = `pair ${i} (${from}->${to})`;
        const dj = dijkstraCsr(graph.n, graph.fwd, from, to);
        if (dj.dist === Infinity) continue; // unreachable this pair — settle-ratio isn't meaningful
        const bg = bidiAstar("greedy", graph, gRev, from, to, vMax);
        expect(bg.settled.length, `${label} bidi-greedy settled vs dijkstra settled (< 20%)`).toBeLessThan(
          Math.max(1, dj.settled.length * 0.2),
        );
        expect(
          bg.settled.length,
          `${label} bidi-greedy settled vs graph size (pre-fix: ~101-103%)`,
        ).toBeLessThan(graph.n * 0.1);
      }
    },
  );
});

describe.skipIf(haveArtifacts)("astar real-graph sanity", () => {
  it.todo("run pnpm data:fetch && pnpm data:build, commit public/data");
});
