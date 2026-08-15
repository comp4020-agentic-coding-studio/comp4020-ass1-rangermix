// Boot script for the /how/ page: wires the theme toggle (same as home.ts),
// fetches the toytown artifact ONCE and hands the decoded result to every
// toytown-based toy (flood, contraction, order, climb — design spec §14.8:
// "how.ts orchestrates one load, passes the result to each mount"), and
// gates chapter 1 (flood) and chapter 3 (climb)'s auto-play behind
// IntersectionObserver so nothing animates before the visitor has actually
// scrolled to it. Chapter 2 (hierarchy) stays on the full Canberra
// render.json payload instead of toytown — it keeps its own separate,
// unchanged IO-gated fetch+mount (see hierarchy.ts's file banner for why).

import { initTheme } from "../theme";
import { mountFlood } from "../toys/flood";
import { mountContraction } from "../toys/contraction";
import { mountOrder } from "../toys/order";
import { mountHierarchy } from "../toys/hierarchy";
import { mountClimb, mountClosingEcho } from "../toys/climb";
import { loadToytown } from "../toys/toytown";

const VISIBILITY_THRESHOLD = 0.4;

/** Runs `fn` once `el` is at least `threshold` visible in the viewport
 * (fires once, then disconnects — design spec §14.10: "fire once per
 * toy"), or immediately if IntersectionObserver isn't available — the same
 * eager fallback hierarchy.ts's own mount gate already used. */
function onceVisible(el: Element, threshold: number, fn: () => void): void {
  if (typeof IntersectionObserver === "undefined") {
    fn();
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        fn();
        io.disconnect();
      }
    },
    { threshold },
  );
  io.observe(el);
}

export interface AutoPlayGate {
  /** Call once the toy's root has scrolled into view. */
  visible(): void;
  /** Call once the toy has finished mounting, passing its own auto-play
   * trigger. Fires immediately if the root is ALREADY visible; otherwise
   * waits for a later `visible()` call. */
  ready(play: () => void): void;
}

/** A toy's auto-play trigger only fires once BOTH "the toy has finished
 * mounting" and "its root has scrolled into view" are true — whichever
 * happens last. The toytown fetch and the visitor's scroll position race
 * independently (a fast connection can finish mounting chapter 3 well
 * before the visitor scrolls that far; a short viewport can already have
 * chapter 1 on screen before the fetch even resolves), so neither side can
 * assume the other already happened. Pure/DOM-free — exported so this
 * ordering logic is unit-tested directly rather than only "verified by
 * eye" through a real scroll. */
export function makeAutoPlayGate(): AutoPlayGate {
  let isVisible = false;
  let pending: (() => void) | undefined;
  return {
    visible() {
      isVisible = true;
      if (pending) {
        const fn = pending;
        pending = undefined;
        fn();
      }
    },
    ready(play) {
      if (isVisible) play();
      else pending = play;
    },
  };
}

function showToyLoading(root: HTMLElement | null): void {
  if (root) root.innerHTML = `<p class="toy-loading">loading the street network…</p>`;
}

function showToyFailure(root: HTMLElement | null): void {
  if (root) {
    root.innerHTML = `<p class="toy-loading">couldn't load the street network — reload to retry</p>`;
  }
}

function boot(): void {
  initTheme();

  const floodRoot = document.querySelector<HTMLElement>('[data-testid="toy-flood"]');
  const contractionRoot = document.querySelector<HTMLElement>('[data-testid="toy-contraction"]');
  const orderRoot = document.querySelector<HTMLElement>('[data-testid="toy-order"]');
  const climbRoot = document.querySelector<HTMLElement>('[data-testid="toy-climb"]');

  // Only flood (ch1) and climb (ch3) auto-play on scroll (design spec
  // §14.10); contraction and order are click-driven from the moment
  // they're mounted, no gate needed.
  const floodGate = makeAutoPlayGate();
  const climbGate = makeAutoPlayGate();
  if (floodRoot) onceVisible(floodRoot, VISIBILITY_THRESHOLD, () => floodGate.visible());
  if (climbRoot) onceVisible(climbRoot, VISIBILITY_THRESHOLD, () => climbGate.visible());

  for (const root of [floodRoot, contractionRoot, orderRoot, climbRoot]) showToyLoading(root);

  // /how/ is one path segment deeper than the site root, so toytown.json
  // (committed under public/data/, served at the site ROOT's /data/) needs
  // one more ".." than loadToytown's own default — resolved through
  // `new URL(..., document.baseURI)`, the same pattern hierarchy.ts and
  // climb.ts's mountClosingEcho already use for their own /how/-relative
  // data fetches.
  const dataBase = new URL("../data/", document.baseURI).href;
  loadToytown(dataBase)
    .then((toytown) => {
      if (floodRoot) {
        const { playDefault } = mountFlood(floodRoot, toytown);
        floodGate.ready(playDefault);
      }
      if (contractionRoot) mountContraction(contractionRoot, toytown);
      if (orderRoot) mountOrder(orderRoot, toytown);
      if (climbRoot) {
        const { playDefault } = mountClimb(climbRoot, toytown);
        climbGate.ready(playDefault);
      }
    })
    .catch((err: unknown) => {
      console.error("how.ts: toytown.json failed to load", err);
      for (const root of [floodRoot, contractionRoot, orderRoot, climbRoot]) showToyFailure(root);
    });

  // The hierarchy toy fetches the full render.json (the same payload the
  // home page's map uses) and constructs a MapView — real work, not free.
  // Chapter 2 sits below chapter 1, so defer the fetch + MapView
  // construction until the toy's root actually enters the viewport
  // (IntersectionObserver), same "don't pay for what you haven't scrolled
  // to" reasoning as lazy-loading an image. `io.disconnect()` right after
  // triggering guarantees mountHierarchy runs exactly once (MapView must
  // never be constructed/discarded repeatedly — see hierarchy.ts's own
  // note). Falls back to an eager mount if IntersectionObserver isn't
  // available. Mounting only once visible also means hierarchy's own
  // auto-loop (started inside mountHierarchy once its data loads) already
  // satisfies "auto-start on scroll" for this chapter with no separate
  // gate.
  const hierarchyRoot = document.querySelector<HTMLElement>('[data-testid="toy-hierarchy"]');
  if (hierarchyRoot) {
    if (typeof IntersectionObserver !== "undefined") {
      const io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          mountHierarchy(hierarchyRoot);
          io.disconnect();
        }
      });
      io.observe(hierarchyRoot);
    } else {
      mountHierarchy(hierarchyRoot);
    }
  }

  const closerRoot = document.querySelector<HTMLElement>('[data-testid="closer-echo"]');
  if (closerRoot) mountClosingEcho(closerRoot);
}

// Guarded (not a bare call) so this module is safely importable from a
// plain Node test environment (no `document`) to reach the pure export
// (`makeAutoPlayGate`) alone — same idiom home.ts uses for `autoRunPins`.
if (typeof document !== "undefined") boot();
