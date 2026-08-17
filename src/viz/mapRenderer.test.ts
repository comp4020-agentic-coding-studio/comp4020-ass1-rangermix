// Pure-function tests only. jsdom has no canvas 2D context, so MapView's
// actual canvas calls (drawBase/drawDots/drawRoute/drawPin/clearOverlay) are
// thin, untested here, and verified by eye once wired into a real page. What's
// exercised here is the geometry/data logic MapView is built on: projection
// fit, delta decode, threshold filter, dot stride math, and (§16.11) the
// geo-anchored view-state layer: deriveTransform, zoomAbout, panGeo,
// clampGeoView, zoomToBounds, createViewStore.

import { describe, expect, it } from "vitest";
import {
  assignStaggerSlots,
  baseBlitRect,
  baseCacheValid,
  baseCaptureBounds,
  baseFingerprintKey,
  captureBoundsDeviceSize,
  clampGeoView,
  createViewStore,
  decodeLine,
  deriveTransform,
  fitTransform,
  panGeo,
  projectPoint,
  refreshDue,
  strideFor,
  unprojectPoint,
  visibleLines,
  wholeMapView,
  withinBlitRange,
  zoomAbout,
  zoomToBounds,
  type BaseCacheKey,
  type CaptureBounds,
  type Transform,
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

/** The fraction of the TRUE fitted content rect's own width/height that
 * overlaps the viewport, per axis, after a `clampGeoView` call — what the
 * design spec's ">= 25% visible each axis" contract (build-review amendment
 * §14.2, re-derived in geo terms by §16.11) actually means. Computed by
 * projecting the bbox's own NW/SE corners through deriveTransform +
 * projectPoint (the PUBLIC api), never by reaching into clampGeoView's own
 * offset-clamping internals, so this helper can't share a bug with the code
 * it checks. Also returns the content size itself (px, per axis) — callers
 * deep enough into zoom territory need it to compute `minRequiredFraction`
 * below rather than compare against a flat 0.25 (see that function's
 * comment for why). */
function contentVisibleFraction(
  view: ViewState, bbox: [number, number, number, number], fit: Transform, viewportW: number, viewportH: number,
): { x: number; y: number; contentW: number; contentH: number } {
  const t = deriveTransform(view, bbox, fit, viewportW, viewportH);
  const [x0, y0] = projectPoint(bbox, t, bbox[0], bbox[3]); // NW corner (minLon, maxLat)
  const [x1, y1] = projectPoint(bbox, t, bbox[2], bbox[1]); // SE corner (maxLon, minLat)
  const contentW = x1 - x0;
  const contentH = y1 - y0;
  const overlapX = Math.min(viewportW, x1) - Math.max(0, x0);
  const overlapY = Math.min(viewportH, y1) - Math.max(0, y0);
  return { x: overlapX / contentW, y: overlapY / contentH, contentW, contentH };
}

/** The visible-fraction floor the design spec's own 25% target degrades to
 * once the content is more than 4x the viewport on an axis — reachable at
 * any span below 1/4 (well inside [MIN_SPAN, MAX_SPAN] = [1/8, 1]) even with
 * zero fit slack, since content size scales linearly with 1/span while the
 * viewport doesn't. Past that point, showing 25% of the content would need
 * more px than the viewport HAS at all — no pan position can do it — so the
 * best (and correct) achievable is filling the viewport completely (overlap
 * == viewportSize, a smaller fraction of the content than 25% but the true
 * physical maximum, not a clamp bug). Same floor the pre-geo-anchor
 * clampPan's own property test used; the algebra is unchanged by the
 * geo-anchor refactor (see clampGeoView's own comment: clamping the offset
 * and clamping the center are the same operation viewed from two sides). */
function minRequiredFraction(contentSize: number, viewportSize: number): number {
  return Math.min(0.25, viewportSize / contentSize);
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

// The geo-anchored view-transform layer (§16.11, replacing the old
// pixel-space `{scale, tx, ty}` ViewState): MapView's own zoomAt/panBy/
// resetView are thin (untested here, same jsdom-has-no-canvas rationale as
// the rest of the class) wrappers around the pure functions below, which
// carry the actual math and are what these tests exercise.

describe("wholeMapView", () => {
  it("centers on the bbox's own midpoint at span 1 (whole map)", () => {
    const bbox: [number, number, number, number] = [148.9, -35.6, 149.3, -35.05];
    const view = wholeMapView(bbox);
    expect(view.cLon).toBeCloseTo(149.1, 9);
    expect(view.cLat).toBeCloseTo(-35.325, 9);
    expect(view.span).toBe(1);
  });
});

describe("deriveTransform", () => {
  const bbox: [number, number, number, number] = [148.9, -35.6, 149.3, -35.05];

  it("at span 1 (wholeMapView), reproduces fitTransform's own output exactly for the SAME w/h -- span 1 is defined as \"the fit's own extent\"", () => {
    const w = 900, h = 600, pad = 20;
    const fit = fitTransform(bbox, w, h, pad);
    const t = deriveTransform(wholeMapView(bbox), bbox, fit, w, h);
    expect(t.scale).toBeCloseTo(fit.scale, 9);
    expect(t.ox).toBeCloseTo(fit.ox, 6);
    expect(t.oy).toBeCloseTo(fit.oy, 6);
  });

  it("scale is fit.scale / span", () => {
    const fit = fitTransform(bbox, 900, 600, 20);
    const t = deriveTransform({ cLon: 149.1, cLat: -35.3, span: 0.25 }, bbox, fit, 900, 600);
    expect(t.scale).toBeCloseTo(fit.scale / 0.25, 9);
  });

  it("the view's own (cLon, cLat) always projects to the viewport's exact center, for ANY panel size (property, 200 seeded random states/sizes) -- the mechanism that lets differently-shaped panels stay centered on the same geo point (§16.11)", () => {
    const fit = fitTransform(bbox, 900, 600, 20);
    const rand = mulberry32(160816);
    for (let i = 0; i < 200; i++) {
      const view: ViewState = {
        cLon: bbox[0] + rand() * (bbox[2] - bbox[0]),
        cLat: bbox[1] + rand() * (bbox[3] - bbox[1]),
        span: 1 / 8 + rand() * (1 - 1 / 8),
      };
      const w = 200 + rand() * 1500;
      const h = 200 + rand() * 1500;
      const t = deriveTransform(view, bbox, fit, w, h);
      const [x, y] = projectPoint(bbox, t, view.cLon, view.cLat);
      expect(x).toBeCloseTo(w / 2, 6);
      expect(y).toBeCloseTo(h / 2, 6);
    }
  });
});

describe("zoomAbout (anchor-preserving zoom, geo-anchored)", () => {
  const bbox: [number, number, number, number] = [148.9, -35.6, 149.3, -35.05];
  const fit = fitTransform(bbox, 900, 600, 20);

  it("the anchor's screen position is unchanged by the zoom (property, 200 seeded random states/anchors/factors, span kept off the MAX_SPAN reset boundary)", () => {
    const rand = mulberry32(20260816);
    for (let i = 0; i < 200; i++) {
      // span kept strictly inside (MIN_SPAN, MAX_SPAN) and factor kept
      // close to 1 so span/factor never lands exactly on MAX_SPAN -- that
      // transition deliberately resets to wholeMapView (tested on its own
      // below) and would break the invariant this test checks.
      const view: ViewState = {
        cLon: bbox[0] + rand() * (bbox[2] - bbox[0]),
        cLat: bbox[1] + rand() * (bbox[3] - bbox[1]),
        span: 0.2 + rand() * 0.5, // [0.2, 0.7]
      };
      const cx = rand() * 900;
      const cy = rand() * 600;
      const factor = 0.8 + rand() * 0.4; // [0.8, 1.2] -> span/factor in ~[0.167, 0.875], both clear of [1/8, 1]'s ends
      const before = deriveTransform(view, bbox, fit, 900, 600);
      const anchor = unprojectPoint(bbox, before, cx, cy);
      const after = zoomAbout(view, bbox, fit, 900, 600, cx, cy, factor);
      const afterT = deriveTransform(after, bbox, fit, 900, 600);
      const [xAfter, yAfter] = projectPoint(bbox, afterT, anchor[0], anchor[1]);
      expect(Math.abs(xAfter - cx)).toBeLessThan(1e-6);
      expect(Math.abs(yAfter - cy)).toBeLessThan(1e-6);
    }
  });

  // Regression (live-verify catch, G2): a MapView calls zoomAbout only from
  // a real pointer/wheel gesture, which can't reach a hidden panel -- but a
  // degenerate `fit.scale === 0` is nonetheless a real value MapView.resize()
  // can produce (see clampGeoView's own regression test below for the exact
  // scenario: a `display:none` canvas floors to a 1x1 css size, starving
  // fitTransform's availW/availH to 0). zoomAbout must not propagate that
  // into Infinity/NaN.
  it("regression: fit.scale === 0 (degenerate/hidden panel) returns view UNCHANGED instead of dividing by zero", () => {
    const degenerateFit: Transform = { scale: 0, ox: 24, oy: 24 };
    const view: ViewState = { cLon: 149.1, cLat: -35.3, span: 0.5 };
    expect(zoomAbout(view, bbox, degenerateFit, 1, 1, 0.5, 0.5, 2)).toEqual(view);
  });

  it("clamps the resulting span to [1/8, 1]", () => {
    expect(zoomAbout(wholeMapView(bbox), bbox, fit, 900, 600, 0, 0, 100).span).toBe(1 / 8);
    expect(zoomAbout({ cLon: 149.1, cLat: -35.3, span: 1 / 8 }, bbox, fit, 900, 600, 0, 0, 100).span).toBe(1 / 8);
    expect(zoomAbout({ cLon: 149.1, cLat: -35.3, span: 0.5 }, bbox, fit, 900, 600, 0, 0, 0.0001).span).toBe(1);
  });

  it("resets to wholeMapView(bbox) when the clamped span lands at MAX_SPAN (the one deliberate exception to anchor preservation)", () => {
    const after = zoomAbout({ cLon: 149.2, cLat: -35.1, span: 0.3 }, bbox, fit, 900, 600, 400, 300, 0.01);
    expect(after).toEqual(wholeMapView(bbox));
  });

  it("does NOT reset when span merely clamps at MIN_SPAN -- only the whole-map (MAX_SPAN) boundary is special; anchor preservation still holds exactly at MIN_SPAN", () => {
    const view: ViewState = { cLon: 149.15, cLat: -35.2, span: 0.4 };
    const cx = 100, cy = 100;
    const before = deriveTransform(view, bbox, fit, 900, 600);
    const anchor = unprojectPoint(bbox, before, cx, cy);
    const after = zoomAbout(view, bbox, fit, 900, 600, cx, cy, 100); // requests span 0.004, clamped to 1/8
    expect(after.span).toBe(1 / 8);
    const afterT = deriveTransform(after, bbox, fit, 900, 600);
    const [x, y] = projectPoint(bbox, afterT, anchor[0], anchor[1]);
    expect(Math.abs(x - cx)).toBeLessThan(1e-6);
    expect(Math.abs(y - cy)).toBeLessThan(1e-6);
  });
});

describe("panGeo", () => {
  const bbox: [number, number, number, number] = [148.9, -35.6, 149.3, -35.05];
  const fit = fitTransform(bbox, 900, 600, 20);

  it("shifts EVERY point's screen projection by exactly (dx, dy) -- panning is a uniform screen-space translation at fixed scale, independent of which point you check (property, 200 seeded random states/deltas/points)", () => {
    const rand = mulberry32(424243);
    for (let i = 0; i < 200; i++) {
      const view: ViewState = {
        cLon: bbox[0] + rand() * (bbox[2] - bbox[0]),
        cLat: bbox[1] + rand() * (bbox[3] - bbox[1]),
        span: 1 / 8 + rand() * (1 - 1 / 8),
      };
      const dx = (rand() - 0.5) * 300;
      const dy = (rand() - 0.5) * 300;
      const shifted = panGeo(view, bbox, fit, 900, 600, dx, dy);
      expect(shifted.span).toBe(view.span); // pan never touches zoom
      const tOld = deriveTransform(view, bbox, fit, 900, 600);
      const tNew = deriveTransform(shifted, bbox, fit, 900, 600);
      const lon = bbox[0] + rand() * (bbox[2] - bbox[0]);
      const lat = bbox[1] + rand() * (bbox[3] - bbox[1]);
      const [x0, y0] = projectPoint(bbox, tOld, lon, lat);
      const [x1, y1] = projectPoint(bbox, tNew, lon, lat);
      expect(x1 - x0).toBeCloseTo(dx, 6);
      expect(y1 - y0).toBeCloseTo(dy, 6);
    }
  });

  it("dx=dy=0 is a no-op", () => {
    const view: ViewState = { cLon: 149.1, cLat: -35.3, span: 0.5 };
    expect(panGeo(view, bbox, fit, 900, 600, 0, 0)).toEqual(view);
  });

  // Regression (live-verify catch, G2) — see clampGeoView's own regression
  // test for the concrete scenario (a hidden panel's resize() producing
  // fit.scale === 0); panGeo isn't on THAT call path today, but guards the
  // same input for the same reason zoomAbout does: a nonzero (dx, dy)
  // against scale 0 would divide by zero.
  it("regression: fit.scale === 0 returns view UNCHANGED instead of dividing by zero", () => {
    const degenerateFit: Transform = { scale: 0, ox: 24, oy: 24 };
    const view: ViewState = { cLon: 149.1, cLat: -35.3, span: 0.5 };
    expect(panGeo(view, bbox, degenerateFit, 1, 1, 40, -15)).toEqual(view);
  });
});

describe("clampGeoView (against the TRUE fitted content rect, not the viewport as a stand-in)", () => {
  it("an extreme pan (east) clamps cLon to exactly the 25%-visible boundary (flush fit, no slack, hand-checked)", () => {
    // midLat 0 -> cosMid exactly 1, so this bbox/fit pair is hand-checkable:
    // mapW = mapH = 1 (map units), fit.scale 800 with zero pad -> content
    // exactly fills an 800x800 viewport at span 1 (the "flushFit" case the
    // old pixel-space clampPan test suite used, re-expressed in geo terms).
    const bbox: [number, number, number, number] = [0, -0.5, 1, 0.5];
    const fit: Transform = fitTransform(bbox, 800, 800, 0);
    expect(fit).toEqual({ scale: 800, ox: 0, oy: 0 }); // sanity: genuinely zero slack
    const clamped = clampGeoView({ cLon: 1000, cLat: 0, span: 1 }, bbox, fit, 800, 800);
    // Hand-derived: ox = 400 - 1000*800 (huge negative) clamps to
    // max = 800 - 0.25*800 = 600 -> cLon = 0 + (400-600)/800 = -0.25... see
    // below for the OTHER direction; this axis's clamp pushes content's
    // LEFT edge in from the right, landing cLon at 1.25 (just east of the
    // bbox's own east edge, so only its western sliver still shows).
    expect(clamped.cLon).toBeCloseTo(1.25, 9);
    expect(clamped.cLat).toBeCloseTo(0, 9); // already centered/in-bounds, untouched
    expect(clamped.span).toBe(1);
    const frac = contentVisibleFraction(clamped, bbox, fit, 800, 800);
    expect(frac.x).toBeCloseTo(0.25, 6);
  });

  it("an extreme pan (west) clamps symmetrically", () => {
    const bbox: [number, number, number, number] = [0, -0.5, 1, 0.5];
    const fit: Transform = fitTransform(bbox, 800, 800, 0);
    const clamped = clampGeoView({ cLon: -1000, cLat: 0, span: 1 }, bbox, fit, 800, 800);
    expect(clamped.cLon).toBeCloseTo(-0.25, 9);
    const frac = contentVisibleFraction(clamped, bbox, fit, 800, 800);
    expect(frac.x).toBeCloseTo(0.25, 6);
  });

  it("leaves an already in-bounds view untouched (flush fit)", () => {
    const bbox: [number, number, number, number] = [0, -0.5, 1, 0.5];
    const fit: Transform = fitTransform(bbox, 800, 800, 0);
    const view: ViewState = { cLon: 0.4, cLat: 0.05, span: 0.5 };
    const clamped = clampGeoView(view, bbox, fit, 800, 800);
    expect(clamped.cLon).toBeCloseTo(view.cLon, 9);
    expect(clamped.cLat).toBeCloseTo(view.cLat, 9);
  });

  // Regression (live-verify catch, G2) — the actual bug: MapView.resize()
  // calls clampGeoView UNCONDITIONALLY, including for a panel whose canvas
  // is currently `display:none` (found live: the overlay map, constructed
  // while a PERSISTED localStorage preference already has Compare mode
  // active, so the overlay's `.map-frame` starts `hidden` before the
  // overlay's own MapView is ever constructed). A hidden element's
  // `getBoundingClientRect()` is zero, MapView.resize() floors that to a
  // 1x1 css size, and fitTransform(bbox, 1, 1, PAD=24) then has
  // availW=availH=0 (viewport smaller than 2*PAD) -> fit.scale === 0
  // exactly — reproduced here directly against fitTransform's own output,
  // not a hand-typed Transform, so this test would catch a regression in
  // EITHER function. Before the fix, this produced NaN (0/0) in cLon/cLat,
  // written into the SHARED store — corrupting every panel sharing it, not
  // just the hidden one (confirmed live: switching to Compare mode after
  // this showed `null`/`null` for every panel's center once the value round-
  // tripped through JSON, i.e. NaN).
  it("regression: a hidden panel's degenerate fit (scale === 0, from a real fitTransform call) returns view UNCHANGED, never NaN", () => {
    const bbox: [number, number, number, number] = [148.9179634, -35.6505443, 149.3332927, -35.0450695];
    const hiddenFit = fitTransform(bbox, 1, 1, 24); // MapView.resize()'s own floor for a display:none canvas
    expect(hiddenFit.scale).toBe(0); // sanity: genuinely the degenerate case, not almost-zero
    const view: ViewState = wholeMapView(bbox);
    const result = clampGeoView(view, bbox, hiddenFit, 1, 1);
    expect(result).toEqual(view);
    expect(Number.isFinite(result.cLon)).toBe(true);
    expect(Number.isFinite(result.cLat)).toBe(true);
  });

  // The real committed bbox (public/data/render.json) fitted into a
  // realistic desktop map viewport (~1016x778, PAD=24 -- mirrors
  // mapRenderer.ts's own PAD constant). Canberra's bbox is much taller than
  // wide in map units (mapH/mapW ~= 1.8 after cos(midLat) x-correction --
  // see the fitTransform describe block above), so THIS viewport is
  // height-constrained: the fitted content is far NARROWER than the
  // viewport, centered with wide slack on the x-axis — exactly the
  // asymmetric-slack case the F2 fix (now re-derived in geo terms here) was
  // written to cover.
  const bbox: [number, number, number, number] = [
    148.9179634, -35.6505443, 149.3332927, -35.0450695,
  ];
  const viewportW = 1016, viewportH = 778, pad = 24;
  const fit = fitTransform(bbox, viewportW, viewportH, pad);

  it("sanity: this fit is genuinely asymmetric (wide x-axis slack) -- otherwise this block wouldn't exercise the bug", () => {
    expect(fit.ox).toBeGreaterThan(pad + 50);
  });

  it("one ordinary drag-sized pan (well under the viewport's own ~1016px width, not an extreme fling) never drops below 25% visible on either axis", () => {
    const wide = wholeMapView(bbox);
    // panGeo by a realistic single-drag-sized delta, then clamp -- mirrors
    // how MapView.panBy actually composes the two.
    const dragged = clampGeoView(
      panGeo(wide, bbox, fit, viewportW, viewportH, -700, -700), bbox, fit, viewportW, viewportH,
    );
    const frac = contentVisibleFraction(dragged, bbox, fit, viewportW, viewportH);
    expect(frac.x).toBeGreaterThanOrEqual(0.25 - 1e-6);
    expect(frac.y).toBeGreaterThanOrEqual(0.25 - 1e-6);
  });

  it("resize()'s job: reclamping a view that was valid at one viewport size against a NEW (much smaller) size still satisfies the 25% bound", () => {
    const bigW = 1200, bigH = 900;
    const bigFit = fitTransform(bbox, bigW, bigH, pad);
    const view = clampGeoView(
      panGeo(wholeMapView(bbox), bbox, bigFit, bigW, bigH, -2000, 1800), bbox, bigFit, bigW, bigH,
    );

    // The viewport then shrinks a lot (phone rotation, drastic desktop
    // resize) without the geo view itself changing -- MapView.resize() must
    // now re-run clampGeoView against the new fit/size for exactly this
    // reason (a resize used to leave the view untouched, stranding content
    // off-screen); simulating that re-clamp here must still land within the
    // 25% bound at the NEW size, not the stale bounds of a viewport that no
    // longer exists.
    const smallW = 380, smallH = 700;
    const smallFit = fitTransform(bbox, smallW, smallH, pad);
    const reclamped = clampGeoView(view, bbox, smallFit, smallW, smallH);
    const frac = contentVisibleFraction(reclamped, bbox, smallFit, smallW, smallH);
    expect(frac.x).toBeGreaterThanOrEqual(minRequiredFraction(frac.contentW, smallW) - 1e-6);
    expect(frac.y).toBeGreaterThanOrEqual(minRequiredFraction(frac.contentH, smallH) - 1e-6);
  });

  it("never lets the content fully leave the viewport: visible fraction of the CONTENT rect >= 25% (or the viewport-filling floor once zoom makes 25% physically unreachable — see minRequiredFraction) per axis, incl. at max zoom and after extreme pans (property, 200 seeded random spans/centers against the realistic asymmetric fit)", () => {
    const rand = mulberry32(7);
    for (let i = 0; i < 200; i++) {
      const span = 1 / 8 + rand() * (1 - 1 / 8); // full [MIN_SPAN, MAX_SPAN] range
      // Deliberately far beyond any real drag — random geo centers well
      // outside the bbox itself, exercising the clamp's own boundary math
      // rather than only ever-in-bounds values.
      const cLon = bbox[0] + (rand() - 0.5) * 40;
      const cLat = bbox[1] + (rand() - 0.5) * 40;
      const clamped = clampGeoView({ cLon, cLat, span }, bbox, fit, viewportW, viewportH);
      const frac = contentVisibleFraction(clamped, bbox, fit, viewportW, viewportH);
      expect(frac.x).toBeGreaterThanOrEqual(minRequiredFraction(frac.contentW, viewportW) - 1e-6);
      expect(frac.y).toBeGreaterThanOrEqual(minRequiredFraction(frac.contentH, viewportH) - 1e-6);
    }
  });
});

// §16.6: starting any race zooms the viewport to the A-B bounds with ~15%
// padding — zoomToBounds now takes the REFERENCE panel's own w/h and routes
// A/B through that panel's REAL fit (see the function's own comment for the
// build-review fix this is: the old bbox-fraction formula was only exact at
// pad=0 and an aspect-matched viewport, neither true of any real panel here
// — PAD=24, and Canberra's bbox aspect matches no real viewport).
describe("zoomToBounds", () => {
  /** The padding fraction actually achieved on whichever edge is TIGHTEST,
   * evaluating a zoomToBounds result against a specific panel size via the
   * PUBLIC deriveTransform/projectPoint (never zoomToBounds's own internals)
   * — takes min/max of the two points' own coordinates per axis (not "A's
   * edge, B's edge") since which point ends up further north/east depends
   * on the pair, not on argument order. A single number this small (>0)
   * simultaneously proves "both points strictly inside" — there is no
   * separate boundary case where all four edges have positive margin here
   * but a point is still outside. */
  function achievedLimitingPadding(
    view: ViewState, bbox: [number, number, number, number], w: number, h: number,
    lonA: number, latA: number, lonB: number, latB: number,
  ): number {
    const fit = fitTransform(bbox, w, h, 24); // PAD — mirrors mapRenderer.ts's own real-panel constant
    const t = deriveTransform(view, bbox, fit, w, h);
    const [xA, yA] = projectPoint(bbox, t, lonA, latA);
    const [xB, yB] = projectPoint(bbox, t, lonB, latB);
    const left = Math.min(xA, xB);
    const right = Math.max(xA, xB);
    const top = Math.min(yA, yB);
    const bottom = Math.max(yA, yB);
    return Math.min(left / w, (w - right) / w, top / h, (h - bottom) / h);
  }

  it("frames a pair with EXACTLY the requested padding on the limiting axis (hand-checked: bbox/pair/viewport chosen so cosMid=1 and both axes are equally matched, so PAD's specific pixel cost cancels out of the achieved on-screen fraction exactly — see zoomToBounds's own comment)", () => {
    // bbox centered at lat 0 (cosMid exactly 1), square in map units
    // (mapW = mapH = 2), square viewport — the cleanest possible hand-check.
    const bbox: [number, number, number, number] = [-1, -1, 1, 1];
    const w = 1000, h = 1000;
    // A and B both sit on the bbox's own horizontal center line (latSpread
    // = 0), so lon is unambiguously the limiting axis this pair's framing
    // is matched to.
    const view = zoomToBounds(bbox, -0.5, 0, 0.5, 0, w, h, 0.15);
    expect(view.cLon).toBeCloseTo(0, 9);
    expect(view.cLat).toBeCloseTo(0, 9);
    // Hand-derived against the REAL PAD=24 fit (scale 476, ox=oy=24):
    // dxPx = 476, spanX = 476 / (0.7 * 1000) = 0.68 exactly.
    expect(view.span).toBeCloseTo(0.68, 9);

    const fit = fitTransform(bbox, w, h, 24); // PAD — the same real-panel constant zoomToBounds uses internally
    const t = deriveTransform(view, bbox, fit, w, h);
    const [xA] = projectPoint(bbox, t, -0.5, 0);
    const [xB] = projectPoint(bbox, t, 0.5, 0);
    expect(xA).toBeCloseTo(150, 6); // 15% of 1000px in from the left
    expect(xB).toBeCloseTo(850, 6); // 15% of 1000px in from the right
    expect(xA).toBeGreaterThan(0);
    expect(xB).toBeLessThan(w);
  });

  // build-review fix (review finding #1): measured against the REAL
  // committed bbox (public/data/render.json) and REAL preset coordinates
  // (src/presets.ts) at the two viewport sizes this app actually ships
  // (desktop overlay ~1016x778, phone/compare-panel ~350x460), the OLD
  // formula landed 17-49% padding instead of ~15% on 4 of 5 presets
  // (ANU->Airport measured 36%/41%). [12%, 22%] rather than an exact 15%
  // because MIN_SPAN's pre-existing 8x-zoom cap can legitimately push a
  // pair that's close together relative to the whole bbox (ANU->Airport at
  // the LARGER viewport specifically) above the natural 15% target — a
  // physical zoom-cap floor, not a padding-formula bug (every other
  // cell here lands within float noise of exactly 15%, see the console
  // trace this suite was built against).
  const REAL_BBOX: [number, number, number, number] = [148.9179634, -35.6505443, 149.3332927, -35.0450695];
  const REAL_PRESETS = [
    { id: "hill (Gungahlin -> Capital Hill)", a: [149.133, -35.186], b: [149.1245, -35.308] },
    { id: "anu-airport", a: [149.119, -35.278], b: [149.193, -35.307] },
    { id: "diagonal (Belconnen -> Tuggeranong)", a: [149.066, -35.24], b: [149.088, -35.415] },
    { id: "dickson-woden", a: [149.14, -35.252], b: [149.085, -35.345] },
    { id: "kingston-belconnen", a: [149.147, -35.316], b: [149.066, -35.24] },
  ] as const;

  describe.each([
    { label: "desktop overlay (1016x778)", w: 1016, h: 778 },
    { label: "phone/compare panel (350x460)", w: 350, h: 460 },
  ])("against the real bbox + real presets: $label", ({ w, h }) => {
    it.each(REAL_PRESETS)("$id achieves ~15% padding on the limiting axis (within [12%, 22%]), both points strictly inside", ({ a, b }) => {
      const view = zoomToBounds(REAL_BBOX, a[0], a[1], b[0], b[1], w, h);
      expect(Number.isFinite(view.cLon)).toBe(true);
      expect(Number.isFinite(view.cLat)).toBe(true);
      const pad = achievedLimitingPadding(view, REAL_BBOX, w, h, a[0], a[1], b[0], b[1]);
      expect(pad).toBeGreaterThanOrEqual(0.12);
      expect(pad).toBeLessThanOrEqual(0.22);
    });
  });

  it("both points land strictly inside the resulting view, for random bboxes/pairs/PANEL SIZES (property, 200 seeded) — deliberately NOT aspect-matched or zero-pad: arbitrary aspect ratio and a real PAD are exactly what the old formula got wrong", () => {
    const rand = mulberry32(20260817);
    for (let i = 0; i < 200; i++) {
      const minLon = 148 + rand() * 2;
      const minLat = -36 + rand() * 2;
      const bbox: [number, number, number, number] = [minLon, minLat, minLon + 0.2 + rand() * 0.4, minLat + 0.2 + rand() * 0.4];
      const lonA = bbox[0] + rand() * (bbox[2] - bbox[0]);
      const latA = bbox[1] + rand() * (bbox[3] - bbox[1]);
      const lonB = bbox[0] + rand() * (bbox[2] - bbox[0]);
      const latB = bbox[1] + rand() * (bbox[3] - bbox[1]);
      const w = 200 + rand() * 1200; // comfortably > 2*PAD=48 at every draw
      const h = 200 + rand() * 1200;
      const view = zoomToBounds(bbox, lonA, latA, lonB, latB, w, h, 0.15);
      expect(view.span).toBeGreaterThanOrEqual(1 / 8 - 1e-9);
      expect(view.span).toBeLessThanOrEqual(1 + 1e-9);
      expect(Number.isFinite(view.cLon)).toBe(true);
      expect(Number.isFinite(view.cLat)).toBe(true);
      const fit = fitTransform(bbox, w, h, 24);
      const t = deriveTransform(view, bbox, fit, w, h);
      for (const [lon, lat] of [[lonA, latA], [lonB, latB]] as const) {
        const [x, y] = projectPoint(bbox, t, lon, lat);
        expect(x).toBeGreaterThanOrEqual(-1e-6);
        expect(x).toBeLessThanOrEqual(w + 1e-6);
        expect(y).toBeGreaterThanOrEqual(-1e-6);
        expect(y).toBeLessThanOrEqual(h + 1e-6);
      }
    }
  });

  it("a degenerate same-point pair has no extent to frame -- clamps to MIN_SPAN (max zoom), no NaN/crash, centered exactly on the point", () => {
    const bbox: [number, number, number, number] = [148.9, -35.6, 149.3, -35.05];
    const view = zoomToBounds(bbox, 149.1, -35.3, 149.1, -35.3, 900, 600, 0.15);
    expect(view).toEqual({ cLon: 149.1, cLat: -35.3, span: 1 / 8 });
  });

  it("a pair spanning (most of) the whole bbox clamps to MAX_SPAN (whole map) rather than requesting an impossible zoom-out", () => {
    const bbox: [number, number, number, number] = [148.9, -35.6, 149.3, -35.05];
    const view = zoomToBounds(bbox, bbox[0], bbox[1], bbox[2], bbox[3], 900, 600, 0.15);
    expect(view.span).toBe(1);
  });

  it("default pad is 0.15", () => {
    const bbox: [number, number, number, number] = [-1, -1, 1, 1];
    expect(zoomToBounds(bbox, -0.5, 0, 0.5, 0, 1000, 1000)).toEqual(zoomToBounds(bbox, -0.5, 0, 0.5, 0, 1000, 1000, 0.15));
  });

  // Regression: a hidden panel's resize() (Compare mode persisted, overlay
  // still `display:none` when its own MapView first constructs — the exact
  // scenario clampGeoView/zoomAbout/panGeo/baseBlitRect's own regression
  // tests already cover) floors to a 1x1 css size, making fit.scale exactly
  // 0. zoomToBounds has no pre-existing `view` to fall back to (unlike those
  // four functions), so it returns the AB midpoint at MAX_SPAN instead.
  it("regression: a degenerate viewport (fit.scale === 0, e.g. a hidden panel's 1x1 floor) returns the AB midpoint at MAX_SPAN instead of dividing by zero", () => {
    const bbox: [number, number, number, number] = [148.9179634, -35.6505443, 149.3332927, -35.0450695];
    const view = zoomToBounds(bbox, 149.1, -35.3, 149.15, -35.25, 1, 1, 0.15); // MapView.resize()'s own floor for a display:none canvas
    expect(view).toEqual({ cLon: 149.125, cLat: -35.275, span: 1 });
    expect(Number.isFinite(view.cLon)).toBe(true);
    expect(Number.isFinite(view.cLat)).toBe(true);
  });
});

// The shared pan/zoom store (build-review amendment §14.3, Compare mode; §16.11
// geo-anchored): ONE store, every panel's MapView (plus the overlay's own)
// subscribes to it, so a pan/zoom gesture in any one of them moves all of
// them. MapView itself is untested here (jsdom has no canvas, same rationale
// as the rest of the class) but the store is plain data + callbacks — no DOM
// at all — so its get/set/subscribe/unsubscribe contract is fully
// unit-testable on its own.
describe("createViewStore (the shared pan/zoom store)", () => {
  it("get() returns whatever initial state was passed", () => {
    const initial: ViewState = { cLon: 149.1, cLat: -35.3, span: 0.5 };
    const store = createViewStore(initial);
    expect(store.get()).toEqual(initial);
  });

  it("set() updates what get() returns", () => {
    const store = createViewStore({ cLon: 0, cLat: 0, span: 1 });
    const next: ViewState = { cLon: 1, cLat: 2, span: 0.25 };
    store.set(next);
    expect(store.get()).toEqual(next);
  });

  it("subscribe() does NOT fire immediately on registration (matches theme.ts's onThemeChange: register-then-wait, not register-then-replay)", () => {
    const store = createViewStore({ cLon: 0, cLat: 0, span: 1 });
    let calls = 0;
    store.subscribe(() => {
      calls++;
    });
    expect(calls).toBe(0);
  });

  it("subscribe() fires with the new state on every set(), in order", () => {
    const store = createViewStore({ cLon: 0, cLat: 0, span: 1 });
    const seen: ViewState[] = [];
    store.subscribe((v) => seen.push(v));
    const a: ViewState = { cLon: 1, cLat: 1, span: 0.5 };
    const b: ViewState = { cLon: 2, cLat: 2, span: 0.25 };
    store.set(a);
    store.set(b);
    expect(seen).toEqual([a, b]);
  });

  it("every subscriber is notified on the same set() — the mechanism one store driving N panels + the overlay relies on", () => {
    const store = createViewStore({ cLon: 0, cLat: 0, span: 1 });
    let a = 0;
    let b = 0;
    let c = 0;
    store.subscribe(() => {
      a++;
    });
    store.subscribe(() => {
      b++;
    });
    store.subscribe(() => {
      c++;
    });
    store.set({ cLon: 1, cLat: 1, span: 0.5 });
    expect([a, b, c]).toEqual([1, 1, 1]);
  });

  it("set() with a value field-equal to the current state is a no-op: no notify, no re-render fan-out (build-review fix — a resize's no-op re-clamp used to still notify every sharer of the store)", () => {
    const store = createViewStore({ cLon: 149.1, cLat: -35.3, span: 0.5 });
    let calls = 0;
    store.subscribe(() => {
      calls++;
    });
    store.set({ cLon: 149.1, cLat: -35.3, span: 0.5 }); // same values, deliberately a NEW object (not the same reference)
    expect(calls).toBe(0);
    expect(store.get()).toEqual({ cLon: 149.1, cLat: -35.3, span: 0.5 });
  });

  it("set() still notifies when only ONE field actually changes (the guard is a full field compare, not a truthy/reference shortcut)", () => {
    const store = createViewStore({ cLon: 149.1, cLat: -35.3, span: 0.5 });
    let calls = 0;
    store.subscribe(() => {
      calls++;
    });
    store.set({ cLon: 149.1, cLat: -35.3, span: 0.5001 });
    expect(calls).toBe(1);
  });

  it("subscribe() returns a REAL unsubscribe: that callback stops firing, other subscribers keep firing", () => {
    const store = createViewStore({ cLon: 0, cLat: 0, span: 1 });
    let stopped = 0;
    let kept = 0;
    const unsub = store.subscribe(() => {
      stopped++;
    });
    store.subscribe(() => {
      kept++;
    });
    store.set({ cLon: 1, cLat: 1, span: 0.5 });
    unsub();
    store.set({ cLon: 2, cLat: 2, span: 0.25 });
    expect(stopped).toBe(1);
    expect(kept).toBe(2);
  });

  it("unsubscribing twice is a harmless no-op (MapView.dispose() must be safe to call more than once)", () => {
    const store = createViewStore({ cLon: 0, cLat: 0, span: 1 });
    const unsub = store.subscribe(() => {});
    unsub();
    expect(() => unsub()).not.toThrow();
  });

  // §16.9 REGRESSION — the overlay-lag bug's actual root cause and the
  // property that makes MapView's fix (no cached transform; every consumer
  // derives one fresh from store.get(), see mapRenderer.ts's MapView class
  // comment) immune to it. The bug was NOT in this store: `state = next`
  // already ran before the listener loop, so get() answering with the NEW
  // value inside every subscriber was already true. The bug was that
  // MapView cached a Transform inside ITS OWN subscription callback, and a
  // DIFFERENT, earlier-registered subscriber (home.ts's page-level overlay
  // redraw) read that stale cache before MapView's callback had a chance to
  // refresh it. This test pins the guarantee the fix now leans on instead:
  // two independent subscribers, registered in the SAME order the historical
  // bug had (page-level "early" one first, MapView-style "late" one second),
  // deriving a Transform from store.get() on every notification, must always
  // derive the IDENTICAL Transform — proving there is no window, at any
  // point in the listener order, where one subscriber's derivation could see
  // different data than another's.
  it("regression (§16.9 overlay-lag bug): two subscribers registered in either order derive the IDENTICAL Transform from store.get() on every update — nothing left for subscription order to make stale", () => {
    const bbox: [number, number, number, number] = [148.9, -35.6, 149.3, -35.05];
    const fit = fitTransform(bbox, 900, 600, 24);
    const store = createViewStore(wholeMapView(bbox));
    const seenEarly: Transform[] = []; // mirrors home.ts's page-level subscription (historically registered FIRST)
    const seenLate: Transform[] = []; // mirrors a MapView's own subscription (historically registered SECOND, once render data arrived)
    store.subscribe(() => seenEarly.push(deriveTransform(store.get(), bbox, fit, 900, 600)));
    store.subscribe(() => seenLate.push(deriveTransform(store.get(), bbox, fit, 900, 600)));
    store.set(zoomAbout(store.get(), bbox, fit, 900, 600, 450, 300, 2));
    store.set(panGeo(store.get(), bbox, fit, 900, 600, 40, -15));
    store.set(zoomToBounds(bbox, 149.0, -35.4, 149.2, -35.2, 900, 600));
    expect(seenEarly).toEqual(seenLate);
  });
});

describe("project/unproject round trip through a derived (geo view) transform", () => {
  it("unprojectPoint(projectPoint(p)) recovers the original geo point at random seeded geo view states", () => {
    const bbox: [number, number, number, number] = [148.9, -35.6, 149.3, -35.05];
    const fit = fitTransform(bbox, 900, 600, 20);
    const rand = mulberry32(424242);
    for (let i = 0; i < 200; i++) {
      const view: ViewState = {
        cLon: bbox[0] + rand() * (bbox[2] - bbox[0]),
        cLat: bbox[1] + rand() * (bbox[3] - bbox[1]),
        span: 1 / 8 + rand() * (1 - 1 / 8),
      };
      const t = deriveTransform(view, bbox, fit, 900, 600);
      const lon = bbox[0] + rand() * (bbox[2] - bbox[0]);
      const lat = bbox[1] + rand() * (bbox[3] - bbox[1]);
      const [x, y] = projectPoint(bbox, t, lon, lat);
      const [lon2, lat2] = unprojectPoint(bbox, t, x, y);
      expect(lon2).toBeCloseTo(lon, 9);
      expect(lat2).toBeCloseTo(lat, 9);
    }
  });
});

// Interaction-time base-layer caching (§16.10 — perf: "overlay view should
// be smooth; compare view currently lags significantly"). MapView itself
// (the class that actually decides blit-vs-crisp-restroke and owns the
// cached bitmap) is untested here, same jsdom-has-no-canvas rationale as the
// rest of this file — what's exercised below is the pure math/decision
// layer it's built on: where to blit the cached bitmap (baseBlitRect), how
// far the cache's own zoom may drift from the current view before a blit
// isn't worth it (withinBlitRange), and what invalidates the cache
// (baseCacheValid).
describe("baseBlitRect (where to drawImage the cached base bitmap under the CURRENT transform)", () => {
  it("identity: cached and current view are the same -> the cached bitmap covers the viewport exactly (dx=dy=0, full size)", () => {
    const bbox: [number, number, number, number] = [148.9, -35.6, 149.3, -35.05];
    const fit = fitTransform(bbox, 900, 600, 20);
    const view: ViewState = { cLon: 149.1, cLat: -35.3, span: 0.4 };
    const rect = baseBlitRect(view, view, bbox, fit, 900, 600);
    // toBeCloseTo, not toEqual: this round-trips through project/unproject
    // twice (real irrational scale/cos values), so it lands at ~1e-12, not
    // bit-exact zero — same tolerance the project/unproject round-trip
    // tests above already use for the same reason.
    expect(rect.dx).toBeCloseTo(0, 6);
    expect(rect.dy).toBeCloseTo(0, 6);
    expect(rect.dw).toBeCloseTo(900, 6);
    expect(rect.dh).toBeCloseTo(600, 6);
  });

  it("a 2x zoom-in about the SAME center doubles the blit rect, centered on the viewport (hand-checked: cosMid=1, zero-slack square bbox/fit)", () => {
    // Same bbox/fit shape as clampGeoView's own "flush fit" hand-checked
    // cases above: midLat 0 -> cosMid exactly 1, square bbox in map units,
    // zero pad -> fit.scale is a round number with no aspect slack.
    const bbox: [number, number, number, number] = [0, -0.5, 1, 0.5];
    const fit = fitTransform(bbox, 800, 800, 0);
    expect(fit).toEqual({ scale: 800, ox: 0, oy: 0 }); // sanity: genuinely zero slack
    const cached = wholeMapView(bbox); // span 1, centered — the cached bitmap IS the whole bbox
    const current: ViewState = { cLon: cached.cLon, cLat: cached.cLat, span: 0.5 }; // 2x zoom in, same center
    const rect = baseBlitRect(cached, current, bbox, fit, 800, 800);
    // The cached bitmap's own corners (the whole bbox, at scale 800) sit at
    // screen (0,0)-(800,800) under the CACHED transform; unprojecting those
    // through the cached transform recovers the bbox corners exactly, and
    // reprojecting the bbox corners through the NEW (2x) transform doubles
    // their distance from the viewport center (400,400) -- corners land at
    // (-400,-400) and (1200,1200), i.e. a 1600x1600 rect centered on (400,400).
    expect(rect.dx).toBeCloseTo(-400, 6);
    expect(rect.dy).toBeCloseTo(-400, 6);
    expect(rect.dw).toBeCloseTo(1600, 6);
    expect(rect.dh).toBeCloseTo(1600, 6);
  });

  it("a pure pan (span unchanged) shifts the blit rect by exactly the screen-space delta panGeo would produce, size unchanged", () => {
    const bbox: [number, number, number, number] = [148.9, -35.6, 149.3, -35.05];
    const fit = fitTransform(bbox, 900, 600, 20);
    const cached: ViewState = { cLon: 149.1, cLat: -35.3, span: 0.5 };
    const dx = -37;
    const dy = 84;
    const current = panGeo(cached, bbox, fit, 900, 600, dx, dy);
    const rect = baseBlitRect(cached, current, bbox, fit, 900, 600);
    expect(rect.dx).toBeCloseTo(dx, 6);
    expect(rect.dy).toBeCloseTo(dy, 6);
    expect(rect.dw).toBeCloseTo(900, 6);
    expect(rect.dh).toBeCloseTo(600, 6);
  });

  it("equals the direct projection of the cached bitmap's own two corners under the CURRENT transform, for random cached/current view pairs (property, 200 seeded) -- this IS what \"correct blit rect\" means, so a regression in the corner math would show up here even though it shares projectPoint/unprojectPoint with the implementation", () => {
    const bbox: [number, number, number, number] = [148.9, -35.6, 149.3, -35.05];
    const fit = fitTransform(bbox, 1016, 778, 24);
    const rand = mulberry32(160817);
    for (let i = 0; i < 200; i++) {
      const randomView = (): ViewState => ({
        cLon: bbox[0] + rand() * (bbox[2] - bbox[0]),
        cLat: bbox[1] + rand() * (bbox[3] - bbox[1]),
        span: 1 / 8 + rand() * (1 - 1 / 8),
      });
      const cached = randomView();
      const current = randomView();
      const rect = baseBlitRect(cached, current, bbox, fit, 1016, 778);

      const cachedT = deriveTransform(cached, bbox, fit, 1016, 778);
      const currentT = deriveTransform(current, bbox, fit, 1016, 778);
      const [lon0, lat0] = unprojectPoint(bbox, cachedT, 0, 0);
      const [lon1, lat1] = unprojectPoint(bbox, cachedT, 1016, 778);
      const [ex0, ey0] = projectPoint(bbox, currentT, lon0, lat0);
      const [ex1, ey1] = projectPoint(bbox, currentT, lon1, lat1);
      expect(rect.dx).toBeCloseTo(ex0, 6);
      expect(rect.dy).toBeCloseTo(ey0, 6);
      expect(rect.dw).toBeCloseTo(ex1 - ex0, 6);
      expect(rect.dh).toBeCloseTo(ey1 - ey0, 6);
    }
  });

  // Regression (same defect class G2 fixed — see clampGeoView/zoomAbout/
  // panGeo's own regression tests): a hidden panel's resize() can produce a
  // genuinely degenerate fit.scale === 0 (a display:none canvas floors to a
  // 1x1 css size, starving fitTransform's availW/availH to 0). Unlike
  // clampGeoView/zoomAbout/panGeo, this function never WRITES to the shared
  // store — a bad result here can't corrupt another panel the way the G2 bug
  // did — but it still shouldn't divide by zero (unprojectPoint's own
  // `(x - ox) / (scale * cosMid)`) and hand Infinity/NaN to a caller's
  // drawImage. Guarded the same way: fit.scale <= 0 returns a 1:1 "blit
  // covers the whole viewport" rect instead.
  it("regression: fit.scale === 0 (degenerate/hidden panel) returns a full-viewport rect instead of dividing by zero", () => {
    const bbox: [number, number, number, number] = [148.9179634, -35.6505443, 149.3332927, -35.0450695];
    const hiddenFit = fitTransform(bbox, 1, 1, 24); // MapView.resize()'s own floor for a display:none canvas
    expect(hiddenFit.scale).toBe(0); // sanity: genuinely the degenerate case
    const cached = wholeMapView(bbox);
    const current: ViewState = { cLon: 149.1, cLat: -35.3, span: 0.5 };
    const rect = baseBlitRect(cached, current, bbox, hiddenFit, 1, 1);
    expect(rect).toEqual({ dx: 0, dy: 0, dw: 1, dh: 1 });
    expect(Number.isFinite(rect.dx)).toBe(true);
    expect(Number.isFinite(rect.dy)).toBe(true);
    expect(Number.isFinite(rect.dw)).toBe(true);
    expect(Number.isFinite(rect.dh)).toBe(true);
  });

  // §19.3: an overscanned capture's `bounds` extend past [0,w]x[0,h] (see
  // baseCaptureBounds) -- these cases cover the omitted-vs-explicit legacy
  // default, and that an overscanned bitmap's mapped rect still fully
  // covers the viewport after a pan that stays within the captured margin.
  describe("with an overscanned CaptureBounds (§19.3)", () => {
    it("omitting bounds is EXACTLY equivalent to passing the plain [0,w]x[0,h] viewport rect -- legacy callers unaffected", () => {
      const bbox: [number, number, number, number] = [148.9, -35.6, 149.3, -35.05];
      const fit = fitTransform(bbox, 900, 600, 20);
      const cached: ViewState = { cLon: 149.1, cLat: -35.3, span: 0.5 };
      const current: ViewState = { cLon: 149.12, cLat: -35.31, span: 0.45 };
      const withDefault = baseBlitRect(cached, current, bbox, fit, 900, 600);
      const withExplicit = baseBlitRect(cached, current, bbox, fit, 900, 600, { left: 0, top: 0, right: 900, bottom: 600 });
      expect(withExplicit).toEqual(withDefault);
    });

    it("identity view: an overscanned bitmap maps to a rect wider than the viewport on every side, by exactly the margin", () => {
      const bbox: [number, number, number, number] = [148.9, -35.6, 149.3, -35.05];
      const fit = fitTransform(bbox, 900, 600, 20);
      const view: ViewState = { cLon: 149.1, cLat: -35.3, span: 0.4 };
      const bounds = baseCaptureBounds(view, bbox, fit, 900, 600);
      const rect = baseBlitRect(view, view, bbox, fit, 900, 600, bounds);
      expect(rect.dx).toBeCloseTo(bounds.left, 6);
      expect(rect.dy).toBeCloseTo(bounds.top, 6);
      expect(rect.dw).toBeCloseTo(bounds.right - bounds.left, 6);
      expect(rect.dh).toBeCloseTo(bounds.bottom - bounds.top, 6);
    });

    it("a pan that stays WITHIN the overscan margin: the mapped rect still fully covers the viewport (no empty edge to reveal)", () => {
      const bbox: [number, number, number, number] = [148.9, -35.6, 149.3, -35.05];
      const fit = fitTransform(bbox, 900, 600, 20);
      // span 1/8 (max zoom), same as baseCaptureBounds' own "zoomed in" case
      // above -- content vastly exceeds viewport+margin on BOTH axes there,
      // so the full, unclamped 0.3x margin is captured on every side (a
      // more modest zoom, e.g. span 0.4, can leave one axis -- whichever
      // ISN'T this bbox/viewport's fit-limiting axis -- still letterboxed
      // with NO real margin to pan into, which isn't the case this test is
      // for).
      const cached: ViewState = { cLon: 149.1, cLat: -35.3, span: 1 / 8 };
      const bounds = baseCaptureBounds(cached, bbox, fit, 900, 600);
      // A pan well inside the 0.3-viewport margin on every side (e.g. 10% of
      // the viewport, not the full 30% captured).
      const current = panGeo(cached, bbox, fit, 900, 600, 90, 60);
      const rect = baseBlitRect(cached, current, bbox, fit, 900, 600, bounds);
      // The bitmap's mapped rect must fully contain the viewport -- this IS
      // what "no empty area while the pointer keeps moving" means in this
      // module's own geometry: dx <= 0 <= dw+dx... i.e. left edge at/before
      // 0 and right edge at/after 900 (same for the vertical axis).
      expect(rect.dx).toBeLessThanOrEqual(0);
      expect(rect.dy).toBeLessThanOrEqual(0);
      expect(rect.dx + rect.dw).toBeGreaterThanOrEqual(900);
      expect(rect.dy + rect.dh).toBeGreaterThanOrEqual(600);
    });

    it("a pan that EXACTLY reaches the overscan margin's edge still just covers the viewport (boundary case)", () => {
      // Zero-slack square bbox/fit (same shape as the hand-checked 2x-zoom
      // case above), but zoomed IN (span 0.5, not the whole-map span 1) so
      // content genuinely extends past the viewport and the margin isn't
      // clamped away to nothing (whole-map span-1 view has zero slack here
      // by construction -- fitTransform's own pad is 0 -- so it captures no
      // margin at all; that's a different, already-covered case above).
      const bbox: [number, number, number, number] = [0, -0.5, 1, 0.5];
      const fit = fitTransform(bbox, 800, 800, 0);
      const cached: ViewState = { cLon: 0.5, cLat: 0, span: 0.5 };
      const bounds = baseCaptureBounds(cached, bbox, fit, 800, 800, 0.3);
      expect(bounds.left).toBeCloseTo(-240, 6); // sanity: genuinely a full, unclamped 240px margin
      // Pan by exactly the margin (240px) so the bitmap's own left edge
      // lands exactly at the viewport's left edge (0) -- one pixel further
      // and it would no longer fully cover x=0.
      const current = panGeo(cached, bbox, fit, 800, 800, 240, 0);
      const rect = baseBlitRect(cached, current, bbox, fit, 800, 800, bounds);
      expect(rect.dx).toBeCloseTo(0, 6);
    });

    it("property: for random cached/current view pairs within a fixed overscan margin, the mapped rect equals the direct reprojection of bounds' own two corners (200 seeded) -- same property the legacy [0,w]x[0,h] case already checks, generalized to bounds", () => {
      const bbox: [number, number, number, number] = [148.9, -35.6, 149.3, -35.05];
      const fit = fitTransform(bbox, 1016, 778, 24);
      const bounds: CaptureBounds = { left: -300, top: -230, right: 1316, bottom: 1008 };
      const rand = mulberry32(190817);
      for (let i = 0; i < 200; i++) {
        const randomView = (): ViewState => ({
          cLon: bbox[0] + rand() * (bbox[2] - bbox[0]),
          cLat: bbox[1] + rand() * (bbox[3] - bbox[1]),
          span: 1 / 8 + rand() * (1 - 1 / 8),
        });
        const cached = randomView();
        const current = randomView();
        const rect = baseBlitRect(cached, current, bbox, fit, 1016, 778, bounds);

        const cachedT = deriveTransform(cached, bbox, fit, 1016, 778);
        const currentT = deriveTransform(current, bbox, fit, 1016, 778);
        const [lon0, lat0] = unprojectPoint(bbox, cachedT, bounds.left, bounds.top);
        const [lon1, lat1] = unprojectPoint(bbox, cachedT, bounds.right, bounds.bottom);
        const [ex0, ey0] = projectPoint(bbox, currentT, lon0, lat0);
        const [ex1, ey1] = projectPoint(bbox, currentT, lon1, lat1);
        expect(rect.dx).toBeCloseTo(ex0, 6);
        expect(rect.dy).toBeCloseTo(ey0, 6);
        expect(rect.dw).toBeCloseTo(ex1 - ex0, 6);
        expect(rect.dh).toBeCloseTo(ey1 - ey0, 6);
      }
    });
  });
});

describe("withinBlitRange (the \">2x away\" boundary past which a blit isn't worth it)", () => {
  it("the same span (no zoom change) is always in range", () => {
    expect(withinBlitRange(0.5, 0.5)).toBe(true);
  });

  it("exactly 2x zoomed IN since the cache (cachedSpan / currentSpan === 2) is still in range (boundary inclusive)", () => {
    expect(withinBlitRange(0.5, 0.25)).toBe(true);
  });

  it("just past 2x zoomed in is out of range", () => {
    expect(withinBlitRange(0.5, 0.24)).toBe(false);
  });

  it("exactly 2x zoomed OUT since the cache (cachedSpan / currentSpan === 0.5) is still in range (boundary inclusive, symmetric)", () => {
    expect(withinBlitRange(0.4, 0.8)).toBe(true);
  });

  it("just past 2x zoomed out is out of range", () => {
    expect(withinBlitRange(0.4, 0.81)).toBe(false);
  });

  // A custom ratioLimit (MapView's own per-instance jitter, §16.10 — see
  // that field's own comment: Compare-mode panels share one ViewStore, so
  // without this every panel would cross the exact same fixed threshold on
  // the exact same tick during a sustained zoom, spiking one frame to an
  // N-panel-simultaneous re-stroke instead of spreading it across a few) is
  // honored instead of the BLIT_SPAN_RATIO_LIMIT default.
  it("a custom ratioLimit overrides the default boundary", () => {
    expect(withinBlitRange(0.5, 0.2, 2)).toBe(false); // ratio 2.5 -- past the DEFAULT 2x limit
    expect(withinBlitRange(0.5, 0.2, 3)).toBe(true); // same inputs, wider custom limit -- now in range
  });
});

describe("baseCacheValid (§16.10 cache invalidation: theme, resize, and hierarchy-filter changes each force a crisp re-stroke)", () => {
  const key = (overrides: Partial<BaseCacheKey> = {}): BaseCacheKey => ({
    theme: "dark",
    cssWidth: 900,
    cssHeight: 600,
    dpr: 1,
    pctThreshold: null,
    emphasize: false,
    ...overrides,
  });

  it("no cached key yet (nothing stroked) is never valid", () => {
    expect(baseCacheValid(null, key())).toBe(false);
  });

  it("an identical key is valid", () => {
    expect(baseCacheValid(key(), key())).toBe(true);
  });

  it("a theme change invalidates", () => {
    expect(baseCacheValid(key({ theme: "dark" }), key({ theme: "light" }))).toBe(false);
  });

  it("a resize (css size or device-pixel-ratio change) invalidates", () => {
    expect(baseCacheValid(key({ cssWidth: 900 }), key({ cssWidth: 901 }))).toBe(false);
    expect(baseCacheValid(key({ cssHeight: 600 }), key({ cssHeight: 599 }))).toBe(false);
    expect(baseCacheValid(key({ dpr: 1 }), key({ dpr: 2 }))).toBe(false);
  });

  it("a hierarchy-filter change (pctThreshold or emphasize) invalidates", () => {
    expect(baseCacheValid(key({ pctThreshold: null }), key({ pctThreshold: 50 }))).toBe(false);
    expect(baseCacheValid(key({ pctThreshold: 50 }), key({ pctThreshold: 60 }))).toBe(false);
    expect(baseCacheValid(key({ emphasize: false }), key({ emphasize: true }))).toBe(false);
  });
});

// §16.10 review round 2 (polish round, findings 1 & 2): a page-lifetime
// monotonic counter (MapView's own mapViewSequence) assigned each panel's
// re-stroke stagger ONCE, at construction, and never revisited — so a
// panel torn down and later REBUILT (home.ts's syncPanels is diff-based, a
// racer toggled off then back on really does construct a brand-new
// MapView) could land on the same slot a still-live sibling already held,
// silently recreating the same-tick simultaneous-restroke spike the
// stagger exists to prevent. assignStaggerSlots is the fix (see its own
// comment in mapRenderer.ts): derive every slot fresh from the CURRENT live
// roster's own order instead of a persisted counter.
describe("assignStaggerSlots (the LIVE-roster-derived replacement for the page-lifetime mapViewSequence counter)", () => {
  it("assigns 0..n-1 to n ids, in the order given", () => {
    expect([...assignStaggerSlots(["a", "b", "c"]).values()]).toEqual([0, 1, 2]);
  });

  it("every concurrently-live id gets its own slot, distinct from every other live id's", () => {
    const slots = assignStaggerSlots(["dijkstra", "astar", "bidi", "ch"]);
    const values = [...slots.values()];
    expect(new Set(values).size).toBe(values.length);
  });

  it("a single live id always lands on slot 0 (unstaggered) -- the common single-overlay-equivalent case", () => {
    expect(assignStaggerSlots(["only"]).get("only")).toBe(0);
  });

  it("an empty live set is a harmless no-op (empty map, no throw)", () => {
    expect(assignStaggerSlots([]).size).toBe(0);
  });

  // The property the OLD page-lifetime counter did NOT have (the exact
  // review round 2 finding this function fixes): simulates arbitrary
  // add/remove sequences (200 seeded trials, a random walk of toggles over
  // a 5-id pool -- exactly as many ids as BLIT_RATIO_MULTIPLIERS has slots,
  // so the property is achievable, not a pigeonhole artifact -- including
  // ids re-added after having been removed earlier in the SAME trial) and
  // checks, after EVERY step, that whatever is live RIGHT NOW gets
  // pairwise-distinct slots. assignStaggerSlots is generic over opaque ids
  // (never actually keyed to RacerId), so this pool is illustrative labels,
  // not roster.ts's own id strings -- kept at 5 to exercise the tight
  // pigeonhole case regardless of the real ROSTER's own current size (spec
  // §20.2 trims it to four; this function's contract doesn't change either
  // way).
  it("property: for any sequence of add/remove operations, the ids alive at any point always get pairwise-distinct slots (200 seeded random toggle sequences)", () => {
    const rand = mulberry32(31337);
    const pool = ["dijkstra", "astar", "bidi", "ch", "astar-straight"];
    for (let trial = 0; trial < 200; trial++) {
      let live: string[] = [];
      const steps = 3 + Math.floor(rand() * 20);
      for (let s = 0; s < steps; s++) {
        const id = pool[Math.floor(rand() * pool.length)];
        live = live.includes(id) ? live.filter((x) => x !== id) : [...live, id];

        const slots = assignStaggerSlots(live);
        const values = live.map((x) => slots.get(x));
        expect(new Set(values).size).toBe(live.length); // pairwise distinct among whatever's live RIGHT NOW
      }
    }
  });
});

describe("baseFingerprintKey (the shared cross-instance base-cache key, §16.10 review round 2 finding 2; §19.3 bounds join)", () => {
  const key: BaseCacheKey = {
    theme: "dark", cssWidth: 900, cssHeight: 600, dpr: 1, pctThreshold: null, emphasize: false,
  };
  const view: ViewState = { cLon: 149.1, cLat: -35.3, span: 0.5 };
  const bounds: CaptureBounds = { left: -270, top: -180, right: 1170, bottom: 780 };

  it("identical inputs (even different object instances) produce the identical key", () => {
    expect(baseFingerprintKey(key, view, bounds)).toBe(baseFingerprintKey({ ...key }, { ...view }, { ...bounds }));
  });

  it("any one differing BaseCacheKey field changes the key", () => {
    const base = baseFingerprintKey(key, view, bounds);
    expect(baseFingerprintKey({ ...key, theme: "light" }, view, bounds)).not.toBe(base);
    expect(baseFingerprintKey({ ...key, cssWidth: 901 }, view, bounds)).not.toBe(base);
    expect(baseFingerprintKey({ ...key, cssHeight: 601 }, view, bounds)).not.toBe(base);
    expect(baseFingerprintKey({ ...key, dpr: 2 }, view, bounds)).not.toBe(base);
    expect(baseFingerprintKey({ ...key, pctThreshold: 50 }, view, bounds)).not.toBe(base);
    expect(baseFingerprintKey({ ...key, emphasize: true }, view, bounds)).not.toBe(base);
  });

  it("any one differing ViewState field changes the key -- two panels only ever stroke identical pixels at the identical view", () => {
    const base = baseFingerprintKey(key, view, bounds);
    expect(baseFingerprintKey(key, { ...view, cLon: 149.2 }, bounds)).not.toBe(base);
    expect(baseFingerprintKey(key, { ...view, cLat: -35.4 }, bounds)).not.toBe(base);
    expect(baseFingerprintKey(key, { ...view, span: 0.4 }, bounds)).not.toBe(base);
  });

  // §19.3 delta: overscan capture bounds join the fingerprint too, so a
  // sibling panel can never adopt a shared-cache entry whose captured
  // footprint doesn't match what THIS instance would itself have captured
  // (defensive — bounds are, in this app, already fully determined by
  // fields the key/view halves cover, but the string makes that explicit
  // and directly testable rather than relying on the derivation staying in
  // sync forever).
  it("any one differing CaptureBounds field changes the key (fingerprint invalidation on bounds change)", () => {
    const base = baseFingerprintKey(key, view, bounds);
    expect(baseFingerprintKey(key, view, { ...bounds, left: -269 })).not.toBe(base);
    expect(baseFingerprintKey(key, view, { ...bounds, top: -179 })).not.toBe(base);
    expect(baseFingerprintKey(key, view, { ...bounds, right: 1171 })).not.toBe(base);
    expect(baseFingerprintKey(key, view, { ...bounds, bottom: 781 })).not.toBe(base);
  });
});

// §19.3 (fifth build review, user): "panning around the map without
// stopping wont show empty area" — the two mechanisms below (overscan
// capture bounds, and the periodic-refresh throttle) are the pure decision
// layer this is built on. MapView's actual stroke-into-an-oversized-bitmap
// and periodic-strokeBaseCrisp wiring is untested here, same jsdom-has-no-
// canvas rationale as the rest of this file.
describe("baseCaptureBounds (§19.3 overscan capture rect)", () => {
  const bbox: [number, number, number, number] = [148.9, -35.6, 149.3, -35.05];

  it("zoomed in (content spans far past the viewport): full margin on every side, ~1.6x the viewport per axis", () => {
    const fit = fitTransform(bbox, 900, 600, 20);
    const view: ViewState = { cLon: 149.1, cLat: -35.3, span: 1 / 8 }; // max zoom -- content is huge on screen
    const bounds = baseCaptureBounds(view, bbox, fit, 900, 600);
    expect(bounds.left).toBeCloseTo(-0.3 * 900, 6);
    expect(bounds.top).toBeCloseTo(-0.3 * 600, 6);
    expect(bounds.right).toBeCloseTo(900 + 0.3 * 900, 6);
    expect(bounds.bottom).toBeCloseTo(600 + 0.3 * 600, 6);
  });

  it("a custom marginRatio scales the same way", () => {
    const fit = fitTransform(bbox, 900, 600, 20);
    const view: ViewState = { cLon: 149.1, cLat: -35.3, span: 1 / 8 };
    const bounds = baseCaptureBounds(view, bbox, fit, 900, 600, 0.1);
    expect(bounds.left).toBeCloseTo(-0.1 * 900, 6);
    expect(bounds.right).toBeCloseTo(900 + 0.1 * 900, 6);
  });

  it("fully zoomed out (whole map, span 1): clamped to the fitted content extent -- degrades to exactly the legacy no-margin viewport rect", () => {
    const fit = fitTransform(bbox, 900, 600, 20);
    const view = wholeMapView(bbox); // span 1 -- the SAME view fitTransform itself frames, no slack to overscan into
    const bounds = baseCaptureBounds(view, bbox, fit, 900, 600);
    expect(bounds).toEqual({ left: 0, top: 0, right: 900, bottom: 600 });
  });

  it("the core viewport rect is always included, even on a letterboxed axis (content narrower than the viewport)", () => {
    // A very wide, short viewport against a roughly-square bbox: at whole-map
    // zoom the fitted content can't fill the wide axis, so that axis has NO
    // real content to overscan into -- must still cover [0,w], never shrink
    // below it.
    const fit = fitTransform(bbox, 2000, 400, 20);
    const view = wholeMapView(bbox);
    const bounds = baseCaptureBounds(view, bbox, fit, 2000, 400);
    expect(bounds.left).toBeLessThanOrEqual(0);
    expect(bounds.top).toBeLessThanOrEqual(0);
    expect(bounds.right).toBeGreaterThanOrEqual(2000);
    expect(bounds.bottom).toBeGreaterThanOrEqual(400);
  });

  it("a partially-clamped margin (some but not the full 0.3x of content available beyond the viewport) lands strictly between the no-margin and full-margin rects", () => {
    // This bbox's fit is HEIGHT-limited at 900x600/pad 20 (mapH/availH beats
    // mapW/availW regardless of the exact cos(midLat) correction, since
    // mapW = 0.4*cosMid < 0.4 < 860/1018.18 always) -- so the VERTICAL axis
    // is the one that sits flush against the viewport at whole-map zoom,
    // and is the one a modest zoom-in pushes past the viewport edge first.
    // At span 0.9 (exact, no cosMid dependence: contentTop = 300 -
    // 0.275*(fit.scale/0.9) = 300 - 0.275*1131.31... = -11.11), the overflow
    // is real (top/bottom past the viewport) but far short of the full 180px
    // (0.3*600) margin request -- exactly the "partially clamped" case.
    const fit = fitTransform(bbox, 900, 600, 20);
    const view: ViewState = { cLon: (bbox[0] + bbox[2]) / 2, cLat: (bbox[1] + bbox[3]) / 2, span: 0.9 };
    const bounds = baseCaptureBounds(view, bbox, fit, 900, 600);
    const rawTop = -0.3 * 600;
    const rawBottom = 600 + 0.3 * 600;
    expect(bounds.top).toBeGreaterThan(rawTop); // clamped inward from the raw 0.3x request...
    expect(bounds.top).toBeLessThan(0); // ...yet still strictly negative -- genuine overflow, not fully clamped away
    expect(bounds.bottom).toBeLessThan(rawBottom);
    expect(bounds.bottom).toBeGreaterThan(600);
  });

  it("regression: fit.scale === 0 (degenerate/hidden panel) returns the plain viewport rect instead of dividing by zero", () => {
    const hiddenFit = fitTransform(bbox, 1, 1, 24);
    expect(hiddenFit.scale).toBe(0);
    const view = wholeMapView(bbox);
    const bounds = baseCaptureBounds(view, bbox, hiddenFit, 1, 1);
    expect(bounds).toEqual({ left: 0, top: 0, right: 1, bottom: 1 });
  });
});

describe("captureBoundsDeviceSize (device-pixel canvas allocation for a CaptureBounds rect, DPR-aware)", () => {
  it("dpr 1: device px equals CSS px", () => {
    const bounds: CaptureBounds = { left: -100, top: -50, right: 1000, bottom: 650 };
    expect(captureBoundsDeviceSize(bounds, 1)).toEqual({ width: 1100, height: 700 });
  });

  it("dpr 2: device px is exactly double", () => {
    const bounds: CaptureBounds = { left: -100, top: -50, right: 1000, bottom: 650 };
    expect(captureBoundsDeviceSize(bounds, 2)).toEqual({ width: 2200, height: 1400 });
  });

  it("a fractional dpr (e.g. 1.5, a real Windows scaling value) rounds the same way resize()'s own cssW*dpr sizing does", () => {
    const bounds: CaptureBounds = { left: 0, top: 0, right: 901, bottom: 601 };
    expect(captureBoundsDeviceSize(bounds, 1.5)).toEqual({
      width: Math.round(901 * 1.5),
      height: Math.round(601 * 1.5),
    });
  });

  it("the legacy no-margin viewport rect at dpr 1 matches resize()'s own plain cssW/cssH backing-store size", () => {
    const bounds: CaptureBounds = { left: 0, top: 0, right: 900, bottom: 600 };
    expect(captureBoundsDeviceSize(bounds, 1)).toEqual({ width: 900, height: 600 });
  });
});

describe("refreshDue (§19.3 periodic crisp-refresh throttle during sustained interaction)", () => {
  it("not due before the base cadence has elapsed", () => {
    expect(refreshDue(1000, 1499, 0)).toBe(false);
  });

  it("due once at least PERIODIC_REFRESH_BASE_MS (500ms) has elapsed, slot 0 (zero offset)", () => {
    expect(refreshDue(1000, 1500, 0)).toBe(true);
    expect(refreshDue(1000, 1000 + 10_000, 0)).toBe(true); // long-elapsed is still due, not just the boundary instant
  });

  it("never due before 500ms regardless of slot (the offsets only ever ADD to the base, never subtract)", () => {
    for (let slot = 0; slot < 5; slot++) {
      expect(refreshDue(1000, 1499, slot)).toBe(false);
    }
  });

  it("out-of-range slots wrap (% length), same defensive stance as setStaggerSlot/assignStaggerSlots", () => {
    expect(refreshDue(1000, 2000, 5)).toBe(refreshDue(1000, 2000, 0));
    expect(refreshDue(1000, 2000, 7)).toBe(refreshDue(1000, 2000, 2));
  });

  it("property: every slot's own cadence is >= 500ms (never shorter than the design spec's own floor)", () => {
    for (let slot = 0; slot < 5; slot++) {
      // Right up to (but not reaching) 500ms elapsed: never due, for ANY slot.
      expect(refreshDue(1000, 1000 + 499, slot)).toBe(false);
    }
  });

  it("property: the 5 slots' own due-at instants are pairwise distinct (the whole point of staggering)", () => {
    const dueAt = (slot: number): number => {
      // Smallest `now` (integer ms) at which this slot first becomes due.
      let now = 1000;
      while (!refreshDue(1000, now, slot)) now++;
      return now;
    };
    const instants = [0, 1, 2, 3, 4].map(dueAt);
    expect(new Set(instants).size).toBe(instants.length);
  });
});
