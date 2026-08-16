import { describe, expect, it } from "vitest";
import { decodeToytown, type ToytownArtifact } from "./toytown";
import {
  advancePick,
  declutterXY,
  edgeClsOf,
  IDLE_PICK,
  isArterial,
  physicalEdges,
  roadPolylineMarkup,
  unorderedKey,
} from "./toytownView";

// A tiny synthetic 3-node fixture, deliberately mixing a TWO-WAY pair
// (0<->1, different weights per direction — real one-ways can have
// asymmetric travel times, so the dedup must not assume symmetry) with a
// ONE-WAY-only pair (1->2, no reverse edge at all) — the exact shape
// contraction.ts's F4 review risk-list flagged: MINITOWN was always
// undirected, so a bug in this dedup would never show up against it. The
// two physical streets also deliberately differ in road class (0-1 local,
// 1-2 arterial — task G5) so the cls-passthrough/styling tests below have
// both cases to check.
const ARTIFACT: ToytownArtifact = {
  bbox: [149.1, -35.3, 149.11, -35.29],
  n: 3,
  lon: [0, 500, 1000],
  lat: [0, 0, 500],
  edges: [
    { from: 0, to: 1, w: 50, cls: 0, geometry: [[0, 0], [500, 0]] },
    { from: 1, to: 0, w: 60, cls: 0, geometry: [[500, 0], [0, 0]] },
    { from: 1, to: 2, w: 70, cls: 3, geometry: [[500, 0], [1000, 500]] },
  ],
};

describe("physicalEdges: collapses real directed edges to one line per street", () => {
  const t = decodeToytown(ARTIFACT);
  const edges = physicalEdges(t);

  it("returns exactly one entry per PHYSICAL street, not one per directed edge", () => {
    // 3 directed edges, 2 physical streets (0-1 two-way, 1-2 one-way).
    expect(edges).toHaveLength(2);
  });

  it("marks the two-way pair (both 0->1 and 1->0 exist) as NOT oneway", () => {
    const pair = edges.find((e) => (e.a === 0 && e.b === 1) || (e.a === 1 && e.b === 0));
    expect(pair).toBeTruthy();
    expect(pair?.oneway).toBe(false);
  });

  it("marks the one-way-only pair (1->2, no 2->1) as oneway — detected, not assumed", () => {
    const pair = edges.find((e) => (e.a === 1 && e.b === 2) || (e.a === 2 && e.b === 1));
    expect(pair).toBeTruthy();
    expect(pair?.oneway).toBe(true);
  });

  it("never fabricates a physical edge that has no directed edge backing it at all", () => {
    const keys = new Set(edges.map((e) => (e.a < e.b ? `${e.a}-${e.b}` : `${e.b}-${e.a}`)));
    expect(keys.has("0-2")).toBe(false);
  });

  it("every returned geometry is a real edge's geometry (non-empty point list)", () => {
    for (const e of edges) expect(e.geometry.length).toBeGreaterThanOrEqual(2);
  });

  it("carries through the physical street's cls (task G5)", () => {
    const local = edges.find((e) => (e.a === 0 && e.b === 1) || (e.a === 1 && e.b === 0));
    const arterial = edges.find((e) => (e.a === 1 && e.b === 2) || (e.a === 2 && e.b === 1));
    expect(local?.cls).toBe(0);
    expect(arterial?.cls).toBe(3);
  });
});

describe("roadPolylineMarkup", () => {
  const t = decodeToytown(ARTIFACT);
  const edges = physicalEdges(t);
  const markup = roadPolylineMarkup(edges);

  it("draws one <polyline> per physical edge", () => {
    expect(markup.match(/<polyline/g)).toHaveLength(edges.length);
  });

  it("tags the one-way street's line with edge-oneway, and the two-way street's without it", () => {
    const oneway = edges.find((e) => e.oneway);
    const twoway = edges.find((e) => !e.oneway);
    expect(markup).toContain(`data-a="${oneway?.a}" data-b="${oneway?.b}"`);
    // Slice out just the one-way line to check it carries the class...
    const onewayLine = markup
      .split("<polyline")
      .find((chunk) => chunk.includes(`data-a="${oneway?.a}" data-b="${oneway?.b}"`));
    expect(onewayLine).toContain("edge-oneway");
    // ...and the two-way line does not.
    const twowayLine = markup
      .split("<polyline")
      .find((chunk) => chunk.includes(`data-a="${twoway?.a}" data-b="${twoway?.b}"`));
    expect(twowayLine).not.toContain("edge-oneway");
  });

  it("tags the arterial street (cls 3) with edge-arterial, and the local street (cls 0) without it", () => {
    const arterial = edges.find((e) => e.cls === 3);
    const local = edges.find((e) => e.cls === 0);
    const arterialLine = markup
      .split("<polyline")
      .find((chunk) => chunk.includes(`data-a="${arterial?.a}" data-b="${arterial?.b}"`));
    expect(arterialLine).toContain("edge-arterial");
    const localLine = markup
      .split("<polyline")
      .find((chunk) => chunk.includes(`data-a="${local?.a}" data-b="${local?.b}"`));
    expect(localLine).not.toContain("edge-arterial");
  });
});

describe("isArterial: the cls>=2 arterial threshold (design spec §16.12/13)", () => {
  it("cls 0 (residential/unclassified) and 1 (tertiary) are locals, not arterial", () => {
    expect(isArterial(0)).toBe(false);
    expect(isArterial(1)).toBe(false);
  });

  it("cls 2 (secondary) and up are arterial", () => {
    expect(isArterial(2)).toBe(true);
    expect(isArterial(3)).toBe(true);
    expect(isArterial(4)).toBe(true);
  });
});

describe("edgeClsOf: looks up a single directed edge's cls by (u, v)", () => {
  const t = decodeToytown(ARTIFACT);

  it("finds the real cls for an existing directed edge", () => {
    expect(edgeClsOf(t, 0, 1)).toBe(0);
    expect(edgeClsOf(t, 1, 2)).toBe(3);
  });

  it("the two directions of a two-way street can carry independently-looked-up (here equal) cls", () => {
    expect(edgeClsOf(t, 1, 0)).toBe(0);
  });

  it("returns -1 for a pair with no direct edge at all", () => {
    expect(edgeClsOf(t, 0, 2)).toBe(-1);
    expect(edgeClsOf(t, 2, 1)).toBe(-1); // 1->2 exists, but toytown's edge is one-way: no 2->1
  });
});

describe("unorderedKey: the a<->b lookup key shared by contraction's witness-flash and climb's touched-street highlighting", () => {
  it("is the same key regardless of argument order", () => {
    expect(unorderedKey(3, 9)).toBe(unorderedKey(9, 3));
  });

  it("distinguishes different pairs", () => {
    expect(unorderedKey(1, 2)).not.toBe(unorderedKey(1, 3));
  });
});

describe("advancePick: the three-click endpoint re-pick cycle", () => {
  it("first click on idle state sets it as the pending start, nothing completes", () => {
    const r = advancePick(IDLE_PICK, 5);
    expect(r).toEqual({ next: { start: 5, end: null }, complete: null });
  });

  it("clicking the pending start again is a no-op (can't query a node against itself)", () => {
    const r = advancePick({ start: 5, end: null }, 5);
    expect(r).toEqual({ next: { start: 5, end: null }, complete: null });
  });

  it("second click (a different node) sets the end AND fires complete", () => {
    const r = advancePick({ start: 5, end: null }, 9);
    expect(r).toEqual({ next: { start: 5, end: 9 }, complete: [5, 9] });
  });

  it("third click (state already complete) resets AND becomes the new start — not a dead click", () => {
    const r = advancePick({ start: 5, end: 9 }, 3);
    expect(r).toEqual({ next: { start: 3, end: null }, complete: null });
  });

  it("the cycle repeats indefinitely: start, end+complete, reset+start, end+complete, ...", () => {
    let state = IDLE_PICK;
    let step = advancePick(state, 1);
    state = step.next;
    expect(step.complete).toBeNull();
    step = advancePick(state, 2);
    state = step.next;
    expect(step.complete).toEqual([1, 2]);
    step = advancePick(state, 3);
    state = step.next;
    expect(step.complete).toBeNull();
    expect(state).toEqual({ start: 3, end: null });
    step = advancePick(state, 4);
    expect(step.complete).toEqual([3, 4]);
  });
});

describe("declutterXY: nudges near-coincident points apart", () => {
  function minPairDist(pts: [number, number][]): number {
    let min = Infinity;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        min = Math.min(min, Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]));
      }
    }
    return min;
  }

  it("leaves points that are already far enough apart untouched", () => {
    const pts: [number, number][] = [
      [0, 0],
      [100, 0],
      [0, 100],
    ];
    expect(declutterXY(pts, 24)).toEqual(pts);
  });

  it("separates two points 1.7px apart (the real toytown case found live) to at least minDist", () => {
    const pts: [number, number][] = [
      [200, 200],
      [201.7, 200],
    ];
    const out = declutterXY(pts, 24);
    expect(Math.hypot(out[0][0] - out[1][0], out[0][1] - out[1][1])).toBeGreaterThanOrEqual(
      24 - 0.01,
    );
  });

  it("separates two EXACTLY coincident points deterministically (same input, same output every call)", () => {
    const pts: [number, number][] = [
      [50, 50],
      [50, 50],
    ];
    const a = declutterXY(pts, 24);
    const b = declutterXY(pts, 24);
    expect(a).toEqual(b);
    expect(Math.hypot(a[0][0] - a[1][0], a[0][1] - a[1][1])).toBeGreaterThanOrEqual(24 - 0.01);
  });

  it("resolves a dense cluster of 20 near-identical points to all pairwise >= minDist apart", () => {
    const pts: [number, number][] = Array.from({ length: 20 }, (_, i) => [
      100 + (i % 5) * 0.3,
      100 + Math.floor(i / 5) * 0.3,
    ]);
    const out = declutterXY(pts, 24);
    expect(minPairDist(out)).toBeGreaterThanOrEqual(24 - 0.05);
  });

  it("preserves the point count and never introduces NaN/Infinity", () => {
    const pts: [number, number][] = [
      [0, 0],
      [0, 0],
      [5, 5],
      [200, 5],
    ];
    const out = declutterXY(pts, 24);
    expect(out).toHaveLength(pts.length);
    for (const [x, y] of out) {
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    }
  });

  it("does not mutate the input array", () => {
    const pts: [number, number][] = [
      [10, 10],
      [10.5, 10],
    ];
    const original = pts.map((p) => [...p]);
    declutterXY(pts, 24);
    expect(pts).toEqual(original);
  });

  describe("with bounds: a dense cluster near an edge can't escape the viewBox", () => {
    it("keeps every point inside [minX,minY,maxX,maxY] even under heavy repulsion pressure", () => {
      // 10 points crammed into the bottom-right corner of a 460x300 box —
      // exactly the shape that pushed real flood-toy buttons below the
      // stage into the controls underneath it (see the F5 report).
      const pts: [number, number][] = Array.from({ length: 10 }, (_, i) => [
        455 + (i % 3) * 0.5,
        295 + Math.floor(i / 3) * 0.5,
      ]);
      const out = declutterXY(pts, 35, 60, [0, 0, 460, 300]);
      for (const [x, y] of out) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(460);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(300);
      }
    });

    it("without bounds, the same cramped-corner cluster DOES escape the box (regression guard for the bug itself)", () => {
      const pts: [number, number][] = Array.from({ length: 10 }, (_, i) => [
        455 + (i % 3) * 0.5,
        295 + Math.floor(i / 3) * 0.5,
      ]);
      const out = declutterXY(pts, 35, 60);
      const anyOutside = out.some(([x, y]) => x < 0 || x > 460 || y < 0 || y > 300);
      expect(anyOutside).toBe(true);
    });

    it("a point starting outside the given bounds is pulled back in immediately", () => {
      const pts: [number, number][] = [
        [-50, 500],
        [200, 150],
      ];
      const out = declutterXY(pts, 24, 60, [0, 0, 460, 300]);
      expect(out[0][0]).toBeGreaterThanOrEqual(0);
      expect(out[0][1]).toBeLessThanOrEqual(300);
    });
  });
});
