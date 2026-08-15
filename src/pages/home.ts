// Boot script for the home page (/): wires the theme toggle, loads the
// committed render + routing artifacts, paints the base map layer, and
// (Task 8) wires the actual race — pins, presets, keyboard, and the
// RaceController that drives worker compute + canvas replay + scoreboard.
//
// Two independent copies of the routing graph load: this file's own (for
// nearestNode snapping and drawing, both needed synchronously on the main
// thread on every click/drag) and RaceController's own internal copy (for
// its worker, which can't share objects across the thread boundary, and for
// its own draw calls). Both hit the same relative URL, so the second is a
// cheap cache hit in any real browser — the alternative (threading a graph
// reference through RaceController's frozen two-argument constructor) isn't
// available.

import { initTheme } from "../theme";
import { loadRender, loadRouting } from "../data";
import { createViewStore, MapView, type RenderData } from "../viz/mapRenderer";
import { haversine, nearestNode } from "../snap";
import { PRESETS } from "../presets";
import { ALGO_LABEL, RaceController, type ComparePanel, type RaceUi, formatMs } from "../race/controller";
import { makeRaceScheduler } from "../race/scheduler";
import type { Graph } from "../algos/graph";
import type { Algo } from "../race/worker";

const DEBOUNCE_MS = 250;
const AUTO_RUN_MS = 1500;
const DRAG_HIT_PX = 24; // build-review amendment §14.1's own "24 px grab radius"
const SURPRISE_MIN_M = 8000;
const SURPRISE_MAX_TRIES = 50;
const WHEEL_ZOOM_BASE = 1.0015; // factor per wheel event = WHEEL_ZOOM_BASE ** -deltaY
const BUTTON_ZOOM_FACTOR = 1.4; // one +/- button click's zoom step

/** The AUTO_RUN_MS idle timer's fire condition: both pins must be placed,
 * returned as the pinned pair (or `null` if either still isn't) so the
 * caller never re-checks nullness itself. Motion preference does NOT gate
 * this — design spec §5.1 state 2 says the auto-run is "skipped under
 * prefers-reduced-motion, replaced by the final still + numbers", i.e.
 * reduced motion swaps out the ANIMATION, not the race itself.
 * RaceController.run() already renders straight to the final frame with no
 * rAF loop when `matchMedia("(prefers-reduced-motion: reduce)").matches`
 * (see controller.ts's `isReducedMotion()`/`animate()` split), so the
 * auto-run below reuses that exact path via the same `scheduler.now()` a
 * manual trigger uses — motion preference only changes how the race is
 * DRAWN, not whether or when it runs. Pure and exported so this one
 * decision is unit-testable without a real timer/DOM/matchMedia. */
export function autoRunPins(pinA: number | null, pinB: number | null): [number, number] | null {
  return pinA !== null && pinB !== null ? [pinA, pinB] : null;
}

export interface PanelDiff {
  keep: Algo[];
  add: Algo[];
  remove: Algo[];
}

/** Diffs the CURRENT Compare-mode panel algos (in their existing order)
 * against the NEXT desired active-racer set (RaceController.
 * getActiveRoster(), already ROSTER-ordered) so a racer toggle or a
 * view-mode switch only creates/destroys the panels that actually changed,
 * instead of tearing down and rebuilding the whole grid every time (build-
 * review §14.3). Pure (no DOM) so the add/keep/remove set logic is
 * exhaustively unit-testable on its own — syncPanels() inside boot() is the
 * thin, untested-here DOM consumer (same pure/DOM split every other piece
 * of this file and this repo already uses). `keep`/`remove` preserve
 * CURRENT's own order; `add` preserves NEXT's own order — a plain
 * set-membership diff, not a re-sort. */
export function diffPanels(current: Algo[], next: Algo[]): PanelDiff {
  const nextSet = new Set(next);
  const currentSet = new Set(current);
  return {
    keep: current.filter((a) => nextSet.has(a)),
    add: next.filter((a) => !currentSet.has(a)),
    remove: current.filter((a) => !nextSet.has(a)),
  };
}

interface PanelEntry {
  algo: Algo;
  el: HTMLElement;
  view: MapView;
}

interface PanelDom {
  el: HTMLElement;
  base: HTMLCanvasElement;
  overlay: HTMLCanvasElement;
  zoomIn: HTMLButtonElement;
  zoomOut: HTMLButtonElement;
}

/** Builds one Compare-mode panel's DOM (build-review §14.3): a base+overlay
 * canvas pair (a MapView subscribing to the shared store draws into these —
 * wired up by syncPanels, not here; this function is pure DOM construction,
 * no listeners), a corner label chip (racer name + a dot in its chart hue
 * token, same [data-algo] convention the scoreboard rows already use — kept
 * as a dot rather than coloring the name text itself so bidirectional's hue,
 * which the design spec's own palette notes fails AA contrast as small text
 * on light surfaces, never carries the label alone; the settled-count span
 * starts empty and is filled by RaceUi.setRow once a race completes, same
 * single code path that fills the scoreboard row), and its own zoom in/out
 * buttons — F2's interactions must work identically inside every panel,
 * zoom buttons included, so every panel gets a real, independently
 * labelled pair rather than sharing the single map's buttons. */
function buildPanelDom(algo: Algo): PanelDom {
  const el = document.createElement("div");
  el.className = "compare-panel";
  el.dataset.algo = algo;

  const base = document.createElement("canvas");
  const overlay = document.createElement("canvas");
  el.append(base, overlay);

  const chip = document.createElement("div");
  chip.className = "panel-chip";
  chip.dataset.algo = algo;
  const name = document.createElement("span");
  name.className = "panel-name";
  name.textContent = ALGO_LABEL[algo];
  const count = document.createElement("span");
  count.className = "panel-count";
  chip.append(name, count);
  el.append(chip);

  const zoomWrap = document.createElement("div");
  zoomWrap.className = "zoom-controls";
  const zoomIn = document.createElement("button");
  zoomIn.type = "button";
  zoomIn.className = "zoom-btn";
  zoomIn.textContent = "+";
  zoomIn.setAttribute("aria-label", `Zoom in (${ALGO_LABEL[algo]})`);
  const zoomOut = document.createElement("button");
  zoomOut.type = "button";
  zoomOut.className = "zoom-btn";
  zoomOut.textContent = "−";
  zoomOut.setAttribute("aria-label", `Zoom out (${ALGO_LABEL[algo]})`);
  zoomWrap.append(zoomIn, zoomOut);
  el.append(zoomWrap);

  return { el, base, overlay, zoomIn, zoomOut };
}

// Compare-mode persistence (build-review §14.3) — same guarded try/catch
// pattern as theme.ts's own safeGetItem/safeSetItem (private-mode/storage-
// disabled browsers throw on ANY localStorage access): view-mode cycling
// still works in-memory even when persistence can't happen.
const VIEW_KEY = "hth-view";

function loadViewMode(): "overlay" | "compare" {
  try {
    return localStorage.getItem(VIEW_KEY) === "compare" ? "compare" : "overlay";
  } catch {
    return "overlay";
  }
}

function saveViewMode(mode: "overlay" | "compare"): void {
  try {
    localStorage.setItem(VIEW_KEY, mode);
  } catch {
    /* storage unavailable — cycling still works in-memory */
  }
}

function boot(): void {
  initTheme();

  const baseCanvas = document.getElementById("map-base");
  const overlayCanvas = document.getElementById("map-overlay");
  const stack = document.querySelector('[data-testid="race-canvas"]');
  const mapFrame = document.querySelector<HTMLElement>(".map-frame");
  const compareGrid = document.querySelector<HTMLElement>('[data-testid="compare-panels"]');
  const loadNote = document.getElementById("load-note");
  const raceRunBtn = document.querySelector<HTMLButtonElement>('[data-testid="race-run"]');
  const astarChip = document.querySelector<HTMLButtonElement>('[data-testid="algo-astar"]');
  const bidiChip = document.querySelector<HTMLButtonElement>('[data-testid="algo-bidi"]');
  const zoomInBtn = document.querySelector<HTMLButtonElement>('[data-testid="zoom-in"]');
  const zoomOutBtn = document.querySelector<HTMLButtonElement>('[data-testid="zoom-out"]');
  const viewToggleBtn = document.querySelector<HTMLButtonElement>('[data-testid="view-toggle"]');

  if (
    !(baseCanvas instanceof HTMLCanvasElement) ||
    !(overlayCanvas instanceof HTMLCanvasElement)
  ) {
    return;
  }

  // ONE store for the whole page (build-review §14.3): the overlay's own
  // MapView and every Compare panel's MapView are constructed against this
  // SAME store, so a pan/zoom gesture from any one of them moves all of
  // them — see mapRenderer.ts's ViewStore/MapView doc comments for the
  // mechanism.
  const viewStore = createViewStore();
  let view: MapView | undefined;
  let controller: RaceController | undefined;
  let graph: Graph | undefined;
  let renderData: RenderData | undefined;
  let pinA: number | null = null;
  let pinB: number | null = null;
  let viewMode: "overlay" | "compare" = loadViewMode();
  let panels: PanelEntry[] = [];

  // A race's own promise rejecting means the WORKER told us it failed (see
  // worker.ts's onmessage catch + controller.ts's dispatchResponse) — the
  // one non-silent failure mode this page has. Surface it honestly (same
  // "reload to retry" voice as the initial-load failure below) and stop
  // offering a control that can't work until the page is reloaded.
  function handleRaceError(err: unknown): void {
    console.error("race failed", err);
    if (loadNote) {
      loadNote.hidden = false;
      loadNote.textContent = "route engine failed — reload to retry";
    }
    if (raceRunBtn) raceRunBtn.disabled = true;
  }

  // Single entry point for "a race should happen now or soon": DIRECT
  // triggers (Race button, presets, "R", auto-run) call `scheduler.now()`;
  // pin drag/tap call `scheduler.schedule()` — see src/race/scheduler.ts's
  // own comment for why `now()` cancelling any pending `schedule()` is the
  // fix for a stale debounced race silently overwriting a newer direct one.
  const scheduler = makeRaceScheduler((a, b) => {
    controller?.run(a, b).catch(handleRaceError);
  }, DEBOUNCE_MS);

  function scheduleRace(): void {
    if (pinA === null || pinB === null) return;
    scheduler.schedule(pinA, pinB);
  }

  // Which views a caller should draw pins/frames onto right now: the single
  // overlay `view` in overlay mode, or every active Compare panel's own
  // view in Compare mode — the one place "which views are live" is decided,
  // so drawAllPinsOnly/syncAllOverlays/syncPanels can't disagree about it.
  function activeViews(): MapView[] {
    if (viewMode === "compare") return panels.map((p) => p.view);
    return view ? [view] : [];
  }

  // Redraws pins-only on every currently active view — the pre-race (or
  // between-races) state. Generalizes the old single-map drawPinsOnly to
  // "however many views are live right now" (1 in overlay mode, 2-4 panels
  // in Compare).
  function drawAllPinsOnly(): void {
    if (!graph) return;
    for (const v of activeViews()) {
      v.clearOverlay();
      if (pinA !== null) v.drawPin(graph.lon[pinA], graph.lat[pinA], "A");
      if (pinB !== null) v.drawPin(graph.lon[pinB], graph.lat[pinB], "B");
    }
  }

  // Redraws whatever every active view's overlay canvas should currently
  // show: the full race frame (settle-flood dots + route + pins) if a race
  // has ever completed or is in flight, else just the pins alone.
  // `controller.redrawFrame()` already knows which views to target — it
  // reads its own `comparePanels` field (set via setComparePanels, kept in
  // sync with `panels` below) — so this function only owns the pins-only
  // half; `redrawFrame()` is a documented no-op before the first race, so
  // calling both in this order is always correct and never double-draws
  // anything visible.
  function syncAllOverlays(): void {
    drawAllPinsOnly();
    controller?.redrawFrame();
  }

  // ONE subscription drives every view's overlay resync regardless of how
  // many MapViews currently share viewStore (1 in overlay mode, 2-4 panels
  // in Compare) — deliberately a single store-level subscription here,
  // rather than one registered per MapView: each MapView already redraws
  // its OWN base layer from its own store subscription (see
  // mapRenderer.ts), but also hanging a full pins+frame overlay resync off
  // every one of those would re-run it once PER PANEL per change —
  // O(panels^2) work for one pan/zoom tick instead of O(panels). Safe to
  // register before `view`/`panels` exist: activeViews() and
  // controller?.redrawFrame() both handle "not ready yet" gracefully.
  viewStore.subscribe(() => syncAllOverlays());

  // ------------------------------------------------------------------
  // Pointer interaction (build-review amendments §14.1-3): pins move by
  // DRAG only, tap-to-place is gone entirely. pointerdown within
  // DRAG_HIT_PX of an existing pin drags that pin (live snap-on-move,
  // re-races via the debounced scheduler on release); pointerdown
  // anywhere else on the map instead starts a PAN of the view. A second
  // simultaneous pointer turns whichever single-pointer gesture was
  // running into a pinch (zoom by distance ratio about the midpoint + pan
  // by the midpoint's own movement); pointers are tracked by id in
  // `pointers` so lifting one finger of a pinch cleanly resumes as a
  // single-pointer pan on whichever pointer remains down, with no jump.
  // Wheel zooms about the cursor; the +/- buttons zoom about the viewport
  // centre and are the keyboard/a11y path — presets remain the keyboard PIN
  // path (arrow-key pin-nudging is out of scope for this round).
  //
  // Factored into its own function (Compare mode, §14.3) so the identical
  // wiring binds to EVERY panel's own canvas/zoom-button pair, not just the
  // single overlay map: `canvas`/`getView`/`zoomInBtn`/`zoomOutBtn` are this
  // target's own; `pinA`/`pinB`/`graph`/`scheduleRace`/`drawAllPinsOnly`
  // stay closed over from the OUTER boot() scope, shared by every call —
  // which is exactly what makes "pin drag from ANY panel updates the
  // shared pins" true for free, with no extra plumbing. Each call gets its
  // own local gesture state (dragPin, panActive, pointers, pinch geometry)
  // so a drag/pinch tracked on one canvas can never be confused with
  // another's — the browser's own pointer-capture (setPointerCapture below)
  // guarantees a gesture's move/up events keep routing to the canvas that
  // started it even if the pointer physically leaves its bounds.
  function wireMapInteraction(
    canvas: HTMLCanvasElement,
    getView: () => MapView | undefined,
    zoomInBtn: HTMLButtonElement | null,
    zoomOutBtn: HTMLButtonElement | null,
  ): void {
    let dragPin: "A" | "B" | null = null;
    let dragPinOrigin: number | null = null; // the node dragPin sat on before THIS drag began -- see the mid-drag-abort restore below
    let panActive = false;
    let panX = 0;
    let panY = 0;
    const pointers = new Map<number, { x: number; y: number }>();
    let pinchDist = 0;
    let pinchMidX = 0;
    let pinchMidY = 0;

    function canvasXY(e: MouseEvent): [number, number] {
      const rect = canvas.getBoundingClientRect();
      return [e.clientX - rect.left, e.clientY - rect.top];
    }

    function pinNear(x: number, y: number): "A" | "B" | null {
      const activeView = getView();
      if (!activeView || !graph) return null;
      const candidates: ["A" | "B", number | null][] = [
        ["A", pinA],
        ["B", pinB],
      ];
      for (const [label, node] of candidates) {
        if (node === null) continue;
        const [px, py] = activeView.project(graph.lon[node], graph.lat[node]);
        if (Math.hypot(px - x, py - y) <= DRAG_HIT_PX) return label;
      }
      return null;
    }

    /** The two currently-tracked pointers' on-screen distance apart and
     * midpoint — `undefined` unless exactly-or-more than two are down (a
     * third simultaneous touch is tracked in `pointers` for correct
     * up-bookkeeping but doesn't change the gesture; the pinch just keeps
     * using the first two encountered by Map iteration order). */
    function pinchGeometry(): { dist: number; midX: number; midY: number } | undefined {
      const pts = [...pointers.values()];
      if (pts.length < 2) return undefined;
      const [p0, p1] = pts;
      return { dist: Math.hypot(p1.x - p0.x, p1.y - p0.y), midX: (p0.x + p1.x) / 2, midY: (p0.y + p1.y) / 2 };
    }

    canvas.addEventListener("pointerdown", (e) => {
      const [x, y] = canvasXY(e);
      pointers.set(e.pointerId, { x, y });
      canvas.setPointerCapture(e.pointerId);

      if (pointers.size >= 2) {
        // A second pointer landing turns any single-pointer gesture into a
        // pinch. If a pin drag was in progress, this ABORTS it: the pin is
        // restored to its pre-drag node (build-review fix) rather than
        // left wherever it had moved to when the second finger landed, and
        // no race is scheduled for that in-flight position.
        if (dragPin) {
          if (dragPin === "A") pinA = dragPinOrigin;
          else pinB = dragPinOrigin;
          drawAllPinsOnly();
        }
        dragPin = null;
        panActive = false;
        const geo = pinchGeometry();
        if (geo) {
          pinchDist = geo.dist;
          pinchMidX = geo.midX;
          pinchMidY = geo.midY;
        }
        return;
      }

      const near = pinNear(x, y);
      if (near) {
        dragPin = near;
        dragPinOrigin = near === "A" ? pinA : pinB;
      } else {
        panActive = true;
        panX = x;
        panY = y;
      }
    });

    canvas.addEventListener("pointermove", (e) => {
      if (!pointers.has(e.pointerId)) return; // hover / no button down
      const [x, y] = canvasXY(e);
      pointers.set(e.pointerId, { x, y });
      const activeView = getView();

      if (pointers.size >= 2) {
        const geo = pinchGeometry();
        if (!geo || !activeView) return;
        if (pinchDist > 0) activeView.zoomAt(geo.midX, geo.midY, geo.dist / pinchDist);
        activeView.panBy(geo.midX - pinchMidX, geo.midY - pinchMidY);
        pinchDist = geo.dist;
        pinchMidX = geo.midX;
        pinchMidY = geo.midY;
        return;
      }

      if (dragPin && activeView && graph) {
        const [lon, lat] = activeView.unproject(x, y);
        const node = nearestNode(lon, lat, graph.lon, graph.lat);
        if (dragPin === "A") pinA = node;
        else pinB = node;
        drawAllPinsOnly();
      } else if (panActive && activeView) {
        activeView.panBy(x - panX, y - panY);
        panX = x;
        panY = y;
      }
    });

    const endPointer = (e: PointerEvent): void => {
      const wasDragging = dragPin !== null;
      pointers.delete(e.pointerId);
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);

      if (pointers.size >= 2) {
        // Still a pinch with the remaining pointers: recapture a fresh
        // baseline so the gesture continues without a jump.
        const geo = pinchGeometry();
        if (geo) {
          pinchDist = geo.dist;
          pinchMidX = geo.midX;
          pinchMidY = geo.midY;
        }
        return;
      }
      if (pointers.size === 1) {
        // A pinch ending with one finger still down resumes as a
        // single-pointer pan from THAT finger's current position.
        const [remaining] = [...pointers.values()];
        dragPin = null;
        panActive = true;
        panX = remaining.x;
        panY = remaining.y;
        return;
      }

      dragPin = null;
      panActive = false;
      if (wasDragging) scheduleRace();
    };
    canvas.addEventListener("pointerup", endPointer);
    canvas.addEventListener("pointercancel", endPointer);

    // Wheel zooms about the cursor. `{ passive: false }` + preventDefault so
    // the page doesn't ALSO scroll while the map zooms under the cursor.
    canvas.addEventListener(
      "wheel",
      (e) => {
        const activeView = getView();
        if (!activeView) return;
        e.preventDefault();
        const [x, y] = canvasXY(e);
        activeView.zoomAt(x, y, Math.pow(WHEEL_ZOOM_BASE, -e.deltaY));
      },
      { passive: false },
    );

    // The +/- buttons: the a11y zoom path (real buttons, native
    // Enter/Space activation, no extra keyboard wiring needed) — zoom
    // about the viewport centre rather than a cursor position, since a
    // keyboard/switch user has no cursor to anchor on.
    function zoomAtCentre(factor: number): void {
      const activeView = getView();
      if (!activeView) return;
      const rect = canvas.getBoundingClientRect();
      activeView.zoomAt(rect.width / 2, rect.height / 2, factor);
    }
    zoomInBtn?.addEventListener("click", () => zoomAtCentre(BUTTON_ZOOM_FACTOR));
    zoomOutBtn?.addEventListener("click", () => zoomAtCentre(1 / BUTTON_ZOOM_FACTOR));
  }

  wireMapInteraction(overlayCanvas, () => view, zoomInBtn, zoomOutBtn);

  // "R"/"r" re-runs the current pair (ignore browser-refresh chords). A
  // direct trigger, so it goes through scheduler.now() — cancels any
  // pending debounced race from a pin drag that hasn't released yet.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "r" && e.key !== "R") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (pinA !== null && pinB !== null) scheduler.now(pinA, pinB);
  });

  // The two stacked canvases fill the race-canvas wrapper; watch IT resize
  // (not window) so DPR/layout changes from any cause — viewport resize,
  // font load reflow, orientation change, or the overlay map being
  // un-hidden after a Compare -> Overlay mode switch — repaint at the right
  // size. DPR itself is handled inside MapView.resize(); syncAllOverlays()
  // re-renders whatever every active view should show.
  if (stack instanceof HTMLElement && typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => {
      view?.resize();
      syncAllOverlays();
    });
    ro.observe(stack);
  }

  // Same idea, one ResizeObserver instance watching every Compare panel's
  // own container (panels can differ in size from each other — the "quad"
  // phone layout especially — so each is measured independently rather
  // than inferring sizes from the grid as a whole).
  const panelResizeObserver =
    typeof ResizeObserver !== "undefined"
      ? new ResizeObserver((entries) => {
          for (const entry of entries) {
            const panel = panels.find((p) => p.el === entry.target);
            panel?.view.resize();
          }
          syncAllOverlays();
        })
      : undefined;

  const ui: RaceUi = {
    setRow(algo, settled, total) {
      const row = document.querySelector(`.board .row[data-algo="${algo}"]`);
      const val = row?.querySelector(".val");
      const fill = row?.querySelector<HTMLElement>(".fill");
      if (val) val.textContent = settled.toLocaleString("en-AU");
      if (fill) fill.style.width = `${total > 0 ? (settled / total) * 100 : 0}%`;
      // Compare-mode panel chips mirror the same count, same single code
      // path — a no-op query when overlay mode is active (no panels exist)
      // or when this algo doesn't currently have a panel (racer toggled on
      // since the last panel rebuild; the rebuild catches up next race).
      const panelCount = document.querySelector(`[data-testid="compare-panels"] [data-algo="${algo}"] .panel-count`);
      if (panelCount) panelCount.textContent = settled.toLocaleString("en-AU");
    },
    setTime(algo, ms) {
      const row = document.querySelector(`.board .row[data-algo="${algo}"]`);
      if (!row) return;
      let msEl = row.querySelector(".ms");
      if (!msEl) {
        msEl = document.createElement("span");
        msEl.className = "ms";
        row.querySelector(".val")?.after(msEl);
      }
      msEl.textContent = formatMs(ms);
    },
    setHeadline(text) {
      const el = document.getElementById("board-headline");
      if (el) el.textContent = text;
      // Single point where a completed race turns up the /how/ CTA's
      // emphasis (design spec §14.7) — setHeadline fires exactly once per
      // race, only after results are in (see controller.ts's
      // reportResults), so this can't fire early or repeat mid-replay.
      document.querySelector('[data-testid="how-cta"]')?.classList.add("is-hot");
    },
    announce(text) {
      // Same text, two sinks: the aria-live region (screen readers hear it
      // immediately) and the canvas wrapper's aria-label. Both stay keyed
      // to the SINGLE overlay race-canvas element regardless of view mode
      // (scoreboard/aria unchanged in both modes, build-review §14.3) —
      // Compare panels carry no aria surface of their own.
      const live = document.querySelector('[data-testid="race-live"]');
      if (live) live.textContent = text;
      const canvas = document.querySelector('[data-testid="race-canvas"]');
      if (canvas) canvas.setAttribute("aria-label", text);
    },
  };

  function presetButton(id: string): Element | null {
    // preset-hill ships as a testid in the markup; the other presets ship
    // as data-preset (see index.html — not this task's to modify).
    return id === "hill"
      ? document.querySelector('[data-testid="preset-hill"]')
      : document.querySelector(`[data-preset="${id}"]`);
  }

  for (const preset of PRESETS) {
    presetButton(preset.id)?.addEventListener("click", () => {
      if (!graph) return;
      pinA = nearestNode(preset.a[0], preset.a[1], graph.lon, graph.lat);
      pinB = nearestNode(preset.b[0], preset.b[1], graph.lon, graph.lat);
      // Presets are the keyboard/a11y pin path now that pins move by drag
      // only — resetView() so a pin placed while the map is zoomed/panned
      // somewhere else is always immediately visible. Goes through
      // viewStore directly (not a specific view's resetView()) since it
      // must reset EVERY view sharing the store, including every active
      // Compare panel, not just one.
      viewStore.set({ scale: 1, tx: 0, ty: 0 });
      drawAllPinsOnly();
      scheduler.now(pinA, pinB); // direct trigger: cancels any pending debounce
    });
  }

  function surprisePair(g: Graph): [number, number] {
    let a = 0;
    let b = 0;
    for (let attempt = 0; attempt < SURPRISE_MAX_TRIES; attempt++) {
      a = Math.floor(Math.random() * g.n);
      b = Math.floor(Math.random() * g.n);
      if (a === b) continue;
      if (haversine(g.lon[a], g.lat[a], g.lon[b], g.lat[b]) >= SURPRISE_MIN_M) break;
    }
    return [a, b];
  }

  document.querySelector('[data-preset="surprise"]')?.addEventListener("click", () => {
    if (!graph) return;
    const [a, b] = surprisePair(graph);
    pinA = a;
    pinB = b;
    viewStore.set({ scale: 1, tx: 0, ty: 0 }); // see the preset handler above for why
    drawAllPinsOnly();
    scheduler.now(a, b); // direct trigger: cancels any pending debounce
  });

  raceRunBtn?.addEventListener("click", () => {
    if (pinA !== null && pinB !== null) scheduler.now(pinA, pinB);
  });

  // ------------------------------------------------------------------
  // Compare-mode panel lifecycle (build-review §14.3).
  // ------------------------------------------------------------------

  function destroyPanel(p: PanelEntry): void {
    panelResizeObserver?.unobserve(p.el);
    p.view.dispose(); // unhooks the shared store + guards the theme callback — see MapView.dispose()
    p.el.remove();
  }

  /** Rebuilds the panel set to match the currently active racer roster:
   * diffPanels() decides what to add/keep/remove, only the changed panels
   * are constructed/torn down, the result is re-assembled and re-appended
   * in ROSTER order (moving already-DOM-attached elements, not cloning —
   * `Element.append` on a node already in the document relocates it), the
   * controller's render target is kept in sync (setComparePanels — safe
   * mid-race, see that method's own comment), and every panel is
   * (re-)sized before the pins/current frame are redrawn onto it. A no-op
   * before the data + controller this needs exist (guarded below) — the
   * initial pre-load call to applyViewMode() relies on that. */
  function syncPanels(): void {
    if (!compareGrid || !renderData || !graph || !controller) return;
    const render = renderData;
    const next = controller.getActiveRoster();
    const { add, remove } = diffPanels(panels.map((p) => p.algo), next);

    for (const algo of remove) {
      const idx = panels.findIndex((p) => p.algo === algo);
      if (idx >= 0) {
        destroyPanel(panels[idx]);
        panels.splice(idx, 1);
      }
    }

    const byAlgo = new Map(panels.map((p) => [p.algo, p] as const));
    for (const algo of add) {
      const dom = buildPanelDom(algo);
      compareGrid.append(dom.el);
      const panelView = new MapView(dom.base, dom.overlay, render, viewStore);
      wireMapInteraction(dom.overlay, () => panelView, dom.zoomIn, dom.zoomOut);
      panelResizeObserver?.observe(dom.el);
      byAlgo.set(algo, { algo, el: dom.el, view: panelView });
    }

    panels = next.map((algo) => byAlgo.get(algo)).filter((p): p is PanelEntry => p !== undefined);
    for (const p of panels) compareGrid.append(p.el); // re-append in `next`'s order (relocates existing nodes too)
    // `.is-loading` (styles.css) ships in the static markup so the pre-data
    // LOADING state — a persisted "compare" view mode restored before
    // renderData/graph/controller exist, when this function's own guard
    // above still returns early — has a min-height floor instead of
    // collapsing to a blank sliver. Once panels actually exist (always true
    // past this point: Dijkstra+CH are never excludable, so `next` is never
    // empty), drop it so the grid sizes from the panels' own aspect-ratio
    // instead of an unconditional min-height (build-review fix — that used
    // to survive past the loading state too, flooring a real 2-racer row
    // to 72vh and leaving a ~400px dead gap above the controls at
    // 1920x1080).
    compareGrid.classList.toggle("is-loading", panels.length === 0);
    // Phone layout (§14.3): 2 racers stack in one full-width column (two
    // ~171px columns at 390px are too cramped); 3-4 racers use a 2x2 grid
    // at ~44vw per panel instead of also stacking — four full-width
    // stacked panels would push the map far below the fold on a phone.
    // See styles.css's own comment on this rule for the desktop side.
    compareGrid.classList.toggle("compare-grid-quad", panels.length >= 3);

    controller.setComparePanels(panels.map((p): ComparePanel => ({ algo: p.algo, view: p.view })));
    for (const p of panels) p.view.resize();
    drawAllPinsOnly();
  }

  /** Applies `viewMode` to the DOM (map-frame vs. compare-grid visibility,
   * the toggle button's label/aria-pressed) and to the panel set. Called
   * once immediately (before data exists — syncPanels() no-ops safely, see
   * its own guard) so the static layout is never wrong even during the
   * loading state, again once data/controller are ready (this time
   * syncPanels() actually builds panels if the persisted mode is
   * "compare"), and on every view-toggle click. */
  function applyViewMode(): void {
    const compare = viewMode === "compare";
    if (mapFrame) mapFrame.hidden = compare;
    if (compareGrid) compareGrid.hidden = !compare;
    if (viewToggleBtn) {
      viewToggleBtn.setAttribute("aria-pressed", String(compare));
      viewToggleBtn.textContent = `View: ${viewMode}`;
    }
    if (compare) {
      syncPanels();
    } else {
      for (const p of panels) destroyPanel(p);
      panels = [];
      controller?.setComparePanels(null); // back to overlay target; redraws the current frame there (safe mid-race)
      view?.resize(); // the overlay map was hidden (0-size) while Compare was active; measure it fresh now it's shown
      drawAllPinsOnly();
    }
  }

  applyViewMode();

  viewToggleBtn?.addEventListener("click", () => {
    viewMode = viewMode === "overlay" ? "compare" : "overlay";
    saveViewMode(viewMode);
    applyViewMode();
  });

  // The two optional-racer chips (A*, Bidirectional) — default OFF, real
  // aria-pressed toggle buttons (Dijkstra/CH have no equivalent chip: they
  // race unconditionally, the disable-proof core comparison). Toggling
  // updates the controller's participation state for every future race,
  // rebuilds the Compare panel set if Compare mode is active (a racer
  // toggle changes which panels SHOULD exist), AND re-races the current
  // pins right away, through the same cancel-first `scheduler.now()` every
  // other direct trigger already goes through. The matching scoreboard row
  // is shown/hidden here too (not left empty): "rows for inactive algos
  // hidden entirely" is a scoreboard-shape contract, not something RaceUi
  // (a per-RACE reporting interface) owns.
  function wireAlgoToggle(chip: HTMLButtonElement | null, algo: "astar" | "bidi"): void {
    chip?.addEventListener("click", () => {
      const active = chip.getAttribute("aria-pressed") !== "true";
      chip.setAttribute("aria-pressed", String(active));
      controller?.setAlgoActive(algo, active);
      const row = document.querySelector(`.board .row[data-algo="${algo}"]`);
      if (row instanceof HTMLElement) row.hidden = !active;
      if (viewMode === "compare") syncPanels();
      if (pinA !== null && pinB !== null) scheduler.now(pinA, pinB); // direct trigger: cancels any pending debounce
    });
  }
  wireAlgoToggle(astarChip, "astar");
  wireAlgoToggle(bidiChip, "bidi");

  // render.json and routing.json load independently — nothing orders one
  // before the other — so routingReady's rejection can land BEFORE
  // renderReady's success. Without this guard, renderReady's own "warming
  // up…" text write still lands even after Promise.all's catch below has
  // already shown the honest failure copy, silently overwriting it with a
  // progress message that will now never move again. Once true,
  // renderReady's own then() stops touching loadNote at all.
  let loadFailed = false;

  const renderReady = loadRender().then((render) => {
    renderData = render;
    view = new MapView(baseCanvas, overlayCanvas, render, viewStore);
    view.drawBase(); // explicit repaint; harmless right after construction
    if (loadNote && !loadFailed) loadNote.textContent = "warming up the route engine…";
  });

  const routingReady = loadRouting().then((routing) => {
    graph = routing.graph;
  });

  Promise.all([renderReady, routingReady])
    .then(() => {
      if (!view || !graph) return;
      controller = new RaceController(view, ui);
      if (loadNote) loadNote.hidden = true;
      if (raceRunBtn) raceRunBtn.disabled = false;
      // Ship disabled (index.html) so a pre-load click can't flip
      // aria-pressed / un-hide a scoreboard row that has nothing to show
      // yet (unlike the preset buttons, which no-op silently on their own
      // `if (!graph) return` guard, a chip's own click handler has a
      // visible side effect — aria-pressed, row.hidden — before it ever
      // checks whether `controller` exists, so disabling until ready is
      // the honest fix here, not a redundant belt-and-braces one).
      if (astarChip) astarChip.disabled = false;
      if (bidiChip) bidiChip.disabled = false;
      if (zoomInBtn) zoomInBtn.disabled = false;
      if (zoomOutBtn) zoomOutBtn.disabled = false;
      if (viewToggleBtn) viewToggleBtn.disabled = false;

      // Pins pre-placed on the signature preset (design spec's "Ready /
      // idle" state) as soon as routing lets us snap them — independent of
      // whether the auto-run below actually fires. The view is already at
      // its identity (nothing has zoomed/panned yet), so no explicit reset
      // is needed here the way the preset/surprise handlers need one.
      const hill = PRESETS.find((p) => p.id === "hill");
      if (hill) {
        pinA = nearestNode(hill.a[0], hill.a[1], graph.lon, graph.lat);
        pinB = nearestNode(hill.b[0], hill.b[1], graph.lon, graph.lat);
      }

      // Re-applies the (possibly persisted-as-"compare") view mode now
      // that data + controller exist: builds the real panel set if needed,
      // and either way draws the just-placed pins onto whatever is active.
      applyViewMode();

      // Auto-run on desktop only (design spec §5.1)
      if (matchMedia("(min-width: 940px)").matches) {
        setTimeout(() => {
          const pins = autoRunPins(pinA, pinB);
          if (pins) scheduler.now(pins[0], pins[1]);
        }, AUTO_RUN_MS);
      }
    })
    .catch((err: unknown) => {
      loadFailed = true;
      console.error("failed to load map/routing data", err);
      if (loadNote) loadNote.textContent = "failed to load the map — reload to retry";
    });
}

// Guarded (not a bare call) so this module is safely importable from a
// plain Node test environment (no `document`) to reach the pure exports
// (`autoRunPins`, `diffPanels`) alone — same "don't assume a browser global
// exists" idiom this file already uses for `typeof ResizeObserver !==
// "undefined"` above. Always true, so always runs, on any real page load.
if (typeof document !== "undefined") boot();
