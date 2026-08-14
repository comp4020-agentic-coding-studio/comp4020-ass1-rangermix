import { describe, expect, it } from "vitest";
import { toyGraph, type Graph } from "./algos/graph";
import { buildCh } from "./algos/chBuild";
import { dijkstra } from "./algos/dijkstra";
import { chQuery } from "./algos/chQuery";
import { chFromArtifact, graphFromArtifact, type RoutingArtifact } from "./data-node";

// mulberry32 — seeded RNG so failures reproduce (same generator as
// src/algos/*.test.ts)
function rng(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Mirrors build.ts's emit(): quantize coords to a 1e-5°-relative-to-bbox
// grid, ChEdge weights to deciseconds, and shape the result exactly like
// routing.json — enough to exercise the real quantize/serialize/decode
// round trip this module's loader contract is frozen against, without
// needing the OSM/render pipeline at all.
function toArtifact(g: Graph, bboxMin: [number, number]): RoutingArtifact {
  const ch = buildCh(g);
  const [minLon, minLat] = bboxMin;
  const bbox: [number, number, number, number] = [minLon, minLat, minLon + 10, minLat + 10];
  const lon = Array.from(g.lon, (v) => Math.round((v - minLon) * 1e5));
  const lat = Array.from(g.lat, (v) => Math.round((v - minLat) * 1e5));
  return {
    n: g.n, bbox, lon, lat,
    from: ch.edges.map((e) => e.from),
    to: ch.edges.map((e) => e.to),
    w: ch.edges.map((e) => Math.max(1, Math.round(e.w * 10))),
    childA: ch.edges.map((e) => e.childA),
    childB: ch.edges.map((e) => e.childB),
    src: ch.edges.map((e) => e.src),
    rank: Array.from(ch.rank),
    renderOf: ch.edges.map((e) => (e.childA < 0 ? e.src : -1)),
  };
}

function withRealCoords(g: Graph, lonBase: number, latBase: number): Graph {
  for (let i = 0; i < g.n; i++) {
    g.lon[i] = lonBase + i * 0.0013;
    g.lat[i] = latBase - i * 0.0011;
  }
  return g;
}

describe("graphFromArtifact / chFromArtifact: roundtrip through the routing.json shape", () => {
  it("decoded Dijkstra and decoded CH both match the pre-encode oracle, all pairs", () => {
    const rand = rng(4020);
    const n = 24;
    const edges: [number, number, number][] = [];
    for (let i = 1; i < n; i++) // spanning tree keeps it connected
      edges.push([Math.floor(rand() * i), i, 1 + Math.floor(rand() * 9)]);
    for (let e = 0; e < n; e++)
      edges.push([Math.floor(rand() * n), Math.floor(rand() * n), 1 + Math.floor(rand() * 9)]);
    const g = withRealCoords(toyGraph(n, edges, { undirected: true }), 149, -35);

    const artifact = toArtifact(g, [149 - 1, -35 - 1]);
    const decodedGraph = graphFromArtifact(artifact);
    const decodedCh = chFromArtifact(artifact);

    expect(decodedGraph.n).toBe(n);
    for (let s = 0; s < n; s++)
      for (let t = 0; t < n; t++) {
        const want = dijkstra(g, s, t).dist; // pre-encode oracle
        const gotDj = dijkstra(decodedGraph, s, t).dist;
        const gotCh = chQuery(decodedCh, s, t).dist;
        // integer edge weights quantize to deciseconds losslessly, so this
        // is exact equality, not toBeCloseTo — a real drift bug would fail it.
        expect(gotDj, `dijkstra ${s}->${t}`).toBe(want);
        expect(gotCh, `ch ${s}->${t}`).toBe(want);
      }
  });

  it("dequantizes node coordinates back to the source 1e-5° grid", () => {
    const g = toyGraph(3, [[0, 1, 2], [1, 2, 3]], { undirected: true });
    g.lon[0] = 149.12345; g.lat[0] = -35.54321;
    g.lon[1] = 149.12346; g.lat[1] = -35.5432;
    g.lon[2] = 149.123; g.lat[2] = -35.544;
    const artifact = toArtifact(g, [149.1, -35.6]);
    const decoded = graphFromArtifact(artifact);
    for (let i = 0; i < 3; i++) {
      expect(decoded.lon[i]).toBeCloseTo(g.lon[i], 5);
      expect(decoded.lat[i]).toBeCloseTo(g.lat[i], 5);
    }
  });

  it("Graph.fwd.edge[] indexes back into the artifact's augmented arrays, at an original row", () => {
    const g = toyGraph(6, [
      [0, 1, 4], [1, 2, 3], [0, 3, 2], [3, 2, 3], [1, 4, 3], [4, 5, 5],
    ], { undirected: true });
    const artifact = toArtifact(g, [0, 0]);
    const decoded = graphFromArtifact(artifact);
    let checked = 0;
    for (let u = 0; u < decoded.n; u++)
      for (let s = decoded.fwd.firstOut[u]; s < decoded.fwd.firstOut[u + 1]; s++) {
        const augIdx = decoded.fwd.edge[s];
        expect(artifact.childA[augIdx]).toBeLessThan(0); // must be an original, not a shortcut
        expect(artifact.from[augIdx]).toBe(u);
        expect(artifact.to[augIdx]).toBe(decoded.fwd.head[s]);
        checked++;
      }
    expect(checked).toBeGreaterThan(0);
  });

  it("chFromArtifact partitions up/downRev by rank exactly as buildChOrdered does", () => {
    const g = toyGraph(10, [
      [0, 1, 1], [1, 2, 1], [2, 3, 1], [3, 4, 1], [4, 5, 1],
      [5, 6, 1], [6, 7, 1], [7, 8, 1], [8, 9, 1], [9, 0, 1],
    ], { undirected: true });
    const artifact = toArtifact(g, [0, 0]);
    const decoded = chFromArtifact(artifact);
    let upChecked = 0, downChecked = 0;
    for (let u = 0; u < decoded.n; u++)
      for (let s = decoded.up.firstOut[u]; s < decoded.up.firstOut[u + 1]; s++) {
        expect(decoded.rank[decoded.up.head[s]]).toBeGreaterThan(decoded.rank[u]);
        upChecked++;
      }
    for (let u = 0; u < decoded.n; u++)
      for (let s = decoded.downRev.firstOut[u]; s < decoded.downRev.firstOut[u + 1]; s++) {
        // downRev is keyed by the ORIGINAL edge's `to` and stores it
        // reversed, so head[s] is the original `from`, whose rank must be
        // >= this row's key (rank[to] <= rank[from] is exactly the
        // else-branch of the builder's partition condition).
        expect(decoded.rank[decoded.downRev.head[s]]).toBeGreaterThanOrEqual(decoded.rank[u]);
        downChecked++;
      }
    expect(upChecked).toBeGreaterThan(0);
    expect(downChecked).toBeGreaterThan(0);
  });
});
