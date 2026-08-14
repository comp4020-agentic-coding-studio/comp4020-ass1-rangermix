// Pure-function tests only. jsdom has no canvas 2D context, so MapView's
// actual canvas calls (drawBase/drawDots/drawRoute/drawPin/clearOverlay) are
// thin, untested here, and verified by eye once Task 7 wires MapView into a
// real page. What's exercised here is the geometry/data logic MapView is
// built on: projection fit, delta decode, threshold filter, dot stride math.

import { describe, expect, it } from "vitest";
import { decodeLine, fitTransform, strideFor, visibleLines } from "./mapRenderer";

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
