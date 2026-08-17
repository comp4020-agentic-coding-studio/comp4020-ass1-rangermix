// Mostly pure-function tests. home.ts's `boot()` itself is the DOM-wiring
// half (real canvas/Worker/matchMedia/timers) — untested here by design,
// same rationale as controller.ts's stateful class and mapRenderer.ts's
// MapView (verified by eye once wired into the page, per those files' own
// comments). `autoRunPins`, `shouldArmAutoRun`, and `diffPanels` are pure
// (no DOM, no matchMedia, no timer) so they're tested below with plain
// values — the DOM-observing glue that feeds them live values (boot()'s
// maybeArmAutoRun) stays untested here like the rest of boot().
// `applyControlsEnabled`/`applySplashInert` (H2 gate fix) are the one
// exception: they DO mutate real DOM elements — that's the whole point of
// the review finding they fix — but are still parameterized (no closure
// over boot()'s own mutable state), so a plain constructed DOM tree is
// enough to exercise them directly, no canvas/Worker/fetch needed.
// Deliberately NOT switched to a jsdom test environment file-wide (the
// docblock idiom theme.test.ts/controller.test.ts use — naming it plainly
// here rather than spelling out that exact magic comment, since Vitest's
// own scanner for it isn't scoped to a leading comment block and will
// arm on the phrase anywhere in the file, comments included, which is
// it self a trap worth flagging for the next person tempted to paste
// that idiom into this particular file): that would stamp a real
// `document` onto this file's global scope, which would trip home.ts's
// own `if (typeof document !== "undefined") boot()` at the bottom of the
// file — the exact guard that exists so this module stays safely
// importable from a plain Node test environment (see that line's own
// comment) — and run the FULL page boot (matchMedia, canvas, fetch,
// Worker, none of it mocked here) as a side effect of merely importing
// "./home" up above. Instead, the one block below that needs real
// elements builds its own throwaway document via the `jsdom` package
// directly (already a devDependency; same technique
// spec/highway-to-hill.test.ts already uses for parsing built HTML) — a
// `Document` that home.ts's own module-level code never sees or touches,
// so the global environment here stays exactly what it was before this
// test existed: plain Node, no ambient `document`.

import { JSDOM } from "jsdom";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyControlsEnabled,
  applySplashInert,
  autoRunPins,
  clearFinalizedRowText,
  computeChromeHeight,
  diffPanels,
  effectiveViewMode,
  reopenSplashDom,
  shouldAdaptVertically,
  shouldArmAutoRun,
  shouldShowSplashOnBoot,
  type GatedControls,
  type SplashInertTargets,
} from "./home";

describe("autoRunPins (the auto-run timer's fire condition — motion-preference independent, per design spec §5.1)", () => {
  it("returns the pinned pair once both pins are placed", () => {
    expect(autoRunPins(3, 7)).toEqual([3, 7]);
  });

  it("returns null with either pin still unset — order doesn't matter", () => {
    expect(autoRunPins(null, 7)).toBeNull();
    expect(autoRunPins(3, null)).toBeNull();
    expect(autoRunPins(null, null)).toBeNull();
  });

  it("does not special-case pin index 0 (falsy but a valid node id)", () => {
    expect(autoRunPins(0, 1)).toEqual([0, 1]);
    expect(autoRunPins(1, 0)).toEqual([1, 0]);
  });
});

// The auto-run gate's OTHER half (third build review §17.3): whether the
// page itself is ready to arm the timer, independent of whether the pins
// are placed (autoRunPins, above, covers that). All four inputs must hold
// simultaneously — each test flips exactly one away from "go" to pin down
// that every condition is actually load-bearing, not just decorative.
describe("shouldArmAutoRun (the auto-run gate's page-readiness half — data loaded, splash dismissed, not already armed, desktop width)", () => {
  it("arms once every condition is met", () => {
    expect(shouldArmAutoRun(true, true, false, true)).toBe(true);
  });

  it("withholds while the splash hasn't been dismissed yet, even once data is ready", () => {
    expect(shouldArmAutoRun(true, false, false, true)).toBe(false);
  });

  it("withholds while data hasn't loaded yet, even once the splash is dismissed", () => {
    expect(shouldArmAutoRun(false, true, false, true)).toBe(false);
  });

  it("never arms on a narrow (non-desktop) viewport, regardless of the other two", () => {
    expect(shouldArmAutoRun(true, true, false, false)).toBe(false);
  });

  it("won't re-arm once already armed, even if asked again with every other condition true", () => {
    expect(shouldArmAutoRun(true, true, true, true)).toBe(false);
  });
});

// H5 gate fix: the persisted-Compare splash deadlock. A returning visitor
// whose LAST session left `hth-view` persisted as "compare" would, on a
// fresh session, have .map-frame (and the splash living inside it, per H2)
// hidden by applyViewMode() before ever seeing it — Explore unreachable,
// dismiss() never fires, splashDismissed stuck false forever, every gate
// that depends on it (auto-run, applyControlsEnabled/applySplashInert)
// withholding for the rest of the pageview. effectiveViewMode is the fix:
// applyViewMode() routes through this instead of reading `viewMode`
// directly, forcing Overlay while the splash is still pending regardless of
// what's persisted, and releasing back to the real persisted mode the
// instant splashDismissed flips true (home.ts's dismiss() calls
// applyViewMode() again for exactly this).
describe("effectiveViewMode (H5 gate fix — the persisted-Compare splash deadlock)", () => {
  it("forces overlay when Compare is persisted but the splash hasn't been dismissed yet (the deadlock scenario itself)", () => {
    expect(effectiveViewMode("compare", false)).toBe("overlay");
  });

  it("restores the persisted Compare mode the instant the splash is dismissed", () => {
    expect(effectiveViewMode("compare", true)).toBe("compare");
  });

  it("leaves a persisted Overlay mode alone regardless of splash state (nothing to force — already the safe default)", () => {
    expect(effectiveViewMode("overlay", false)).toBe("overlay");
    expect(effectiveViewMode("overlay", true)).toBe("overlay");
  });
});

// §19.5 (fifth build review — the ⓘ splash-reopen control): boot-time splash
// visibility now depends on TWO independent, never-mutually-clearing flags
// instead of one. Each test flips exactly one flag away from "show" to pin
// down that both are independently load-bearing, matching the same
// one-flag-at-a-time discipline shouldArmAutoRun's own tests above use.
describe("shouldShowSplashOnBoot (§19.5 — session dismissal OR the persistent \"don't show this again\" preference, either alone suppresses)", () => {
  it("shows the splash when neither flag is set (a genuinely first visit)", () => {
    expect(shouldShowSplashOnBoot(false, false)).toBe(true);
  });

  it("off-pref set (localStorage \"hth-splash-off\") suppresses the splash even on a fresh session with no sessionStorage dismissal", () => {
    expect(shouldShowSplashOnBoot(false, true)).toBe(false);
  });

  it("session dismissal alone (the pre-existing rule) still suppresses, off-pref or not", () => {
    expect(shouldShowSplashOnBoot(true, false)).toBe(false);
  });

  it("both flags set: still suppressed (not a special/different state)", () => {
    expect(shouldShowSplashOnBoot(true, true)).toBe(false);
  });
});

// J3 gate-review Important finding: this is the regression cover for a bug
// that was ONLY caught live (a screenshot showed the splash staying
// invisible after clicking ⓘ on a reloaded pageview, even though every
// JS-observable side of open() — gate/inert/view-mode state — checked out
// correctly in isolation). index.html's pre-paint script stamps
// `data-splash-dismissed` on `<html>` before home.ts loads whenever the
// splash was already dismissed earlier this session; styles.css's
// `html[data-splash-dismissed] .splash { display:none }` is more specific
// than the plain `.splash` rule the `hidden` PROPERTY relies on, so on a
// reloaded pageview, clearing `.hidden` alone leaves the splash CSS-hidden
// regardless. reopenSplashDom is open()'s fix, pulled into its own
// parameterized function precisely so this has real jsdom coverage instead
// of relying on the live screenshot alone.
describe("reopenSplashDom (§19.5 — the live-caught stale data-splash-dismissed bug fix, J3 gate review Important finding)", () => {
  it("simulating a reloaded, already-dismissed pageview (the stamp present, splash hidden): clears the stamp AND unhides the splash", () => {
    const doc = new JSDOM(`<!doctype html><body><div class="splash" hidden></div></body>`).window.document;
    doc.documentElement.setAttribute("data-splash-dismissed", "");
    const splashEl = doc.querySelector<HTMLElement>(".splash")!;
    expect(splashEl.hidden).toBe(true); // sanity: the fixture starts in the buggy pre-fix state

    reopenSplashDom(doc, splashEl);

    expect(doc.documentElement.hasAttribute("data-splash-dismissed")).toBe(false);
    expect(splashEl.hidden).toBe(false);
  });

  it("a fresh pageview with no stamp present: still unhides (a no-op removeAttribute, not an error)", () => {
    const doc = new JSDOM(`<!doctype html><body><div class="splash" hidden></div></body>`).window.document;
    const splashEl = doc.querySelector<HTMLElement>(".splash")!;
    expect(doc.documentElement.hasAttribute("data-splash-dismissed")).toBe(false); // sanity

    reopenSplashDom(doc, splashEl);

    expect(doc.documentElement.hasAttribute("data-splash-dismissed")).toBe(false);
    expect(splashEl.hidden).toBe(false);
  });
});

// H2 gate fix: the review finding this covers — "`.splash` only covers
// `.map-frame`, so Routes chips and — once data loads — the Algorithms
// toggles/View-toggle/Race-again stay visible and enabled regardless of
// splash state" and "with no focus trap, a keyboard user can Tab straight
// past Explore to a live 'Race again'". Real DOM elements (jsdom), built
// fresh per test from a minimal fragment of index.html's own shape —
// enough for applyControlsEnabled/applySplashInert to have real targets to
// mutate, none of boot()'s canvas/Worker/fetch machinery.
describe("applyControlsEnabled / applySplashInert (H2 gate fix — the board panel + routes group, gated on dataReady AND splashDismissed, with a real focus/accessibility-tree trap while the splash is up)", () => {
  let controls: GatedControls;
  let inertTargets: SplashInertTargets;
  let howCta: HTMLElement | null;

  beforeEach(() => {
    // A fresh throwaway Document per test (see the file-header comment for
    // why this is a local JSDOM instance rather than the file's own global
    // `document`). Roster round (spec §18.3/.6, weighted A* since removed by
    // §20.2): the two hand-named algo-astar/algo-bidi toggles are gone —
    // two `role="button"` roster rows (no native `disabled`, gated via
    // aria-disabled/tabindex instead — see setDisabled's own comment) plus
    // one real `<button>` family bidi modifier replace them. how-cta is
    // included specifically because
    // it must NOT be touched by either function (build-review ruling:
    // leaving to /how/ while the splash is up is legitimate) — these tests
    // assert that directly rather than just trusting the source comment.
    // It sits INSIDE `.board-actions` alongside a control that must be
    // gated, matching the real markup's structure — the exact reason
    // applyControlsEnabled/applySplashInert target leaf controls directly
    // instead of `.board` as a whole (`inert` has no per-descendant
    // opt-out once set on an ancestor).
    const doc = new JSDOM(`<!doctype html><body>
      <div class="controls">
        <button class="chip route-chip" data-testid="preset-hill">Gungahlin → Capital Hill</button>
        <button class="chip route-chip" data-preset="surprise">Surprise me</button>
      </div>
      <aside class="board">
        <div class="family-bezel" data-family="searchers">
          <button data-testid="bidi-toggle">⇄</button>
          <div class="row row-optional" data-algo="astar-straight" role="button" aria-pressed="false">A* — straight line</div>
          <div class="row row-optional" data-algo="astar-greedy" role="button" aria-pressed="false">A* — greedy (direction only)</div>
        </div>
        <div class="board-actions">
          <button data-testid="view-toggle">View: overlay</button>
          <button data-testid="race-run">Race again</button>
          <a data-testid="how-cta" href="./how/">How is that possible?</a>
        </div>
      </aside>
      <div class="zoom-controls">
        <button data-testid="zoom-fit">Map</button>
        <button data-testid="zoom-in">+</button>
        <button data-testid="zoom-out">−</button>
      </div>
    </body>`).window.document;
    controls = {
      raceRun: doc.querySelector<HTMLButtonElement>('[data-testid="race-run"]'),
      rosterToggles: [...doc.querySelectorAll<HTMLElement>(".row-optional")],
      familyBidiToggle: doc.querySelector<HTMLButtonElement>('[data-testid="bidi-toggle"]'),
      viewToggle: doc.querySelector<HTMLButtonElement>('[data-testid="view-toggle"]'),
      zoomIn: doc.querySelector<HTMLButtonElement>('[data-testid="zoom-in"]'),
      zoomOut: doc.querySelector<HTMLButtonElement>('[data-testid="zoom-out"]'),
      zoomFit: doc.querySelector<HTMLButtonElement>('[data-testid="zoom-fit"]'),
      routeChips: [...doc.querySelectorAll<HTMLButtonElement>(".route-chip")],
    };
    inertTargets = {
      raceRun: controls.raceRun,
      rosterToggles: controls.rosterToggles,
      familyBidiToggle: controls.familyBidiToggle,
      viewToggle: controls.viewToggle,
      routesContainer: doc.querySelector<HTMLElement>(".controls"),
    };
    howCta = doc.querySelector<HTMLElement>('[data-testid="how-cta"]');
  });

  // Every control in `controls`/`inertTargets` is meant to move together —
  // a per-control loop (rather than one combined assertion) catches a
  // single wrong field/element that a copy-pasted bug might miss if it
  // happened to be wrong in the same direction as whatever's under test.
  // The three roster rows are plain divs (no native `disabled`), so their
  // gated state is read off `aria-disabled`/`tabIndex` instead — exactly
  // what setDisabled (home.ts) is supposed to write for a non-button
  // element, asserted here rather than assumed.
  function expectAllGated(disabled: boolean, inert: boolean): void {
    expect(controls.raceRun?.disabled).toBe(disabled);
    expect(controls.rosterToggles.length).toBe(2); // sanity: the fixture's rows were actually found
    for (const row of controls.rosterToggles) {
      expect(row.getAttribute("aria-disabled")).toBe(String(disabled));
      expect(row.tabIndex).toBe(disabled ? -1 : 0);
    }
    expect(controls.familyBidiToggle?.disabled).toBe(disabled);
    expect(controls.viewToggle?.disabled).toBe(disabled);
    expect(controls.zoomIn?.disabled).toBe(disabled);
    expect(controls.zoomOut?.disabled).toBe(disabled);
    expect(controls.zoomFit?.disabled).toBe(disabled);
    expect(controls.routeChips.length).toBeGreaterThan(0); // sanity: the fixture's chips were actually found
    for (const chip of controls.routeChips) expect(chip.disabled).toBe(disabled);
    expect(controls.raceRun?.inert).toBe(inert);
    for (const row of controls.rosterToggles) expect(row.inert).toBe(inert);
    expect(controls.familyBidiToggle?.inert).toBe(inert);
    expect(controls.viewToggle?.inert).toBe(inert);
    expect(inertTargets.routesContainer?.inert).toBe(inert);
  }

  it("splash visible + dataReady=true: every gated control is disabled AND inert, and how-cta is untouched (the exact review finding — these used to stay enabled regardless of splash state)", () => {
    applyControlsEnabled(controls, true, false);
    applySplashInert(inertTargets, false);
    expectAllGated(true, true);
    expect(howCta?.hasAttribute("disabled")).toBe(false);
    expect(howCta?.inert).toBeFalsy();
  });

  it("dismissal (splashDismissed flips true): every gated control re-enables and the focus trap releases", () => {
    applyControlsEnabled(controls, true, false);
    applySplashInert(inertTargets, false);
    expectAllGated(true, true); // sanity: starts gated, same as the previous test

    applyControlsEnabled(controls, true, true);
    applySplashInert(inertTargets, true);
    expectAllGated(false, false);
    expect(howCta?.inert).toBeFalsy();
  });

  it("boot-with-predismissed-session (splashDismissed=true before dataReady=true): stays disabled (data isn't ready yet) but is already NOT inert — the two gates are independent, not the same predicate", () => {
    applyControlsEnabled(controls, false, true);
    applySplashInert(inertTargets, true);
    expectAllGated(true, false);
  });

  // §19.5: home.ts's new open() (the ⓘ button's handler) calls these exact
  // same two functions a second time, with splashDismissed flipped back to
  // false — it isn't a fork of dismiss()'s gating logic, just a second call
  // site for it. This chains dismiss -> reopen -> dismiss (three transitions,
  // not the original test's two) specifically to catch a state-leak a
  // single round-trip could miss — e.g. a listener or attribute that only
  // fails to reset correctly the SECOND time a control is re-gated.
  it("reopening after dismissal (§19.5 — the ⓘ button) re-gates every control exactly like the original splash did, and a second dismissal re-ungates them the same way", () => {
    applyControlsEnabled(controls, true, false); // fresh splash, data ready
    applySplashInert(inertTargets, false);
    expectAllGated(true, true);

    applyControlsEnabled(controls, true, true); // first dismissal (Explore/Escape)
    applySplashInert(inertTargets, true);
    expectAllGated(false, false);

    applyControlsEnabled(controls, true, false); // reopened via ⓘ
    applySplashInert(inertTargets, false);
    expectAllGated(true, true);
    expect(howCta?.inert).toBeFalsy(); // still untouched, same carve-out as every other state above

    applyControlsEnabled(controls, true, true); // dismissed again
    applySplashInert(inertTargets, true);
    expectAllGated(false, false);
  });
});

// Final-review Minor: the `.ms` wall-time badge (and `.row-delta`) used to
// carry the LAST race's numbers into a replay of a NEW one, for as long as
// that row's own finalization took — unlike `.val` (RaceUi.setRow), neither
// element repaints on every frame, only once at finalization. home.ts's
// scheduler callback (the single race-start funnel every trigger already
// shares) now calls clearFinalizedRowText right before dispatching the new
// race — this is that function's own direct jsdom coverage, real elements
// built the same throwaway-JSDOM way the rest of this file's DOM-mutating
// tests are (see the file-header comment for why).
describe("clearFinalizedRowText (final-review Minor — the stale .ms/.row-delta-at-race-start fix)", () => {
  it("clears a finalized core row's stale wall-time text, leaving .val/.fill untouched (not this function's concern)", () => {
    const doc = new JSDOM(`<!doctype html><body>
      <aside class="board">
        <div class="row" data-algo="dijkstra">
          <span class="val">21,480</span>
          <span class="ms">1042.7 ms</span>
          <div class="track"><div class="fill" style="width: 100%"></div></div>
        </div>
      </aside>
    </body>`).window.document;

    clearFinalizedRowText(doc);

    expect(doc.querySelector(".ms")?.textContent).toBe("");
    expect(doc.querySelector(".val")?.textContent).toBe("21,480"); // untouched — .val resets itself every frame, see this function's own doc
    expect(doc.querySelector<HTMLElement>(".fill")?.style.width).toBe("100%"); // untouched
  });

  it("clears a finalized optional row's stale wall-time text AND its honesty disclosure together", () => {
    const doc = new JSDOM(`<!doctype html><body>
      <aside class="board">
        <div class="row row-optional" data-algo="astar-greedy" data-active="true">
          <span class="val">21,480</span>
          <span class="ms">823.1 ms</span>
          <p class="row-delta">+4.2% longer route</p>
        </div>
      </aside>
    </body>`).window.document;

    clearFinalizedRowText(doc);

    expect(doc.querySelector(".ms")?.textContent).toBe("");
    expect(doc.querySelector(".row-delta")?.textContent).toBe("");
  });

  it("a row that has never finalized (no .ms element yet, the pristine pre-first-race state) is left alone, not an error", () => {
    const doc = new JSDOM(`<!doctype html><body>
      <aside class="board">
        <div class="row" data-algo="ch"><span class="val"></span></div>
      </aside>
    </body>`).window.document;

    expect(() => clearFinalizedRowText(doc)).not.toThrow();
    expect(doc.querySelector(".ms")).toBeNull();
  });

  it("clears every row on the board independently, including ones inactive this race (a stale badge left behind is equally wrong)", () => {
    const doc = new JSDOM(`<!doctype html><body>
      <aside class="board">
        <div class="row" data-algo="dijkstra"><span class="ms">500.0 ms</span></div>
        <div class="row row-optional" data-algo="astar-straight" data-active="false">
          <span class="ms">600.0 ms</span>
          <p class="row-delta">+1.0% longer route</p>
        </div>
        <div class="row" data-algo="ch"><span class="ms">10.0 ms</span></div>
      </aside>
    </body>`).window.document;

    clearFinalizedRowText(doc);

    for (const ms of doc.querySelectorAll(".ms")) expect(ms.textContent).toBe("");
    expect(doc.querySelector(".row-delta")?.textContent).toBe("");
  });
});

// Compare mode (build-review §14.3): diffPanels is the pure add/keep/remove
// set logic behind syncPanels() (DOM-wiring, untested here by design, same
// rationale as the rest of boot() — verified live instead), so a racer
// toggle or a view-mode switch only creates/destroys the panels that
// actually changed instead of tearing down and rebuilding the whole grid.
// I3 reconciliation: the roster round's `RacerId` migration (diffPanels was
// generic `Algo[]`/plain strings pre-roster-round) narrowed these fixtures
// to a real union — the old placeholder ids "astar"/"bidi" (never real
// roster ids even before this round) no longer typecheck, so this block
// uses two real non-core ids ("astar-straight"/"astar-greedy") as the
// stand-ins instead; the set-membership logic under test doesn't care which
// two, only that they're distinct. (Weighted A* — the round's original
// third non-core id — was itself removed from the roster by §20.2; these
// fixtures were repointed at greedy rather than left naming a retired id.)
describe("diffPanels (panel-set diffing: current panel algos vs. the next desired active-racer set)", () => {
  it("both empty: nothing to add, keep, or remove", () => {
    expect(diffPanels([], [])).toEqual({ keep: [], add: [], remove: [] });
  });

  it("starting from nothing (view-mode switched to Compare for the first time): every racer in next is an add", () => {
    expect(diffPanels([], ["dijkstra", "ch"])).toEqual({ keep: [], add: ["dijkstra", "ch"], remove: [] });
  });

  it("no change: everything currently shown stays, nothing added or removed", () => {
    expect(diffPanels(["dijkstra", "ch"], ["dijkstra", "ch"])).toEqual({
      keep: ["dijkstra", "ch"],
      add: [],
      remove: [],
    });
  });

  it("a racer toggled ON: existing panels are kept as-is, the new one is the only add", () => {
    expect(diffPanels(["dijkstra", "ch"], ["dijkstra", "astar-straight", "ch"])).toEqual({
      keep: ["dijkstra", "ch"],
      add: ["astar-straight"],
      remove: [],
    });
  });

  it("racers toggled OFF: they move to remove, survivors stay in keep", () => {
    expect(diffPanels(["dijkstra", "astar-straight", "astar-greedy", "ch"], ["dijkstra", "ch"])).toEqual({
      keep: ["dijkstra", "ch"],
      add: [],
      remove: ["astar-straight", "astar-greedy"],
    });
  });

  it("simultaneous add and remove (one racer swapped for another) in a single diff", () => {
    expect(diffPanels(["dijkstra", "astar-straight", "ch"], ["dijkstra", "astar-greedy", "ch"])).toEqual({
      keep: ["dijkstra", "ch"],
      add: ["astar-greedy"],
      remove: ["astar-straight"],
    });
  });

  it("switching OFF Compare mode entirely: next is empty, every current panel is a remove", () => {
    expect(diffPanels(["dijkstra", "astar-straight", "ch"], [])).toEqual({
      keep: [],
      add: [],
      remove: ["dijkstra", "astar-straight", "ch"],
    });
  });

  it("keep and remove preserve CURRENT's own order; add preserves NEXT's own order — a plain set-membership diff, not a re-sort by ROSTER order", () => {
    const result = diffPanels(["ch", "astar-straight", "dijkstra"], ["dijkstra", "astar-greedy", "ch"]);
    expect(result.keep).toEqual(["ch", "dijkstra"]);
    expect(result.remove).toEqual(["astar-straight"]);
    expect(result.add).toEqual(["astar-greedy"]);
  });
});

// J3 (spec §19.2): the arithmetic behind the `--chrome-h` custom property
// styles.css's adaptive-height rule reads — everything in the `.hero` column
// EXCEPT the map area itself. updateChromeHeight() (boot()-only, untested
// here like the rest of boot()'s DOM glue) is the thin live-measurement
// wrapper around this; this is the plain sum it hands off to, tested with
// plain numbers rather than a real layout.
describe("computeChromeHeight (J3 — the live-measured height of everything but the map area, in .hero)", () => {
  it("sums all five pieces", () => {
    expect(computeChromeHeight(73, 96, 24, 40, 16)).toBe(249);
  });

  it("is a plain sum — order of the same five values doesn't matter, only that all five are counted once", () => {
    expect(computeChromeHeight(1, 2, 3, 4, 5)).toBe(15);
    expect(computeChromeHeight(5, 4, 3, 2, 1)).toBe(15);
  });

  it("an all-zero layout (nothing measured yet, e.g. a pre-layout call) sums to zero, not NaN or a floor value — updateChromeHeight's own `|| 0` guards feed this the same way", () => {
    expect(computeChromeHeight(0, 0, 0, 0, 0)).toBe(0);
  });
});

// Final-review fix (Minor #2): the live-measured replacement for
// styles.css's old static `height > 900px` media query, which assumed
// chromeH's own desktop-width figure (227px) held at every width — it
// doesn't once the Routes strip wraps (941-1300px). updateChromeHeight()
// (boot()-only, untested here like the rest of boot()'s DOM glue) is the
// thin live-measurement wrapper that calls this with the real
// window.innerHeight/chromeH and stamps the result onto `.race-layout` as
// `data-adaptive-v`; this is the plain arithmetic it hands off to, tested
// with plain numbers exactly like computeChromeHeight above.
describe("shouldAdaptVertically (final-review Minor #2 — real headroom over the 72vh floor, replacing the static height>900px query)", () => {
  it("a tall viewport at the desktop-width (unwrapped) chromeH figure the retired 900px query assumed (227px): true", () => {
    expect(shouldAdaptVertically(1500, 227, 0.72, 80)).toBe(true); // 1500-227=1273 > 0.72*1500+80=1160
  });

  it("a short viewport (well under the old 900px threshold): false", () => {
    expect(shouldAdaptVertically(768, 227, 0.72, 80)).toBe(false); // 768-227=541 < 0.72*768+80=632.96
  });

  it("is a strict >, not >=  — sitting exactly on the boundary is not real headroom yet", () => {
    expect(shouldAdaptVertically(1000, 200, 0.72, 80)).toBe(false); // 1000-200=800, 0.72*1000+80=800 exactly
    expect(shouldAdaptVertically(1000, 199, 0.72, 80)).toBe(true); // one pixel less chrome tips it over
  });

  it("the exact bug this replaces: a taller chromeH from Routes-strip wrapping at 941-1300px width pushes the TRUE crossover past the retired static 900px number", () => {
    // Height 920 alone would have satisfied the old `height > 900px` query
    // regardless of width — but at a wrapped chromeH (a plausible 941-1300px
    // width figure, larger than the 227px unwrapped one), there's no real
    // headroom here: the old query would have shown the button / grown the
    // map for a near-zero gain.
    expect(shouldAdaptVertically(920, 300, 0.72, 80)).toBe(false); // 920-300=620 < 0.72*920+80=742.4
    // The SAME wrapped chromeH at genuine desktop height: still true — this
    // isn't "wrapped chromeH always reads false", only that 900px specifically
    // stopped being a reliable line once chromeH varies by width.
    expect(shouldAdaptVertically(1500, 300, 0.72, 80)).toBe(true); // 1500-300=1200 > 0.72*1500+80=1160
  });

  it("a zero/negative buffer or floor still computes (defensive — callers always pass the real ADAPTIVE_V_* constants, but the arithmetic itself doesn't assume positivity)", () => {
    expect(shouldAdaptVertically(1000, 0, 0, 0)).toBe(true); // 1000-0=1000 > 0
    expect(shouldAdaptVertically(0, 0, 0.72, 80)).toBe(false); // 0-0=0, not > 0*0.72+80=80
  });
});
