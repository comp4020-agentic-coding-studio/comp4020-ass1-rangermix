import { describe, expect, it } from "vitest";
import { decodeToytown, VIEWBOX_H, VIEWBOX_W, type ToytownArtifact } from "./toytown";

// A tiny synthetic 4-node "square loop" + one diagonal (with a mid-route
// waypoint, to exercise multi-point geometry decode) on a round 0.01deg x
// 0.01deg bbox — chosen so the quantized/dequantized math is exact in
// floating point (1000 units at COORD_SCALE=1e5 is *exactly* 0.01 degrees),
// and no fetch is involved anywhere below: decodeToytown is pure, fed this
// object directly.
//
//   3 ------ 2
//   |      / |
//   |    /   |     (every edge directed as drawn; 0->2 is the diagonal,
//   |  /     |      with an interior waypoint that isn't any node's coord)
//   0 ------ 1
const ARTIFACT: ToytownArtifact = {
  bbox: [149.10, -35.30, 149.11, -35.29],
  n: 4,
  lon: [0, 1000, 1000, 0],
  lat: [0, 0, 1000, 1000],
  edges: [
    { from: 0, to: 1, w: 100, geometry: [[0, 0], [1000, 0]] },
    { from: 1, to: 2, w: 100, geometry: [[1000, 0], [1000, 1000]] },
    { from: 2, to: 3, w: 100, geometry: [[1000, 1000], [0, 1000]] },
    { from: 3, to: 0, w: 100, geometry: [[0, 1000], [0, 0]] },
    { from: 0, to: 2, w: 141, geometry: [[0, 0], [500, 500], [1000, 1000]] },
  ],
};

function outNeighbors(graph: ReturnType<typeof decodeToytown>["graph"], u: number): number[] {
  const { firstOut, head } = graph.fwd;
  const out: number[] = [];
  for (let s = firstOut[u]; s < firstOut[u + 1]; s++) out.push(head[s]);
  return out.sort((a, b) => a - b);
}

describe("decodeToytown: quantization decode", () => {
  const { graph } = decodeToytown(ARTIFACT);

  it("dequantizes node coordinates relative to the artifact's own bbox", () => {
    expect(graph.lon[0]).toBeCloseTo(149.10, 9);
    expect(graph.lat[0]).toBeCloseTo(-35.30, 9);
    expect(graph.lon[1]).toBeCloseTo(149.11, 9); // +1000 units = +0.01deg
    expect(graph.lat[1]).toBeCloseTo(-35.30, 9);
    expect(graph.lon[2]).toBeCloseTo(149.11, 9);
    expect(graph.lat[2]).toBeCloseTo(-35.29, 9); // +1000 units = +0.01deg
    expect(graph.lon[3]).toBeCloseTo(149.10, 9);
    expect(graph.lat[3]).toBeCloseTo(-35.29, 9);
  });

  it("dequantizes edge weights from deciseconds to seconds", () => {
    // node 0's first out-edge in artifact order is 0->1, w:100 deciseconds.
    const slot = graph.fwd.firstOut[0];
    expect(graph.fwd.weight[slot]).toBeCloseTo(10, 9);
  });

  // Migrated from src/toys/minitown.test.ts (deleted in F5 — toytown is its
  // replacement substrate): every toy that measures "distance order"
  // (flood's settle order, dijkstra-based far-pair search) only makes sense
  // if every edge weight is genuinely positive.
  it("every edge weight is positive", () => {
    expect(graph.fwd.weight.length).toBeGreaterThan(0);
    for (const w of graph.fwd.weight) expect(w).toBeGreaterThan(0);
  });

  it("builds a DIRECTED graph — edges are not symmetrized", () => {
    expect(outNeighbors(graph, 0)).toEqual([1, 2]); // 0->1, 0->2
    expect(outNeighbors(graph, 1)).toEqual([2]); // 1->2 only, no 1->0
    expect(outNeighbors(graph, 2)).toEqual([3]); // 2->3 only, no 2->1, no 2->0
    expect(outNeighbors(graph, 3)).toEqual([0]); // 3->0 only
  });
});

describe("decodeToytown: layout projection", () => {
  const { xy } = decodeToytown(ARTIFACT);

  it("has one xy point per node", () => {
    expect(xy).toHaveLength(ARTIFACT.n);
  });

  it("projects every node within the VIEWBOX_W x VIEWBOX_H viewBox", () => {
    for (const [x, y] of xy) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(VIEWBOX_W);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(VIEWBOX_H);
    }
  });

  it("preserves north-up orientation (higher-latitude node projects higher on screen)", () => {
    // node 0 (south, lat -35.30) vs node 3 (north, lat -35.29, same longitude)
    expect(xy[3][1]).toBeLessThan(xy[0][1]);
  });
});

describe("decodeToytown: edge geometry", () => {
  const { xy, edgeGeometry } = decodeToytown(ARTIFACT);

  it("has one geometry entry per edge, in the artifact's edge order", () => {
    expect(edgeGeometry).toHaveLength(ARTIFACT.edges.length);
  });

  it("every edge's projected geometry starts and ends at its endpoint nodes' xy", () => {
    ARTIFACT.edges.forEach((e, i) => {
      const geom = edgeGeometry[i];
      expect(geom[0][0]).toBeCloseTo(xy[e.from][0], 6);
      expect(geom[0][1]).toBeCloseTo(xy[e.from][1], 6);
      expect(geom[geom.length - 1][0]).toBeCloseTo(xy[e.to][0], 6);
      expect(geom[geom.length - 1][1]).toBeCloseTo(xy[e.to][1], 6);
    });
  });

  it("keeps interior waypoints (the diagonal's midpoint) distinct from either endpoint", () => {
    const diagonal = edgeGeometry[4]; // 0->2, the 3-point diagonal
    expect(diagonal).toHaveLength(3);
    const [start, mid, end] = diagonal;
    expect(mid).not.toEqual(start);
    expect(mid).not.toEqual(end);
  });
});

describe("decodeToytown: bbox passthrough", () => {
  it("returns the same bbox the artifact shipped", () => {
    expect(decodeToytown(ARTIFACT).bbox).toEqual(ARTIFACT.bbox);
  });
});
