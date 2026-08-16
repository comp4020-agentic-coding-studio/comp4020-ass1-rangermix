// Theme-aware canvas map renderer over public/data/render.json's road-line
// artifact. Split deliberately into two halves:
//
//   1. Pure geometry/data functions (fitTransform, deriveTransform,
//      zoomAbout, clampGeoView, projectPoint/unprojectPoint, decodeLine,
//      visibleLines, strideFor) — no DOM, no canvas, fully unit-tested in
//      mapRenderer.test.ts.
//   2. `MapView`, a thin class wrapping two stacked <canvas> elements (a
//      static "base" layer for the road network, a dynamic "overlay" layer
//      for settle-flood dots/route/pins) that composes those pure functions
//      with real canvas 2D calls. jsdom has no canvas 2D context, so this
//      half is untested here by design — verified by eye once Task 7 wires
//      a MapView into the home page.
//
// Coordinates: render.json's `lines` are quantized to an integer 1e-5°
// grid relative to `bbox`'s [minLon, minLat] corner, delta-encoded after
// the first point (see scripts/data/build.ts's emit() and
// src/data-node.ts's matching COORD_SCALE) — decodeLine reverses exactly
// that. Projection is equirectangular with cos(midLat) x-scaling: Canberra's
// bbox is small enough (~0.4° x 0.6°) that this is visually indistinguishable
// from a proper conformal projection, at a fraction of the code.

import { effectiveTheme, onThemeChange, themeColors } from "../theme";

/** The shape of public/data/render.json: one polyline per PipeEdge, each
 * `[cls, pct, x0, y0, dx1, dy1, ...]` — see decodeLine for the coordinate
 * scheme. `cls` 0-3 (residential -> motorway); `pct` 0-255, the CH-rank
 * percentile the hierarchy slider filters on (see visibleLines). */
export interface RenderData {
  bbox: [number, number, number, number];
  lines: number[][];
}

/** A fitted map projection: screen = (lon - bbox.minLon) * cosMidLat *
 * scale + ox, (bbox.maxLat - lat) * scale + oy (see fitTransform). */
export interface Transform {
  scale: number;
  ox: number;
  oy: number;
}

const COORD_SCALE = 1e5; // matches src/data-node.ts and scripts/data/build.ts
const DEG2RAD = Math.PI / 180;

function cosMidLat(bbox: [number, number, number, number]): number {
  const midLat = (bbox[1] + bbox[3]) / 2;
  return Math.cos(midLat * DEG2RAD);
}

/** Geo -> screen through an arbitrary Transform (the fitted transform
 * alone, or a fit+view derived transform via deriveTransform — this
 * function doesn't care which, it just applies scale+offset). Exported so
 * MapView.project and the round-trip tests in mapRenderer.test.ts share
 * the exact same math. */
export function projectPoint(
  bbox: [number, number, number, number], t: Transform, lon: number, lat: number,
): [number, number] {
  const cosMid = cosMidLat(bbox);
  return [(lon - bbox[0]) * cosMid * t.scale + t.ox, (bbox[3] - lat) * t.scale + t.oy];
}

/** Screen -> geo: the exact algebraic inverse of projectPoint against the
 * same Transform. Kept as its own pure function (not inlined in
 * MapView.unproject) for the same reason projectPoint is one: round-trip
 * project/unproject becomes a unit-testable property once both halves are
 * plain functions of (bbox, Transform, ...). */
export function unprojectPoint(
  bbox: [number, number, number, number], t: Transform, x: number, y: number,
): [number, number] {
  const [minLon, , , maxLat] = bbox;
  const cosMid = cosMidLat(bbox);
  const lon = minLon + (x - t.ox) / (t.scale * cosMid);
  const lat = maxLat - (y - t.oy) / t.scale;
  return [lon, lat];
}

/** Fits `bbox` inside a `w`x`h` viewport with `pad` px of margin on every
 * side, preserving aspect ratio (a single uniform `scale`, never separate
 * x/y scales — an equirectangular projection with cos(midLat) x-correction
 * needs exactly one scale to stay undistorted). The limiting dimension
 * exactly fills its padded span; the other is centered with slack. Y is
 * flipped so north (higher latitude) renders up. */
export function fitTransform(
  bbox: [number, number, number, number], w: number, h: number, pad: number,
): Transform {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const cosMid = cosMidLat(bbox);
  const mapW = Math.max(1e-9, (maxLon - minLon) * cosMid);
  const mapH = Math.max(1e-9, maxLat - minLat);
  const availW = Math.max(0, w - 2 * pad);
  const availH = Math.max(0, h - 2 * pad);
  const scale = Math.min(availW / mapW, availH / mapH);
  const ox = pad + (availW - mapW * scale) / 2;
  const oy = pad + (availH - mapH * scale) / 2;
  return { scale, ox, oy };
}

// px of margin fitTransform keeps around the fitted bbox for every REAL
// caller in this codebase: MapView.resize() (below) and zoomToBounds' own
// internal fit (see that function's own comment for why it needs this SAME
// constant, not a caller-supplied one, to compute an accurate padding
// fraction for a real on-screen panel). Defined here, ahead of both real
// call sites, rather than down by MapView (its only user before
// zoomToBounds needed it too).
const PAD = 24;

/** GEO-ANCHORED view state (§16.11 — replaces the old pixel-space `{scale,
 * tx, ty}`): `cLon`/`cLat` is the geo point rendered at the CENTER of
 * whichever panel's own viewport is showing this state; `span` is the
 * fraction of the whole bbox's own fitted extent currently visible (`1` =
 * the whole map, matching the old identity view; the old 8x max zoom is
 * `span === MIN_SPAN` = 1/8). Deliberately dimensionless in the pixel
 * sense — nothing here is a screen-px offset — which is the whole point:
 * two MapViews with DIFFERENT css sizes (the overlay map vs. a Compare
 * panel, or two differently-shaped Compare panels) showing the SAME
 * ViewState both center on the SAME geo point (see deriveTransform), so
 * switching between them preserves what the visitor was looking at instead
 * of carrying over a pixel pan that meant something different in the old
 * panel's geometry. The identity view (whole map, centered) is
 * `wholeMapView(bbox)` — what a freshly constructed or resetView()'d
 * MapView starts at. */
export interface ViewState {
  cLon: number;
  cLat: number;
  span: number;
}

const MIN_SPAN = 1 / 8; // most zoomed in — matches the old MAX_VIEW_SCALE (8x)
const MAX_SPAN = 1; // whole map — matches the old MIN_VIEW_SCALE (1x, identity)

function clampSpan(span: number): number {
  return Math.min(MAX_SPAN, Math.max(MIN_SPAN, span));
}

/** The identity view: whole bbox, centered — `span: 1` shows exactly the
 * fitted extent fitTransform itself computes, regardless of which panel's
 * own `fit` ends up applying it (see deriveTransform), so this is
 * panel-shape-agnostic on purpose. Used as the default starting state and
 * as the fit-toggle button's "whole map" target (§16.7). */
export function wholeMapView(bbox: [number, number, number, number]): ViewState {
  return { cLon: (bbox[0] + bbox[2]) / 2, cLat: (bbox[1] + bbox[3]) / 2, span: MAX_SPAN };
}

/** Derives ONE effective Transform from a geo ViewState for a SPECIFIC
 * panel's own `fit` and `w`x`h` css size — the per-frame, per-panel step
 * §16.11 asks for ("each MapView derives its pixel transform per-frame from
 * geo state × its OWN fitTransform × its css size"). `span` scales the
 * fit's own scale (`scale = fit.scale / span` — smaller span = more zoomed
 * in); `cLon`/`cLat` is placed at the viewport's own center `(w/2, h/2)` by
 * solving projectPoint's own `screen = (geo - bbox0) * cosMid * scale +
 * offset` for the offset directly, rather than reusing `fit.ox`/`fit.oy`
 * (which only describe span-1-AND-bbox-centered — this replaces that
 * whole-map-only centering with an arbitrary one). Callers never cache the
 * result across a store update — see MapView's class comment for why that
 * used to be exactly the overlay-lag bug (§16.9). */
export function deriveTransform(view: ViewState, bbox: [number, number, number, number], fit: Transform, w: number, h: number): Transform {
  const cosMid = cosMidLat(bbox);
  const scale = fit.scale / view.span;
  return {
    scale,
    ox: w / 2 - (view.cLon - bbox[0]) * cosMid * scale,
    oy: h / 2 - (bbox[3] - view.cLat) * scale,
  };
}

/** Anchor-preserving zoom, geo-anchored equivalent of the old pixel-space
 * zoomAbout: returns the ViewState after scaling by `factor` (>1 zooms in,
 * <1 zooms out) about the SCREEN point `(cx, cy)` in CSS px, WITHIN the
 * panel described by `bbox`/`fit`/`w`/`h` — whatever geo point currently
 * renders at `(cx, cy)` in THAT panel renders at `(cx, cy)` again after the
 * zoom (the invariant mapRenderer.test.ts checks directly): unproject the
 * anchor under the CURRENT transform, then solve for the new center that
 * puts that same geo point back at `(cx, cy)` under the NEW span's
 * transform. `span` is clamped to `[MIN_SPAN, MAX_SPAN]`; if it clamps
 * exactly at `MAX_SPAN` (fully zoomed out), the result resets to
 * `wholeMapView(bbox)` instead of preserving the anchor through that
 * transition — "zoomed all the way out" is the canonical home position
 * regardless of where the anchor was, the one deliberate exception to
 * anchor preservation carried over unchanged from the old zoomAbout (only
 * MIN_SPAN, the old scale-8 boundary, is NOT special — anchor preservation
 * holds right up to and at that clamp too). Deliberately does NOT also run
 * clampGeoView's pan-bounds clamp here, same reason as before: that could
 * move the center away from the anchor-preserving value computed below.
 * Pan bounds are panBy's job (see clampGeoView's own comment).
 *
 * Guards `fit.scale <= 0` by returning `view` unchanged: a MapView calls
 * this from a real pointer/wheel gesture only, which can't reach a panel
 * with no real on-screen size — but `fit` is caller-supplied data, not
 * something this function controls, so it defends itself anyway rather
 * than trusting every future caller to only ever pass a live fit (see
 * clampGeoView's own comment for the concrete scenario this class of bug
 * came from — a resize() firing against a `display:none` canvas). Without
 * this, `scaleNew` below would be 0 and the anchor math would divide by
 * it, producing Infinity/NaN. */
export function zoomAbout(
  view: ViewState, bbox: [number, number, number, number], fit: Transform, w: number, h: number,
  cx: number, cy: number, factor: number,
): ViewState {
  if (!(fit.scale > 0)) return view;
  const spanNew = clampSpan(view.span / factor);
  if (spanNew === MAX_SPAN) return wholeMapView(bbox);
  const t0 = deriveTransform(view, bbox, fit, w, h);
  const [anchorLon, anchorLat] = unprojectPoint(bbox, t0, cx, cy);
  const cosMid = cosMidLat(bbox);
  const scaleNew = fit.scale / spanNew;
  return {
    cLon: anchorLon - (cx - w / 2) / (cosMid * scaleNew),
    cLat: anchorLat + (cy - h / 2) / scaleNew,
    span: spanNew,
  };
}

/** Shifts `view`'s geo center by a screen-space `(dx, dy)` CSS-px delta,
 * within the panel described by `bbox`/`fit`/`w`/`h` — the geo-anchored
 * equivalent of the old pixel-space `panBy`'s plain `tx + dx`. Dragging the
 * pointer by `(dx, dy)` moves the MAP by `(dx, dy)` (content follows the
 * finger/mouse), which is the same as moving the viewport's CENTER by
 * `(-dx, -dy)` screen px — converted to geo via the current scale (and
 * `cosMid` on the lon axis, matching every other geo<->screen conversion in
 * this module). Unclamped on purpose (mirrors the old panBy/clampPan split):
 * MapView.panBy composes this with clampGeoView; kept separate so the pure
 * shift math is independently testable.
 *
 * Guards `fit.scale <= 0` by returning `view` unchanged — same defensive
 * reasoning as zoomAbout's own comment: without it, `scale` below would be
 * 0 and dividing by it would produce Infinity/NaN for any nonzero
 * (dx, dy). */
export function panGeo(
  view: ViewState, bbox: [number, number, number, number], fit: Transform, w: number, h: number,
  dx: number, dy: number,
): ViewState {
  if (!(fit.scale > 0)) return view;
  const cosMid = cosMidLat(bbox);
  const scale = fit.scale / view.span;
  return { cLon: view.cLon - dx / (cosMid * scale), cLat: view.cLat + dy / scale, span: view.span };
}

// The design spec's pan-clamp contract: "the fitted content never fully
// leaves the viewport — keep >= 25% visible each axis" (build-review
// amendment §14.2), enforced against the TRUE fitted content rect, not the
// viewport's own size as a stand-in for it (a prior version used the
// viewport size directly, which silently counted a fit's own ox/oy slack —
// often the majority of the viewport on the non-limiting axis for a bbox as
// tall/narrow as Canberra's — as if it were content, letting one ordinary
// drag pan the network to ~0% visible; see clampGeoView's own comment for
// the fix and mapRenderer.test.ts's realistic-fit cases for the regression
// coverage).
const MIN_VISIBLE_FRACTION = 0.25;

/** A tiny observable holding ONE shared geo ViewState — the mechanism
 * build-review amendment §14.3's Compare mode is built on: pan/zoom in ANY
 * panel (or the overlay map) moves every panel, because every MapView
 * sharing a store derives its own transform off the same `get()`/
 * `subscribe()` pair rather than owning a private ViewState of its own
 * (§16.11 additionally makes that shared state geo-anchored, so panels of
 * DIFFERENT shapes stay centered on the same place too — see the ViewState
 * doc comment). Deliberately minimal — no middleware, no selectors, `set()`
 * always replaces the whole ViewState — because the only thing ever stored
 * is a ViewState and the only consumer is MapView. `subscribe()` does NOT
 * fire on registration, only on a LATER `set()` (matches theme.ts's
 * onThemeChange: register-then-wait, not register-then-replay) whose value
 * actually differs from the current one — `set()` field-compares against
 * the current state and no-ops otherwise (build-review fix: a resize's
 * re-clamp calls set() unconditionally, and without this guard a no-op
 * clamp would still fan out to every sharer of the store) — and, unlike
 * onThemeChange, returns a REAL unsubscribe function; MapView.dispose()
 * depends on that (see its own comment for why: a Compare panel gets
 * constructed and discarded repeatedly, which theme.ts's existing callers
 * never did). Critically for §16.9's overlay-lag fix: `state` is updated
 * BEFORE the listener loop runs, so `get()` already answers with the NEW
 * state inside EVERY subscriber's callback, regardless of which order they
 * were registered in or which one runs first — see MapView's class comment
 * for why that specific guarantee is what makes deriving a transform fresh
 * (rather than caching one inside a subscription callback) immune to
 * subscription-order bugs. */
export interface ViewStore {
  get(): ViewState;
  set(view: ViewState): void;
  subscribe(cb: (view: ViewState) => void): () => void;
}

/** Creates a ViewStore. `initial` is required (unlike the old pixel-space
 * store's dimensionless `{scale:1,tx:0,ty:0}` default) because a
 * geo-anchored identity genuinely needs a bbox to mean anything — every
 * real caller in this codebase has one in hand at construction time and
 * passes `wholeMapView(render.bbox)` explicitly (see MapView's constructor
 * default below, and home.ts's page-level store, created once render.json
 * resolves). A MapView constructed with no explicit `store` creates its own
 * private one this same way, so single-instance callers (the /how/ toys)
 * are unaffected — sharing a store is opt-in, by passing the SAME store
 * instance to every MapView that should move together. */
export function createViewStore(initial: ViewState): ViewStore {
  let state = initial;
  const listeners = new Set<(view: ViewState) => void>();
  return {
    get: () => state,
    set(next) {
      // Equality guard (build-review fix): resize()'s re-clamp calls set()
      // unconditionally even when clampGeoView is a no-op, which on a
      // SHARED store would otherwise fan a genuinely unchanged view out to
      // every sibling panel (and home.ts's page-level overlay-resync
      // subscription) — O(panels) wasted work per panel resizing, i.e.
      // O(panels^2) for one grid reflow, for zero visual change. Field
      // compare, not reference: every caller passes a freshly computed
      // object, so `===` per field is a true value check.
      if (next.cLon === state.cLon && next.cLat === state.cLat && next.span === state.span) return;
      state = next;
      for (const cb of listeners) cb(state);
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

/** Clamps `view`'s center so the fitted content can't slide fully out of a
 * `viewportW` x `viewportH` viewport — the geo-anchored re-derivation of
 * the F2 pan-clamp contract (see MIN_VISIBLE_FRACTION above): at least
 * `MIN_VISIBLE_FRACTION` of the CONTENT rect's own size (not the
 * viewport's) stays inside the viewport, per axis. Works by computing the
 * screen-space offset (`ox`/`oy`, exactly what deriveTransform itself would
 * produce for this `view`) that the geo center implies, clamping THAT to
 * the same `[min, max]` interval the old pixel-space clampPan derived
 * (`min = -(1 - MIN_VISIBLE_FRACTION) * contentSize`, `max = viewportSize -
 * MIN_VISIBLE_FRACTION * contentSize`, where `contentSize = mapW-or-H *
 * scale` is the TRUE fitted content's own px size at the current span —
 * see git history for the full inequality derivation, unchanged here), then
 * solving deriveTransform's own `ox`/`oy` formula backwards for the geo
 * center that produces the clamped offset. Algebraically exact (clamping
 * the offset and clamping the center it implies are the same operation
 * viewed from two sides — deriveTransform's `ox`/`oy` formula is a strictly
 * monotonic function of `cLon`/`cLat`), so this is the same clamp the old
 * clampPan enforced, just expressed in geo terms so it composes with the
 * geo-anchored store. Used by panBy (drag-pan, wheel-drag, pinch-pan) and
 * resize (re-clamping a view that a viewport-size change left stale);
 * deliberately NOT applied inside zoomAt (see zoomAbout's own comment on
 * why). Assumes `view.span <= MAX_SPAN` (1), so a real clamp interval
 * always exists on both axes (in fact `min <= max` holds for any
 * non-negative size/contentSize).
 *
 * Guards `fit.scale <= 0` by returning `view` unchanged — the concrete bug
 * this fixes: MapView.resize() calls this UNCONDITIONALLY, including for a
 * panel whose canvas is currently `display:none` (e.g. the overlay map,
 * constructed while Compare is the active view mode — a persisted
 * localStorage preference means this can be true from the very first
 * resize(), not just after a later mode switch). A hidden canvas's
 * `getBoundingClientRect()` is zero, which floors to a 1x1 css size (see
 * resize()'s own `Math.max(1, ...)`), which starves `fitTransform`'s own
 * `availW`/`availH` to 0 (viewport smaller than 2x PAD), which makes
 * `fit.scale` exactly 0. Every other div-by-`scale` in this module
 * (deriveTransform's own math never divides by it, only multiplies — see
 * that function's comment) is fine at scale 0, but this function's
 * offset<->center round-trip does divide by it (`cosMid * scale`), so
 * `fit.scale === 0` here would put `NaN` (0/0) or `Infinity` (n/0) into
 * `cLon`/`cLat` and, since this is the SHARED store, corrupt every panel
 * sharing it — not just the hidden one. Returning `view` unchanged leaves
 * the store exactly as it was; the panel's NEXT resize() (once it actually
 * has a real size — a mode switch back, or the ResizeObserver firing once
 * it's un-hidden) re-clamps for real. */
export function clampGeoView(
  view: ViewState, bbox: [number, number, number, number], fit: Transform, viewportW: number, viewportH: number,
): ViewState {
  if (!(fit.scale > 0)) return view;
  const cosMid = cosMidLat(bbox);
  const scale = fit.scale / view.span;
  const mapW = Math.max(1e-9, (bbox[2] - bbox[0]) * cosMid);
  const mapH = Math.max(1e-9, bbox[3] - bbox[1]);

  const clampOffset = (off: number, contentSize: number, viewportSize: number): number => {
    const min = -(1 - MIN_VISIBLE_FRACTION) * contentSize;
    const max = viewportSize - MIN_VISIBLE_FRACTION * contentSize;
    return Math.min(max, Math.max(min, off));
  };

  const ox = viewportW / 2 - (view.cLon - bbox[0]) * cosMid * scale;
  const oy = viewportH / 2 - (bbox[3] - view.cLat) * scale;
  const oxClamped = clampOffset(ox, mapW * scale, viewportW);
  const oyClamped = clampOffset(oy, mapH * scale, viewportH);

  return {
    cLon: bbox[0] + (viewportW / 2 - oxClamped) / (cosMid * scale),
    cLat: bbox[3] - (viewportH / 2 - oyClamped) / scale,
    span: view.span,
  };
}

/** Frames both A/B points with `pad` fraction of margin held back on every
 * side (design spec §16.6: "starting any race zooms the viewport to the A-B
 * bounds with pleasant padding (~15%)") — `w`/`h` is the REFERENCE panel's
 * own CSS px size (home.ts passes whichever panel is currently live — see
 * that call site's own comment) that this frames padding AGAINST: A/B are
 * projected through THAT panel's actual fitted pixel geometry
 * (`fitTransform(bbox, w, h, PAD)` — the exact same fit a REAL MapView of
 * this size would compute in its own `resize()`, PAD included) rather than
 * compared as a raw fraction of the bbox's own extent.
 *
 * build-review fix: the old formula (`frac = max(lonSpread/mapW,
 * latSpread/mapH); span = frac/(1-2*pad)`) compared the pair's spread
 * against the BBOX's own aspect ratio, which only equals the padding
 * actually achieved on screen when the panel's fit has zero pixel padding
 * AND an aspect ratio that exactly matches the bbox's — true of none of
 * this app's real panels (PAD=24, and Canberra's bbox aspect matches no
 * real viewport). Measured 17-49% achieved padding instead of ~15% against
 * the real bbox/presets (ANU->Airport: 36%/41%). Going through a REAL fit
 * fixes this for arbitrary aspect ratios and PAD: `span` is solved so that,
 * when `deriveTransform` is later evaluated against THIS SAME `w`/`h` (any
 * real panel of this exact size), the on-screen A-B distance on the
 * LIMITING axis is exactly `(1 - 2*pad)` of `w` (or `h`) — see
 * mapRenderer.test.ts's real-bbox/real-preset cases for the achieved-
 * padding verification. `span` is matched to whichever axis THIS panel's
 * own projection of the pair spans a LARGER fraction of `w`/`h` on (that's
 * the one that would clip first); the other axis ends up with more than the
 * target padding, never less. Because a shared `span` still means "this
 * fraction of the SAME bbox's fit" for every panel regardless of its own
 * size (see the ViewState doc comment), a DIFFERENT panel shape than the
 * one passed in here ends up close to but not bit-exactly at `pad` — this
 * app's Compare panels all share one CSS aspect-ratio (styles.css's
 * `.compare-panel`), so that residual gap is small in practice.
 *
 * Clamped to `[MIN_SPAN, MAX_SPAN]`: a pair spanning most of the bbox
 * already (e.g. the "Belconnen -> Tuggeranong" full-diagonal preset) clamps
 * to the whole map rather than requesting an impossible zoom-out past it; a
 * pair close together relative to the whole bbox (e.g. "ANU -> Airport" at
 * a large viewport) can likewise hit MIN_SPAN's 8x-zoom cap before reaching
 * exactly `pad` — achieving MORE than the target padding is the correct,
 * physically-forced outcome there, not a bug (mapRenderer.test.ts's
 * real-preset cases allow a tolerance band for exactly this). A degenerate
 * same-point pair (or two nodes that snapped to the same node) has zero
 * extent to frame — both axes' fractions are then exactly 0, which clamps
 * up to MIN_SPAN (the closest legal zoom) instead of needing a
 * special-cased branch: framing a single point at max zoom ("show me where
 * this pin actually is") is exactly the sensible fallback the degenerate
 * case needs.
 *
 * Guards `fit.scale <= 0` (same defensive reasoning as zoomAbout/panGeo/
 * clampGeoView/baseBlitRect — a hidden panel's `resize()` is a real,
 * reachable source of a degenerate fit) by returning the AB midpoint at
 * MAX_SPAN (whole map) instead of dividing by zero: unlike those functions
 * there's no pre-existing `view` to fall back to (this BUILDS a view from
 * scratch), so the widest legal, still-centered, still-finite result is the
 * safest fallback. */
export function zoomToBounds(
  bbox: [number, number, number, number], lonA: number, latA: number, lonB: number, latB: number,
  w: number, h: number, pad = 0.15,
): ViewState {
  const cLon = (lonA + lonB) / 2;
  const cLat = (latA + latB) / 2;
  const fit = fitTransform(bbox, w, h, PAD);
  if (!(fit.scale > 0)) return { cLon, cLat, span: MAX_SPAN };
  const [xA, yA] = projectPoint(bbox, fit, lonA, latA);
  const [xB, yB] = projectPoint(bbox, fit, lonB, latB);
  const avail = Math.max(1e-9, 1 - 2 * pad);
  const spanX = Math.abs(xB - xA) / (avail * w);
  const spanY = Math.abs(yB - yA) / (avail * h);
  return { cLon, cLat, span: clampSpan(Math.max(spanX, spanY)) };
}

// Interaction-time base-layer caching (§16.10 — user-reported: "overlay view
// have acceptable but not perfectly smooth frame rate, and compare view lags
// significantly"). Re-stroking every road line (drawBase, tens of thousands
// of points) on EVERY pan/zoom tick is the cost — MapView instead blits its
// last crisply-stroked bitmap under the delta between the geo state it was
// stroked at and the current one WHILE the view is actively changing, then
// re-strokes crisply once it settles (see MapView.drawBase/strokeBaseCrisp/
// blitBase). The three functions below are the pure decision layer that
// makes this correct rather than a source of stale/wrong frames: WHERE to
// blit (baseBlitRect), how far the cache may have drifted before blitting
// stops being worth it (withinBlitRange), and what invalidates the cache
// outright (baseCacheValid). MapView itself (which owns the actual bitmap,
// the recency timer, and the real canvas calls) is untested here, same
// jsdom-has-no-canvas rationale as the rest of this file.

const INTERACTION_IDLE_MS = 150; // design spec's own "~150ms" idle debounce before a crisp re-stroke

export const BLIT_SPAN_RATIO_LIMIT = 2; // "zoom deltas beyond the cache's useful range (>2x away) may re-stroke immediately"

/** Whether a base-layer bitmap cached at `cachedSpan` is still close enough
 * to the CURRENT `currentSpan` to blit instead of paying for a full crisp
 * re-stroke (§16.10's own ">2x away" allowance). Past that ratio in either
 * direction the blit would be a very blurry upscale (zoomed in a lot since
 * the cache) or a wastefully tiny downscale (zoomed out a lot since the
 * cache) — re-stroking crisply instead reads better AND leaves a fresh
 * cache that resets the ratio to 1 for the next tick, so a fast continuous
 * zoom gesture only pays for a re-stroke when it crosses another threshold,
 * not on every frame. Boundary is inclusive at exactly `ratioLimit` (same
 * "inclusive at the boundary" convention as visibleLines/strideFor above).
 *
 * `ratioLimit` defaults to `BLIT_SPAN_RATIO_LIMIT` (the spec's own "say
 * >2x") but is a parameter, not hardcoded, so MapView can pass a small
 * per-instance jitter around it (see MapView's own `blitRatioLimit` field
 * comment) — Compare mode's panels all share ONE ViewStore, so during a
 * sustained zoom every panel's cache would otherwise cross the SAME fixed
 * threshold on the SAME tick, turning one frame into an N-panel-simultaneous
 * crisp-restroke spike instead of N single-panel ones spread across a few
 * consecutive frames (found via the §16.10 honest measurement itself — see
 * the G3 report). */
export function withinBlitRange(cachedSpan: number, currentSpan: number, ratioLimit = BLIT_SPAN_RATIO_LIMIT): boolean {
  const ratio = cachedSpan / currentSpan;
  return ratio >= 1 / ratioLimit && ratio <= ratioLimit;
}

/** Where to `drawImage` a cached base-layer bitmap (its own [0,0]-[w,h] CSS
 * rect, crisply stroked at `cachedView`) so the SAME geographic content it
 * shows reprojects correctly under the panel's CURRENT view (`currentView`)
 * — the pure geometry behind interaction-time blitting (§16.10). Both the
 * cached and current transforms are plain uniform-scale + offset (no
 * rotation — see deriveTransform), so the cached rect's two opposite
 * corners individually reprojecting through (unproject under the cached
 * transform) -> (project under the current transform) is exactly enough to
 * define the single other axis-aligned rect the WHOLE bitmap maps to.
 * Deliberately goes via geo space (the one frame both transforms agree on)
 * rather than an algebraic scale/offset delta: this is provably exactly
 * what `unprojectPoint`/`projectPoint` themselves define "correct" to mean,
 * so a regression in either of those two functions would show up here too,
 * not just be silently re-derived alongside it. `fit`/`bbox`/`w`/`h` are the
 * SAME panel-specific inputs every other view-derivation function in this
 * module takes (see deriveTransform) — this only ever compares two
 * ViewStates against the panel's own current geometry, never a stale one.
 *
 * Guards `fit.scale <= 0` (same defensive reasoning as zoomAbout/panGeo/
 * clampGeoView — a hidden panel's resize() is a real, reachable source of a
 * degenerate fit, see clampGeoView's own comment for the concrete scenario)
 * by returning a 1:1 "the bitmap covers the whole viewport" rect instead of
 * letting unprojectPoint divide by zero. Unlike those three functions this
 * one never writes to the shared store — a bad result here can only mis-draw
 * ONE panel's own (in practice invisible, since fit.scale=0 only happens
 * behind display:none) canvas, not corrupt a sibling's view state — but it
 * guards anyway rather than hand a caller's drawImage an Infinity/NaN rect. */
export function baseBlitRect(
  cachedView: ViewState, currentView: ViewState, bbox: [number, number, number, number], fit: Transform, w: number, h: number,
): { dx: number; dy: number; dw: number; dh: number } {
  if (!(fit.scale > 0)) return { dx: 0, dy: 0, dw: w, dh: h };
  const cachedT = deriveTransform(cachedView, bbox, fit, w, h);
  const currentT = deriveTransform(currentView, bbox, fit, w, h);
  const [lon0, lat0] = unprojectPoint(bbox, cachedT, 0, 0);
  const [lon1, lat1] = unprojectPoint(bbox, cachedT, w, h);
  const [x0, y0] = projectPoint(bbox, currentT, lon0, lat0);
  const [x1, y1] = projectPoint(bbox, currentT, lon1, lat1);
  return { dx: x0, dy: y0, dw: x1 - x0, dh: y1 - y0 };
}

/** The fingerprint a cached base-layer bitmap was stroked under — every
 * field is one of MapView.strokeBaseCrisp's own inputs (theme, this
 * instance's own css size + device pixel ratio, and the hierarchy-filter
 * state), so a real difference in ANY of them means the cached pixels no
 * longer reflect what a fresh crisp stroke would paint. */
export interface BaseCacheKey {
  theme: "light" | "dark";
  cssWidth: number;
  cssHeight: number;
  dpr: number;
  pctThreshold: number | null;
  emphasize: boolean;
}

/** Whether a cached base-layer bitmap stroked under `cached` is still usable
 * under the CURRENT fingerprint `current` — §16.10's three named
 * invalidation triggers (theme change, resize, hierarchy-filter/"data"
 * change) all fall out of this one field-by-field comparison rather than
 * each needing its own explicit "invalidate the cache" call site: a theme
 * flip changes `theme`, a resize changes `cssWidth`/`cssHeight`/`dpr`, and
 * the hierarchy toy's slider changes `pctThreshold`/`emphasize` — whichever
 * it is, the fingerprint no longer matches and MapView.drawBase falls back
 * to a crisp re-stroke structurally, the same way this module already
 * prefers "derive fresh, don't cache separately" over ad hoc invalidation
 * flags elsewhere (see deriveTransform's own class-comment history, §16.9).
 * `cached === null` (nothing has ever been crisply stroked yet) is never
 * valid. */
export function baseCacheValid(cached: BaseCacheKey | null, current: BaseCacheKey): boolean {
  if (!cached) return false;
  return (
    cached.theme === current.theme &&
    cached.cssWidth === current.cssWidth &&
    cached.cssHeight === current.cssHeight &&
    cached.dpr === current.dpr &&
    cached.pctThreshold === current.pctThreshold &&
    cached.emphasize === current.emphasize
  );
}

/** Canonical string key for the CROSS-INSTANCE shared base-layer cache
 * (§16.10 review round 2 — see the `sharedBaseCache` module comment, right
 * before `MapView`, for the full mechanism this keys): every field
 * BaseCacheKey already tracks (theme/cssWidth/cssHeight/dpr/pctThreshold/
 * emphasize) PLUS the live geo ViewState's own three fields. `view` has to
 * be part of the key, not just `key`: two panels only ever stroke IDENTICAL
 * pixels when both their fingerprint AND their current view agree — folding
 * its fields into the string (rather than relying on same-store panels
 * usually sharing ONE ViewState object reference) also makes this correct
 * for a future caller whose panels don't share a store but happen to
 * coincide numerically. Plain string interpolation, not a hash: a small
 * fixed field count, and a readable key is easier to debug than a hash
 * collision would be to notice. Exported so the "identical inputs -> the
 * same key, any one differing field -> a different key" contract is
 * directly unit-testable without a real canvas. */
export function baseFingerprintKey(key: BaseCacheKey, view: ViewState): string {
  return `${key.theme}|${key.cssWidth}|${key.cssHeight}|${key.dpr}|${key.pctThreshold}|${key.emphasize}|${view.cLon}|${view.cLat}|${view.span}`;
}

/** Reverses render.json's per-line encoding: `line[0]` is `cls`, `line[1]`
 * is `pct` (both metadata, not coordinates), `line[2..3]` is the first
 * point in absolute quantized units, and every following pair is a delta
 * from the running position. Returns absolute, dequantized [lon, lat]
 * pairs, one per geometry point. */
export function decodeLine(
  line: number[], bbox: [number, number, number, number],
): [number, number][] {
  const [minLon, minLat] = bbox;
  const pts: [number, number][] = [];
  let qx = line[2];
  let qy = line[3];
  pts.push([minLon + qx / COORD_SCALE, minLat + qy / COORD_SCALE]);
  for (let i = 4; i < line.length; i += 2) {
    qx += line[i];
    qy += line[i + 1];
    pts.push([minLon + qx / COORD_SCALE, minLat + qy / COORD_SCALE]);
  }
  return pts;
}

/** The hierarchy slider's filter: keep only lines whose `pct` (line[1]) is
 * at or above `pctThreshold`. `null` means unfiltered (every line visible)
 * — the base layer's default. */
export function visibleLines(lines: number[][], pctThreshold: number | null): number[][] {
  if (pctThreshold === null) return lines;
  return lines.filter((line) => line[1] >= pctThreshold);
}

/** How many of every `stride`-th settled node to draw so a flood of `len`
 * points never exceeds `cap` drawn dots per frame (perf: replay is capped
 * to ~4k drawn points per the design spec, §12 phone-canvas-perf risk) —
 * the settled COUNTER stays exact regardless, only the visual sampling
 * thins out. Always at least 1 (never 0 — a 0 stride would stall or
 * divide-by-zero a caller's `for (i = 0; i < upto; i += stride)` loop). */
export function strideFor(len: number, cap = 4000): number {
  return Math.max(1, Math.ceil(len / cap));
}

// Ghost-underlay alpha for the hierarchy toy's filtered steps (round 4 fix):
// once a pct threshold hides most of the network, the retained lines alone
// read as fragments floating in a void — drawing the FULL network first, at
// this near-invisible alpha, gives the eye the remembered shape of the
// whole city to read the highlighted subset against. `--road`'s own alpha
// (0.55, used for the unfiltered base layer) would still swamp the
// emphasis; this sits an order of magnitude fainter, per spec (0.05-0.08).
const GHOST_ALPHA = 0.07;

// Light-mode density compositing (§16.8 — user-reported: "in dark mode when
// there are overlap of nodes they are brightened. I want similar effect on
// light mode too"): MapView.drawDots composites settled dots with `multiply`
// in light theme (the non-additive analogue of dark's `lighter` glow — see
// that method's own comment for why multiply, not lighter). Raw full-alpha
// multiply overdarkens a dense cluster to flat black well before the
// settle-flood visually finishes, because every dot past the first one or
// two AT A GIVEN PIXEL is already multiplying against near-black there.
// 0.55 keeps late-arriving overlap still visibly deepening instead of
// clipping to black — picked by eye against a real dense race on the
// deployed light palette (see the G3 report for the comparison).
const LIGHT_MULTIPLY_ALPHA = 0.55;

// How many separate Path2D/fill() calls MapView.drawDots splits an
// ADDITIVE (lighter/multiply) dot cloud across — see that method's own
// comment for why a single batched fill() can't express per-dot
// compositing at all (canvas's nonzero winding rule unions overlapping
// subpaths into one flat-alpha shape). 12 keeps the call count trivial
// (12 fill()s, not thousands) while still giving genuine cross-bucket
// accumulation: two overlapping dots share a bucket only 1-in-12 of the
// time. Not exposed as a tuning knob (no evidence a different value reads
// better — picked once, alongside LIGHT_MULTIPLY_ALPHA, against a real
// dense race).
const DENSITY_BUCKETS = 12;

/** Owns the two stacked canvases the home page's race (and /how/'s
 * hierarchy toy, which reuses the same data) paint into: `base` is the
 * static road network, redrawn only on resize/theme-change/threshold
 * change/store-change; `overlay` is the per-frame settle-flood/route/pins
 * layer the caller (RaceController) drives directly. MapView never redraws
 * the overlay on its own — replay state lives in the caller, not here (see
 * design spec §8: "Canvases re-render on theme change, including mid-race
 * — replay state lives in data") — so after a theme change (or a pan/zoom)
 * flips/moves the base layer automatically, the caller re-invokes
 * clearOverlay/drawDots/drawRoute/drawPin with whatever frame it was
 * already showing; those four methods ARE that redraw hook.
 *
 * Build-review §14.3 (Compare mode): the user's pan/zoom `ViewState` lives
 * in an external `ViewStore` (see createViewStore above), not a private
 * field — every MapView constructed against the SAME store redraws its base
 * layer whenever ANY of them (or a caller calling `store.set` directly)
 * changes it, which is the entire mechanism behind "pan/zoom in one Compare
 * panel moves every panel". A MapView constructed with no `store` argument
 * creates its own private one (`wholeMapView(render.bbox)`, this class's
 * own default), so every pre-existing single-instance caller (the /how/
 * toys) is unaffected. Because Compare panels are constructed and discarded
 * repeatedly (unlike every prior MapView caller, which built exactly one
 * for the page's lifetime), call `dispose()` when discarding one — see
 * that method's own comment for what it does and does not fully unhook.
 *
 * §16.9 (the overlay-lag bug) — root cause and fix: this class used to
 * cache ONE derived Transform (`recompose()`, writing a private
 * `this.transform` field) inside its own store subscription callback, and
 * every draw method read that cached field. home.ts ALSO subscribes to the
 * same shared store, separately, to redraw the overlay (pins/dots/route)
 * whenever the view changes — and because home.ts's page-level subscription
 * was registered BEFORE this class's MapView instances existed (it's set up
 * synchronously in boot(), while a MapView is only constructed once
 * render.json resolves), `ViewStore`'s listener `Set` — which fires
 * callbacks in insertion order — always called home.ts's overlay-redraw
 * subscriber BEFORE this instance's own subscriber on every single
 * `store.set()`. So every overlay redraw read `this.transform` one store
 * update BEFORE this instance's own subscriber had refreshed it — the base
 * layer (redrawn by THIS instance's subscriber, later in the same
 * notification) always painted the CURRENT view; the overlay (redrawn by
 * home.ts's subscriber, earlier) always painted the PREVIOUS one. Two
 * things independently make this class immune now: there is no cached
 * transform field at all (see `currentTransform()` below — every draw call
 * derives it fresh from `this.store.get()`, which `ViewStore.set()` already
 * updates BEFORE it notifies anyone, so every subscriber sees the same,
 * current state regardless of registration order — see ViewStore's own doc
 * comment and mapRenderer.test.ts's direct regression test for that
 * property), and the state itself is now geo-anchored rather than a pixel
 * pan that only made sense relative to a snapshot of `fit`. Base and
 * overlay redraws still run from two separately-registered subscriptions
 * (home.ts's overlay one and this class's own base one) — that ordering no
 * longer matters, because there's nothing left for the order to make stale. */

// Round-robin source for MapView's own `blitRatioLimit` field (§16.10) —
// see that field's own comment for why it exists (desynchronizing Compare
// mode's panels' re-stroke thresholds). Deterministic and monotonically
// increasing rather than random: an EARLIER version of this used
// `Math.random()`, and live measurement (see the G3 report's before/after
// table) showed real run-to-run variance — a 4-of-4 random draw sometimes
// clusters two panels' thresholds close together by chance, which is
// exactly the failure mode this exists to avoid. Module-level mutable
// state, same established pattern as theme.ts's own `listeners` array —
// every MapView on the page shares this one counter.
//
// BLIT_RATIO_MULTIPLIERS[0] is exactly 1 (i.e. this instance's own limit is
// exactly BLIT_SPAN_RATIO_LIMIT, unstaggered) DELIBERATELY: the FIRST
// MapView constructed on any page is, in the overwhelming common case, the
// SOLE overlay view — home.ts constructs it before any Compare-mode panel
// can exist — and a single panel has no sibling to desynchronize FROM, so
// it should see exactly the spec's own default, not an arbitrarily
// narrower (more re-stroke-happy) or wider (blurrier) one. An earlier
// version of this array happened to put its narrowest value first, which
// live measurement caught as a real regression: the plain single-overlay
// case (the MOST common one) got MORE frequent re-strokes than before this
// fix existed at all, for a desync benefit that case doesn't even need.
//
// This counter is ONLY a construction-time DEFAULT now (review round 2):
// it correctly covers a batch of up to 4 panels built together from empty
// (an initial Compare-mode build gets 4 clearly distinct thresholds), but
// on its own it does NOT cover home.ts's syncPanels being diff-based — it
// only ever counts UP, so a panel torn down and later rebuilt (a racer
// toggled off then back on) gets whatever slot the counter is up to next,
// with no regard for which slots its CURRENTLY-LIVE siblings already hold.
// setStaggerSlot/assignStaggerSlots (below) are the real fix: home.ts calls
// setStaggerSlot on every currently-live Compare panel after every diff,
// which supersedes whatever this counter guessed at construction.
const BLIT_RATIO_MULTIPLIERS = [1, 1.3, 0.75, 1.15];
let mapViewSequence = 0;

/** Assigns each id in `liveIds` (already in the caller's own stable order —
 * home.ts's syncPanels passes its ROSTER-ordered active-panel list) a
 * stagger slot index (0..BLIT_RATIO_MULTIPLIERS.length-1) for
 * MapView.setStaggerSlot, purely as a function of POSITION within the
 * CURRENT live set. Exists to replace the collision `mapViewSequence`
 * (above) can produce on its own: a page-lifetime counter, assigned ONCE at
 * construction and never revisited, hands a REBUILT panel (home.ts's
 * syncPanels is diff-based — a racer toggled off then back on really does
 * construct a brand-new MapView) whatever slot the counter is up to next,
 * with zero regard for which slots its CURRENTLY-LIVE siblings already
 * hold — silently recreating the exact same-tick simultaneous-restroke
 * spike the stagger exists to prevent (review round 2 finding). Deriving
 * fresh from the live set's own order instead makes a collision
 * structurally impossible: positions within one array are always pairwise
 * distinct, so calling this against whichever ids are live RIGHT NOW, every
 * time the set changes (syncPanels calls it for every CURRENT panel, not
 * only newly-added ones — a kept panel's own position can shift too, e.g.
 * CH's slot shifts whenever astar/bidi toggle around it in ROSTER order),
 * guarantees every concurrently-live panel has its own slot regardless of
 * how many add/remove cycles came before it — there's no persisted per-id
 * counter state for a stale removal to leave stranded. `%
 * BLIT_RATIO_MULTIPLIERS.length` is defensive (this app's own ROSTER never
 * exceeds 4 concurrently-active algos, exactly that many slots), not
 * load-bearing for the common case. Pure and exported so the
 * pairwise-distinctness property is unit-testable directly, across
 * arbitrary add/remove sequences, without a real MapView/DOM. */
export function assignStaggerSlots<T>(liveIds: readonly T[]): Map<T, number> {
  const slots = new Map<T, number>();
  liveIds.forEach((id, i) => slots.set(id, i % BLIT_RATIO_MULTIPLIERS.length));
  return slots;
}

// Shared (cross-instance) base-layer cache (§16.10, review round 2): Compare
// mode's panels all share ONE ViewStore AND (styles.css's `.compare-panel`:
// equal 1fr grid columns + a fixed aspect-ratio) the same css size, so at
// any instant every panel sharing that size/theme/filter sees the exact
// SAME view (literally the same object, via ViewStore's own `state` field —
// see that interface's own comment) — meaning the crisp bitmap ANY ONE of
// them just stroked is pixel-for-pixel identical to what every OTHER
// same-fingerprint panel would independently re-stroke a moment later (same
// bbox/render data — home.ts constructs every MapView on the page against
// the SAME `renderData` object — same PAD constant, same derived fit and
// transform for matching css size). Before this, N panels crossing their
// re-stroke threshold on the same tick each paid the FULL
// tens-of-thousands-of-points stroke cost independently — the residual
// "architectural floor" the G3 report's own compare-4 zoom-burst
// measurement flagged. Now the FIRST panel to need a fresh stroke this
// instant pays for it and PUBLISHES the result here (MapView.
// captureBaseCache), and every sibling that needs the identical
// fingerprint within the same window finds it (MapView.strokeBaseCrisp)
// and pays only for a drawImage copy (adoptSharedBaseCache) instead of a
// real re-stroke. Module-level (shared by every MapView on the page, not
// per-instance) and small/bounded (SHARED_BASE_CACHE_CAP entries, oldest
// evicted first) so a session of continuous panning — where the
// fingerprint changes on nearly every tick — can't grow this into an
// unbounded leak of full-size offscreen bitmaps. Real canvas objects, so
// (like the rest of this section) untested here by design — see
// baseFingerprintKey's own comment for the one piece of this that IS pure
// and unit-tested.
const SHARED_BASE_CACHE_CAP = BLIT_RATIO_MULTIPLIERS.length; // this app's own ROSTER never has more concurrently-live panels than this
interface SharedBaseCacheEntry {
  bitmap: HTMLCanvasElement;
  view: ViewState;
  key: BaseCacheKey;
}
const sharedBaseCache = new Map<string, SharedBaseCacheEntry>();

/** Publishes a freshly-stroked bitmap into the shared cache under its own
 * fingerprint — called only from MapView.captureBaseCache, right after a
 * REAL crisp stroke (never from adoptSharedBaseCache's own cheap path,
 * which would just be re-publishing a copy of what's already there).
 * Stores a private COPY of `bitmap`, not the caller's own canvas by
 * reference: `bitmap` is a MapView instance's own `baseBitmap`, which THAT
 * instance mutates in place on every future crisp stroke (captureBaseCache
 * resizes/redraws into the SAME canvas object rather than allocating a
 * fresh one) — aliasing it here would let a later stroke on the PUBLISHING
 * instance silently corrupt every OTHER instance that has since adopted
 * this entry. Evicts the oldest entry first once at cap (a Map iterates
 * insertion order in JS, so `.keys().next()` is the oldest). */
function publishSharedBaseCache(key: BaseCacheKey, view: ViewState, bitmap: HTMLCanvasElement): void {
  const fpKey = baseFingerprintKey(key, view);
  if (!sharedBaseCache.has(fpKey) && sharedBaseCache.size >= SHARED_BASE_CACHE_CAP) {
    const oldest = sharedBaseCache.keys().next().value;
    if (oldest !== undefined) sharedBaseCache.delete(oldest);
  }
  const copy = document.createElement("canvas");
  copy.width = bitmap.width;
  copy.height = bitmap.height;
  const copyCtx = copy.getContext("2d");
  if (copyCtx) copyCtx.drawImage(bitmap, 0, 0);
  sharedBaseCache.set(fpKey, { bitmap: copy, view, key });
}

export class MapView {
  private readonly baseCanvas: HTMLCanvasElement;
  private readonly overlayCanvas: HTMLCanvasElement;
  private readonly baseCtx: CanvasRenderingContext2D;
  private readonly overlayCtx: CanvasRenderingContext2D;
  private render: RenderData;
  // `fit` is the raw geo->screen fit (recomputed on every resize() — it
  // depends only on THIS panel's own css size + the bbox, never on the
  // shared store). Deliberately NOT composed with the store's view into a
  // cached `transform` field anymore — see the class doc comment's §16.9
  // section for why that used to be the overlay-lag bug. Every draw method
  // instead derives the effective Transform fresh, per call, via
  // `currentTransform()`.
  private fit: Transform = { scale: 1, ox: 0, oy: 0 };
  private readonly store: ViewStore;
  private readonly unsubscribeStore: () => void;
  // Guards the onThemeChange callback below post-dispose (see dispose()'s
  // own comment: theme.ts's onThemeChange has no matching "off", so this
  // flag is what actually stops the redraw cost on a disposed instance).
  private disposed = false;
  private pctThreshold: number | null = null;
  private emphasize = false;
  private dpr = 1;
  private cssWidth = 0;
  private cssHeight = 0;
  // Interaction-time base-layer cache (§16.10) — see drawBase/strokeBaseCrisp/
  // blitBase/currentBaseKey below for how these are used. All three are only
  // ever written together, in captureBaseCache, right after a crisp stroke;
  // null until the first one ever happens (this constructor's own resize()
  // call), so the very first paint has nothing to blit and is always crisp.
  private baseBitmap: HTMLCanvasElement | null = null;
  private baseCacheView: ViewState | null = null;
  private baseCacheKey: BaseCacheKey | null = null;
  // performance.now() of the last PAN/ZOOM-driven redraw (markViewChanged,
  // called only from the store subscription below — never from resize()'s,
  // setPctThreshold()'s, or the theme callback's OWN drawBase() calls), so
  // "recently changed" tracks gesture activity specifically, matching the
  // design spec's own "~150ms of the last view change" wording. -Infinity so
  // a fresh instance starts idle (never spuriously "recent").
  private lastViewChangeAt = -Infinity;
  // The trailing debounce that forces a crisp re-stroke + cache refresh once
  // a gesture settles (reset on every pan/zoom tick — see markViewChanged).
  // Its callback calls strokeBaseCrisp() directly rather than drawBase()
  // (which would have to re-derive "am I still within the idle window"):
  // setTimeout fires AT OR AFTER its delay, never exactly at it, so leaving
  // the branch decision to elapsed-time comparison alone would be one
  // scheduling-jitter away from occasionally blitting a stale cache forever.
  private idleRestrokeTimer: ReturnType<typeof setTimeout> | undefined;
  // This instance's own zoom-delta re-stroke threshold. Exists at all
  // because Compare mode's panels share ONE ViewStore, so during a
  // sustained zoom every panel would otherwise cross the exact SAME fixed
  // threshold on the exact SAME tick, turning one frame into an
  // N-panel-simultaneous full re-stroke spike — found via this task's own
  // honest before/after measurement (see the G3 report). Defaults to a
  // deterministic construction-time value from BLIT_RATIO_MULTIPLIERS' own
  // round-robin (mapViewSequence, see that module-level comment) — correct
  // on its own for a standalone MapView (the /how/ toys: always exactly one
  // instance on the page, always lands on the unstaggered slot 0) but NOT
  // sufficient on its own for Compare mode, where panels are torn down and
  // rebuilt over the page's life (review round 2 finding — see
  // assignStaggerSlots' own comment for the exact collision). setStaggerSlot
  // (below) is the real fix: home.ts's syncPanels calls it on every
  // currently-live Compare panel after every diff, via assignStaggerSlots,
  // which supersedes whatever this construction-time guess assigned.
  // Mutable (not `readonly`) for exactly that override; safe to change at
  // any time — read fresh by drawBase on every call, nothing about it is
  // stateful across calls.
  private blitRatioLimit =
    BLIT_SPAN_RATIO_LIMIT * BLIT_RATIO_MULTIPLIERS[mapViewSequence++ % BLIT_RATIO_MULTIPLIERS.length];

  constructor(base: HTMLCanvasElement, overlay: HTMLCanvasElement, render: RenderData, store?: ViewStore) {
    this.baseCanvas = base;
    this.overlayCanvas = overlay;
    this.render = render;
    const baseCtx = base.getContext("2d");
    const overlayCtx = overlay.getContext("2d");
    if (!baseCtx || !overlayCtx) throw new Error("MapView: 2D canvas context unavailable");
    this.baseCtx = baseCtx;
    this.overlayCtx = overlayCtx;
    this.store = store ?? createViewStore(wholeMapView(render.bbox));
    // Fires on every `store.set()` from ANY sharer of this store, this
    // instance's own zoomAt/panBy/resetView included (they go through
    // `store.set` too, see below) — so drawBase has exactly one call site
    // regardless of who originated the change. No transform to refresh
    // first (see the class doc comment) — drawBase derives its own fresh.
    // markViewChanged() runs ONLY here (§16.10) — this is specifically the
    // "a pan/zoom just happened" signal, not "drawBase needs to run for any
    // reason", which is why resize()/setPctThreshold()/the theme callback
    // below call drawBase() directly without it.
    this.unsubscribeStore = this.store.subscribe(() => {
      if (this.disposed) return;
      this.markViewChanged();
      this.drawBase();
    });
    // NOTE (ledger, carried from an earlier review): onThemeChange has no
    // matching "off" — theme.ts's own listener array only ever grows, and
    // that file is outside this task's edit scope — so this callback is
    // guarded by `disposed` rather than truly unhooked; see dispose()'s
    // own comment for the full story.
    onThemeChange(() => {
      if (!this.disposed) this.drawBase();
    });
    this.resize();
  }

  /** Tears down this instance's subscriptions so a discarded MapView (a
   * Compare-mode panel removed on a racer-set or view-mode change — see
   * home.ts's syncPanels/destroyPanel) stops costing redraws for the rest
   * of the page's life instead of leaking one on every future theme flip
   * and every future shared-view change (the ledger note this fixes).
   * Idempotent — safe to call more than once.
   *
   * The store half is a REAL removal: createViewStore's `subscribe()`
   * returns an unsubscribe function, so `store.set()` from a still-live
   * sibling panel never touches this instance again. The theme half is
   * necessarily weaker: theme.ts's `onThemeChange` (out of this task's
   * file scope) has no matching "off" at all, so `disposed` guards that
   * callback's BODY instead of removing it from theme.ts's listener array.
   * That still eliminates the actual cost the ledger note flagged —
   * `drawBase()` never runs again on a disposed instance, on either a
   * theme flip or a shared-view change — at the price of one harmless dead
   * closure staying in theme.ts's array (and this instance, canvases
   * included, not being garbage-collected) for the rest of the page's
   * life. A complete fix needs a small theme.ts change (onThemeChange
   * returning its own unsubscribe, same shape as the store's); that file
   * isn't in this task's edit list.
   *
   * Also clears the §16.10 idle-restroke timer (if one is pending): without
   * this, a disposed panel mid-gesture would still fire its trailing
   * strokeBaseCrisp() ~150ms later, into a canvas nobody's looking at —
   * harmless visually (same "wasted work on a discarded instance" class the
   * rest of this method already exists to stop) but there's no reason to
   * leave it running once `disposed` already guards everything else. */
  dispose(): void {
    this.disposed = true;
    this.unsubscribeStore();
    if (this.idleRestrokeTimer !== undefined) clearTimeout(this.idleRestrokeTimer);
  }

  /** Re-reads each canvas's CSS box size, re-allocates its backing store at
   * the (capped) device pixel ratio, recomputes the fitted projection,
   * re-clamps the existing pan/zoom against the new size (a resize or
   * orientation change can otherwise strand a pan that was valid a moment
   * ago off-screen — build-review finding; see clampGeoView's call below),
   * and repaints the base layer — safe to call from a ResizeObserver as often
   * as layout changes; also called once by the constructor so a freshly
   * constructed MapView is never left blank. Does NOT itself redraw the
   * OVERLAY (pins/route/settle-flood): the caller's ResizeObserver hook
   * already re-syncs the overlay right after calling resize() (see
   * home.ts's syncAllOverlays()), same as it always has for the
   * backing-store-reallocation-blanks-the-overlay case.
   *
   * The re-clamp goes through `store.set` like every other view mutation
   * (see the class doc comment), so on a SHARED store a resize of ANY one
   * panel that actually moves the clamped view moves every sibling too —
   * accepted as-is for Compare mode: panels in the same grid resize
   * together in practice (a window resize or a panel-count change reflows
   * all of them at once), so this settles rather than fights. If the clamp
   * is a no-op (nothing to re-clamp), the store never fires, which is why
   * `drawBase()` is still called explicitly below — resize() must repaint
   * at the new `fit` either way, not only when the store happens to
   * change. */
  resize(): void {
    const dpr = Math.min(2, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
    this.dpr = dpr;
    for (const canvas of [this.baseCanvas, this.overlayCanvas]) {
      const rect = canvas.getBoundingClientRect();
      const cssW = Math.max(1, rect.width || canvas.clientWidth || 1);
      const cssH = Math.max(1, rect.height || canvas.clientHeight || 1);
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    this.cssWidth = this.baseCanvas.width / dpr;
    this.cssHeight = this.baseCanvas.height / dpr;
    this.baseCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.fit = fitTransform(this.render.bbox, this.cssWidth, this.cssHeight, PAD);
    this.store.set(clampGeoView(this.store.get(), this.render.bbox, this.fit, this.cssWidth, this.cssHeight));
    this.drawBase();
  }

  /** This panel's current CSS-px viewport size (post-`resize()`) — exposed
   * read-only so a caller that needs to compute something against THIS
   * panel's real on-screen geometry (home.ts's `zoomToBounds` call sites,
   * G2 fix: they need a REAL panel's `w`/`h` to frame race-start/fit-button
   * padding accurately for it — see zoomToBounds's own comment) doesn't have
   * to duplicate resize()'s own DOM measurement. Nothing outside resize()
   * ever writes `cssWidth`/`cssHeight`. */
  viewportSize(): { w: number; h: number } {
    return { w: this.cssWidth, h: this.cssHeight };
  }

  /** Overrides this instance's own §16.10 re-stroke-threshold stagger (see
   * `blitRatioLimit`'s own field comment) to a specific slot index —
   * home.ts's syncPanels calls this on every currently-live Compare panel,
   * every time the panel set changes (via assignStaggerSlots), so slots are
   * always derived from the CURRENT live roster rather than trusting the
   * construction-time default (mapViewSequence) to still be collision-free
   * after panels have been torn down and rebuilt over the page's life.
   * Out-of-range slots wrap (`% BLIT_RATIO_MULTIPLIERS.length`), the same
   * defensive stance the constructor's own default already takes. */
  setStaggerSlot(slot: number): void {
    this.blitRatioLimit = BLIT_SPAN_RATIO_LIMIT * BLIT_RATIO_MULTIPLIERS[slot % BLIT_RATIO_MULTIPLIERS.length];
  }

  /** Sets the hierarchy-slider filter (`null` = show every road) and
   * repaints the base layer immediately. `emphasize` (the toy's top-two
   * slider stops — top 12%/top 2%) strokes every retained line in the
   * CH-blue family at a touch of extra width instead of the normal
   * road/road-major greys, so the surviving skeleton reads as one connected
   * thing rather than same-weight leftover fragments. */
  setPctThreshold(pct: number | null, opts: { emphasize?: boolean } = {}): void {
    this.pctThreshold = pct;
    this.emphasize = opts.emphasize ?? false;
    this.drawBase();
  }

  /** Derives this panel's CURRENT effective Transform fresh from the shared
   * store's live state, this instance's own `fit`, and this instance's own
   * css size — never cached across calls (see the class doc comment's
   * §16.9 section: a cached transform, refreshed only inside this
   * instance's own store subscription, is exactly what used to make the
   * overlay lag one store update behind the base layer). Called once per
   * draw method invocation (drawBase/drawDots/drawRoute), not once per
   * point traced within one — cheap (one cos() call, a handful of flops),
   * and the store cannot change mid-call (JS is single-threaded), so
   * hoisting it to the top of each draw method is a pure perf win with zero
   * staleness risk; `project`/`unproject` (below), called at arbitrary
   * times by callers like home.ts's pin hit-testing, each derive their own
   * on every call for the same always-fresh guarantee. */
  private currentTransform(): Transform {
    return deriveTransform(this.store.get(), this.render.bbox, this.fit, this.cssWidth, this.cssHeight);
  }

  /** Zooms by `factor` anchored at the screen point `(cx, cy)` in CSS px
   * (see zoomAbout for the anchor-preserving math, the span clamp, and the
   * zoomed-all-the-way-out reset) — wheel, pinch, and the +/- buttons all
   * funnel through this one method. Writes the new view to the shared
   * store; the store's own subscription (registered in the constructor) is
   * what actually redraws the base layer — for THIS instance and, on a
   * shared store, every sibling too (see the class doc comment: that
   * fan-out IS Compare mode's pan/zoom sync). */
  zoomAt(cx: number, cy: number, factor: number): void {
    this.store.set(zoomAbout(this.store.get(), this.render.bbox, this.fit, this.cssWidth, this.cssHeight, cx, cy, factor));
  }

  /** Pans the view by `(dx, dy)` CSS px, clamped so the fitted content can
   * never fully leave the viewport (see clampGeoView), then writes the
   * result to the shared store — same fan-out as zoomAt above. */
  panBy(dx: number, dy: number): void {
    const shifted = panGeo(this.store.get(), this.render.bbox, this.fit, this.cssWidth, this.cssHeight, dx, dy);
    this.store.set(clampGeoView(shifted, this.render.bbox, this.fit, this.cssWidth, this.cssHeight));
  }

  /** Returns to the identity view (whole map, centered) — the same state a
   * freshly constructed MapView starts at — via the shared store, same
   * fan-out as zoomAt/panBy. */
  resetView(): void {
    this.store.set(wholeMapView(this.render.bbox));
  }

  /** Geo -> screen, through this panel's current derived transform (see
   * currentTransform) — every draw call (drawBase, drawDots, drawRoute,
   * drawPin) and every caller's own hit-testing (home.ts's pinNear) goes
   * through this one method (or, for the three hot-loop draw methods, a
   * transform hoisted once from the same currentTransform() call), so
   * zoom/pan is correct everywhere for free once the store is right. */
  project(lon: number, lat: number): [number, number] {
    return projectPoint(this.render.bbox, this.currentTransform(), lon, lat);
  }

  /** Screen -> geo, the exact inverse of project() against the same
   * derived transform — home.ts uses this for pin-drag snapping and pan
   * math correctly at any zoom level. */
  unproject(x: number, y: number): [number, number] {
    return unprojectPoint(this.render.bbox, this.currentTransform(), x, y);
  }

  /** Traces one render.json line into `ctx`'s current path (decode + project
   * + moveTo/lineTo) without touching stroke style — the caller sets
   * strokeStyle/lineWidth/globalAlpha and calls `stroke()`. Returns false
   * (nothing traced) for a degenerate single-point line, matching the old
   * inline `if (pts.length < 2) continue`. Shared by drawBase's ghost pass
   * and its retained-lines pass so the decode/project walk exists once.
   * Takes `t` (a Transform) from the caller rather than calling
   * `this.project()` per point: drawBase derives it ONCE per repaint (see
   * currentTransform's own comment on why that's still always-fresh, just
   * not re-derived per point) — with tens of thousands of line points in
   * the real Canberra network, re-deriving per point would mean a repeated
   * `Math.cos()` (deriveTransform's cosMidLat call) on every single one. */
  private tracePath(ctx: CanvasRenderingContext2D, line: number[], t: Transform): boolean {
    const pts = decodeLine(line, this.render.bbox);
    if (pts.length < 2) return false;
    ctx.beginPath();
    const [x0, y0] = projectPoint(this.render.bbox, t, pts[0][0], pts[0][1]);
    ctx.moveTo(x0, y0);
    for (let i = 1; i < pts.length; i++) {
      const [x, y] = projectPoint(this.render.bbox, t, pts[i][0], pts[i][1]);
      ctx.lineTo(x, y);
    }
    return true;
  }

  /** Records "a pan/zoom just happened" and (re)arms the idle-settle timer
   * that forces a crisp re-stroke + cache refresh ~150ms after the LAST such
   * change (§16.10). Called only from the constructor's store subscription —
   * see that call site's own comment for why resize/setPctThreshold/theme
   * changes deliberately do NOT call this. */
  private markViewChanged(): void {
    this.lastViewChangeAt = performance.now();
    if (this.idleRestrokeTimer !== undefined) clearTimeout(this.idleRestrokeTimer);
    this.idleRestrokeTimer = setTimeout(() => {
      this.idleRestrokeTimer = undefined;
      if (!this.disposed) this.strokeBaseCrisp();
    }, INTERACTION_IDLE_MS);
  }

  /** This panel's CURRENT base-layer cache fingerprint (see BaseCacheKey) —
   * every field is one of strokeBaseCrisp's own inputs, so comparing this
   * against `baseCacheKey` (baseCacheValid) is exactly "would a fresh crisp
   * stroke right now paint different pixels than what's cached". */
  private currentBaseKey(): BaseCacheKey {
    return {
      theme: effectiveTheme(),
      cssWidth: this.cssWidth,
      cssHeight: this.cssHeight,
      dpr: this.dpr,
      pctThreshold: this.pctThreshold,
      emphasize: this.emphasize,
    };
  }

  /** Paints the static road network — ground fill, then (once a pct
   * threshold is filtering the view — the hierarchy toy's "top k%" steps)
   * an ultra-faint ghost pass of the FULL, unfiltered network so the
   * retained lines read as a highlighted subset of the remembered whole
   * city rather than fragments in a void, then every visible line (per the
   * current pct threshold), class-weighted width/alpha, major roads
   * (cls >= 2) in `roadMajor`, the rest in `road` (or the CH-blue emphasis
   * family when `emphasize` is set) — choosing between two strategies
   * (§16.10, perf): blit the last crisply-stroked bitmap under the delta
   * between ITS geo state and the current one (cheap, "slightly soft while
   * moving" per the design spec — used WHILE a pan/zoom gesture is actively
   * changing the view) via blitBase, or re-stroke every road line from
   * scratch via strokeBaseCrisp (always correct; what construction/resize/
   * threshold-change/theme-change get, and what the idle-settle timer
   * forces once a gesture has settled). The choice is a plain fingerprint +
   * recency + zoom-delta check — not a separate "interacting" mode flag —
   * so every trigger that must invalidate the cache (theme, resize,
   * hierarchy-filter change) does so structurally, via baseCacheValid's
   * fingerprint no longer matching, rather than needing its own explicit
   * "invalidate" call (see BaseCacheKey/baseCacheValid's own comments).
   * Called on construction, resize, threshold change, every theme change,
   * and every pan/zoom (all four wire into this same method — see each
   * call site's own comment). */
  drawBase(): void {
    const view = this.store.get();
    const key = this.currentBaseKey();
    const recentlyChanged = performance.now() - this.lastViewChangeAt < INTERACTION_IDLE_MS;
    const canBlit =
      recentlyChanged &&
      this.baseBitmap !== null &&
      this.baseCacheView !== null &&
      baseCacheValid(this.baseCacheKey, key) &&
      withinBlitRange(this.baseCacheView.span, view.span, this.blitRatioLimit);
    if (canBlit) this.blitBase(view);
    else this.strokeBaseCrisp();
  }

  /** The "this panel needs a fresh crisp view" path — but not necessarily a
   * fresh STROKE. First checks the shared cross-instance cache (§16.10
   * review round 2 — see the `sharedBaseCache` module comment) for a bitmap
   * a SIBLING panel already stroked at the exact same fingerprint+view this
   * instant, and adopts it (adoptSharedBaseCache) instead of repeating the
   * work on a hit — Compare mode's panels share one ViewStore and (equal
   * css size) an identical fit, so a hit's pixels are guaranteed identical
   * to what THIS instance would otherwise independently stroke. Only on a
   * genuine miss does it actually stroke every visible road line from
   * scratch (identical painting logic to before §16.10 — ground fill,
   * optional ghost pass, class-weighted lines) and capture the
   * freshly-painted canvas as this instance's own interaction-time cache
   * (captureBaseCache, which also PUBLISHES it for the next sibling to
   * adopt) — see drawBase's own comment for when this runs vs. the cheap
   * blitBase path. The only place (together with adoptSharedBaseCache)
   * `baseBitmap`/`baseCacheView`/`baseCacheKey` are written. */
  private strokeBaseCrisp(): void {
    const view = this.store.get();
    const key = this.currentBaseKey();
    const shared = sharedBaseCache.get(baseFingerprintKey(key, view));
    if (shared) {
      this.adoptSharedBaseCache(shared);
      return;
    }
    const ctx = this.baseCtx;
    const colors = themeColors();
    const t = this.currentTransform(); // one derivation for this whole repaint — see currentTransform's own comment
    ctx.save();
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
    ctx.fillStyle = colors.ground;
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (this.pctThreshold !== null) {
      ctx.strokeStyle = colors.road;
      ctx.globalAlpha = GHOST_ALPHA;
      ctx.lineWidth = 1;
      for (const line of this.render.lines) {
        if (this.tracePath(ctx, line, t)) ctx.stroke();
      }
    }
    for (const line of visibleLines(this.render.lines, this.pctThreshold)) {
      const major = line[0] >= 2;
      if (!this.tracePath(ctx, line, t)) continue;
      ctx.strokeStyle = this.emphasize ? colors.ch : (major ? colors.roadMajor : colors.road);
      ctx.globalAlpha = major ? 0.9 : 0.55;
      ctx.lineWidth = (major ? 1.6 : 1) + (this.emphasize ? 0.6 : 0);
      ctx.stroke();
    }
    ctx.restore();
    this.captureBaseCache();
  }

  /** The cross-instance cheap path (§16.10 review round 2): copies a
   * sibling's already-fresh bitmap (found by strokeBaseCrisp via the shared
   * cache) onto both this instance's VISIBLE base canvas and its OWN
   * `baseBitmap`. The second copy matters just as much as the first: this
   * instance's FUTURE blitBase calls read `baseBitmap` directly, so without
   * a private copy of its own, the very next interaction tick would find
   * nothing to blit from and force ANOTHER strokeBaseCrisp call — defeating
   * the §16.10 interaction-time cache for every panel that ever takes this
   * path. Never aliases `shared.bitmap` itself into `this.baseBitmap` — see
   * publishSharedBaseCache's own comment for why that would be unsafe (a
   * later captureBaseCache on THIS instance mutates whatever canvas
   * `baseBitmap` points at, in place). Draws through the SAME dpr-scaled
   * `baseCtx` transform every other paint in this class relies on (see
   * blitBase's own comment) — no explicit setTransform needed here either. */
  private adoptSharedBaseCache(shared: SharedBaseCacheEntry): void {
    const ctx = this.baseCtx;
    ctx.save();
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
    ctx.drawImage(
      shared.bitmap, 0, 0, shared.bitmap.width, shared.bitmap.height,
      0, 0, this.cssWidth, this.cssHeight,
    );
    ctx.restore();
    if (!this.baseBitmap) this.baseBitmap = document.createElement("canvas");
    this.baseBitmap.width = shared.bitmap.width;
    this.baseBitmap.height = shared.bitmap.height;
    const cacheCtx = this.baseBitmap.getContext("2d");
    if (cacheCtx) {
      cacheCtx.setTransform(1, 0, 0, 1, 0, 0);
      cacheCtx.clearRect(0, 0, this.baseBitmap.width, this.baseBitmap.height);
      cacheCtx.drawImage(shared.bitmap, 0, 0);
    }
    this.baseCacheView = shared.view;
    this.baseCacheKey = shared.key;
  }

  /** Copies the base canvas's just-stroked pixels into `baseBitmap`
   * (allocating it on first use) and records the geo ViewState + fingerprint
   * that produced them. A plain device-pixel copy (`drawImage` of the
   * canvas itself, identity transform on the destination) — a pixel-for-
   * pixel snapshot of whatever strokeBaseCrisp just painted, DPR included,
   * so blitBase later needs no DPR math of its own (it draws through the
   * SAME dpr-scaled ctx transform strokeBaseCrisp does). Also PUBLISHES the
   * fresh bitmap to the shared cross-instance cache (§16.10 review round 2 —
   * see that module comment) so a sibling panel with the identical
   * fingerprint can adopt it instead of independently re-stroking. */
  private captureBaseCache(): void {
    if (!this.baseBitmap) this.baseBitmap = document.createElement("canvas");
    this.baseBitmap.width = this.baseCanvas.width;
    this.baseBitmap.height = this.baseCanvas.height;
    const cacheCtx = this.baseBitmap.getContext("2d");
    if (cacheCtx) {
      cacheCtx.setTransform(1, 0, 0, 1, 0, 0);
      cacheCtx.clearRect(0, 0, this.baseBitmap.width, this.baseBitmap.height);
      cacheCtx.drawImage(this.baseCanvas, 0, 0);
    }
    this.baseCacheView = this.store.get();
    this.baseCacheKey = this.currentBaseKey();
    publishSharedBaseCache(this.baseCacheKey, this.baseCacheView, this.baseBitmap);
  }

  /** The cheap path: blits the cached bitmap into the base canvas under the
   * delta between the geo state it was stroked at and `view` (baseBlitRect —
   * the pure geometry, unit-tested in mapRenderer.test.ts), backdropped with
   * a flat ground fill for any margin the cached bitmap doesn't cover this
   * frame (e.g. this tick has zoomed OUT since the cache was taken, so the
   * blit rect is smaller than the viewport). */
  private blitBase(view: ViewState): void {
    if (!this.baseBitmap || !this.baseCacheView) return; // defensive; drawBase's canBlit already checked both
    const ctx = this.baseCtx;
    const colors = themeColors();
    const rect = baseBlitRect(this.baseCacheView, view, this.render.bbox, this.fit, this.cssWidth, this.cssHeight);
    ctx.save();
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
    ctx.fillStyle = colors.ground;
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);
    ctx.drawImage(
      this.baseBitmap, 0, 0, this.baseBitmap.width, this.baseBitmap.height,
      rect.dx, rect.dy, rect.dw, rect.dh,
    );
    ctx.restore();
  }

  clearOverlay(): void {
    this.overlayCtx.clearRect(0, 0, this.cssWidth, this.cssHeight);
  }

  /** Draws `order[0..upto)` sampled every `opts.stride`-th node (see
   * strideFor) as filled dots at `opts.radius`, in `color` — the caller
   * picks `color` per algorithm+theme (e.g. themeColors().dijkstraGlow in
   * dark, .dijkstra in light) since MapView has no notion of "which
   * algorithm". The theme recipe MapView itself owns, when the caller opts
   * in via `opts.additive` ("this cloud should read its own overlap
   * density"): dark composites `lighter` (additive — brighter where dots
   * overlap) at full alpha; light composites `multiply` at a reduced
   * `LIGHT_MULTIPLY_ALPHA` (§16.8 — the light-theme ANALOGUE of dark's glow:
   * overlap reads as DEEPER, not brighter, since an additive `lighter` blend
   * would wash out on a pale ground instead of popping). Light still NEVER
   * blends additively — that half of the original rule is unchanged;
   * `multiply` is a different, non-additive composite chosen specifically
   * because a paper-toned surface darkens legibly under repeated overlap
   * instead of blowing out to white the way `lighter` would. The reduced
   * alpha exists because raw full-alpha multiply overdarkens fast: every dot
   * after the first one or two AT A GIVEN PIXEL is already multiplying
   * against near-black there, so a dense cluster would clip to a flat black
   * blob well before the flood visually finishes — `LIGHT_MULTIPLY_ALPHA`
   * was picked by eye against a real dense race so late-arriving overlap is
   * still visibly deepening instead of clipped (see the G3 report for the
   * comparison this was tuned against). `opts.additive === false` draws
   * plain opaque dots via `source-over`, same as always. Independent of the
   * theme recipe, light nudges the radius up by 0.3 (opaque dots read
   * smaller on paper than glowing ones do at night).
   *
   * Batching (§16.10, perf) is per-composite-mode, not a single blanket
   * "one Path2D for everything": `source-over` (opts.additive === false)
   * really is drawn as ONE Path2D + ONE fill() — a settle-flood is
   * thousands of points per algorithm per frame, and it's the repeated
   * fill() calls that cost, not the path-building, and opaque-over-opaque
   * looks identical whether the overlapping circles are one fill() call or
   * many. `lighter`/`multiply` do NOT get that same one-call treatment: a
   * SINGLE Path2D containing overlapping circles rasterizes them as one
   * UNIONED shape (canvas fill()'s nonzero winding rule doesn't count HOW
   * MANY subpaths cover a pixel, only whether it's covered at all) and
   * composites that one shape against the backdrop exactly ONCE — so a
   * fully-batched `lighter`/`multiply` fill would paint every dot at the
   * SAME flat alpha regardless of overlap, silently deleting the entire
   * density effect this method exists to produce (dark mode's original
   * per-dot brightening depended on EVERY dot getting its OWN fill() call,
   * compositing against whatever earlier dots had already painted there —
   * found by directly sampling rendered pixel data while verifying §16.8,
   * see the G3 report). `additive` dots are instead split across
   * DENSITY_BUCKETS separate Path2Ds/fill() calls (round-robin by draw
   * order — settle order is spatially clustered in short runs, so
   * consecutive, likely-overlapping dots land in DIFFERENT buckets), which
   * keeps the call count small and fixed (DENSITY_BUCKETS per algorithm per
   * frame, not thousands) while restoring real cross-bucket compositing:
   * two overlapping dots land in the same bucket only 1-in-DENSITY_BUCKETS
   * of the time, so most genuine overlap still visibly compounds across the
   * other buckets' fill() calls. `moveTo` before each `arc` starts a fresh
   * subpath per dot (a bare chained `arc()` would implicitly connect the
   * previous dot's end to this one's start with a straight line — since
   * that connector has zero width it wouldn't actually fill any extra
   * pixels either way, but starting fresh is the standard, unambiguous way
   * to batch unrelated circles into one path). */
  drawDots(
    order: Uint32Array, upto: number, lon: Float64Array, lat: Float64Array,
    color: string, opts: { additive: boolean; radius: number; stride: number },
  ): void {
    const ctx = this.overlayCtx;
    const t = this.currentTransform(); // one derivation for this whole batch — see currentTransform's own comment
    const dark = effectiveTheme() === "dark";
    const radius = dark ? opts.radius : opts.radius + 0.3;
    const stride = Math.max(1, opts.stride);
    const n = Math.min(upto, order.length);
    ctx.save();
    ctx.fillStyle = color;
    if (opts.additive) {
      ctx.globalCompositeOperation = dark ? "lighter" : "multiply";
      ctx.globalAlpha = dark ? 1 : LIGHT_MULTIPLY_ALPHA;
      const buckets: Path2D[] = [];
      for (let b = 0; b < DENSITY_BUCKETS; b++) buckets.push(new Path2D());
      let b = 0;
      for (let i = 0; i < n; i += stride) {
        const node = order[i];
        const [x, y] = projectPoint(this.render.bbox, t, lon[node], lat[node]);
        const bucket = buckets[b % DENSITY_BUCKETS];
        bucket.moveTo(x + radius, y);
        bucket.arc(x, y, radius, 0, Math.PI * 2);
        b++;
      }
      for (const bucket of buckets) ctx.fill(bucket);
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      const path = new Path2D();
      for (let i = 0; i < n; i += stride) {
        const node = order[i];
        const [x, y] = projectPoint(this.render.bbox, t, lon[node], lat[node]);
        path.moveTo(x + radius, y);
        path.arc(x, y, radius, 0, Math.PI * 2);
      }
      ctx.fill(path);
    }
    ctx.restore();
  }

  /** Draws the shared shortest route (a sequence of node indices) as a
   * single stroked path in the theme's route color. `opts.dashed` (default
   * false; spec §18.4, Compare mode): true strokes the SAME route colour
   * and width with a dash pattern instead of a solid line — the visual
   * echo of a disclosed variant's own numeric "+X% longer route" row, so
   * "not the shortest" reads from the route itself at a glance, without
   * changing identity colour (that stays panel/theme-derived either way —
   * only the stroke PATTERN carries the honesty signal, same principle as
   * this app's other route-colour rule: identity never encodes correctness).
   * Never passed for the overlay's own single shared route, which is
   * always the true optimal path (see controller.ts's run()) — only a
   * Compare-mode panel's OWN racer route can legitimately be the longer
   * one. Dash unit [8, 6] scales this route's 2.4px stroke up from
   * toytownView's own precedent for "dashed = not the direct/expected
   * line" (styles.css's `.edge-line.edge-oneway { stroke-dasharray: 5 4 }`
   * at a 1.6px stroke — same ~3:1 dash:stroke-width ratio, rounded to
   * clean canvas units). `ctx.restore()` below reverts the dash list too
   * (canvas state), so no separate reset is needed between calls. */
  drawRoute(path: number[], lon: Float64Array, lat: Float64Array, opts?: { dashed?: boolean }): void {
    if (path.length < 2) return;
    const ctx = this.overlayCtx;
    const colors = themeColors();
    const t = this.currentTransform(); // one derivation for this whole path — see currentTransform's own comment
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = colors.route;
    ctx.lineWidth = 2.4;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    if (opts?.dashed) ctx.setLineDash([8, 6]);
    ctx.beginPath();
    const [x0, y0] = projectPoint(this.render.bbox, t, lon[path[0]], lat[path[0]]);
    ctx.moveTo(x0, y0);
    for (let i = 1; i < path.length; i++) {
      const [x, y] = projectPoint(this.render.bbox, t, lon[path[i]], lat[path[i]]);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  /** Draws pin `label` ("A" or "B") as a disc + letter, entirely
   * theme-sourced (read fresh from `themeColors()` on every call, so a
   * theme switch is correct on the very next draw, mid-race included): disc
   * = `ink`, letter = `ground` — `ink`/`ground` are each theme's own
   * validated contrast pair (design spec "Surfaces & ink"), so this inverts
   * sensibly instead of just re-coloring — dark theme gets a near-white
   * disc with a near-black letter (matching the original fixed design),
   * light theme gets a near-black disc with a near-white letter (the
   * inversion that actually reads against light theme's near-white
   * ground/panel, unlike a literal white disc would). The ring is `ground`
   * again at reduced `globalAlpha` (a translucent DERIVATION of a theme
   * token via the canvas API's own alpha channel, not a hardcoded
   * rgba literal) — a soft halo in the opposite tone from the disc that
   * separates the pin from the road lines under it, in either theme. */
  drawPin(lonV: number, latV: number, label: "A" | "B"): void {
    const ctx = this.overlayCtx;
    const colors = themeColors();
    const [x, y] = this.project(lonV, latV);
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.fillStyle = colors.ink;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = colors.ground;
    ctx.globalAlpha = 0.4;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = colors.ground;
    ctx.font = "bold 11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x, y);
    ctx.restore();
  }
}
