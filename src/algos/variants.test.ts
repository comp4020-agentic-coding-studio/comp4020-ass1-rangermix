import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { astar, MAX_SPEED_MPS } from "./astar";
import { bidijkstra } from "./bidijkstra";
import { dijkstra, dijkstraCsr } from "./dijkstra";
import { chQuery } from "./chQuery";
import { toyGraph, transpose, type Graph } from "./graph";
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
 * up each hop's original weight without re-deriving it.
 */
function coordGraph(
  rand: () => number, n: number, edgeCount: number,
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
  const g = toyGraph(n, edges);
  for (let i = 0; i < n; i++) { g.lon[i] = lon[i]; g.lat[i] = lat[i]; }
  return { g, edges };
}

/** The haversine/MAX_SPEED_MPS heuristic astar's worker.ts caller builds,
 * bound to a fixed target — matches the interface binding exactly
 * (`h(v) = haversineMeters(v, to) / 27.7778`; see astar.ts's own doc on
 * MAX_SPEED_MPS for the precise constant and why 100 km/h stays safe on
 * the real shipped graph despite a few 110 km/h-tagged segments). */
function haversineHeuristic(g: Graph, to: number): (v: number) => number {
  return (v: number) => haversine(g.lon[v], g.lat[v], g.lon[to], g.lat[to]) / MAX_SPEED_MPS;
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

describe("path cost equivalence (both variants match dijkstra's path cost; the path itself may differ under ties)", () => {
  it("astar and bidijkstra both return a path whose summed edge weight equals dijkstra's distance", () => {
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
        const bd = bidijkstra(g, gRev, 0, t);
        for (const [label, r] of [["astar", a], ["bidijkstra", bd]] as const) {
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
  let graph: Graph;
  let ch: Ch;

  beforeAll(() => {
    const routing: RoutingArtifact = JSON.parse(readFileSync(resolve(DATA, "routing.json"), "utf8"));
    graph = graphFromArtifact(routing);
    ch = chFromArtifact(routing);
  });

  it(
    "astar, chQuery, and dijkstra agree on distance (decisecond rounding) " +
      "for 10 seeded pairs, and astar settles fewer nodes than dijkstra on every one",
    () => {
      const rand = rng(2026);
      for (let i = 0; i < 10; i++) {
        const from = Math.floor(rand() * graph.n);
        const to = Math.floor(rand() * graph.n);
        const label = `pair ${i} (${from}->${to})`;
        const h = haversineHeuristic(graph, to);
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

describe.skipIf(haveArtifacts)("astar real-graph sanity", () => {
  it.todo("run pnpm data:fetch && pnpm data:build, commit public/data");
});
