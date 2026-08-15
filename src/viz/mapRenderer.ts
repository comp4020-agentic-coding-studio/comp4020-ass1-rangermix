// Theme-aware canvas map renderer over public/data/render.json's road-line
// artifact. Split deliberately into two halves:
//
//   1. Pure geometry/data functions (fitTransform, composeView, zoomAbout,
//      clampPan, projectPoint/unprojectPoint, decodeLine, visibleLines,
//      strideFor) — no DOM, no canvas, fully unit-tested in
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
 * alone, or a fit composed with a view state via composeView — this
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

/** A user-driven view transform composed ON TOP of the fitted transform
 * (see composeView): `scale` multiplies the fit's own scale (clamped to
 * [1, 8]), `tx`/`ty` are an additional screen-space pan offset in CSS px,
 * applied AFTER the fit's own scale (so panning by 10px always moves the
 * view by 10 screen px regardless of zoom level). The identity view (no
 * zoom, no pan) is `{ scale: 1, tx: 0, ty: 0 }` — what a freshly
 * constructed or resetView()'d MapView starts at. */
export interface ViewState {
  scale: number;
  tx: number;
  ty: number;
}

const MIN_VIEW_SCALE = 1;
const MAX_VIEW_SCALE = 8;

function clampViewScale(s: number): number {
  return Math.min(MAX_VIEW_SCALE, Math.max(MIN_VIEW_SCALE, s));
}

/** Composes the fitted (geo -> screen) transform with a user ViewState
 * into one effective Transform, so project()/unproject() have exactly one
 * transform to apply/invert — the caller never reasons about "fit then
 * view" as two separate steps. View-space screen coords are fit-space
 * screen coords scaled by `view.scale` then offset by `(view.tx,
 * view.ty)`: `screenView = screenFit * view.scale + (tx, ty)`. Composing
 * two transforms of this scale+offset shape yields another transform of
 * the exact same shape, which is what makes reusing projectPoint/
 * unprojectPoint unchanged (just fed a composed Transform) correct,
 * rather than needing separate "apply the view on top" code paths. */
export function composeView(fit: Transform, view: ViewState): Transform {
  return {
    scale: fit.scale * view.scale,
    ox: fit.ox * view.scale + view.tx,
    oy: fit.oy * view.scale + view.ty,
  };
}

/** Anchor-preserving zoom: returns the ViewState after scaling `view` by
 * `factor` (>1 zooms in, <1 zooms out) about the SCREEN point `(cx, cy)`
 * in CSS px — whatever geo point currently renders at `(cx, cy)` renders
 * at `(cx, cy)` again after the zoom (the invariant mapRenderer.test.ts
 * checks directly). The resulting scale is clamped to [1, 8]; if the
 * clamped scale lands exactly at the minimum (fully zoomed out), tx/ty
 * reset to 0 instead of preserving the anchor through that transition —
 * "zoomed all the way out" is the canonical home position regardless of
 * where the anchor was, not wherever the anchor math would otherwise leave
 * the pan. That reset is the one deliberate exception to anchor
 * preservation; everywhere else — including when the top clamp at scale 8
 * kicks in — the anchor math runs against whatever the actual post-clamp
 * scale turns out to be, so the invariant still holds exactly. Deliberately
 * does NOT also run clampPan's pan-bounds clamp here: doing so could move
 * tx/ty away from the anchor-preserving values computed below, breaking
 * the exact invariant this function exists to guarantee. Pan bounds are
 * panBy's job, not zoomAt's (see clampPan's own comment). */
export function zoomAbout(view: ViewState, cx: number, cy: number, factor: number): ViewState {
  const newScale = clampViewScale(view.scale * factor);
  if (newScale === MIN_VIEW_SCALE) return { scale: MIN_VIEW_SCALE, tx: 0, ty: 0 };
  const ratio = newScale / view.scale;
  return { scale: newScale, tx: cx - (cx - view.tx) * ratio, ty: cy - (cy - view.ty) * ratio };
}

// The design spec's pan-clamp contract: "the fitted content never fully
// leaves the viewport — keep >= 25% visible each axis" (build-review
// amendment §14.2), enforced against the TRUE fitted content rect, not the
// viewport's own size as a stand-in for it (a prior version used the
// viewport size directly, which silently counted a fit's own ox/oy slack —
// often the majority of the viewport on the non-limiting axis for a bbox as
// tall/narrow as Canberra's — as if it were content, letting one ordinary
// drag pan the network to ~0% visible; see clampPan's own comment for the
// fix and mapRenderer.test.ts's realistic-fit cases for the regression
// coverage).
const MIN_VISIBLE_FRACTION = 0.25;

/** Clamps `view`'s pan so the fitted content can't slide fully out of a
 * `viewportW` x `viewportH` viewport — see the MIN_VISIBLE_FRACTION comment
 * above for the exact contract: at least `MIN_VISIBLE_FRACTION` of the
 * CONTENT rect's own size (not the viewport's) stays inside the viewport,
 * per axis. `fit` locates the TRUE fitted content rect: at view-scale 1 it
 * spans `[fit.ox, fit.ox + contentSize]` in screen space on each axis,
 * where `contentSize` is recovered from `fit.ox`/`fit.oy` alone via the
 * identity `contentSize = viewportSize - 2*off` — algebraically exact from
 * fitTransform's own centering (`ox = pad + (availW - mapW*scale) / 2`
 * implies `w - 2*ox = mapW*scale`, the true fitted content width; same
 * derivation for oy/height), so there's no need to separately thread
 * fitTransform's internal mapW/mapH through this function. That content
 * rect is then transformed by `view` exactly as composeView does (`screen =
 * fitSpace * view.scale + (tx, ty)`), giving the content's view-space edge
 * `contentStart = off*view.scale + t`. The valid range for `contentStart`
 * is content-size-relative, NOT viewport-size-relative — solving
 * `overlap(contentStart) >= MIN_VISIBLE_FRACTION * contentSize` for each
 * sliding-off-one-side case gives `min = -(1 - MIN_VISIBLE_FRACTION) *
 * contentSize` (content sliding off the start edge) and `max = viewportSize
 * - MIN_VISIBLE_FRACTION * contentSize` (content sliding off the end edge);
 * these only reduce to the viewport-relative-looking `[0.25*size -
 * contentSize, 0.75*size]` shape when `contentSize === size` (no fit slack,
 * no zoom) — a prior version used that reduced shape unconditionally, which
 * over-clamps when content is narrower than the viewport (fit slack, e.g.
 * Canberra's tall/narrow bbox in a wide viewport) and under-clamps when
 * content is wider (any real zoom), so it's wrong on both sides of scale 1
 * once `fit`'s true slack is accounted for at all. Used by panBy (drag-pan,
 * wheel-drag, pinch-pan) and resize (re-clamping a pan that a
 * viewport-size change left stale); deliberately NOT applied inside zoomAt
 * (see zoomAbout's own comment on why). Assumes `view.scale >=
 * MIN_VIEW_SCALE` (1), so a real clamp interval always exists on both
 * axes (in fact `min <= max` holds for any non-negative size/contentSize). */
/** A tiny observable holding ONE shared user view — the mechanism build-
 * review amendment §14.3's Compare mode is built on: pan/zoom in ANY panel
 * (or the overlay map) moves every panel, because every MapView sharing a
 * store recomposes/redraws off the same `get()`/`subscribe()` pair rather
 * than owning a private ViewState of its own. Deliberately minimal — no
 * middleware, no selectors, `set()` always replaces the whole ViewState —
 * because the only thing ever stored is a ViewState and the only consumer
 * is MapView. `subscribe()` does NOT fire on registration, only on a LATER
 * `set()` (matches theme.ts's onThemeChange: register-then-wait, not
 * register-then-replay), and — unlike onThemeChange — returns a REAL
 * unsubscribe function; MapView.dispose() depends on that (see its own
 * comment for why: a Compare panel gets constructed and discarded
 * repeatedly, which theme.ts's existing callers never did). */
export interface ViewStore {
  get(): ViewState;
  set(view: ViewState): void;
  subscribe(cb: (view: ViewState) => void): () => void;
}

/** Creates a ViewStore, defaulting to the identity view (no zoom, no pan —
 * the same starting state a standalone MapView has always used). A MapView
 * constructed with no explicit store creates its own private one via this
 * same function, so single-instance callers (the /how/ toys) are unaffected
 * — sharing a store is opt-in, by passing the SAME store instance to every
 * MapView that should move together. */
export function createViewStore(initial: ViewState = { scale: 1, tx: 0, ty: 0 }): ViewStore {
  let state = initial;
  const listeners = new Set<(view: ViewState) => void>();
  return {
    get: () => state,
    set(next) {
      state = next;
      for (const cb of listeners) cb(state);
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

export function clampPan(
  view: ViewState, fit: Transform, viewportW: number, viewportH: number,
): ViewState {
  const clampAxis = (t: number, off: number, size: number): number => {
    const contentSize = (size - 2 * off) * view.scale;
    const contentStart = off * view.scale + t; // true content edge, view-space px
    const min = -(1 - MIN_VISIBLE_FRACTION) * contentSize;
    const max = size - MIN_VISIBLE_FRACTION * contentSize;
    const clampedStart = Math.min(max, Math.max(min, contentStart));
    return clampedStart - off * view.scale;
  };
  return {
    scale: view.scale,
    tx: clampAxis(view.tx, fit.ox, viewportW),
    ty: clampAxis(view.ty, fit.oy, viewportH),
  };
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

const PAD = 24; // px of margin fitTransform keeps around the fitted bbox

// Ghost-underlay alpha for the hierarchy toy's filtered steps (round 4 fix):
// once a pct threshold hides most of the network, the retained lines alone
// read as fragments floating in a void — drawing the FULL network first, at
// this near-invisible alpha, gives the eye the remembered shape of the
// whole city to read the highlighted subset against. `--road`'s own alpha
// (0.55, used for the unfiltered base layer) would still swamp the
// emphasis; this sits an order of magnitude fainter, per spec (0.05-0.08).
const GHOST_ALPHA = 0.07;

/** Owns the two stacked canvases the home page's race (and /how/'s
 * hierarchy toy, which reuses the same data) paint into: `base` is the
 * static road network, redrawn only on resize/theme-change/threshold
 * change; `overlay` is the per-frame settle-flood/route/pins layer the
 * caller (RaceController, Task 8) drives directly. MapView never redraws
 * the overlay on its own — replay state lives in the caller, not here (see
 * design spec §8: "Canvases re-render on theme change, including mid-race
 * — replay state lives in data") — so after a theme change flips the base
 * layer's colors automatically, the caller re-invokes clearOverlay/
 * drawDots/drawRoute/drawPin with whatever frame it was already showing;
 * those four methods ARE that redraw hook.
 *
 * Build-review §14.3 (Compare mode): the user's pan/zoom `ViewState` now
 * lives in an external `ViewStore` (see createViewStore above), not a
 * private field — every MapView constructed against the SAME store
 * recomposes/redraws whenever ANY of them (or a caller calling `store.set`
 * directly) changes it, which is the entire mechanism behind "pan/zoom in
 * one Compare panel moves every panel". A MapView constructed with no
 * `store` argument creates its own private one (createViewStore's own
 * default), so every pre-existing single-instance caller (the /how/ toys)
 * is unaffected. Because Compare panels are constructed and discarded
 * repeatedly (unlike every prior MapView caller, which built exactly one
 * for the page's lifetime), call `dispose()` when discarding one — see
 * that method's own comment for what it does and does not fully unhook. */
export class MapView {
  private readonly baseCanvas: HTMLCanvasElement;
  private readonly overlayCanvas: HTMLCanvasElement;
  private readonly baseCtx: CanvasRenderingContext2D;
  private readonly overlayCtx: CanvasRenderingContext2D;
  private render: RenderData;
  // `fit` is the raw geo->screen fit (recomputed on every resize()); the
  // user's pan/zoom state lives in `store` (shared, possibly with other
  // MapView instances — see the class doc comment), composed with `fit` on
  // top of it into `transform` (see recompose()) — project()/unproject()
  // only ever touch `transform`, never `fit`/the store directly, so they
  // stay correct whichever changed most recently (a resize, or a
  // zoomAt/panBy/resetView call from THIS instance or a sibling sharing
  // the same store).
  private fit: Transform = { scale: 1, ox: 0, oy: 0 };
  private readonly store: ViewStore;
  private readonly unsubscribeStore: () => void;
  // Guards the onThemeChange callback below post-dispose (see dispose()'s
  // own comment: theme.ts's onThemeChange has no matching "off", so this
  // flag is what actually stops the redraw cost on a disposed instance).
  private disposed = false;
  private transform: Transform = { scale: 1, ox: 0, oy: 0 };
  private readonly viewChangeListeners: (() => void)[] = [];
  private pctThreshold: number | null = null;
  private emphasize = false;
  private dpr = 1;
  private cssWidth = 0;
  private cssHeight = 0;

  constructor(base: HTMLCanvasElement, overlay: HTMLCanvasElement, render: RenderData, store?: ViewStore) {
    this.baseCanvas = base;
    this.overlayCanvas = overlay;
    this.render = render;
    const baseCtx = base.getContext("2d");
    const overlayCtx = overlay.getContext("2d");
    if (!baseCtx || !overlayCtx) throw new Error("MapView: 2D canvas context unavailable");
    this.baseCtx = baseCtx;
    this.overlayCtx = overlayCtx;
    this.store = store ?? createViewStore();
    // Fires on every `store.set()` from ANY sharer of this store, this
    // instance's own zoomAt/panBy/resetView included (they go through
    // `store.set` too, see below) — so recompose+drawBase+fireViewChange
    // has exactly one call site regardless of who originated the change.
    this.unsubscribeStore = this.store.subscribe(() => {
      if (this.disposed) return;
      this.recompose();
      this.drawBase();
      this.fireViewChange();
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
   * isn't in this task's edit list. */
  dispose(): void {
    this.disposed = true;
    this.unsubscribeStore();
  }

  /** Re-reads each canvas's CSS box size, re-allocates its backing store at
   * the (capped) device pixel ratio, recomputes the fitted projection,
   * re-clamps the existing pan/zoom against the new size (a resize or
   * orientation change can otherwise strand a pan that was valid a moment
   * ago off-screen — build-review finding; see clampPan's call below), and
   * repaints the base layer — safe to call from a ResizeObserver as often
   * as layout changes; also called once by the constructor so a freshly
   * constructed MapView is never left blank. Does NOT itself fire
   * onViewChange: the caller's ResizeObserver hook already re-syncs the
   * overlay right after calling resize() (see home.ts), same as it always
   * has for the backing-store-reallocation-blanks-the-overlay case.
   *
   * The re-clamp goes through `store.set` like every other view mutation
   * (see the class doc comment), so on a SHARED store a resize of ANY one
   * panel that actually moves the clamped view moves every sibling too —
   * accepted as-is for Compare mode: panels in the same grid resize
   * together in practice (a window resize or a panel-count change reflows
   * all of them at once), so this settles rather than fights. If the clamp
   * is a no-op (nothing to re-clamp), the store never fires, which is why
   * `recompose()`/`drawBase()` are still called explicitly below — resize()
   * must repaint at the new `fit` either way, not only when the store
   * happens to change. */
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
    this.store.set(clampPan(this.store.get(), this.fit, this.cssWidth, this.cssHeight));
    this.recompose();
    this.drawBase();
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

  private recompose(): void {
    this.transform = composeView(this.fit, this.store.get());
  }

  private fireViewChange(): void {
    for (const cb of this.viewChangeListeners) cb();
  }

  /** Registers `cb` to run after every zoomAt/panBy/resetView call (the
   * base layer has already been redrawn by then, at the new projection) —
   * the caller's hook for re-rendering whatever it owns on the OVERLAY
   * (pins, and — mid-race — the current settle-flood/route frame), since
   * MapView itself only ever owns the base layer's redraw (see this
   * class's own doc comment on why the overlay redraw is always the
   * caller's job). Multiple listeners supported (array, same pattern as
   * theme.ts's onThemeChange) though home.ts currently registers just one. */
  onViewChange(cb: () => void): void {
    this.viewChangeListeners.push(cb);
  }

  /** Zooms by `factor` anchored at the screen point `(cx, cy)` in CSS px
   * (see zoomAbout for the anchor-preserving math, the [1,8] scale clamp,
   * and the zoomed-all-the-way-out reset) — wheel, pinch, and the +/-
   * buttons all funnel through this one method. Writes the new view to the
   * shared store; the store's own subscription (registered in the
   * constructor) is what actually redraws the base layer and notifies
   * onViewChange listeners — for THIS instance and, on a shared store,
   * every sibling too (see the class doc comment: that fan-out IS Compare
   * mode's pan/zoom sync). */
  zoomAt(cx: number, cy: number, factor: number): void {
    this.store.set(zoomAbout(this.store.get(), cx, cy, factor));
  }

  /** Pans the view by `(dx, dy)` CSS px, clamped so the fitted content can
   * never fully leave the viewport (see clampPan), then writes the result
   * to the shared store — same fan-out as zoomAt above. */
  panBy(dx: number, dy: number): void {
    const view = this.store.get();
    this.store.set(
      clampPan({ scale: view.scale, tx: view.tx + dx, ty: view.ty + dy }, this.fit, this.cssWidth, this.cssHeight),
    );
  }

  /** Returns to the identity view (no zoom, no pan) — the same state a
   * freshly constructed MapView starts at — via the shared store, same
   * fan-out as zoomAt/panBy. */
  resetView(): void {
    this.store.set({ scale: 1, tx: 0, ty: 0 });
  }

  /** Geo -> screen, through the fit+view composed transform (fit alone
   * when the view is at identity) — every draw call (drawBase, drawDots,
   * drawRoute, drawPin) and every caller's own hit-testing (home.ts's
   * pinNear) goes through this one method, so zoom/pan is correct
   * everywhere for free once `transform` is right. */
  project(lon: number, lat: number): [number, number] {
    return projectPoint(this.render.bbox, this.transform, lon, lat);
  }

  /** Screen -> geo, the exact inverse of project() against the same
   * composed transform — home.ts uses this for pin-drag snapping and pan
   * math correctly at any zoom level. */
  unproject(x: number, y: number): [number, number] {
    return unprojectPoint(this.render.bbox, this.transform, x, y);
  }

  /** Traces one render.json line into `ctx`'s current path (decode + project
   * + moveTo/lineTo) without touching stroke style — the caller sets
   * strokeStyle/lineWidth/globalAlpha and calls `stroke()`. Returns false
   * (nothing traced) for a degenerate single-point line, matching the old
   * inline `if (pts.length < 2) continue`. Shared by drawBase's ghost pass
   * and its retained-lines pass so the decode/project walk exists once. */
  private tracePath(ctx: CanvasRenderingContext2D, line: number[]): boolean {
    const pts = decodeLine(line, this.render.bbox);
    if (pts.length < 2) return false;
    ctx.beginPath();
    const [x0, y0] = this.project(pts[0][0], pts[0][1]);
    ctx.moveTo(x0, y0);
    for (let i = 1; i < pts.length; i++) {
      const [x, y] = this.project(pts[i][0], pts[i][1]);
      ctx.lineTo(x, y);
    }
    return true;
  }

  /** Paints the static road network: ground fill, then (once a pct
   * threshold is filtering the view — the hierarchy toy's "top k%" steps)
   * an ultra-faint ghost pass of the FULL, unfiltered network so the
   * retained lines read as a highlighted subset of the remembered whole
   * city rather than fragments in a void, then every visible line (per the
   * current pct threshold), class-weighted width/alpha, major roads
   * (cls >= 2) in `roadMajor`, the rest in `road` (or the CH-blue emphasis
   * family when `emphasize` is set). Called on construction, resize,
   * threshold change, and automatically on every theme change (subscribed
   * in the constructor). */
  drawBase(): void {
    const ctx = this.baseCtx;
    const colors = themeColors();
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
        if (this.tracePath(ctx, line)) ctx.stroke();
      }
    }
    for (const line of visibleLines(this.render.lines, this.pctThreshold)) {
      const major = line[0] >= 2;
      if (!this.tracePath(ctx, line)) continue;
      ctx.strokeStyle = this.emphasize ? colors.ch : (major ? colors.roadMajor : colors.road);
      ctx.globalAlpha = major ? 0.9 : 0.55;
      ctx.lineWidth = (major ? 1.6 : 1) + (this.emphasize ? 0.6 : 0);
      ctx.stroke();
    }
    ctx.restore();
  }

  clearOverlay(): void {
    this.overlayCtx.clearRect(0, 0, this.cssWidth, this.cssHeight);
  }

  /** Draws `order[0..upto)` sampled every `opts.stride`-th node (see
   * strideFor) as filled dots at `opts.radius`, in `color` — the caller
   * picks `color` per algorithm+theme (e.g. themeColors().dijkstraGlow in
   * dark, .dijkstra in light) since MapView has no notion of "which
   * algorithm". The theme recipe MapView itself owns: dark blends dots
   * additively ("lighter", if the caller asked for it via opts.additive —
   * light NEVER blends additively, since glow washes out on paper per the
   * design spec) and light nudges the radius up by 0.3 (opaque dots read
   * smaller on paper than glowing ones do at night). */
  drawDots(
    order: Uint32Array, upto: number, lon: Float64Array, lat: Float64Array,
    color: string, opts: { additive: boolean; radius: number; stride: number },
  ): void {
    const ctx = this.overlayCtx;
    const dark = effectiveTheme() === "dark";
    ctx.save();
    ctx.globalCompositeOperation = dark && opts.additive ? "lighter" : "source-over";
    ctx.fillStyle = color;
    const radius = dark ? opts.radius : opts.radius + 0.3;
    const stride = Math.max(1, opts.stride);
    const n = Math.min(upto, order.length);
    for (let i = 0; i < n; i += stride) {
      const node = order[i];
      const [x, y] = this.project(lon[node], lat[node]);
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Draws the shared shortest route (a sequence of node indices) as a
   * single stroked path in the theme's route color. */
  drawRoute(path: number[], lon: Float64Array, lat: Float64Array): void {
    if (path.length < 2) return;
    const ctx = this.overlayCtx;
    const colors = themeColors();
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = colors.route;
    ctx.lineWidth = 2.4;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    const [x0, y0] = this.project(lon[path[0]], lat[path[0]]);
    ctx.moveTo(x0, y0);
    for (let i = 1; i < path.length; i++) {
      const [x, y] = this.project(lon[path[i]], lat[path[i]]);
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
