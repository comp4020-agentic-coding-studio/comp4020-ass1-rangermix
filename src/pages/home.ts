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
import { assignStaggerSlots, createViewStore, MapView, wholeMapView, zoomToBounds, type RenderData, type ViewStore } from "../viz/mapRenderer";
import { haversine, nearestNode } from "../snap";
import { PRESETS } from "../presets";
import { ALGO_LABEL, RaceController, type ComparePanel, type RaceUi, formatMs } from "../race/controller";
import { makeRaceScheduler } from "../race/scheduler";
import { ROSTER } from "../race/roster";
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

/** The auto-run timer's OTHER fire condition (third build review §17.3):
 * whether the desktop-only 1.5s idle timer should be armed right now.
 * `autoRunPins` (above) decides whether the PINNED PAIR is ready; this
 * decides whether the PAGE is — data loaded, the splash no longer
 * covering the map, not already armed (arming is one-shot per pageview;
 * this guards the second of two possible triggers — data-ready and
 * splash-dismissal racing each other, whichever finishes second — from
 * scheduling a second timer), and the viewport wide enough that the
 * design spec's "desktop only" still applies. Pure so this contract is
 * unit-testable without a real timer/DOM/matchMedia, same rationale as
 * autoRunPins itself; the DOM wiring that reads live values into these
 * four booleans and actually calls setTimeout lives in boot()'s
 * maybeArmAutoRun, untested here by the same design as the rest of
 * boot(). */
export function shouldArmAutoRun(
  dataReady: boolean,
  splashDismissed: boolean,
  alreadyArmed: boolean,
  isDesktopWidth: boolean,
): boolean {
  return dataReady && splashDismissed && !alreadyArmed && isDesktopWidth;
}

/** H5 gate fix: the persisted-Compare splash deadlock. `.splash` lives
 * inside `.map-frame` (H2's own placement — "inside the map frame, above
 * the canvases"), and `applyViewMode()` hides `.map-frame` whenever Compare
 * is the active view. A returning visitor whose PREVIOUS session left
 * `hth-view` persisted as "compare" would, on a fresh session, have
 * `.map-frame` — and the splash inside it — hidden before ever seeing it.
 * Since the splash never shows, Explore can never be clicked, so
 * `dismiss()` never fires: `splashDismissed` never becomes true, the
 * auto-run gate withholds forever (shouldArmAutoRun above), and — since the
 * H2 gate fix — every control gated on `splashDismissed` (applyControlsEnabled/
 * applySplashInert below) stays disabled/inert for the rest of the session
 * too. A silent, total deadlock for exactly the visitors who opted into
 * Compare mode.
 *
 * The fix: while the splash hasn't been dismissed YET this pageview, the
 * view forcibly renders as Overlay — regardless of what's persisted — so
 * `.map-frame` (and the splash inside it) stays visible and reachable.
 * `viewMode` itself is never overwritten and nothing is re-saved to
 * localStorage: this only overrides what's APPLIED to the DOM while the
 * splash is pending, never the visitor's actual stored preference. The
 * instant `splashDismissed` flips true (dismiss(), below), calling
 * `applyViewMode()` again re-evaluates this function and the real
 * persisted mode takes over — Compare panels build for real at that point.
 * Pure so the override (and its own release once dismissed) is unit-
 * testable without any DOM/storage, same rationale as autoRunPins/
 * shouldArmAutoRun above. */
export function effectiveViewMode(mode: "overlay" | "compare", splashDismissed: boolean): "overlay" | "compare" {
  return splashDismissed ? mode : "overlay";
}

/** The full set of controls gated by (dataReady AND splashDismissed) --
 * everything that OPERATES the hidden map/race (H2 gate fix, a build-review
 * finding against the splash this subsumes into: ".splash only covers
 * .map-frame, so Routes chips and -- once data loads -- the Algorithms
 * toggles/View-toggle/Race-again stay visible and enabled regardless of
 * splash state"). Previously only the zoom trio routed through the AND of
 * both flags (updateMapControlsEnabled, replaced by applyControlsEnabled
 * below); Race-again and the two optional-racer toggles flipped
 * `disabled=false` on `dataReady` alone, and the route-preset chips had NO
 * `disabled` gating at all -- they relied purely on their own click
 * handler's silent `if (!graph) return` guard, which says nothing about
 * whether the splash is still covering the map. how-cta and the header nav
 * are deliberately NOT part of this set (build-review ruling): leaving to
 * /how/ or toggling the theme while the splash is up is legitimate, since
 * neither one operates the hidden map/race. */
export interface GatedControls {
  raceRun: HTMLButtonElement | null;
  /** The toggleable searcher rows (spec §18.3) — `role="button"` DIVs now,
   * not `<button>`s (their content includes flow children — .track,
   * .row-note — a button's content model doesn't strictly permit), so
   * gating them means `aria-disabled` + `tabindex`, not the native
   * `disabled` property. See `setDisabled` below for the branch. */
  rosterToggles: readonly HTMLElement[];
  /** The searchers-family bidirectional MODIFIER (spec §18.6) — a real
   * `<button>` living on the family bezel's own header, replacing the old
   * per-racer "Bidirectional" toggle this field used to name. */
  familyBidiToggle: HTMLButtonElement | null;
  viewToggle: HTMLButtonElement | null;
  zoomIn: HTMLButtonElement | null;
  zoomOut: HTMLButtonElement | null;
  zoomFit: HTMLButtonElement | null;
  routeChips: readonly HTMLButtonElement[];
}

/** Gates one element against `disabled`, branching on whether it's a real
 * button (native `disabled`) or a `role="button"` div (no such property —
 * `aria-disabled` carries the state for assistive tech, `tabIndex` removes
 * it from the Tab order the same way a disabled button already is). Both
 * branches leave the element inert to click/keydown too — the roster row's
 * own activate() handler (see wireRosterRowToggle) checks `aria-disabled`
 * itself before doing anything, so a div can't be "clicked" via mouse even
 * though nothing but `tabindex` stops a real disabled button natively.
 * `tagName`, not `instanceof HTMLButtonElement`: home.test.ts (deliberately,
 * see its own header comment) builds its fixture elements from a SEPARATE
 * `JSDOM` instance rather than a global jsdom environment, so those
 * elements' prototype chain runs through THAT window's own
 * HTMLButtonElement, not this module's ambient global (which doesn't even
 * exist in the plain-Node environment the rest of this file runs its pure
 * exports under) — the classic cross-realm `instanceof` pitfall. `tagName`
 * is a plain string property, unaffected by which realm the element came
 * from, and works identically in a real browser. */
function setDisabled(el: HTMLElement | null | undefined, disabled: boolean): void {
  if (!el) return;
  if (el.tagName === "BUTTON") {
    (el as HTMLButtonElement).disabled = disabled;
  } else {
    el.setAttribute("aria-disabled", String(disabled));
    el.tabIndex = disabled ? -1 : 0;
  }
}

/** Applies the (dataReady AND splashDismissed) gate's disabled state to
 * every control in `GatedControls` -- ONE function so a control can never
 * again be wired to `dataReady` alone (the bug this fixes). boot() calls
 * this from three places -- the data-ready success path, once at boot for
 * an already-dismissed session, and dismiss() -- see each call site's own
 * comment for why that particular recompute is needed. Parameterized (no
 * closure over boot()'s own mutable state), same reason autoRunPins/
 * shouldArmAutoRun above are pulled out of boot() as plain exports: this
 * one isn't pure (it mutates the elements it's given), but it's still
 * fully deterministic from its three arguments alone, so it's
 * unit-testable against a plain constructed DOM without any of boot()'s
 * canvas/Worker/fetch machinery. */
export function applyControlsEnabled(controls: GatedControls, dataReady: boolean, splashDismissed: boolean): void {
  const ready = dataReady && splashDismissed;
  setDisabled(controls.raceRun, !ready);
  for (const el of controls.rosterToggles) setDisabled(el, !ready);
  setDisabled(controls.familyBidiToggle, !ready);
  setDisabled(controls.viewToggle, !ready);
  setDisabled(controls.zoomIn, !ready);
  setDisabled(controls.zoomOut, !ready);
  setDisabled(controls.zoomFit, !ready);
  for (const chip of controls.routeChips) setDisabled(chip, !ready);
}

/** Focus containment while the splash is visible (H2 gate fix): with no
 * trap, review found a keyboard user could Tab straight past Explore to a
 * live Race-again and fire a real race whose map result is hidden behind
 * the still-open splash. `inert` -- stronger than `disabled` alone, since a
 * screen reader's own browse-mode cursor can still land on (and announce) a
 * merely-disabled control -- removes each target from the Tab order AND the
 * accessibility tree entirely while `splashDismissed` is false, restored
 * the instant it's true.
 *
 * Targets the four board-panel leaf controls directly, NOT `.board` as a
 * whole: `.board` also contains how-cta, which the same build-review ruling
 * keeps reachable while the splash is up, and `inert` has no per-descendant
 * opt-out once set on an ancestor -- inerting `.board` would trap how-cta
 * too. `routesContainer` (`.controls`, the routes-chip group's own wrapper)
 * has no such exception, so it's inerted as one whole container instead of
 * listing every chip. The zoom trio and the splash's own content are
 * deliberately left out here: the zoom trio is already correctly gated
 * (via applyControlsEnabled above) and, like the splash's own reachable
 * content (Explore, the copy), lives inside `.map-frame` where a careless
 * container-level inert would trap the splash itself -- out of scope for
 * the reported finding, which named the board panel and the routes group
 * specifically. */
export interface SplashInertTargets {
  raceRun: HTMLButtonElement | null;
  rosterToggles: readonly HTMLElement[];
  familyBidiToggle: HTMLButtonElement | null;
  viewToggle: HTMLButtonElement | null;
  routesContainer: HTMLElement | null;
}

export function applySplashInert(targets: SplashInertTargets, splashDismissed: boolean): void {
  const gated = !splashDismissed;
  if (targets.raceRun) targets.raceRun.inert = gated;
  for (const el of targets.rosterToggles) el.inert = gated;
  if (targets.familyBidiToggle) targets.familyBidiToggle.inert = gated;
  if (targets.viewToggle) targets.viewToggle.inert = gated;
  if (targets.routesContainer) targets.routesContainer.inert = gated;
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
  zoomFit: HTMLButtonElement;
}

interface PanelDom {
  el: HTMLElement;
  base: HTMLCanvasElement;
  overlay: HTMLCanvasElement;
  zoomFit: HTMLButtonElement;
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
 * single code path that fills the scoreboard row), and its own zoom
 * fit/in/out buttons — F2's interactions must work identically inside every
 * panel, zoom buttons included, so every panel gets a real, independently
 * labelled set rather than sharing the single map's buttons (G2 fix, review
 * finding #2: the overlay's own zoom-fit button lives in `.map-frame`,
 * which applyViewMode() hides in Compare mode, so without a panel-local one
 * the one-shot A-B/whole-map reframe was unreachable while comparing).
 * `zoomFit`'s label/aria-label are left for updateFitButton() to set
 * (mirrors `fitShowsWhole`, a boot()-level flag every panel shares — see
 * that function's own comment) but start matching the DEFAULT state
 * (fitShowsWhole=true, same default index.html's own static button ships
 * with) so there's no unlabelled flash before that first call. */
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
  // Same class as the overlay's own [data-testid="zoom-fit"] (index.html) so
  // it picks up identical styling for free (styles.css's .zoom-fit-btn/
  // .zoom-btn rules are class-scoped, not scoped to .map-frame — see
  // .compare-grid-quad .zoom-btn, which already resizes every .zoom-btn
  // inside a panel, this one included). "zoom-fit-panel" (not "zoom-fit")
  // keeps the overlay's own spec-tested testid unique to it.
  const zoomFit = document.createElement("button");
  zoomFit.type = "button";
  zoomFit.className = "zoom-btn zoom-fit-btn";
  zoomFit.dataset.testid = "zoom-fit-panel";
  zoomFit.textContent = "Map";
  zoomFit.setAttribute("aria-label", `Zoom to whole map (${ALGO_LABEL[algo]})`);
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
  zoomWrap.append(zoomFit, zoomIn, zoomOut); // fit ABOVE the in/out pair, matching the overlay's own stack order (index.html)
  el.append(zoomWrap);

  return { el, base, overlay, zoomFit, zoomIn, zoomOut };
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
  // Typed HTMLElement (not the bare Element a plain querySelector call
  // infers) because dismiss() below calls .focus() on it directly — the
  // static tabindex="-1" in index.html is what makes that focus call land
  // without also pulling race-canvas into the normal Tab order.
  const stack = document.querySelector<HTMLElement>('[data-testid="race-canvas"]');
  const mapFrame = document.querySelector<HTMLElement>(".map-frame");
  const compareGrid = document.querySelector<HTMLElement>('[data-testid="compare-panels"]');
  const loadNote = document.getElementById("load-note");
  const splashEl = document.querySelector<HTMLElement>('[data-testid="splash"]');
  const exploreBtn = document.querySelector<HTMLButtonElement>('[data-testid="explore"]');
  const raceRunBtn = document.querySelector<HTMLButtonElement>('[data-testid="race-run"]');
  // Roster round (spec §18): the panel is built from src/race/roster.ts's
  // own ROSTER array, not two hand-named toggles any more -- every
  // NON-CORE entry (the three A* variants) gets its row looked up by its
  // OWN `data-algo` id, so this list grows/shrinks with the roster itself
  // rather than needing a matching edit here if the roster ever changes.
  const rosterToggleEls = ROSTER.filter((r) => !r.core).map(
    (r) => document.querySelector<HTMLElement>(`.board .row[data-algo="${r.id}"]`),
  ).filter((el): el is HTMLElement => el !== null);
  const familyBezelEl = document.querySelector<HTMLElement>('[data-family="searchers"]');
  const familyBidiToggle = document.querySelector<HTMLButtonElement>('[data-testid="bidi-toggle"]');
  const zoomInBtn = document.querySelector<HTMLButtonElement>('[data-testid="zoom-in"]');
  const zoomOutBtn = document.querySelector<HTMLButtonElement>('[data-testid="zoom-out"]');
  const zoomFitBtn = document.querySelector<HTMLButtonElement>('[data-testid="zoom-fit"]');
  const viewToggleBtn = document.querySelector<HTMLButtonElement>('[data-testid="view-toggle"]');
  const sizeToggleBtn = document.querySelector<HTMLButtonElement>('[data-testid="size-toggle"]');
  const raceLayoutEl = document.querySelector<HTMLElement>(".race-layout");
  // H2 gate fix: the routes/controls wrapper (the inert target below) and
  // every route-preset chip (a disabled-gate target) -- one shared class
  // (`.route-chip`, index.html) picks up all six regardless of whether each
  // ships a `data-testid` or a `data-preset` attribute, same convention
  // presetButton() below already relies on for click wiring.
  const controlsEl = document.querySelector<HTMLElement>(".controls");
  const routeChipEls = [...document.querySelectorAll<HTMLButtonElement>(".route-chip")];

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
  // mechanism. §16.11: the store is now geo-anchored ({cLon,cLat,span}),
  // which needs a real bbox to mean anything — created once render.json
  // resolves (see renderReady below), not here, since nothing can reach it
  // before then anyway (every use site below is guarded by data having
  // loaded — see e.g. the preset handlers' `!graph` guard, extended to
  // `!viewStore`).
  let viewStore: ViewStore | undefined;
  let view: MapView | undefined;
  let controller: RaceController | undefined;
  let graph: Graph | undefined;
  let renderData: RenderData | undefined;
  let pinA: number | null = null;
  let pinB: number | null = null;
  let viewMode: "overlay" | "compare" = loadViewMode();
  let panels: PanelEntry[] = [];
  // Splash (third build review §17.3) — see the dedicated section below
  // (after `scheduler` is defined, since maybeArmAutoRun needs it).
  let splashDismissed = false; // true once the splash is confirmed gone this pageview — either restored from a prior dismissal this session, or set live by dismiss()
  let dataReady = false; // Promise.all(renderReady, routingReady) has resolved
  let autoRunArmed = false; // guards the auto-run setTimeout from ever being scheduled twice

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
  //
  // §16.6 (A-B auto-zoom): this IS the single call site every race-start
  // trigger funnels through (scheduler.now()'s callers directly,
  // scheduler.schedule()'s callers once its debounce timer fires) — so
  // framing the view here, before dispatching the race, is what makes
  // presets/surprise/"R"/auto-run/drag-drop-rerun all "inherit" the auto-zoom
  // for free, per the task's own requirement, without each trigger needing
  // its own copy of this call. Runs before `controller?.run()` (not after)
  // so the view re-frames immediately when the race starts, not once the
  // worker round-trip finishes.
  //
  // zoomToBounds now needs a REFERENCE panel's own w/h to compute accurate
  // padding against (G2 fix, review finding #1 — see that function's own
  // comment) — referenceViewport() (below) reads it off whichever view is
  // currently live. review finding #3: this reframe happens OUTSIDE the fit
  // button's own click handler, so fitShowsWhole is set directly too —
  // without it, the button's state goes stale after a race (still believes
  // the view is at its PRE-race framing), so the first fit-press after a
  // race could silently re-request the SAME A-B framing this auto-zoom just
  // applied — a no-op click.
  const scheduler = makeRaceScheduler((a, b) => {
    if (viewStore && renderData && graph) {
      const ref = referenceViewport();
      if (ref) {
        viewStore.set(zoomToBounds(renderData.bbox, graph.lon[a], graph.lat[a], graph.lon[b], graph.lat[b], ref.w, ref.h));
        fitShowsWhole = true; // the view is now definitively at A-B bounds -- next press should offer "whole map"
        updateFitButton();
      }
    }
    controller?.run(a, b).catch(handleRaceError);
  }, DEBOUNCE_MS);

  function scheduleRace(): void {
    if (pinA === null || pinB === null) return;
    scheduler.schedule(pinA, pinB);
  }

  // ------------------------------------------------------------------
  // Splash (third build review §17.3): a full-map gate that replaces the
  // old map-corner title/description overlay (removed from index.html and
  // styles.css along with this feature — see the .splash rule's own
  // comment). Shown once; "Explore the race →" (click, or Enter/Space via
  // native button semantics — no extra key handling needed for those two),
  // or Escape anywhere, dismisses it for the rest of THIS session
  // (sessionStorage, not localStorage — a fresh tab sees it again,
  // matching a "welcome screen" rather than a permanent preference). The
  // desktop auto-run, the map-frame's zoom buttons, and — since a
  // build-review gate pass (H2 fix) found they weren't — every other
  // control that OPERATES the hidden map/race (Race-again, the two
  // optional-racer toggles, the view-mode toggle, every route-preset chip)
  // all stay gated until dismissal too: `disabled` (applyControlsEnabled)
  // removes each from the Tab order and click reach, and `inert`
  // (applySplashInert) additionally removes the board-panel/routes-group
  // subset from the accessibility tree for the same window, a focus trap
  // with no manual keydown cycling needed. how-cta and the header nav are
  // the deliberate exception — leaving to /how/ or toggling the theme
  // under the splash is legitimate (build-review ruling), so neither is
  // gated or inerted.
  // ------------------------------------------------------------------

  const SPLASH_KEY = "hth-splash";

  // Same guarded try/catch pattern as theme.ts's own safeGetItem/
  // safeSetItem (private-mode/storage-disabled browsers throw on ANY
  // storage access) — sessionStorage instead of localStorage since
  // dismissal is a per-tab-session thing, not a persisted preference.
  function safeSessionGet(key: string): string | null {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function safeSessionSet(key: string, value: string): void {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      /* storage unavailable — the splash still dismisses in-memory for this pageview */
    }
  }

  // Shared control set for the two gate functions above (H2 gate fix):
  // built once here, since none of these element references ever change
  // for the life of the page — only their `disabled`/`inert` state does,
  // via the two thin wrapper functions below, called wherever `dataReady`
  // or `splashDismissed` changes (three call sites — see each one's own
  // comment for why that particular recompute is needed).
  const gatedControls: GatedControls = {
    raceRun: raceRunBtn,
    rosterToggles: rosterToggleEls,
    familyBidiToggle,
    viewToggle: viewToggleBtn,
    zoomIn: zoomInBtn,
    zoomOut: zoomOutBtn,
    zoomFit: zoomFitBtn,
    routeChips: routeChipEls,
  };
  const splashInertTargets: SplashInertTargets = {
    raceRun: raceRunBtn,
    rosterToggles: rosterToggleEls,
    familyBidiToggle,
    viewToggle: viewToggleBtn,
    routesContainer: controlsEl,
  };

  function updateControlsEnabled(): void {
    applyControlsEnabled(gatedControls, dataReady, splashDismissed);
  }

  function updateSplashInert(): void {
    applySplashInert(splashInertTargets, splashDismissed);
  }

  // Reads the live DOM/timer state into shouldArmAutoRun's four pure
  // booleans and, if it says go, arms the ONE setTimeout. Reduced motion
  // is unaffected: this only decides WHEN the timer is armed, not how the
  // race it eventually triggers renders (that split lives entirely in
  // controller.ts, untouched here).
  function maybeArmAutoRun(): void {
    if (!shouldArmAutoRun(dataReady, splashDismissed, autoRunArmed, matchMedia("(min-width: 940px)").matches)) return;
    autoRunArmed = true;
    setTimeout(() => {
      const pins = autoRunPins(pinA, pinB);
      if (pins) scheduler.now(pins[0], pins[1]);
    }, AUTO_RUN_MS);
  }

  function dismiss(): void {
    if (!splashEl || splashEl.hidden) return;
    splashEl.hidden = true;
    splashDismissed = true;
    safeSessionSet(SPLASH_KEY, "1");
    updateControlsEnabled(); // H2 gate fix: was updateMapControlsEnabled() (zoom-only) -- now the full gated set
    updateSplashInert(); // H2 gate fix: releases focus containment now that the splash is actually gone
    // H5 gate fix: re-applies view mode now that effectiveViewMode() is no
    // longer forced to "overlay" -- restores the visitor's own persisted
    // Compare preference (if any), building the real panel set via
    // syncPanels() if data is ready by now (a no-op harmlessly deferred to
    // the data-ready success path's own applyViewMode() call otherwise --
    // see effectiveViewMode's own comment for the full deadlock this closes).
    applyViewMode();
    maybeArmAutoRun();
    // Moves focus to whichever map region the above just made visible --
    // the overlay's race-canvas (static tabindex="-1") normally, or the
    // compare grid (same static tabindex="-1", index.html) when the
    // restored mode is Compare, since a hidden .map-frame can't receive a
    // real .focus() call (§17.3's own "focus moves to the map region").
    (viewMode === "compare" ? compareGrid : stack)?.focus();
  }

  if (safeSessionGet(SPLASH_KEY) === "1") {
    // Pre-dismissed earlier this session: start hidden with no animation
    // or flash — index.html's own inline head script already stamped
    // `data-splash-dismissed` on <html> before first paint for the CSS
    // half of that; setting `hidden` here is the JS-observable half that
    // updateControlsEnabled/updateSplashInert/maybeArmAutoRun actually read.
    splashDismissed = true;
    if (splashEl) splashEl.hidden = true;
  } else {
    // First splash this session: autofocus the primary action — a real,
    // enabled, on-screen button, safe to autofocus — so keyboard use
    // starts right where a mouse visitor's eye lands.
    exploreBtn?.focus();
  }
  // H2 gate fix: recompute both gates right away too (boot-with-
  // predismissed-session), not only at data-ready or inside dismiss() — a
  // session that starts already-dismissed (splashDismissed=true above,
  // before dataReady is ever true) must release the inert trap immediately
  // rather than wait for a call site that may never fire this pageview
  // (dismiss() can't — the splash is already gone) or fires much later
  // (data-ready). On the OTHER branch (fresh splash) updateControlsEnabled
  // is a no-op (matches what index.html already ships disabled) but
  // updateSplashInert still does real first-time work, since `inert` —
  // unlike `disabled` — isn't part of the static markup (see
  // applySplashInert's own comment for why: no pre-paint flash to guard
  // against the way the theme/splash-dismissed CSS stamps need).
  updateControlsEnabled();
  updateSplashInert();

  exploreBtn?.addEventListener("click", dismiss);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") dismiss();
  });

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

  // The overlay-resync subscription itself is registered once `viewStore`
  // exists (see renderReady below) — ONE subscription drives every view's
  // overlay resync regardless of how many MapViews currently share
  // viewStore (1 in overlay mode, 2-4 panels in Compare), deliberately a
  // single store-level subscription rather than one registered per MapView:
  // each MapView already redraws its OWN base layer from its own store
  // subscription (see mapRenderer.ts), but also hanging a full pins+frame
  // overlay resync off every one of those would re-run it once PER PANEL
  // per change — O(panels^2) work for one pan/zoom tick instead of
  // O(panels).
  //
  // §16.9 note (the overlay-lag bug): this subscription and each MapView's
  // own are still two separately-registered callbacks on the same store —
  // that used to matter (whichever ran first read a stale cached
  // transform); it no longer does, because MapView derives its transform
  // fresh from the store on every draw call instead of caching one inside
  // its subscription callback (see mapRenderer.ts's MapView class comment
  // for the full root-cause writeup). This subscription's registration
  // timing (now deferred until viewStore exists, see below — previously
  // synchronous here, before any MapView existed) is no longer
  // load-bearing for correctness, only for "don't touch viewStore before
  // it exists".

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

  // §16.7: the fit-toggle button above the zoom pair — a one-shot re-frame
  // action, not a mode lock (manual pan/zoom after a press just moves
  // freely; the next press still re-frames from scratch). Its own state is
  // only "which target does the NEXT press give", flipped on every click —
  // it does not track or reflect whatever the live view actually shows,
  // EXCEPT where a reframe happens OUTSIDE this button's own click handler
  // (the race-start auto-zoom in the scheduler callback above, §16.6) —
  // that call site sets fitShowsWhole directly too, for the same reason
  // (G2 fix, review finding #3): without it, the first fit-press after a
  // race could silently re-request the SAME A-B framing the race's own
  // auto-zoom already applied, a no-op click.
  let fitShowsWhole = true; // starts by offering "whole map" -- the natural complement to every race's own auto-zoom-to-AB (§16.6)

  // Reads the CSS-px viewport size zoomToBounds should compute ~15% padding
  // AGAINST (G2 fix, review finding #1 — see that function's own comment):
  // the first currently-active view, i.e. the single overlay in Overlay
  // mode, or the first Compare panel in Compare mode — deliberately never
  // measures the overlay canvas directly, since it's `display:none` (0x0)
  // while Compare mode is active, the exact hidden-panel scenario
  // mapRenderer.ts's clampGeoView/zoomAbout/panGeo guards exist for (see
  // that file's own MapView class comment). Every Compare panel shares one
  // CSS aspect-ratio (styles.css's `.compare-panel { aspect-ratio: 4/3 }`),
  // so this is exact for whichever panel is chosen and close (not
  // bit-identical, if panels differ in absolute pixel size) for the rest.
  function referenceViewport(): { w: number; h: number } | undefined {
    return activeViews()[0]?.viewportSize();
  }

  // Applies the CURRENT fitShowsWhole state's label/aria-label to the
  // overlay's own fit button AND every Compare panel's fit button (G2 fix,
  // review finding #2 — buildPanelDom's own zoomFit field) so every surface
  // agrees, never a stale label on a panel built before the last toggle.
  function updateFitButton(): void {
    const label = fitShowsWhole ? "Map" : "AB";
    const aria = fitShowsWhole ? "Zoom to whole map" : "Zoom to fit the route";
    if (zoomFitBtn) {
      zoomFitBtn.textContent = label;
      zoomFitBtn.setAttribute("aria-label", aria);
    }
    for (const p of panels) {
      p.zoomFit.textContent = label;
      p.zoomFit.setAttribute("aria-label", `${aria} (${ALGO_LABEL[p.algo]})`);
    }
  }

  // The shared one-shot reframe action (G2 fix, review finding #2): both the
  // overlay's own button and every Compare panel's button (wired in
  // syncPanels, below) call this, so the SAME fitShowsWhole flag and the
  // SAME shared viewStore govern every surface — pressing fit in one panel
  // reframes (and relabels) all of them, the same way pan/zoom already
  // share one store across every panel.
  function triggerFit(): void {
    if (!viewStore || !renderData || !graph || pinA === null || pinB === null) return;
    if (fitShowsWhole) {
      viewStore.set(wholeMapView(renderData.bbox));
    } else {
      const ref = referenceViewport();
      if (!ref) return;
      viewStore.set(
        zoomToBounds(renderData.bbox, graph.lon[pinA], graph.lat[pinA], graph.lon[pinB], graph.lat[pinB], ref.w, ref.h),
      );
    }
    fitShowsWhole = !fitShowsWhole;
    updateFitButton();
  }
  updateFitButton();
  zoomFitBtn?.addEventListener("click", triggerFit);

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

  // Widened locally rather than editing controller.ts's own `RaceUi`
  // (READ-ONLY this round — src/race/controller.ts is the sibling
  // implementer's file, landing the multi-heuristic roster + per-racer
  // route-delta plumbing concurrently in this same checkout). `extends`
  // rather than a bare object type so every OTHER member still gets
  // contextual parameter typing from the real `RaceUi` below, and so this
  // stays correct whichever side of that concurrent edit is checked out
  // when this file builds: before it lands, `RaceUi` simply has no
  // `setRowDelta` yet and this only ADDS the optional member; once it
  // lands with a compatible signature, this declaration is redundant but
  // harmless (TS methods compare parameters bivariantly, so `id: string`
  // stays assignable even if the landed signature narrows it to the
  // roster's own id union). The I3 gate reconciles the exact contract.
  interface ExtendedRaceUi extends RaceUi {
    setRowDelta?(id: string, pct: number): void;
  }
  const ui: ExtendedRaceUi = {
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
    setRowDelta(id, pct) {
      // Spec §18.4's honesty rule: a disclosed variant's row must SAY SO
      // live, "+X% longer route" — computed from measured distances by the
      // controller/worker (this file's own concern is only rendering
      // whatever it's told). Honest-empty by construction: pct<=0 (this
      // race's route WAS optimal, or the racer isn't disclosed) clears the
      // slot back to nothing rather than ever printing "+0% longer route",
      // matching styles.css's own `:not(:empty)` visibility gate on
      // `.row-delta` — an empty slot collapses out of the layout instead
      // of reserving dead space.
      const row = document.querySelector(`.board .row[data-algo="${id}"]`);
      const delta = row?.querySelector<HTMLElement>(".row-delta");
      if (delta) delta.textContent = pct > 0 ? `+${pct.toFixed(0)}% longer route` : "";
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
      // only — a pin placed while the map is zoomed/panned somewhere else
      // must still end up visible. §16.6 superseded the old
      // `viewStore.set({scale:1,...})` reset-to-whole-map here: the
      // scheduler's own callback (see makeRaceScheduler above) now frames
      // the A-B bounds with padding on EVERY race start, presets included —
      // a strictly better "make the pins visible" than a flat reset, so
      // this handler no longer needs its own view call at all.
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
    drawAllPinsOnly(); // see the preset handler above for why no view call is needed here either
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
    // `!viewStore` guards the same "data not loaded yet" window as the rest
    // of this condition (viewStore is created alongside renderData — see
    // renderReady below) — belt-and-braces so a Compare panel can never be
    // constructed with `viewStore` undefined, which would silently fall
    // back to MapView's OWN private per-instance store (its `store ??
    // createViewStore(...)` default) instead of the shared one, breaking
    // Compare mode's whole pan/zoom-sync mechanism for that panel.
    if (!compareGrid || !renderData || !graph || !controller || !viewStore) return;
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
      dom.zoomFit.addEventListener("click", triggerFit); // G2 fix (review finding #2): same one-shot reframe the overlay's own button uses
      panelResizeObserver?.observe(dom.el);
      byAlgo.set(algo, { algo, el: dom.el, view: panelView, zoomFit: dom.zoomFit });
    }

    panels = next.map((algo) => byAlgo.get(algo)).filter((p): p is PanelEntry => p !== undefined);
    for (const p of panels) compareGrid.append(p.el); // re-append in `next`'s order (relocates existing nodes too)
    // §16.10 review round 2: (re)assign every CURRENTLY-live panel's base-
    // layer re-stroke stagger from its position in `panels` (mapRenderer.ts's
    // own assignStaggerSlots) — not only the newly-added ones. The old
    // construction-time-only assignment (MapView's own mapViewSequence
    // default) could hand a REBUILT panel (this function is diff-based — a
    // racer toggled off then back on really does construct a new MapView)
    // the same slot a still-live sibling already holds; recomputing from the
    // live roster on every call makes that structurally impossible (see
    // assignStaggerSlots' own comment), and covers a KEPT panel's slot
    // shifting too (e.g. CH's own position shifts whenever astar/bidi toggle
    // around it in ROSTER order).
    const staggerSlots = assignStaggerSlots(panels.map((p) => p.algo));
    for (const p of panels) p.view.setStaggerSlot(staggerSlots.get(p.algo) ?? 0);
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
    updateFitButton(); // newly-built panels' fit buttons start correctly labelled for the CURRENT fitShowsWhole state (G2 fix)
  }

  /** Applies `viewMode` to the DOM (map-frame vs. compare-grid visibility,
   * the toggle button's label/aria-pressed) and to the panel set. Called
   * once immediately (before data exists — syncPanels() no-ops safely, see
   * its own guard) so the static layout is never wrong even during the
   * loading state, again once data/controller are ready (this time
   * syncPanels() actually builds panels if the persisted mode is
   * "compare"), and on every view-toggle click. */
  function applyViewMode(): void {
    // H5 gate fix: routed through effectiveViewMode(), not raw `viewMode`
    // directly -- see that function's own comment for the persisted-Compare
    // splash deadlock this closes. `compare` now drives every DOM
    // consequence below (including the toggle button's own label), so
    // there's exactly one source of truth for "what does the page look like
    // right now" -- never a stale label out of step with what's actually
    // shown while the splash is pending.
    const compare = effectiveViewMode(viewMode, splashDismissed) === "compare";
    if (mapFrame) mapFrame.hidden = compare;
    if (compareGrid) compareGrid.hidden = !compare;
    if (viewToggleBtn) {
      viewToggleBtn.setAttribute("aria-pressed", String(compare));
      viewToggleBtn.textContent = `View: ${compare ? "compare" : "overlay"}`;
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

  // Roster round (spec §18.3/.6): every toggleable searcher row and the
  // family-wide bidirectional modifier get a real aria-pressed control now
  // (superseding build-review §16.1/§16.5's per-racer toggle switch) —
  // Dijkstra/CH have no equivalent, they race unconditionally, the
  // disable-proof core comparison. A loosely-typed view of `controller`
  // (see ControllerApiShim below) is how this file calls into the
  // sibling's concurrently-landing controller.ts API without depending on
  // its exact (still-changing) method signatures — every call is optional
  // chained, so it's a harmless no-op until that wiring lands, and the I3
  // gate reconciles the exact contract once both sides are merged.
  interface ControllerApiShim {
    setAlgoActive?: (id: string, active: boolean) => void;
    setRacerActive?: (id: string, active: boolean) => void;
    setBidiActive?: (active: boolean) => void;
    setFamilyBidi?: (active: boolean) => void;
  }
  function controllerApi(): ControllerApiShim | undefined {
    return controller as unknown as ControllerApiShim | undefined;
  }

  /** Wires ONE toggleable searcher row. It's a `role="button"` div, not a
   * real `<button>` (its content includes flow children — .track,
   * .row-note, .row-delta — a button's content model doesn't strictly
   * permit, and spec §18.3 explicitly sanctions "button or role=button"
   * for exactly this reason), so unlike a real button it gets no native
   * Enter/Space activation — both paths funnel through the same
   * `activate` so aria-pressed/data-active/the controller call/the
   * re-race can never drift between the two input methods. `node` (not
   * the parameter directly) so the null-check above narrows correctly
   * inside the nested closures regardless of TS's cross-closure narrowing
   * rules for reassignable bindings. */
  function wireRosterRowToggle(el: HTMLElement | null, id: string): void {
    if (!el) return;
    const node = el;
    function activate(): void {
      if (node.getAttribute("aria-disabled") === "true") return;
      const active = node.getAttribute("aria-pressed") !== "true";
      node.setAttribute("aria-pressed", String(active));
      node.dataset.active = String(active);
      const api = controllerApi();
      api?.setAlgoActive?.(id, active);
      api?.setRacerActive?.(id, active);
      if (viewMode === "compare") syncPanels();
      if (pinA !== null && pinB !== null) scheduler.now(pinA, pinB); // direct trigger: cancels any pending debounce
    }
    node.addEventListener("click", activate);
    node.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault(); // Space must not also scroll the page
      activate();
    });
  }
  for (const entry of ROSTER.filter((r) => !r.core)) {
    wireRosterRowToggle(document.querySelector<HTMLElement>(`.board .row[data-algo="${entry.id}"]`), entry.id);
  }

  /** The searchers-family bidirectional MODIFIER (spec §18.6): a real
   * button on the bezel's own header, not a per-racer toggle — flips
   * every ACTIVE family member's form for the next race. `data-bidi` on
   * the bezel itself (styles.css) is what shows/hides each active row's
   * own ⇄ marker. */
  function wireFamilyBidiToggle(btn: HTMLButtonElement | null, bezel: HTMLElement | null): void {
    btn?.addEventListener("click", () => {
      const active = btn.getAttribute("aria-pressed") !== "true";
      btn.setAttribute("aria-pressed", String(active));
      bezel?.setAttribute("data-bidi", String(active));
      const api = controllerApi();
      api?.setBidiActive?.(active);
      api?.setFamilyBidi?.(active);
      if (viewMode === "compare") syncPanels();
      if (pinA !== null && pinB !== null) scheduler.now(pinA, pinB);
    });
  }
  wireFamilyBidiToggle(familyBidiToggle, familyBezelEl);

  // Size control (spec §18.9): "current" (default) vs "adaptive" — a pure
  // layout preference, same category as the theme toggle, so unlike
  // view-toggle it's deliberately left OUTSIDE the splash/data gating
  // (GatedControls above): it doesn't operate the hidden map/race any more
  // than switching themes under the splash does. Persisted the same
  // guarded try/catch way as `hth-view`/`hth-theme` — private-mode/
  // storage-disabled browsers throw on ANY localStorage access, and
  // cycling should still work in-memory when that happens.
  const SIZE_KEY = "hth-size";

  function loadSizeMode(): "current" | "adaptive" {
    try {
      return localStorage.getItem(SIZE_KEY) === "adaptive" ? "adaptive" : "current";
    } catch {
      return "current";
    }
  }

  function saveSizeMode(mode: "current" | "adaptive"): void {
    try {
      localStorage.setItem(SIZE_KEY, mode);
    } catch {
      /* storage unavailable — cycling still works in-memory */
    }
  }

  let sizeMode: "current" | "adaptive" = loadSizeMode();

  function applySizeMode(): void {
    raceLayoutEl?.classList.toggle("is-adaptive", sizeMode === "adaptive");
    if (sizeToggleBtn) {
      sizeToggleBtn.setAttribute("aria-pressed", String(sizeMode === "adaptive"));
      sizeToggleBtn.textContent = `Size: ${sizeMode}`;
    }
  }
  applySizeMode();

  sizeToggleBtn?.addEventListener("click", () => {
    sizeMode = sizeMode === "adaptive" ? "current" : "adaptive";
    saveSizeMode(sizeMode);
    applySizeMode();
    // No explicit resize call needed: relaxing/restoring .race-layout's
    // max-width reflows the map-stack element the existing ResizeObserver
    // (further up boot()) already watches, which repaints the base layer
    // and every active overlay at the new box size on its own.
  });

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
    // Created here, not at the top of boot(): a geo-anchored store (§16.11)
    // needs a real bbox to have a meaningful identity value, and render.bbox
    // is exactly what wasn't available yet up there. Nothing earlier in
    // boot() could have reached `viewStore` anyway (every use site is
    // guarded the same way `graph`/`renderData` already are), so this is a
    // pure "construct it once the data it needs exists" move, not a
    // behavior change.
    viewStore = createViewStore(wholeMapView(render.bbox));
    viewStore.subscribe(() => syncAllOverlays());
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
      dataReady = true;
      // H2 gate fix: ONE call now gates race-run, every toggleable roster
      // row, the family bidi modifier, the view-mode toggle, every
      // route-preset chip, and the zoom trio together on (dataReady AND
      // splashDismissed) — previously
      // these flipped `disabled=false` on `dataReady` alone (the exact
      // review finding this fixes: a keyboard user could Tab past Explore
      // straight to a live Race-again while the splash was still up).
      // Route chips get real `disabled` gating for the first time here
      // too, not just their own click handler's silent `if (!graph)
      // return` guard, which never accounted for the splash at all. See
      // GatedControls/applyControlsEnabled's own comment for the full
      // reasoning (why toggle buttons specifically can't rely on a silent
      // guard the way a preset's OWN handler used to).
      updateControlsEnabled();

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

      // Desktop-only 1.5s idle auto-run (design spec §5.1): arms now if
      // the splash is ALSO already dismissed, else waits for dismiss() to
      // call this same function again — see maybeArmAutoRun's own comment.
      maybeArmAutoRun();
    })
    .catch((err: unknown) => {
      loadFailed = true;
      console.error("failed to load map/routing data", err);
      if (loadNote) loadNote.textContent = "failed to load the map — reload to retry";
      // F6 gate fix (still relevant post-§17.3): a visitor whose LAST
      // session left view mode persisted as "compare" (loadViewMode(),
      // above) hits this catch with compareGrid still showing the EMPTY
      // `.is-loading` placeholder — syncPanels() needs `controller`/
      // `graph`, neither of which this failure path ever sets, so it can
      // never populate real panels. Left alone, that's a permanently
      // blank box AND — since the splash now lives INSIDE .map-frame,
      // hidden along with it whenever `mapFrame.hidden` is true — no
      // splash/h1 either, i.e. a failure state that reads as a broken
      // blank page instead of an honest one. Falling back to the overlay
      // DOM state re-shows whatever base map DID load (render.json is
      // independent of routing.json) and the splash (if not yet
      // dismissed), through the exact same applyViewMode() the success
      // path uses — safe here since its non-compare branch only touches
      // `panels` (still empty), `controller`/`graph` (both
      // optionally-chained/guarded), and `view` (already constructed if
      // renderReady won this race). Deliberately
      // NOT persisted (no saveViewMode call): this only steadies the
      // FAILURE view, so a reload that succeeds still restores the
      // visitor's actual compare preference via the normal load path.
      if (viewMode === "compare") {
        viewMode = "overlay";
        applyViewMode();
      }
    });
}

// Guarded (not a bare call) so this module is safely importable from a
// plain Node test environment (no `document`) to reach the pure exports
// (`autoRunPins`, `diffPanels`) alone — same "don't assume a browser global
// exists" idiom this file already uses for `typeof ResizeObserver !==
// "undefined"` above. Always true, so always runs, on any real page load.
if (typeof document !== "undefined") boot();
