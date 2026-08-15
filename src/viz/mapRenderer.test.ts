// Pure-function tests only. jsdom has no canvas 2D context, so MapView's
// actual canvas calls (drawBase/drawDots/drawRoute/drawPin/clearOverlay) are
// thin, untested here, and verified by eye once Task 7 wires MapView into a
// real page. What's exercised here is the geometry/data logic MapView is
// built on: projection fit, delta decode, threshold filter, dot stride math.

import { describe, expect, it } from "vitest";
import {
  clampPan,
  composeView,
  createViewStore,
  decodeLine,
  fitTransform,
  projectPoint,
  strideFor,
  unprojectPoint,
  visibleLines,
  zoomAbout,
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
 * overlaps the viewport, per axis, after a `clampPan` call — what the
 * design spec's ">= 25% visible each axis" contract (build-review amendment
 * §14.2) actually means. Computed independently of clampPan's own
 * internals — straight from `fit.ox`/`fit.oy` and the `contentSize =
 * viewportSize - 2*off` identity (see clampPan's own comment for the
 * derivation) — so this helper can't share a bug with the code it checks.
 * Also returns the content size itself (px, per axis) — callers deep enough
 * into zoom territory need it to compute `minRequiredFraction` below rather
 * than compare against a flat 0.25 (see that function's comment for why). */
function contentVisibleFraction(
  view: ViewState, fit: Transform, viewportW: number, viewportH: number,
): { x: number; y: number; contentW: number; contentH: number } {
  const contentW = (viewportW - 2 * fit.ox) * view.scale;
  const contentH = (viewportH - 2 * fit.oy) * view.scale;
  const x0 = fit.ox * view.scale + view.tx;
  const y0 = fit.oy * view.scale + view.ty;
  const overlapX = Math.min(viewportW, x0 + contentW) - Math.max(0, x0);
  const overlapY = Math.min(viewportH, y0 + contentH) - Math.max(0, y0);
  return { x: overlapX / contentW, y: overlapY / contentH, contentW, contentH };
}

/** The visible-fraction floor the design spec's own 25% target degrades to
 * once the content is more than 4x the viewport on an axis — reachable at
 * any view.scale above 4 (well inside [MIN_VIEW_SCALE, MAX_VIEW_SCALE] =
 * [1, 8]) even with zero fit slack, since content size scales linearly with
 * view.scale while the viewport doesn't. Past that point, showing 25% of
 * the content would need more px than the viewport HAS at all — no pan
 * position can do it — so the best (and correct) achievable is filling the
 * viewport completely (overlap == viewportSize, a smaller fraction of the
 * content than 25% but the true physical maximum, not a clamp bug). Proven
 * algebraically in the fix's own report: clampAxis's `min`/`max` both
 * evaluate to exactly this floor in that regime, not just the plain 25%
 * target. */
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

describe("clampPan (against the TRUE fitted content rect, not the viewport as a stand-in)", () => {
  // A fit with NO slack on either axis (content exactly fills the viewport
  // at scale 1, ox=oy=0) -- the one case where the true content rect and
  // "the whole viewport" coincide, so the simplest boundary math is exact
  // and hand-checkable.
  const flushFit: Transform = { scale: 1, ox: 0, oy: 0 };

  it("a wildly out-of-range pan clamps to the 25%-visible boundary on each axis (flush fit, no slack)", () => {
    const clamped = clampPan({ scale: 1, tx: 1000, ty: -1000 }, flushFit, 800, 600);
    expect(clamped).toEqual({ scale: 1, tx: 0.75 * 800, ty: 0.25 * 600 - 600 });
  });

  it("leaves an already in-bounds pan untouched (flush fit)", () => {
    const view: ViewState = { scale: 3, tx: 50, ty: -30 };
    expect(clampPan(view, flushFit, 800, 600)).toEqual(view);
  });

  // The real committed bbox (public/data/render.json) fitted into a
  // realistic desktop map viewport (~1016x778, PAD=24 -- mirrors
  // mapRenderer.ts's own PAD constant). Canberra's bbox is much taller than
  // wide in map units (mapH/mapW ~= 1.8 after cos(midLat) x-correction --
  // see the fitTransform describe block above), so THIS viewport is
  // height-constrained: the fitted content is far NARROWER than the
  // viewport, centered with wide slack on the x-axis. `fit.ox` (that slack)
  // is exactly what the old `contentSize = viewportSize * scale` code
  // silently treated as if it were content -- the bug this block pins.
  const bbox: [number, number, number, number] = [
    148.9179634, -35.6505443, 149.3332927, -35.0450695,
  ];
  const viewportW = 1016, viewportH = 778, pad = 24;
  const fit = fitTransform(bbox, viewportW, viewportH, pad);

  it("sanity: this fit is genuinely asymmetric (wide x-axis slack) -- otherwise this block wouldn't exercise the bug", () => {
    expect(fit.ox).toBeGreaterThan(pad + 50);
  });

  it("one ordinary drag (well under the map's own ~1016px width, not an extreme fling) never drops below 25% visible on either axis", () => {
    // A single continuous drag from near one side of the map toward the
    // other -- NOT an adversarial/extreme value (both axes stay well
    // inside the viewport's own size). Verified (see the fix report) that
    // the OLD viewport-as-content clamp let a drag exactly this size pan
    // the true content to ~3% visible on the x-axis -- the true-content-
    // rect clamp must not.
    const dragged = clampPan({ scale: 1, tx: -700, ty: -700 }, fit, viewportW, viewportH);
    const frac = contentVisibleFraction(dragged, fit, viewportW, viewportH);
    expect(frac.x).toBeGreaterThanOrEqual(0.25 - 1e-6);
    expect(frac.y).toBeGreaterThanOrEqual(0.25 - 1e-6);
  });

  it("an extreme pan clamps to exactly 25% visible on the TRUE content rect, both axes", () => {
    const clamped = clampPan({ scale: 1, tx: -100000, ty: 100000 }, fit, viewportW, viewportH);
    const frac = contentVisibleFraction(clamped, fit, viewportW, viewportH);
    expect(frac.x).toBeCloseTo(0.25, 5);
    expect(frac.y).toBeCloseTo(0.25, 5);
  });

  it("resize()'s job: reclamping a pan that was valid at one viewport size against a NEW (much smaller) size still satisfies the 25% bound", () => {
    const bigW = 1200, bigH = 900;
    const bigFit = fitTransform(bbox, bigW, bigH, pad);
    const view = clampPan({ scale: 5, tx: -900, ty: 700 }, bigFit, bigW, bigH);

    // The viewport then shrinks a lot (phone rotation, drastic desktop
    // resize) without the view itself changing -- MapView.resize() must
    // now re-run clampPan against the new fit/size for exactly this reason
    // (a resize used to leave the view untouched, stranding content
    // off-screen); simulating that re-clamp here must still land within
    // the 25% bound at the NEW size, not the stale bounds of a viewport
    // that no longer exists.
    const smallW = 380, smallH = 700;
    const smallFit = fitTransform(bbox, smallW, smallH, pad);
    const reclamped = clampPan(view, smallFit, smallW, smallH);
    const frac = contentVisibleFraction(reclamped, smallFit, smallW, smallH);
    expect(frac.x).toBeGreaterThanOrEqual(minRequiredFraction(frac.contentW, smallW) - 1e-6);
    expect(frac.y).toBeGreaterThanOrEqual(minRequiredFraction(frac.contentH, smallH) - 1e-6);
  });

  it("never lets the content fully leave the viewport: visible fraction of the CONTENT rect >= 25% (or the viewport-filling floor once zoom makes 25% physically unreachable — see minRequiredFraction) per axis, incl. at max zoom and after extreme pans (property, 200 seeded random scales/pans against the realistic asymmetric fit)", () => {
    const rand = mulberry32(7);
    for (let i = 0; i < 200; i++) {
      const scale = 1 + rand() * 7; // full [MIN_VIEW_SCALE, MAX_VIEW_SCALE] = [1, 8] range
      const tx = (rand() - 0.5) * 20000; // deliberately far beyond any real drag
      const ty = (rand() - 0.5) * 20000;
      const clamped = clampPan({ scale, tx, ty }, fit, viewportW, viewportH);
      const frac = contentVisibleFraction(clamped, fit, viewportW, viewportH);
      expect(frac.x).toBeGreaterThanOrEqual(minRequiredFraction(frac.contentW, viewportW) - 1e-6);
      expect(frac.y).toBeGreaterThanOrEqual(minRequiredFraction(frac.contentH, viewportH) - 1e-6);
    }
  });
});

// The shared pan/zoom store (build-review amendment §14.3, Compare mode):
// ONE store, every panel's MapView (plus the overlay's own) subscribes to
// it, so a pan/zoom gesture in any one of them moves all of them. MapView
// itself is untested here (jsdom has no canvas, same rationale as the rest
// of the class) but the store is plain data + callbacks — no DOM at all —
// so its get/set/subscribe/unsubscribe contract is fully unit-testable on
// its own, which matters more than usual here: MapView.dispose() (added
// alongside this store) depends on subscribe() returning a REAL unsubscribe,
// unlike theme.ts's onThemeChange, which has none — see mapRenderer.ts's own
// comments on both for why that gap matters for a class that now gets
// constructed and discarded repeatedly (Compare-mode panels), not just once
// per page load.
describe("createViewStore (the shared pan/zoom store)", () => {
  it("get() returns the identity view by default", () => {
    const store = createViewStore();
    expect(store.get()).toEqual({ scale: 1, tx: 0, ty: 0 });
  });

  it("get() returns whatever initial state was passed", () => {
    const initial: ViewState = { scale: 3, tx: 10, ty: -5 };
    const store = createViewStore(initial);
    expect(store.get()).toEqual(initial);
  });

  it("set() updates what get() returns", () => {
    const store = createViewStore();
    const next: ViewState = { scale: 2, tx: 4, ty: 6 };
    store.set(next);
    expect(store.get()).toEqual(next);
  });

  it("subscribe() does NOT fire immediately on registration (matches theme.ts's onThemeChange: register-then-wait, not register-then-replay)", () => {
    const store = createViewStore();
    let calls = 0;
    store.subscribe(() => {
      calls++;
    });
    expect(calls).toBe(0);
  });

  it("subscribe() fires with the new state on every set(), in order", () => {
    const store = createViewStore();
    const seen: ViewState[] = [];
    store.subscribe((v) => seen.push(v));
    const a: ViewState = { scale: 2, tx: 1, ty: 1 };
    const b: ViewState = { scale: 4, tx: 2, ty: 2 };
    store.set(a);
    store.set(b);
    expect(seen).toEqual([a, b]);
  });

  it("every subscriber is notified on the same set() — the mechanism one store driving N panels + the overlay relies on", () => {
    const store = createViewStore();
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
    store.set({ scale: 2, tx: 0, ty: 0 });
    expect([a, b, c]).toEqual([1, 1, 1]);
  });

  it("set() with a value field-equal to the current state is a no-op: no notify, no re-render fan-out (build-review fix — a resize's no-op re-clamp used to still notify every sharer of the store)", () => {
    const store = createViewStore({ scale: 2, tx: 5, ty: -3 });
    let calls = 0;
    store.subscribe(() => {
      calls++;
    });
    store.set({ scale: 2, tx: 5, ty: -3 }); // same values, deliberately a NEW object (not the same reference)
    expect(calls).toBe(0);
    expect(store.get()).toEqual({ scale: 2, tx: 5, ty: -3 });
  });

  it("set() still notifies when only ONE field actually changes (the guard is a full field compare, not a truthy/reference shortcut)", () => {
    const store = createViewStore({ scale: 2, tx: 5, ty: -3 });
    let calls = 0;
    store.subscribe(() => {
      calls++;
    });
    store.set({ scale: 2, tx: 5, ty: -3.0001 });
    expect(calls).toBe(1);
  });

  it("subscribe() returns a REAL unsubscribe: that callback stops firing, other subscribers keep firing", () => {
    const store = createViewStore();
    let stopped = 0;
    let kept = 0;
    const unsub = store.subscribe(() => {
      stopped++;
    });
    store.subscribe(() => {
      kept++;
    });
    store.set({ scale: 2, tx: 0, ty: 0 });
    unsub();
    store.set({ scale: 3, tx: 0, ty: 0 });
    expect(stopped).toBe(1);
    expect(kept).toBe(2);
  });

  it("unsubscribing twice is a harmless no-op (MapView.dispose() must be safe to call more than once)", () => {
    const store = createViewStore();
    const unsub = store.subscribe(() => {});
    unsub();
    expect(() => unsub()).not.toThrow();
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
