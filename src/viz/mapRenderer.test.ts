// Pure-function tests only. jsdom has no canvas 2D context, so MapView's
// actual canvas calls (drawBase/drawDots/drawRoute/drawPin/clearOverlay) are
// thin, untested here, and verified by eye once Task 7 wires MapView into a
// real page. What's exercised here is the geometry/data logic MapView is
// built on: projection fit, delta decode, threshold filter, dot stride math.

import { describe, expect, it } from "vitest";
import {
  clampPan,
  composeView,
  decodeLine,
  fitTransform,
  projectPoint,
  strideFor,
  unprojectPoint,
  visibleLines,
  zoomAbout,
  type ViewState,
} from "./mapRenderer";

// Deterministic PRNG (mulberry32) for the seeded property tests below --
// reproducible failures without pulling in a test dependency for it.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("fitTransform", () => {
  // The real Canberra bbox (public/data/render.json) — deliberately NOT
  // square in map units, so the min(availW/mapW, availH/mapH) branch
  // actually gets exercised both ways below.
  const bbox: [number, number, number, number] = [
    148.9179634, -35.6505443, 149.3332927, -35.0450695,
  ];
  const cosMid = Math.cos(((bbox[1] + bbox[3]) / 2) * (Math.PI / 180));
  const project = (
    t: { scale: number; ox: number; oy: number },
    lon: number,
    lat: number,
  ): [number, number] => [
    (lon - bbox[0]) * cosMid * t.scale + t.ox,
    (bbox[3] - lat) * t.scale + t.oy,
  ];
  const corners: [number, number][] = [
    [bbox[0], bbox[1]],
    [bbox[0], bbox[3]],
    [bbox[2], bbox[1]],
    [bbox[2], bbox[3]],
  ];

  it.each([
    { w: 900, h: 600, pad: 20, label: "wide viewport (height-constrained)" },
    { w: 400, h: 900, pad: 20, label: "tall viewport (width-constrained)" },
  ])("keeps all four bbox corners inside the padded viewport: $label", ({ w, h, pad }) => {
    const t = fitTransform(bbox, w, h, pad);
    for (const [lon, lat] of corners) {
      const [x, y] = project(t, lon, lat);
      expect(x).toBeGreaterThanOrEqual(pad - 1e-6);
      expect(x).toBeLessThanOrEqual(w - pad + 1e-6);
      expect(y).toBeGreaterThanOrEqual(pad - 1e-6);
      expect(y).toBeLessThanOrEqual(h - pad + 1e-6);
    }
  });

  it("preserves aspect (one uniform scale): the limiting dimension exactly fills its padded span", () => {
    const w = 900, h = 600, pad = 20;
    const t = fitTransform(bbox, w, h, pad);
    const mapWpx = (bbox[2] - bbox[0]) * cosMid * t.scale;
    const mapHpx = (bbox[3] - bbox[1]) * t.scale;
    const wTight = Math.abs(mapWpx - (w - 2 * pad)) < 1e-6;
    const hTight = Math.abs(mapHpx - (h - 2 * pad)) < 1e-6;
    expect(wTight || hTight).toBe(true); // exactly one dimension is the constraint
    expect(mapWpx).toBeLessThanOrEqual(w - 2 * pad + 1e-6);
    expect(mapHpx).toBeLessThanOrEqual(h - 2 * pad + 1e-6);
  });

  it("north is up: higher latitude projects to a smaller y (screen space)", () => {
    const t = fitTransform(bbox, 900, 600, 20);
    const [, ySouth] = project(t, bbox[0], bbox[1]); // minLat
    const [, yNorth] = project(t, bbox[0], bbox[3]); // maxLat
    expect(yNorth).toBeLessThan(ySouth);
  });
});

describe("decodeLine", () => {
  it("decodes a hand-built delta-coded line back to absolute lon/lat", () => {
    const bbox: [number, number, number, number] = [149, -35.6, 149.3, -35.1];
    const [minLon, minLat] = bbox;
    // [cls, pct, x0, y0, dx1, dy1, dx2, dy2] — cls/pct are metadata, not coords
    const line = [2, 100, 1000, 2000, 50, -30, -20, 10];
    const pts = decodeLine(line, bbox);
    expect(pts).toEqual([
      [minLon + 1000 / 1e5, minLat + 2000 / 1e5],
      [minLon + 1050 / 1e5, minLat + 1970 / 1e5], // running sum, not reset per hop
      [minLon + 1030 / 1e5, minLat + 1980 / 1e5],
    ]);
  });

  it("a line with only the first point (no delta pairs) decodes to a single point", () => {
    const bbox: [number, number, number, number] = [0, 0, 1, 1];
    expect(decodeLine([0, 0, 500, 500], bbox)).toEqual([[0.005, 0.005]]);
  });

  it("zero deltas repeat the previous point exactly (degenerate but must not crash)", () => {
    const bbox: [number, number, number, number] = [0, 0, 1, 1];
    const pts = decodeLine([1, 10, 100, 100, 0, 0], bbox);
    expect(pts).toEqual([[0.001, 0.001], [0.001, 0.001]]);
  });
});

describe("visibleLines", () => {
  const lines = [
    [0, 0, 0, 0],
    [1, 50, 0, 0],
    [2, 128, 0, 0],
    [3, 255, 0, 0],
  ];

  it("null threshold: every line is visible (no filtering)", () => {
    expect(visibleLines(lines, null)).toEqual(lines);
  });

  it("filters by pct >= threshold, inclusive at the boundary", () => {
    expect(visibleLines(lines, 128).map((l) => l[1])).toEqual([128, 255]);
  });

  it("threshold above every line's pct hides everything", () => {
    expect(visibleLines(lines, 256)).toEqual([]);
  });

  it("threshold of 0 keeps every line (pct is never negative)", () => {
    expect(visibleLines(lines, 0)).toEqual(lines);
  });
});

describe("strideFor", () => {
  it("len below cap -> stride 1", () => {
    expect(strideFor(100, 4000)).toBe(1);
  });

  it("len exactly at cap -> stride 1", () => {
    expect(strideFor(4000, 4000)).toBe(1);
  });

  it("len just over cap -> stride 2", () => {
    expect(strideFor(4001, 4000)).toBe(2);
  });

  it("len double the cap -> stride 2 exactly", () => {
    expect(strideFor(8000, 4000)).toBe(2);
  });

  it("cap defaults to 4000", () => {
    expect(strideFor(3999)).toBe(1);
    expect(strideFor(4001)).toBe(2);
  });

  it("len 0 -> stride still clamps to 1 (no divide-by-zero/stall landmine for callers)", () => {
    expect(strideFor(0, 4000)).toBe(1);
  });
});

// The zoom/pan view-transform layer (build-review amendment §14.2): a user
// ViewState composed ON TOP of the fitted transform. MapView's own
// zoomAt/panBy/resetView are thin (untested here, same jsdom-has-no-canvas
// rationale as the rest of the class) wrappers around the pure functions
// below, which carry the actual math and are what these tests exercise.

describe("composeView", () => {
  it("the identity view leaves the fit transform unchanged", () => {
    const fit = { scale: 2, ox: 10, oy: 20 };
    expect(composeView(fit, { scale: 1, tx: 0, ty: 0 })).toEqual(fit);
  });

  it("multiplies scale and scales the fit's own offset before adding the pan", () => {
    const fit = { scale: 2, ox: 10, oy: 20 };
    const view: ViewState = { scale: 3, tx: 5, ty: -4 };
    const t = composeView(fit, view);
    expect(t).toEqual({ scale: 6, ox: 10 * 3 + 5, oy: 20 * 3 - 4 });
  });
});

describe("zoomAbout (anchor-preserving zoom)", () => {
  it("the anchor's screen position is unchanged by the zoom (property, 200 seeded random states/anchors/factors, scale kept off the MIN_VIEW_SCALE reset boundary)", () => {
    const rand = mulberry32(20260815);
    for (let i = 0; i < 200; i++) {
      // scale kept strictly inside (1, 8) and factor kept close to 1 so the
      // result never lands exactly on MIN_VIEW_SCALE -- that transition
      // deliberately resets tx/ty (tested on its own below) and would
      // break the invariant this test checks.
      const view: ViewState = { scale: 1.2 + rand() * 6, tx: (rand() - 0.5) * 400, ty: (rand() - 0.5) * 400 };
      const cx = rand() * 900;
      const cy = rand() * 600;
      const factor = 0.7 + rand() * 0.6; // [0.7, 1.3]
      // The fit-space point currently sitting under the screen anchor
      // (cx, cy) -- same "invert then reapply" relationship project/
      // unproject have, just inlined for this property check.
      const fitX = (cx - view.tx) / view.scale;
      const fitY = (cy - view.ty) / view.scale;
      const after = zoomAbout(view, cx, cy, factor);
      const screenXAfter = fitX * after.scale + after.tx;
      const screenYAfter = fitY * after.scale + after.ty;
      expect(Math.abs(screenXAfter - cx)).toBeLessThan(1e-6);
      expect(Math.abs(screenYAfter - cy)).toBeLessThan(1e-6);
    }
  });

  it("clamps the resulting scale to [1, 8]", () => {
    expect(zoomAbout({ scale: 1, tx: 0, ty: 0 }, 0, 0, 100).scale).toBe(8);
    expect(zoomAbout({ scale: 8, tx: 0, ty: 0 }, 0, 0, 100).scale).toBe(8);
    expect(zoomAbout({ scale: 5, tx: 0, ty: 0 }, 0, 0, 0.0001).scale).toBe(1);
  });

  it("resets tx/ty to exactly 0 when the clamped scale lands at the minimum (the one deliberate exception to anchor preservation)", () => {
    const after = zoomAbout({ scale: 3, tx: 120, ty: -80 }, 400, 300, 0.01);
    expect(after).toEqual({ scale: 1, tx: 0, ty: 0 });
  });

  it("does NOT reset when scale merely clamps at the MAXIMUM -- only the minimum is special", () => {
    const after = zoomAbout({ scale: 4, tx: 50, ty: 30 }, 100, 100, 100); // requests 400, clamped to 8
    const ratio = 8 / 4;
    expect(after).toEqual({ scale: 8, tx: 100 - (100 - 50) * ratio, ty: 100 - (100 - 30) * ratio });
  });
});

describe("clampPan", () => {
  it("a wildly out-of-range pan clamps to the 25%-visible boundary on each axis", () => {
    const clamped = clampPan({ scale: 1, tx: 1000, ty: -1000 }, 800, 600);
    expect(clamped).toEqual({ scale: 1, tx: 0.75 * 800, ty: 0.25 * 600 - 600 });
  });

  it("leaves an already in-bounds pan untouched", () => {
    const view: ViewState = { scale: 3, tx: 50, ty: -30 };
    expect(clampPan(view, 800, 600)).toEqual(view);
  });

  it("never lets the content fully leave the viewport: overlap stays >= 25% of each axis (property, 200 seeded random scales/viewport sizes/pans)", () => {
    const rand = mulberry32(7);
    for (let i = 0; i < 200; i++) {
      const scale = 1 + rand() * 7;
      const w = 300 + rand() * 1600;
      const h = 300 + rand() * 1600;
      const tx = (rand() - 0.5) * 10000;
      const ty = (rand() - 0.5) * 10000;
      const clamped = clampPan({ scale, tx, ty }, w, h);
      const overlapX = Math.min(w, clamped.tx + w * scale) - Math.max(0, clamped.tx);
      const overlapY = Math.min(h, clamped.ty + h * scale) - Math.max(0, clamped.ty);
      expect(overlapX).toBeGreaterThanOrEqual(0.25 * w - 1e-6);
      expect(overlapY).toBeGreaterThanOrEqual(0.25 * h - 1e-6);
    }
  });
});

describe("project/unproject round trip through a composed (fit + view) transform", () => {
  it("unprojectPoint(projectPoint(p)) recovers the original geo point at random seeded view states", () => {
    const bbox: [number, number, number, number] = [148.9, -35.6, 149.3, -35.05];
    const fit = fitTransform(bbox, 900, 600, 20);
    const rand = mulberry32(424242);
    for (let i = 0; i < 200; i++) {
      const view: ViewState = { scale: 1 + rand() * 7, tx: (rand() - 0.5) * 500, ty: (rand() - 0.5) * 500 };
      const t = composeView(fit, view);
      const lon = bbox[0] + rand() * (bbox[2] - bbox[0]);
      const lat = bbox[1] + rand() * (bbox[3] - bbox[1]);
      const [x, y] = projectPoint(bbox, t, lon, lat);
      const [lon2, lat2] = unprojectPoint(bbox, t, x, y);
      expect(lon2).toBeCloseTo(lon, 9);
      expect(lat2).toBeCloseTo(lat, 9);
    }
  });
});
