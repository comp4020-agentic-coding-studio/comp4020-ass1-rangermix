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

// The design spec's own "all / top 35% / top 12% / top 2%" reveal — `null`
// means unfiltered (step 0), the other three are FRACTIONS to keep, turned
// into actual `pct` byte thresholds by percentileThreshold() below once the
// real data is loaded (see that function's comment for why: a fixed byte
// guess drifted badly from what these labels claim).
const KEEP_FRACS: (number | null)[] = [null, 0.35, 0.12, 0.02];
const STEP_LABELS = ["every road", "top 35%", "top 12%", "top 2%"];

/** The byte-valued `pct` threshold (0-255) that keeps (at least) `keepFrac`
 * of `lines` under `visibleLines`'s `pct >= threshold` rule. Computed from
 * the ACTUAL loaded data every mount, not a guessed constant: an earlier
 * version hardcoded byte thresholds (166/224/250) that were calibrated
 * against assumptions about the rank distribution, not the shipped
 * render.json — against the real ~60k-line Canberra artifact they actually
 * retained 10.2% / 0.75% / 0.025% of lines, not 35% / 12% / 2% (the "top
 * 2%" step showed 15 lines, not ~1,200 — nowhere near "a connected spine
 * with the bridges"). Exported + pure (array in, number out) for direct
 * testing without a fetch. */
export function percentileThreshold(lines: number[][], keepFrac: number): number {
  if (lines.length === 0) return 0;
  const sorted = lines.map((l) => l[1]).sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * (1 - keepFrac))));
  return sorted[idx];
}

/** The full 4-step threshold list `KEEP_FRACS`/`STEP_LABELS` describe: `null`
 * (every road) plus one data-derived `percentileThreshold` per labelled
 * fraction, in step order. */
export function computePctSteps(lines: number[][]): (number | null)[] {
  return KEEP_FRACS.map((frac) => (frac === null ? null : percentileThreshold(lines, frac)));
}

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
  // Placeholder until the real data loads; `range` stays `disabled` until
  // then (see skeletonMarkup), so applyStep() can only run off this
  // placeholder from the one internal call right after pctSteps is
  // computed below, never from user input arriving too early.
  let pctSteps: (number | null)[] = [null, null, null, null];

  function applyStep(step: number): void {
    const clamped = Math.min(pctSteps.length - 1, Math.max(0, step));
    const label = STEP_LABELS[clamped];
    if (output) output.textContent = label;
    if (stack) {
      stack.setAttribute("aria-label", `Map of Canberra's road network, ${label} shown.`);
    }
    // Emphasize the top TWO stops only (index 2 = top 12%, 3 = top 2% —
    // the two most exclusive fractions): "top 35%" stays in normal colors
    // as the sanity/transition step, matching the design spec's own
    // "notice: the lake bridges survive to the very top" payoff landing at
    // the narrow end, not partway through.
    view?.setPctThreshold(pctSteps[clamped], { emphasize: clamped >= 2 });
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
      pctSteps = computePctSteps(render.lines);
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
