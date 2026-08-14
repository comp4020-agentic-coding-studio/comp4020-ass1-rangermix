// Boot script for the home page (/): wires the theme toggle, loads the
// committed road-network render artifact, and paints the base map layer.
// Racing itself (worker, replay, pins, presets) is Task 8 — this file only
// gets the page to a "ready to look at" state and keeps #load-note honest
// about where startup is, per the design spec's "read without waiting"
// journey step. Controls stay inert here: race-run ships `disabled` in the
// markup, and preset/race buttons get no click handlers until Task 8 wires
// them.

import { initTheme } from "../theme";
import { loadRender } from "../data";
import { MapView } from "../viz/mapRenderer";

function boot(): void {
  initTheme();

  const baseCanvas = document.getElementById("map-base");
  const overlayCanvas = document.getElementById("map-overlay");
  const stack = document.querySelector('[data-testid="race-canvas"]');
  const loadNote = document.getElementById("load-note");

  if (
    !(baseCanvas instanceof HTMLCanvasElement) ||
    !(overlayCanvas instanceof HTMLCanvasElement)
  ) {
    return;
  }

  let view: MapView | undefined;

  // The two stacked canvases fill the race-canvas wrapper; watch IT resize
  // (not window) so DPR/layout changes from any cause — viewport resize,
  // font load reflow, orientation change — repaint at the right size. DPR
  // itself is handled inside MapView.resize().
  if (stack instanceof HTMLElement && typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => view?.resize());
    ro.observe(stack);
  }

  loadRender()
    .then((render) => {
      view = new MapView(baseCanvas, overlayCanvas, render);
      view.drawBase(); // explicit repaint; harmless right after construction
      if (loadNote) loadNote.textContent = "warming up the route engine…";
    })
    .catch(() => {
      if (loadNote) loadNote.textContent = "failed to load the map — reload to retry";
    });
}

boot();
