// Chapter 4 toy: the real Canberra road network — the same render.json
// payload the home page's race draws — filtered live by a labelled range
// input against CH's own contraction-rank percentile. This is the one /how/
// toy that isn't the 12-node mini-town: the whole point of this chapter is
// that the hierarchy CH discovers isn't a toy-graph curiosity, it's really
// there in Canberra's own roads.
//
// NOTE (from an earlier review of MapView): it subscribes to theme changes
// in its constructor and never unsubscribes, so this module constructs
// exactly ONE MapView per mount and keeps it for the page's lifetime —
// never construct/discard repeatedly.

import { loadRender } from "../data";
import { MapView } from "../viz/mapRenderer";

// pct thresholds MapView.setPctThreshold expects — render.json's `pct`
// field is the CH-rank percentile (0-255) scripts/data/build.ts stamped on
// each line; `null` means unfiltered. These four steps are the design
// spec's own "all / top 35% / top 12% / top 2%" reveal.
const PCT_STEPS: (number | null)[] = [null, 166, 224, 250];
const STEP_LABELS = ["every road", "top 35%", "top 12%", "top 2%"];

function skeletonMarkup(): string {
  return (
    `<div class="hier-stack" data-role="stack" role="img" ` +
    `aria-label="Map of Canberra's road network, ${STEP_LABELS[0]} shown.">` +
    `<canvas data-role="base"></canvas>` +
    `<canvas data-role="overlay"></canvas>` +
    `<p class="hier-loading" data-role="loading">loading the road network…</p>` +
    `</div>` +
    `<div class="hier-controls">` +
    `<label for="hier-range">roads shown: <output data-role="output" for="hier-range">${STEP_LABELS[0]}</output></label>` +
    `<input type="range" id="hier-range" min="0" max="3" step="1" value="0" data-role="range" disabled />` +
    `</div>`
  );
}

export function mountHierarchy(root: HTMLElement): void {
  root.innerHTML = skeletonMarkup();

  const stack = root.querySelector<HTMLElement>('[data-role="stack"]');
  const baseCanvas = root.querySelector<HTMLCanvasElement>('[data-role="base"]');
  const overlayCanvas = root.querySelector<HTMLCanvasElement>('[data-role="overlay"]');
  const loading = root.querySelector<HTMLElement>('[data-role="loading"]');
  const output = root.querySelector<HTMLOutputElement>('[data-role="output"]');
  const range = root.querySelector<HTMLInputElement>('[data-role="range"]');

  if (!(baseCanvas instanceof HTMLCanvasElement) || !(overlayCanvas instanceof HTMLCanvasElement)) {
    return;
  }

  let view: MapView | undefined;

  function applyStep(step: number): void {
    const clamped = Math.min(PCT_STEPS.length - 1, Math.max(0, step));
    const label = STEP_LABELS[clamped];
    if (output) output.textContent = label;
    if (stack) {
      stack.setAttribute("aria-label", `Map of Canberra's road network, ${label} shown.`);
    }
    view?.setPctThreshold(PCT_STEPS[clamped]);
  }

  range?.addEventListener("input", () => applyStep(Number(range.value)));

  if (stack && typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => view?.resize());
    ro.observe(stack);
  }

  // /how/ is one path segment deeper than the site root, so render.json
  // (committed under public/data/, served at the site ROOT's /data/) needs
  // one more ".." than loadRender's own default ("./data/", right for a
  // page AT the root). Resolved through `new URL(..., document.baseURI)` —
  // the same technique RaceController uses to compute its worker's data
  // base, and climb.ts's mountClosingEcho uses for meta.json — rather than
  // handing the bare relative string straight to fetch, so every /how/ data
  // fetch resolves through one documented pattern instead of two.
  const dataBase = new URL("../data/", document.baseURI).href;
  loadRender(dataBase)
    .then((render) => {
      view = new MapView(baseCanvas, overlayCanvas, render);
      applyStep(Number(range?.value ?? 0));
      if (loading) loading.hidden = true;
      if (range) range.disabled = false;
    })
    .catch((err: unknown) => {
      console.error("hierarchy toy: render.json failed to load", err);
      if (loading) loading.textContent = "couldn't load the map — reload to retry";
    });
}
