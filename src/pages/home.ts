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
import { MapView } from "../viz/mapRenderer";
import { haversine, nearestNode } from "../snap";
import { PRESETS } from "../presets";
import { RaceController, type RaceUi, formatMs } from "../race/controller";
import { makeRaceScheduler } from "../race/scheduler";
import type { Graph } from "../algos/graph";

const DEBOUNCE_MS = 250;
const AUTO_RUN_MS = 1500;
const DRAG_HIT_PX = 20;
const SURPRISE_MIN_M = 8000;
const SURPRISE_MAX_TRIES = 50;

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

function boot(): void {
  initTheme();

  const baseCanvas = document.getElementById("map-base");
  const overlayCanvas = document.getElementById("map-overlay");
  const stack = document.querySelector('[data-testid="race-canvas"]');
  const loadNote = document.getElementById("load-note");
  const raceRunBtn = document.querySelector<HTMLButtonElement>('[data-testid="race-run"]');
  const controls = document.querySelector(".controls");
  const astarChip = document.querySelector<HTMLButtonElement>('[data-testid="algo-astar"]');
  const bidiChip = document.querySelector<HTMLButtonElement>('[data-testid="algo-bidi"]');

  if (
    !(baseCanvas instanceof HTMLCanvasElement) ||
    !(overlayCanvas instanceof HTMLCanvasElement)
  ) {
    return;
  }

  let view: MapView | undefined;
  let controller: RaceController | undefined;
  let graph: Graph | undefined;
  let pinA: number | null = null;
  let pinB: number | null = null;
  let nextPin: "A" | "B" = "A";
  let hint: HTMLSpanElement | undefined;

  function updateHint(): void {
    if (hint) hint.textContent = `Next tap places pin ${nextPin}`;
  }

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

  function drawPinsOnly(): void {
    if (!view || !graph) return;
    view.clearOverlay();
    if (pinA !== null) view.drawPin(graph.lon[pinA], graph.lat[pinA], "A");
    if (pinB !== null) view.drawPin(graph.lon[pinB], graph.lat[pinB], "B");
  }

  function placeNext(node: number): void {
    if (nextPin === "A") {
      pinA = node;
      nextPin = "B";
    } else {
      pinB = node;
      nextPin = "A";
    }
    updateHint();
    drawPinsOnly();
    if (pinA !== null && pinB !== null) scheduleRace();
  }

  // ------------------------------------------------------------------
  // Pointer interaction: tap empty map to place the next pin (A then B
  // then back to A); pointerdown within DRAG_HIT_PX of an existing pin
  // starts a drag instead, which moves that pin live and re-races once
  // released (debounced, same as any other pin change).
  // ------------------------------------------------------------------
  let dragPin: "A" | "B" | null = null;
  let suppressClick = false;

  // Arrow expressions assigned to a const (not `function` declarations):
  // TypeScript only carries the `instanceof HTMLCanvasElement` narrowing of
  // `overlayCanvas` (a const, narrowed by the early-return above) into
  // closures defined as expressions after that point — a hoisted function
  // declaration is conservatively treated as reachable "before" the
  // narrowing, so it loses it.
  const canvasXY = (e: PointerEvent): [number, number] => {
    const rect = overlayCanvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  function pinNear(x: number, y: number): "A" | "B" | null {
    if (!view || !graph) return null;
    const candidates: ["A" | "B", number | null][] = [
      ["A", pinA],
      ["B", pinB],
    ];
    for (const [label, node] of candidates) {
      if (node === null) continue;
      const [px, py] = view.project(graph.lon[node], graph.lat[node]);
      if (Math.hypot(px - x, py - y) <= DRAG_HIT_PX) return label;
    }
    return null;
  }

  overlayCanvas.addEventListener("pointerdown", (e) => {
    const [x, y] = canvasXY(e);
    const near = pinNear(x, y);
    if (near) {
      dragPin = near;
      suppressClick = true;
      overlayCanvas.setPointerCapture(e.pointerId);
    }
  });

  overlayCanvas.addEventListener("pointermove", (e) => {
    if (!dragPin || !view || !graph) return;
    const [x, y] = canvasXY(e);
    const [lon, lat] = view.unproject(x, y);
    const node = nearestNode(lon, lat, graph.lon, graph.lat);
    if (dragPin === "A") pinA = node;
    else pinB = node;
    drawPinsOnly();
  });

  const endDrag = (e: PointerEvent): void => {
    if (!dragPin) return;
    dragPin = null;
    if (overlayCanvas.hasPointerCapture(e.pointerId)) overlayCanvas.releasePointerCapture(e.pointerId);
    // The browser normally synthesizes a `click` right after pointerup,
    // which the click handler below suppresses (so a drag never also
    // re-places a pin) and which resets `suppressClick` itself. But a
    // pointer sequence can also end via pointercancel (touch gesture
    // aborted by the OS — multi-touch, edge-swipe, etc.), which fires no
    // click at all — leaving suppressClick stuck true forever and silently
    // swallowing the user's next real tap. Clear it on a macrotask delay:
    // still set (and so still suppresses) the normal synchronous trailing
    // click if one comes, but self-heals a moment later if it doesn't.
    setTimeout(() => {
      suppressClick = false;
    }, 0);
    scheduleRace();
  };
  overlayCanvas.addEventListener("pointerup", endDrag);
  overlayCanvas.addEventListener("pointercancel", endDrag);

  overlayCanvas.addEventListener("click", (e) => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    if (!view || !graph) return;
    const [x, y] = canvasXY(e);
    const [lon, lat] = view.unproject(x, y);
    placeNext(nearestNode(lon, lat, graph.lon, graph.lat));
  });

  // "R"/"r" re-runs the current pair (ignore browser-refresh chords). A
  // direct trigger, so it goes through scheduler.now() — cancels any
  // pending debounced race from a drag/tap that hasn't fired yet.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "r" && e.key !== "R") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (pinA !== null && pinB !== null) scheduler.now(pinA, pinB);
  });

  // The two stacked canvases fill the race-canvas wrapper; watch IT resize
  // (not window) so DPR/layout changes from any cause — viewport resize,
  // font load reflow, orientation change — repaint at the right size. DPR
  // itself is handled inside MapView.resize(); redrawFrame() re-renders
  // whatever race frame was showing (a no-op before the first race).
  if (stack instanceof HTMLElement && typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => {
      view?.resize();
      controller?.redrawFrame();
    });
    ro.observe(stack);
  }

  const ui: RaceUi = {
    setRow(algo, settled, total) {
      const row = document.querySelector(`.board .row[data-algo="${algo}"]`);
      const val = row?.querySelector(".val");
      const fill = row?.querySelector<HTMLElement>(".fill");
      if (val) val.textContent = settled.toLocaleString("en-AU");
      if (fill) fill.style.width = `${total > 0 ? (settled / total) * 100 : 0}%`;
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
    },
    announce(text) {
      // Same text, two sinks: the aria-live region (screen readers hear it
      // immediately) and the canvas wrapper's aria-label (the summary a
      // screen reader gets if it tabs to the — otherwise fairly opaque,
      // role="img" — race canvas itself). Both update ONCE per race, never
      // per frame, because this is only ever called after replay completes.
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
      nextPin = "A";
      updateHint();
      drawPinsOnly();
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
    nextPin = "A";
    updateHint();
    drawPinsOnly();
    scheduler.now(a, b); // direct trigger: cancels any pending debounce
  });

  raceRunBtn?.addEventListener("click", () => {
    if (pinA !== null && pinB !== null) scheduler.now(pinA, pinB);
  });

  // The two optional-racer chips (A*, Bidirectional) — default OFF, real
  // aria-pressed toggle buttons (Dijkstra/CH have no equivalent chip: they
  // race unconditionally, the disable-proof core comparison). Toggling
  // updates the controller's participation state for every future race
  // AND re-races the current pins right away, through the same
  // cancel-first `scheduler.now()` every other direct trigger (Race
  // button, presets, "R") already goes through — so a toggle mid-drag
  // never leaves a stale debounced race to fire later and silently
  // override it. The matching scoreboard row is shown/hidden here too
  // (not left empty): "rows for inactive algos hidden entirely" is a
  // scoreboard-shape contract, not something RaceUi (a per-RACE reporting
  // interface) owns.
  function wireAlgoToggle(chip: HTMLButtonElement | null, algo: "astar" | "bidi"): void {
    chip?.addEventListener("click", () => {
      const active = chip.getAttribute("aria-pressed") !== "true";
      chip.setAttribute("aria-pressed", String(active));
      controller?.setAlgoActive(algo, active);
      const row = document.querySelector(`.board .row[data-algo="${algo}"]`);
      if (row instanceof HTMLElement) row.hidden = !active;
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
    view = new MapView(baseCanvas, overlayCanvas, render);
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

      // Pins pre-placed on the signature preset (design spec's "Ready /
      // idle" state) as soon as routing lets us snap them — independent of
      // whether the auto-run below actually fires.
      const hill = PRESETS.find((p) => p.id === "hill");
      if (hill) {
        pinA = nearestNode(hill.a[0], hill.a[1], graph.lon, graph.lat);
        pinB = nearestNode(hill.b[0], hill.b[1], graph.lon, graph.lat);
        nextPin = "A";
      }

      hint = document.createElement("span");
      hint.className = "chip hint";
      controls?.appendChild(hint);
      updateHint();
      drawPinsOnly();

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
// plain Node test environment (no `document`) to reach `autoRunPins` alone
// — same "don't assume a browser global exists" idiom this file already
// uses for `typeof ResizeObserver !== "undefined"` above. Always true, so
// always runs, on any real page load.
if (typeof document !== "undefined") boot();
