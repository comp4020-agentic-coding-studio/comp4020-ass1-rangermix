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
    expect(reversed.some((e) => e.cls === 2)).toBe(true); // way111 is secondary
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
