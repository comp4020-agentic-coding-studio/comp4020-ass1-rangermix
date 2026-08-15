// Pure-function tests only. jsdom has no canvas 2D context, so MapView's
// actual canvas calls (drawBase/drawDots/drawRoute/drawPin/clearOverlay) are
// thin, untested here, and verified by eye once wired into a real page. What's
// exercised here is the geometry/data logic MapView is built on: projection
// fit, delta decode, threshold filter, dot stride math, and (§16.11) the
// geo-anchored view-state layer: deriveTransform, zoomAbout, panGeo,
// clampGeoView, zoomToBounds, createViewStore.

import { describe, expect, it } from "vitest";
import {
  clampGeoView,
  createViewStore,
  decodeLine,
  deriveTransform,
  fitTransform,
  panGeo,
  projectPoint,
  strideFor,
  unprojectPoint,
  visibleLines,
  wholeMapView,
  zoomAbout,
  zoomToBounds,
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
// padding — the geo-anchored model makes this ONE call, independent of any
// specific panel's own pixel size (see zoomToBounds's own comment).
describe("zoomToBounds", () => {
  it("frames a pair with EXACTLY the requested padding on the limiting axis (hand-checked: bbox/pair/viewport chosen so cosMid=1 and the fit has zero aspect slack)", () => {
    // bbox centered at lat 0 (cosMid exactly 1), square in map units
    // (mapW = mapH = 2) so a square, zero-pad, aspect-matched viewport has
    // NO slack on either axis — the cleanest possible hand-check.
    const bbox: [number, number, number, number] = [-1, -1, 1, 1];
    const w = 1000, h = 1000;
    const fit = fitTransform(bbox, w, h, 0);
    // A and B both sit on the bbox's own horizontal center line, spanning
    // the middle half of its width (lon -0.5 to 0.5) — the wider of the
    // two spreads (lonSpread=1 of mapW=2 => frac 0.5; latSpread=0), so lon
    // is the limiting axis this pair's framing is matched to.
    const view = zoomToBounds(bbox, -0.5, 0, 0.5, 0, 0.15);
    expect(view.cLon).toBeCloseTo(0, 9);
    expect(view.cLat).toBeCloseTo(0, 9);
    // span = frac / (1 - 2*pad) = 0.5 / 0.7
    expect(view.span).toBeCloseTo(0.5 / 0.7, 9);

    const t = deriveTransform(view, bbox, fit, w, h);
    const [xA] = projectPoint(bbox, t, -0.5, 0);
    const [xB] = projectPoint(bbox, t, 0.5, 0);
    expect(xA).toBeCloseTo(150, 6); // 15% of 1000px in from the left
    expect(xB).toBeCloseTo(850, 6); // 15% of 1000px in from the right
    // Both points strictly inside the viewport (the property the design
    // task asks to pin, verified here to the exact pixel as well).
    expect(xA).toBeGreaterThan(0);
    expect(xB).toBeLessThan(w);
  });

  it("both points land strictly inside the resulting view, for random bboxes/pairs/aspect-matched viewports (property, 200 seeded)", () => {
    const rand = mulberry32(918);
    for (let i = 0; i < 200; i++) {
      const minLon = 148 + rand() * 2;
      const minLat = -36 + rand() * 2;
      const bbox: [number, number, number, number] = [minLon, minLat, minLon + 0.2 + rand() * 0.4, minLat + 0.2 + rand() * 0.4];
      const lonA = bbox[0] + rand() * (bbox[2] - bbox[0]);
      const latA = bbox[1] + rand() * (bbox[3] - bbox[1]);
      const lonB = bbox[0] + rand() * (bbox[2] - bbox[0]);
      const latB = bbox[1] + rand() * (bbox[3] - bbox[1]);
      // Aspect-matched, zero-pad viewport (mirrors the hand-checked case
      // above) so BOTH axes are simultaneously limiting — the strongest
      // version of the "inside the view" property, not weakened by
      // whichever axis happens to have fit slack.
      const cosMid = Math.cos(((bbox[1] + bbox[3]) / 2) * (Math.PI / 180));
      const mapW = Math.max(1e-9, (bbox[2] - bbox[0]) * cosMid);
      const mapH = Math.max(1e-9, bbox[3] - bbox[1]);
      const w = 1000;
      const h = (1000 * mapH) / mapW;
      const fit = fitTransform(bbox, w, h, 0);
      const view = zoomToBounds(bbox, lonA, latA, lonB, latB, 0.15);
      expect(view.span).toBeGreaterThanOrEqual(1 / 8 - 1e-9);
      expect(view.span).toBeLessThanOrEqual(1 + 1e-9);
      expect(Number.isFinite(view.cLon)).toBe(true);
      expect(Number.isFinite(view.cLat)).toBe(true);
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
    const view = zoomToBounds(bbox, 149.1, -35.3, 149.1, -35.3, 0.15);
    expect(view).toEqual({ cLon: 149.1, cLat: -35.3, span: 1 / 8 });
  });

  it("a pair spanning (most of) the whole bbox clamps to MAX_SPAN (whole map) rather than requesting an impossible zoom-out", () => {
    const bbox: [number, number, number, number] = [148.9, -35.6, 149.3, -35.05];
    const view = zoomToBounds(bbox, bbox[0], bbox[1], bbox[2], bbox[3], 0.15);
    expect(view.span).toBe(1);
  });

  it("default pad is 0.15", () => {
    const bbox: [number, number, number, number] = [-1, -1, 1, 1];
    expect(zoomToBounds(bbox, -0.5, 0, 0.5, 0)).toEqual(zoomToBounds(bbox, -0.5, 0, 0.5, 0, 0.15));
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
    store.set(zoomToBounds(bbox, 149.0, -35.4, 149.2, -35.2));
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
