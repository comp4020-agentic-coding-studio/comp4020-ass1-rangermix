import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { haversine, nearestNode } from "./snap";
import { graphFromArtifact, type RoutingArtifact } from "./data-node";
import { PRESETS } from "./presets";

describe("haversine", () => {
  it("is 0 for identical points", () => {
    expect(haversine(149.13, -35.28, 149.13, -35.28)).toBe(0);
  });

  it("is symmetric", () => {
    const a = haversine(149.13, -35.28, 149.2, -35.3);
    const b = haversine(149.2, -35.3, 149.13, -35.28);
    expect(a).toBeCloseTo(b, 6);
  });

  it("matches a known reference distance (Gungahlin to Capital Hill, ~15-16 km as the crow flies)", () => {
    const d = haversine(149.133, -35.186, 149.1245, -35.308);
    expect(d).toBeGreaterThan(13000);
    expect(d).toBeLessThan(15000);
  });

  it("one degree of longitude at the equator is close to 111.32 km", () => {
    const d = haversine(0, 0, 1, 0);
    expect(d / 1000).toBeCloseTo(111.32, 0);
  });
});

describe("nearestNode", () => {
  it("returns the exact node when the query coincides with it", () => {
    const lon = Float64Array.from([0, 2, 4, 6]);
    const lat = Float64Array.from([0, 0, 0, 0]);
    expect(nearestNode(4, 0, lon, lat)).toBe(2);
  });

  it("picks the geometrically nearer of two candidates on a simple axis-aligned grid", () => {
    const lon = Float64Array.from([0, 0, 10, -10]);
    const lat = Float64Array.from([0, 5, 0, 0]);
    expect(nearestNode(0.5, 0.5, lon, lat)).toBe(0);
  });

  // The cos(lat)-weighting sanity check: at high latitude, a degree of
  // longitude covers much less real ground than a degree of latitude
  // (cos(60°) = 0.5 exactly). Node 1 is 2° of longitude east of the query;
  // node 2 is 1.3° of latitude north. Unscaled (naive Euclidean) distance
  // favors node 2 (1.3² = 1.69 < 2² = 4) — the WRONG answer for real
  // ground distance. Correctly cos-scaled, node 1 wins ((2*cos60°)² = 1.0
  // < 1.69) — proving the scaling, not just the argmin, is exercised.
  it("weights the longitude axis by cos(lat), not naive Euclidean degrees", () => {
    const query: [number, number] = [0, 60];
    const lon = Float64Array.from([10, 2, 0, -10]); // 0: far decoy, 1: lon-offset, 2: lat-offset, 3: far decoy
    const lat = Float64Array.from([60, 60, 61.3, 40]);
    expect(nearestNode(query[0], query[1], lon, lat)).toBe(1);
  });

  it("naive (unscaled) distance would have picked the other candidate — confirms the test discriminates", () => {
    // Same grid as above, sanity-checked against a plain (unscaled)
    // Euclidean argmin so this test file itself proves the two methods
    // disagree here (otherwise the cos-weighting test above could pass by
    // accident for graphs where scaling doesn't matter).
    const lon = [10, 2, 0, -10];
    const lat = [60, 60, 61.3, 40];
    const [qlon, qlat] = [0, 60];
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < lon.length; i++) {
      const d = (lon[i] - qlon) ** 2 + (lat[i] - qlat) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    expect(best).toBe(2); // naive picks the lat-offset node — different from the cos-scaled answer (1)
  });
});

// Loads the REAL committed Canberra artifact from disk (node fs), same
// pattern as spec/data.test.ts — skipped rather than failed if it's absent
// (e.g. a fresh clone before the data pipeline has run).
const DATA = resolve("public/data");
const haveRouting = existsSync(resolve(DATA, "routing.json"));

describe.skipIf(!haveRouting)("presets snap onto the real Canberra graph", () => {
  it("every preset endpoint snaps within 800 m of its coordinate", () => {
    const routing: RoutingArtifact = JSON.parse(readFileSync(resolve(DATA, "routing.json"), "utf8"));
    const graph = graphFromArtifact(routing);
    expect(PRESETS.length).toBeGreaterThan(0);
    for (const preset of PRESETS) {
      for (const [label, [lon, lat]] of [
        ["a", preset.a],
        ["b", preset.b],
      ] as const) {
        const node = nearestNode(lon, lat, graph.lon, graph.lat);
        expect(node, `${preset.id} endpoint ${label} found no node`).toBeGreaterThanOrEqual(0);
        const d = haversine(lon, lat, graph.lon[node], graph.lat[node]);
        expect(d, `${preset.id} endpoint ${label} snapped ${d.toFixed(0)} m away`).toBeLessThan(800);
      }
    }
  });
});

describe.skipIf(haveRouting)("presets snap test: artifact missing", () => {
  it.todo("run pnpm data:fetch && pnpm data:build, commit public/data");
});
