import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseOsm, buildRoutingGraph, SPEEDS, haversineM, type OverpassJson, type RoutingGraph } from "./build";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/mini.json", import.meta.url), "utf8"),
);

// fixture node coordinates, named for readability (see fixtures/mini.json's
// _comment for the full topology this fixture models).
const A: [number, number] = [149.1000, -35.2800];
const B: [number, number] = [149.1010, -35.2805];
const C: [number, number] = [149.1000, -35.2810];
const D: [number, number] = [149.0990, -35.2805];
const Y: [number, number] = [149.0980, -35.2805];
const ISLAND1: [number, number] = [149.5000, -35.5000];

function indexOf(g: RoutingGraph, [lon, lat]: [number, number]): number {
  return g.lon.findIndex((x, i) => x === lon && g.lat[i] === lat);
}

function edgesBetween(g: RoutingGraph, from: [number, number], to: [number, number]) {
  const fromIdx = indexOf(g, from);
  const toIdx = indexOf(g, to);
  return g.edges.filter((e) => e.from === fromIdx && e.to === toIdx);
}

describe("pipeline units", () => {
  it("haversine sanity: 0.001° lat ≈ 111 m", () => {
    expect(haversineM(149, -35, 149, -35.001)).toBeGreaterThan(105);
    expect(haversineM(149, -35, 149, -35.001)).toBeLessThan(118);
  });

  it("parses only drivable ways and reads oneway/maxspeed", () => {
    const { ways } = parseOsm(fixture);
    expect(ways.every((w) => w.highway in SPEEDS)).toBe(true);
    expect(ways.some((w) => w.oneway === "yes")).toBe(true);
  });

  it("drops the disconnected island via SCC", () => {
    const g = buildRoutingGraph(parseOsm(fixture));
    // fixture comment records which node ids are on the island
    expect(g.lon.length).toBe(fixture.expect.sccNodes);
  });

  it("contracts the degree-2 chain, preserving weight and geometry", () => {
    const g = buildRoutingGraph(parseOsm(fixture));
    const chain = g.edges.find((e) => e.geometry.length >= 3);
    expect(chain).toBeDefined();
    expect(chain?.w).toBeCloseTo(fixture.expect.chainSeconds, 1);
  });
});

describe("parseOsm: drivable filter, oneway, maxspeed", () => {
  it("drops the footway entirely (not a key of SPEEDS)", () => {
    const { ways } = parseOsm(fixture);
    expect(ways.some((w) => w.id === 110)).toBe(false);
    expect(ways.length).toBe(10); // 11 ways in the fixture, minus the footway
  });

  it("reads an explicit oneway=yes tag", () => {
    const way105 = parseOsm(fixture).ways.find((w) => w.id === 105);
    expect(way105?.oneway).toBe("yes");
  });

  it("reads an explicit oneway=-1 tag, refs unreversed at parse time", () => {
    const way111 = parseOsm(fixture).ways.find((w) => w.id === 111);
    expect(way111?.oneway).toBe("-1");
    expect(way111?.refs).toEqual([1, 4]); // parseOsm doesn't reverse; buildRoutingGraph does
  });

  it("defaults oneway to 'no' for plain highways without a tag", () => {
    const way103 = parseOsm(fixture).ways.find((w) => w.id === 103);
    expect(way103?.oneway).toBe("no");
  });

  it("infers oneway=yes for motorway and roundabouts when the tag is absent", () => {
    const synthetic: OverpassJson = {
      elements: [
        { type: "node", id: 901, lat: -35.0, lon: 149.0 },
        { type: "node", id: 902, lat: -35.001, lon: 149.0 },
        { type: "node", id: 903, lat: -35.002, lon: 149.0 },
        { type: "node", id: 904, lat: -35.003, lon: 149.0 },
        { type: "way", id: 9001, nodes: [901, 902], tags: { highway: "motorway" } },
        { type: "way", id: 9002, nodes: [902, 903], tags: { highway: "residential", junction: "roundabout" } },
        { type: "way", id: 9003, nodes: [903, 904], tags: { highway: "residential" } },
      ],
    };
    const { ways } = parseOsm(synthetic);
    expect(ways.find((w) => w.id === 9001)?.oneway).toBe("yes"); // motorway, no tag
    expect(ways.find((w) => w.id === 9002)?.oneway).toBe("yes"); // roundabout, no tag
    expect(ways.find((w) => w.id === 9003)?.oneway).toBe("no"); // plain residential, no tag
  });

  it("parses a plain-number maxspeed", () => {
    const way106 = parseOsm(fixture).ways.find((w) => w.id === 106);
    expect(way106?.maxspeed).toBe(60);
  });

  it("parses a maxspeed with a ' km/h' suffix", () => {
    const way101 = parseOsm(fixture).ways.find((w) => w.id === 101);
    expect(way101?.maxspeed).toBe(50);
  });

  it("ignores a non-numeric maxspeed (falls back to SPEEDS[highway])", () => {
    const way102 = parseOsm(fixture).ways.find((w) => w.id === 102);
    expect(way102?.maxspeed).toBeUndefined();
  });

  it("ignores an mph-suffixed maxspeed rather than misreading it as km/h", () => {
    const synthetic: OverpassJson = {
      elements: [
        { type: "node", id: 911, lat: -35.0, lon: 149.0 },
        { type: "node", id: 912, lat: -35.001, lon: 149.0 },
        { type: "way", id: 9101, nodes: [911, 912], tags: { highway: "residential", maxspeed: "30 mph" } },
      ],
    };
    expect(parseOsm(synthetic).ways[0].maxspeed).toBeUndefined();
  });

  it("leaves maxspeed undefined when the tag is absent", () => {
    const way103 = parseOsm(fixture).ways.find((w) => w.id === 103);
    expect(way103?.maxspeed).toBeUndefined();
  });
});

describe("buildRoutingGraph: junction split, oneway expansion, cls mapping", () => {
  const g = buildRoutingGraph(parseOsm(fixture));

  it("expands a two-way way into two directed edges", () => {
    expect(edgesBetween(g, D, Y).length).toBe(1); // living_street spur, D->Y
    expect(edgesBetween(g, Y, D).length).toBe(1); // and Y->D
  });

  it("expands a oneway=yes way into exactly one directed edge", () => {
    expect(edgesBetween(g, B, D).length).toBe(1); // way105 B->D
    expect(edgesBetween(g, D, B).length).toBe(0); // no reverse edge
  });

  it("reverses a oneway=-1 way against its ref order", () => {
    // way111 refs=[A,D] (ref order A->D) with oneway=-1 must emit D->A, not A->D
    const forward = edgesBetween(g, A, D); // only way104's two-way leg
    const reversed = edgesBetween(g, D, A); // way104's two-way leg AND way111's reversed leg
    expect(forward.length).toBe(1);
    expect(reversed.length).toBe(2);
    const way111Edge = reversed.find((e) => e.cls === 2); // way111 is secondary
    expect(way111Edge).toBeDefined();
    // geometry must run from ITS from-node (D) to ITS to-node (A), i.e. the
    // way's own [A,D] polyline reversed — not just from/to swapped.
    expect(way111Edge?.geometry).toEqual([D, A]);
  });

  it("keeps parallel edges distinct rather than merging or dropping them", () => {
    const reversed = edgesBetween(g, D, A);
    expect(reversed.map((e) => e.cls).sort()).toEqual([0, 2]); // way104 (residential) + way111 (secondary)
  });

  it("maps highway to cls using the fixed 4-bucket table", () => {
    expect(edgesBetween(g, A, B)[0].cls).toBe(0); // residential
    expect(edgesBetween(g, B, D)[0].cls).toBe(1); // tertiary
    expect(edgesBetween(g, D, Y)[0].cls).toBe(0); // living_street
    expect(edgesBetween(g, D, A).find((e) => e.cls === 2)).toBeDefined(); // secondary
  });

  it("keeps the dead-end two-way spur (degree 1 survives SCC, is never contracted)", () => {
    expect(indexOf(g, Y)).toBeGreaterThanOrEqual(0);
    expect(edgesBetween(g, D, Y)[0].geometry.length).toBe(2); // never merged, still one hop
  });

  it("drops both island nodes", () => {
    expect(indexOf(g, ISLAND1)).toBe(-1);
  });

  it("contracts the chain to a single edge with exact 3-point geometry each way", () => {
    const forward = edgesBetween(g, A, C);
    const backward = edgesBetween(g, C, A);
    expect(forward.length).toBe(1);
    expect(backward.length).toBe(1);
    expect(forward[0].geometry).toEqual([A, [149.1000, -35.2805], C]);
    expect(backward[0].geometry).toEqual([C, [149.1000, -35.2805], A]);
    expect(forward[0].w).toBeCloseTo(fixture.expect.chainSeconds, 3);
    expect(backward[0].w).toBeCloseTo(fixture.expect.chainSeconds, 3);
    expect(forward[0].cls).toBe(1); // min(tertiary, tertiary) = 1, unaffected here
  });

  it("matches the hand-computed final edge count", () => {
    expect(g.edges.length).toBe(fixture.expect.finalEdgeCount);
  });

  it("every edge has a finite, positive weight", () => {
    for (const e of g.edges) {
      expect(e.w).toBeGreaterThan(0);
      expect(Number.isFinite(e.w)).toBe(true);
    }
  });

  it("weighs an edge as meters / (kmh/3.6), matching maxspeed override", () => {
    const dAB = haversineM(A[0], A[1], B[0], B[1]);
    const want = dAB / (50 / 3.6); // way101 maxspeed="50 km/h" overrides residential's 40
    expect(edgesBetween(g, A, B)[0].w).toBeCloseTo(want, 6);
  });
});

describe("cls mapping: all 13 highway types via a hub-and-spoke fixture", () => {
  // A two-way hub H keeps every spoke leaf in one SCC regardless of the
  // spoke's own highway type, and no spoke (degree 1) is ever eligible for
  // chain contraction — so this isolates CLS without disturbing SCC/chain
  // behaviour already covered above.
  const HUB: [number, number] = [149.3000, -35.0000];
  const highways = [
    "motorway", "motorway_link", "trunk", "trunk_link",
    "primary", "primary_link", "secondary", "secondary_link",
    "tertiary", "tertiary_link", "unclassified", "residential", "living_street",
  ];
  const wantCls: Record<string, number> = {
    residential: 0, living_street: 0, unclassified: 0,
    tertiary: 1, tertiary_link: 1,
    secondary: 2, secondary_link: 2, primary: 2, primary_link: 2,
    trunk: 3, trunk_link: 3, motorway: 3, motorway_link: 3,
  };
  const elements: OverpassJson["elements"] = [{ type: "node", id: 1, lat: HUB[1], lon: HUB[0] }];
  const leaves: Record<string, [number, number]> = {};
  highways.forEach((highway, i) => {
    const id = 100 + i;
    const leaf: [number, number] = [149.3000 + (i + 1) * 0.001, -35.0000];
    leaves[highway] = leaf;
    elements.push({ type: "node", id, lat: leaf[1], lon: leaf[0] });
    // explicit oneway=no: motorway/motorway_link would otherwise infer
    // oneway=yes and, as a bare spoke with no return path, get dropped by
    // SCC — this fixture is about cls, not oneway inference (covered above).
    elements.push({ type: "way", id: 900 + i, nodes: [1, id], tags: { highway, oneway: "no" } });
  });
  const g = buildRoutingGraph(parseOsm({ elements }));

  it.each(highways)("maps %s to its render class", (highway) => {
    const edges = edgesBetween(g, HUB, leaves[highway]);
    expect(edges.length).toBe(1);
    expect(edges[0].cls).toBe(wantCls[highway]);
  });
});

describe("chain contraction: the oneway pattern, distinct from the two-way one", () => {
  it("contracts a {u->v,v->w} oneway through-node, summing weight and taking min(cls)", () => {
    // H<->K two-way anchor keeps {H,K} strongly connected on its own; the
    // oneway chain K->M->H (two separate ways, so M is a junction by
    // ref-count) is the ONLY thing that should get contracted.
    const H: [number, number] = [149.4000, -35.1000];
    const K: [number, number] = [149.4000, -35.1010];
    const M: [number, number] = [149.4010, -35.1005];
    const synthetic: OverpassJson = {
      elements: [
        { type: "node", id: 801, lat: H[1], lon: H[0] },
        { type: "node", id: 802, lat: K[1], lon: K[0] },
        { type: "node", id: 803, lat: M[1], lon: M[0] },
        { type: "way", id: 8001, nodes: [801, 802], tags: { highway: "residential" } },
        { type: "way", id: 8002, nodes: [802, 803], tags: { highway: "secondary", oneway: "yes" } },
        { type: "way", id: 8003, nodes: [803, 801], tags: { highway: "tertiary", oneway: "yes" } },
      ],
    };
    const g = buildRoutingGraph(parseOsm(synthetic));

    expect(indexOf(g, M)).toBe(-1); // M contracted away, no longer a node
    expect(edgesBetween(g, H, K).length).toBe(1); // anchor's H->K leg only, no oneway return this way

    const merged = edgesBetween(g, K, H); // anchor's K->H leg + the new merged K->H
    expect(merged.length).toBe(2);
    const chainEdge = merged.find((e) => e.geometry.length === 3);
    expect(chainEdge).toBeDefined();
    expect(chainEdge?.geometry).toEqual([K, M, H]);
    expect(chainEdge?.cls).toBe(1); // min(secondary=2, tertiary=1), not just the first hop's cls

    const want =
      haversineM(K[0], K[1], M[0], M[1]) / (SPEEDS.secondary / 3.6) +
      haversineM(M[0], M[1], H[0], H[1]) / (SPEEDS.tertiary / 3.6);
    expect(chainEdge?.w).toBeCloseTo(want, 6);
  });
});

describe("edgesForWay: junction-split loop on a real multi-node way", () => {
  // Every way elsewhere in this file has exactly 2 refs, so the loop's
  // multi-hop summing (build.ts:68-72) and its mid-way split (:60-61) were
  // never exercised by a way shaped like real OSM data: several interior
  // shape points, AND an interior node that's a junction because another
  // way also touches it. One way, refs=[J1,S1,J2,S2,J3]:
  //   - S1, S2 are pure shape points: referenced once, only here, never an
  //     endpoint -> not junctions -> absorbed into whichever segment
  //     contains them (both their geometry AND their hop distance).
  //   - J2 is an interior node but IS a junction, because a second way
  //     (the spur J2-X) also references it -> the main way must split into
  //     two segments AT J2, not stay one J1..J3 edge.
  // Coordinates zigzag (not collinear) specifically so "sum of individual
  // hops" and "direct haversine(endpoint, endpoint)" give different
  // numbers — a bug that skipped the interior hops (e.g. used
  // haversineM(J1,J2) directly instead of summing J1-S1 and S1-J2) would
  // fail the weight assertions below, not just coincidentally pass.
  const J1: [number, number] = [149.6000, -35.6000];
  const S1: [number, number] = [149.6006, -35.6004];
  const J2: [number, number] = [149.6002, -35.6010];
  const S2: [number, number] = [149.6009, -35.6014];
  const J3: [number, number] = [149.6004, -35.6021];
  const X: [number, number] = [149.6020, -35.6010];
  const synthetic: OverpassJson = {
    elements: [
      { type: "node", id: 701, lat: J1[1], lon: J1[0] },
      { type: "node", id: 702, lat: S1[1], lon: S1[0] },
      { type: "node", id: 703, lat: J2[1], lon: J2[0] },
      { type: "node", id: 704, lat: S2[1], lon: S2[0] },
      { type: "node", id: 705, lat: J3[1], lon: J3[0] },
      { type: "node", id: 706, lat: X[1], lon: X[0] },
      { type: "way", id: 7001, nodes: [701, 702, 703, 704, 705], tags: { highway: "residential" } },
      // only here to make J2(703) a junction by ref-count (endpoint of a 2nd way)
      { type: "way", id: 7002, nodes: [703, 706], tags: { highway: "residential" } },
    ],
  };
  const g = buildRoutingGraph(parseOsm(synthetic));

  // hand-computed (haversineM, same formula as the sanity test above; the
  // zigzag means these don't reduce to a closed form the way the mini.json
  // chain's same-longitude points do, so this uses the function under test
  // to build the *expectation*, then asserts the pipeline's own sum matches
  // it independently — see _comment-equivalent numbers in the PR/report):
  //   hop J1-S1 = 70.150396 m, hop S1-J2 = 75.888351 m -> seg1 = 146.038747 m
  //   hop J2-S2 = 77.354066 m, hop S2-J3 = 90.011313 m -> seg2 = 167.365379 m
  //   residential = 40 km/h = 11.111111 m/s
  //   seg1Seconds = 146.038747 / 11.111111 = 13.143487 s
  //   seg2Seconds = 167.365379 / 11.111111 = 15.062884 s
  // (direct haversine(J1,J2) = 112.656 m and haversine(J2,J3) = 123.644 m —
  // both well short of the hop sums above, confirming the points aren't
  // collinear and a "skip the shape points" bug would be caught below.)
  const seg1Seconds =
    (haversineM(J1[0], J1[1], S1[0], S1[1]) + haversineM(S1[0], S1[1], J2[0], J2[1])) / (40 / 3.6);
  const seg2Seconds =
    (haversineM(J2[0], J2[1], S2[0], S2[1]) + haversineM(S2[0], S2[1], J3[0], J3[1])) / (40 / 3.6);

  it("absorbs interior shape points into one edge's geometry and summed weight", () => {
    expect(indexOf(g, S1)).toBe(-1); // S1 never became its own node
    expect(indexOf(g, J1)).toBeGreaterThanOrEqual(0);
    expect(indexOf(g, J2)).toBeGreaterThanOrEqual(0);

    const forward = edgesBetween(g, J1, J2);
    const backward = edgesBetween(g, J2, J1);
    expect(forward.length).toBe(1);
    expect(backward.length).toBe(1);
    expect(forward[0].geometry).toEqual([J1, S1, J2]);
    expect(backward[0].geometry).toEqual([J2, S1, J1]);
    expect(forward[0].w).toBeCloseTo(seg1Seconds, 6);
    expect(backward[0].w).toBeCloseTo(seg1Seconds, 6);
  });

  it("splits the way into a second edge at the interior junction, absorbing its own shape point", () => {
    expect(indexOf(g, S2)).toBe(-1); // S2 never became its own node
    expect(indexOf(g, J3)).toBeGreaterThanOrEqual(0);

    const forward = edgesBetween(g, J2, J3);
    const backward = edgesBetween(g, J3, J2);
    expect(forward.length).toBe(1);
    expect(backward.length).toBe(1);
    expect(forward[0].geometry).toEqual([J2, S2, J3]);
    expect(backward[0].geometry).toEqual([J3, S2, J2]);
    expect(forward[0].w).toBeCloseTo(seg2Seconds, 6);
    expect(backward[0].w).toBeCloseTo(seg2Seconds, 6);
  });

  it("never emits a single J1->J3 edge spanning both segments", () => {
    expect(edgesBetween(g, J1, J3).length).toBe(0);
    expect(edgesBetween(g, J3, J1).length).toBe(0);
  });

  it("keeps the interior junction as a real 3-neighbour node, not contracted", () => {
    // J2 has J1, J3, AND X as neighbours (the spur) — three distinct
    // neighbours means it can never match either through-pattern.
    expect(edgesBetween(g, J2, X).length).toBe(1);
    expect(edgesBetween(g, X, J2).length).toBe(1);
    expect(indexOf(g, J2)).toBeGreaterThanOrEqual(0);
  });
});
