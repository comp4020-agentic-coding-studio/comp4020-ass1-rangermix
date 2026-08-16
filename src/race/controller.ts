// Replay scheduler + scoreboard/aria wiring for the home page race. Compute
// happens in worker.ts (off-main-thread); this file owns the Worker handle,
// the rAF replay loop, and turning worker results into MapView draw calls
// and UI updates. Split the same way mapRenderer.ts is: pure, exported,
// tested math (sliceForFrame, the text formatters) versus a thin stateful
// class that composes them with real Worker/canvas/DOM calls (untested here
// by design — verified by eye once wired into home.ts, same rationale as
// MapView's own canvas half).

import { loadRouting } from "../data";
import { haversine } from "../snap";
import { effectiveTheme, onThemeChange, themeColors } from "../theme";
import { strideFor, type MapView } from "../viz/mapRenderer";
import type { Graph } from "../algos/graph";
import type { Algo, AlgoResult, RaceRequest, RaceResponse, WorkerResponse } from "./worker";

/** One Compare-mode panel: the racer it's dedicated to, and the MapView that
 * draws ONLY that racer's cloud (plus the shared pins/route — see renderAt).
 * Built by home.ts's syncPanels() from RaceController.getActiveRoster() and
 * handed to setComparePanels(); RaceController never constructs a MapView
 * itself, here or anywhere else — panel lifecycle is entirely home.ts's. */
export interface ComparePanel {
  algo: Algo;
  view: MapView;
}

const REPLAY_MS = 2500;
const DOT_RADIUS = 1.8;
const DRAW_CAP = 4000; // see mapRenderer.strideFor: visual sampling cap per frame

// Fixed roster order — Dijkstra and CH are the always-on core comparison
// (disable-proof: no chip can turn them off); A* and Bidirectional are the
// two optional racers toggled by chips. This order is never re-derived
// from which chips happen to be active — scoreboard rows, replay draw
// order (CH last so its sparks land on top of everything else), and the
// aria announcement's clause order all read off THIS array so the three
// surfaces can never disagree with each other.
const ROSTER: Algo[] = ["dijkstra", "astar", "bidi", "ch"];

// Matches the scoreboard's own static row labels (index.html) exactly, so
// the spoken aria text and the visible row name are always the same word —
// "Bidirectional", not "Bidirectional Dijkstra", both to keep the aria
// sentence readable with four clauses and because the magenta row's label
// IS this text (the accessibility "direct-label every row" obligation).
// Exported so home.ts's Compare-mode panel chips (build-review §14.3) can
// label each panel with the exact same word, rather than a second
// hard-coded copy that could drift from the scoreboard's own wording.
export const ALGO_LABEL: Record<Algo, string> = {
  dijkstra: "Dijkstra",
  astar: "A*",
  bidi: "Bidirectional",
  ch: "Contraction Hierarchies",
};

/** ROSTER filtered down to the racers that are actually active given
 * `optional` (the currently-toggled-on optional racers — Dijkstra and CH
 * need no entry here, they're unconditional). Pure and exported so this
 * exact filter — the one both `run()` (what gets computed) and
 * `getActiveRoster()` (what home.ts builds Compare panels for) need to
 * agree on — is unit-testable without a real RaceController/Worker/MapView,
 * and so the two call sites structurally cannot disagree (both call this,
 * neither re-derives it). */
export function activeRoster(optional: ReadonlySet<"astar" | "bidi">): Algo[] {
  return ROSTER.filter((a) => a === "dijkstra" || a === "ch" || optional.has(a));
}

/** How many of `total` items should be visible at `elapsedMs` into a
 * `durationMs` replay: 0 before the replay starts, `total` once it's done,
 * a linear (floored, so it only ever grows) fraction in between. Pure and
 * exported so replay timing is unit-testable without a real rAF loop or
 * Worker — the class below just feeds it real clock/settle-count numbers. */
export function sliceForFrame(total: number, elapsedMs: number, durationMs: number): number {
  const frac = Math.min(1, Math.max(0, durationMs > 0 ? elapsedMs / durationMs : 1));
  return Math.min(total, Math.floor(total * frac));
}

/** "38.2 ms" — one decimal, per the honest-numbers wall-time format. */
export function formatMs(ms: number): string {
  return `${ms.toFixed(1)} ms`;
}

/** "99.0% less work" — CH's settled-node count against Dijkstra's, as a
 * percentage saved. Guards the degenerate from===to case (dijSettled a
 * would-be 0 denominator) rather than surfacing NaN/Infinity in the UI. */
export function headlineText(dijSettled: number, chSettled: number): string {
  if (dijSettled <= 0) return "0.0% less work";
  const pct = 100 * (1 - chSettled / dijSettled);
  return `${pct.toFixed(1)}% less work`;
}

/** The once-per-race aria text for an arbitrary ROSTER-ORDER list of active
 * racers — canvas wrapper aria-label AND the `race-live` region share this
 * exact string. Only active racers are named (an inactive chip's algorithm
 * never appears), which is why this takes the caller's own already-filtered
 * `entries` rather than a fixed algorithm list. Settled counts use en-AU
 * thousands separators (matches the scoreboard rows); km is the haversine
 * route length, one decimal — never the graph's own travel-TIME distance.
 * "intersections" establishes the unit after the FIRST racer only — every
 * later clause reads as the same count of the same thing, exactly the
 * pattern the original two-racer copy (Dijkstra/CH) already used, extended
 * rather than replaced (see formatAnnouncement below, which is that
 * original two-racer call written in terms of this one). */
export function formatRosterAnnouncement(entries: { label: string; settled: number }[], km: number): string {
  const clauses = entries.map((e, i) => {
    const count = e.settled.toLocaleString("en-AU");
    return i === 0 ? `${e.label} settled ${count} intersections` : `${e.label} settled ${count}`;
  });
  return `${clauses.join("; ")}. Same ${km.toFixed(1)} km route.`;
}

/** The MVP two-racer announcement (Dijkstra, CH) — kept as its own function
 * (not inlined at call sites) because it's still exactly what a race with
 * both optional chips OFF produces, and its exact copy is a pinned test
 * contract. Implemented as a call into formatRosterAnnouncement rather than
 * a second copy of the sentence-building logic, so the two can never drift
 * apart. */
export function formatAnnouncement(dijSettled: number, chSettled: number, km: number): string {
  return formatRosterAnnouncement(
    [
      { label: ALGO_LABEL.dijkstra, settled: dijSettled },
      { label: ALGO_LABEL.ch, settled: chSettled },
    ],
    km,
  );
}

/** Sums haversine hops along a node-index path, in km, 1 decimal applied by
 * the caller (formatAnnouncement) — kept separate so a straight-line path
 * (or an empty one) is trivially 0, not NaN. */
export function pathKm(graph: Graph, path: number[]): number {
  let metres = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    metres += haversine(graph.lon[path[i]], graph.lat[path[i]], graph.lon[path[i + 1]], graph.lat[path[i + 1]]);
  }
  return metres / 1000;
}

export interface PendingRace {
  resolve: (res: RaceResponse) => void;
  reject: (err: Error) => void;
}

/** Routes one incoming worker message to its matching in-flight request:
 * resolves the pending promise on a normal RaceResponse, REJECTS it (with
 * an Error wrapping the worker's message) on a RaceErrorResponse — and
 * always removes the entry from `pending` either way. Pulled out as a pure
 * function (no Worker, no `this`) so `RaceController.request()`'s
 * reject-on-error behavior is testable without a real Worker: the class's
 * `worker.onmessage` handler is just `dispatchResponse(this.pending,
 * e.data)`. */
export function dispatchResponse(pending: Map<number, PendingRace>, msg: WorkerResponse): void {
  const entry = pending.get(msg.id);
  if (!entry) return;
  pending.delete(msg.id);
  if ("error" in msg) entry.reject(new Error(msg.error));
  else entry.resolve(msg);
}

/** Rejects EVERY currently in-flight request with the same Error, then
 * empties the map — the worker-level failure path, wired to `Worker`'s own
 * `error`/`messageerror` events (script failed to load/parse, or posted
 * something that couldn't be structured-cloned back). Those aren't a single
 * request's failure the way a RaceErrorResponse is (dispatchResponse's
 * `msg.id` has nothing to key off — the worker itself is broken), so every
 * pending promise fails the same way at once. Pulled out pure (no Worker)
 * so it's testable the same way dispatchResponse is. */
export function rejectAllPending(pending: Map<number, PendingRace>, reason: string): void {
  const err = new Error(reason);
  for (const entry of pending.values()) entry.reject(err);
  pending.clear();
}

export interface RaceUi {
  setRow(algo: Algo, settled: number, total: number): void;
  /** Called once per algo after a race completes (never before) — the
   * caller uses this to lazily create the "wall time" tile/row, which is
   * exactly what makes it "appear only after measurement": it has no
   * static markup to hide, it just doesn't exist until this fires. */
  setTime(algo: Algo, ms: number): void;
  setHeadline(text: string): void;
  /** Fires ONCE per race (not per frame) with the same announcement text
   * the aria-label and the race-live region both carry. */
  announce(text: string): void;
}

/** One racer's replay data for one frame — ROSTER-ordered inside Frame.layers
 * (only ACTIVE racers present), so draw order and bar-scale max both fall
 * out of "iterate the array", never a per-algo if/else. */
interface AlgoLayer {
  algo: Algo;
  order: Uint32Array;
  total: number;
  stride: number;
}

interface Frame {
  graph: Graph;
  layers: AlgoLayer[];
  path: number[];
  pinA: number;
  pinB: number;
  duration: number;
  elapsed: number;
}

function isReducedMotion(): boolean {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Owns the race Worker, replays its results onto `view` over ~2.5 s, and
 * reports progress/results through `ui`. One instance per page — home.ts
 * constructs it once routing is ready and calls `run()` per race (pin
 * change, preset click, "R", or the one-time auto-run). */
export class RaceController {
  private readonly view: MapView;
  private readonly ui: RaceUi;
  private readonly worker: Worker;
  private readonly dataBase: string;
  private readonly routingPromise: Promise<{ graph: Graph }>;
  private readonly pending = new Map<number, PendingRace>();
  private nextId = 0;
  private raceToken = 0;
  private current: Frame | null = null;
  // null = overlay mode (draw every racer's cloud onto `this.view`, the
  // behavior this class has always had). Non-null = Compare mode (build-
  // review §14.3): one panel per ACTIVE racer, each panel showing only its
  // OWN racer's cloud — see renderAt. Set exclusively via
  // setComparePanels(); home.ts owns panel lifecycle (creating/destroying
  // MapViews), this class only owns WHERE frames get drawn.
  private comparePanels: ComparePanel[] | null = null;
  // themeColors() reads ~14 CSS custom properties via getComputedStyle —
  // cheap once, wasteful at 60fps inside renderAt's per-frame hot path — so
  // it's cached here and refreshed only when it can actually have changed:
  // once at construction, again at the start of every replay (run()), and
  // on a real theme change.
  private colors: Record<string, string>;
  // Which OPTIONAL racers (A*, Bidirectional) the chips currently have
  // switched on — Dijkstra and CH need no such flag, they're unconditional
  // in every run() call (disable-proof, the core comparison). Lives on the
  // controller rather than being threaded through every run() call because
  // run() has several independent callers (pin drag, presets, "R", the
  // auto-run) that all need to respect whatever the chips currently say,
  // not just whichever trigger happens to fire next.
  private readonly optionalActive = new Set<"astar" | "bidi">();

  constructor(view: MapView, ui: RaceUi) {
    this.view = view;
    this.ui = ui;
    // The worker module's own relative fetches resolve against the BUNDLE
    // location (dist/assets/), not the page, so the page (here: the
    // controller that owns the worker) computes the real data base once
    // and sends it along with every request.
    this.dataBase = new URL("./data/", document.baseURI).href;
    this.routingPromise = loadRouting(this.dataBase);
    this.colors = themeColors();
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      dispatchResponse(this.pending, e.data);
    };
    // A Worker `error` event (script failed to load/parse — a bad deploy,
    // an offline bundle, a CSP block) or `messageerror` (posted something
    // that couldn't be structured-cloned back) is not a single request's
    // failure; without this, whatever request() call is in flight at that
    // moment never resolves OR rejects, and the caller hangs forever
    // instead of surfacing the same honest failure copy a RaceErrorResponse
    // already does via dispatchResponse.
    this.worker.onerror = (e: ErrorEvent) => {
      rejectAllPending(this.pending, `race worker failed to load: ${e.message || "script error"}`);
    };
    this.worker.onmessageerror = () => {
      rejectAllPending(this.pending, "race worker posted an undeliverable message");
    };
    // Replay state lives in `this.current`, not in the canvas — so a theme
    // change mid-race is just "redraw the same frame with fresh colors"
    // (MapView repaints its own base layer on the same event already).
    onThemeChange(() => {
      this.colors = themeColors();
      this.redrawFrame();
    });
  }

  /** Flips one optional racer's chip state for every FUTURE run() call
   * (this race and on) — home.ts calls this from the chip's click handler,
   * then re-races the current pins through the scheduler's cancel-first
   * `now()` entry point (same as any other direct trigger), never `run()`
   * directly. Dijkstra/CH have no equivalent: they're not in this set, and
   * run() always includes them regardless. */
  setAlgoActive(algo: "astar" | "bidi", active: boolean): void {
    if (active) this.optionalActive.add(algo);
    else this.optionalActive.delete(algo);
  }

  /** The racer algos that WOULD run in the next run() call, in ROSTER order
   * — Dijkstra and CH always, plus whichever optional racers are currently
   * toggled on (see setAlgoActive). home.ts's syncPanels() calls this to
   * decide the Compare-mode panel set (build-review §14.3: "one panel per
   * ACTIVE racer") without keeping its own separate copy of "which
   * optional racers are on" that could drift from this class's own. */
  getActiveRoster(): Algo[] {
    return activeRoster(this.optionalActive);
  }

  /** Switches the render target between overlay (draw every racer's cloud
   * onto ONE shared view — pass `null`, the default) and Compare (draw
   * each racer's cloud onto its OWN panel view, pins+route on every panel
   * — pass the panel set) — see renderAt for exactly how `comparePanels`
   * changes what gets drawn where. Safe mid-race: replay state lives in
   * `this.current` (state-as-data, same rule mid-race resize/theme-change
   * already relies on), so switching modes just re-renders that SAME frame
   * at its current elapsed time onto the new target(s) via redrawFrame() —
   * never a new race. A no-op redraw before any race has run (redrawFrame's
   * own no-op guard). */
  setComparePanels(panels: ComparePanel[] | null): void {
    this.comparePanels = panels;
    this.redrawFrame();
  }

  private request(req: RaceRequest): Promise<RaceResponse> {
    return new Promise((resolve, reject) => {
      this.pending.set(req.id, { resolve, reject });
      this.worker.postMessage(req);
    });
  }

  /** Re-renders whatever frame was last shown (final or mid-replay) with
   * fresh theme colors and the current canvas size — the resize/theme-change
   * redraw hook. A no-op before any race has run (nothing to redraw yet). */
  redrawFrame(): void {
    if (this.current) this.renderAt(this.current.elapsed);
  }

  // §16.10 (compare-view perf): renderAt below only ever calls
  // clearOverlay/drawDots/drawRoute/drawPin on its targets — the OVERLAY
  // half of MapView's API — never drawBase, in EITHER overlay mode (one
  // target) or Compare mode (comparePanels means N targets, still only ever
  // drawn to through those same four calls). Replay (the animate() rAF loop
  // below) redraws every active view's overlay on every frame by design —
  // that's the settle-flood animation — but the base road-network layer is
  // untouched by any of it: base only repaints from a MapView's OWN pan/
  // zoom/resize/theme/threshold triggers (mapRenderer.ts's own store
  // subscription and onThemeChange callback), never from this class. A
  // replay therefore never pays base-layer cost — crisp-stroke or the
  // §16.10 interaction-time cache/blit alike — regardless of how many
  // panels are active, which is what makes MapView's own base-layer caching
  // (mapRenderer.ts) the whole fix for "compare view lags significantly":
  // N panels each blitting instead of each fully re-stroking on every pan/
  // zoom tick, with replay's per-frame cost unchanged (and already batched —
  // see MapView.drawDots) on top.
  private renderAt(elapsedMs: number): void {
    const c = this.current;
    if (!c) return;
    c.elapsed = elapsedMs;
    const dark = effectiveTheme() === "dark";
    const colors = this.colors;

    // Bar width is "% of max" on a SHARED scale (design contract: CH's bar
    // reads as a sliver next to Dijkstra's full one) — each row's own total
    // as its own denominator would make every bar end at 100%, erasing the
    // entire visual point of the comparison. "Max among ACTIVE racers"
    // falls out for free here: c.layers only ever holds the racers THIS
    // race actually ran (see run()), so an inactive algo's total can never
    // enter the max. Unaffected by overlay vs Compare — the scoreboard is
    // unchanged in both modes (build-review §14.3).
    const maxTotal = Math.max(...c.layers.map((l) => l.total));

    // Render targets (build-review §14.3): overlay mode draws every
    // racer's cloud onto the one shared `this.view`, exactly as before
    // Compare mode existed — `comparePanels` is null until home.ts's first
    // setComparePanels(panels) call, so every page that never enters
    // Compare mode never touches this branch at all. Compare mode draws
    // each racer's cloud onto ONLY its own panel, while pins+route (shared/
    // identical regardless of racer) go on every panel — `targets` is
    // "every view that gets cleared and gets pins+route", one element in
    // overlay mode, one per active panel in Compare mode.
    const targets: MapView[] = this.comparePanels ? this.comparePanels.map((p) => p.view) : [this.view];

    for (const v of targets) v.clearOverlay();
    // ROSTER order (c.layers is built in that order in run()) — CH is
    // always last in the roster, so in OVERLAY mode its sparks land
    // visually on top of every other active racer's dots, per the design
    // contract (moot in Compare mode: each racer already has its own
    // panel, nothing to layer on top of).
    for (const layer of c.layers) {
      const up = sliceForFrame(layer.total, elapsedMs, c.duration);
      const color = dark ? colors[`${layer.algo}Glow`] : colors[layer.algo];
      // Which view(s) get THIS layer's dots: every target in overlay mode
      // (the whole point of "overlay" — every cloud shares one canvas),
      // but only the ONE panel whose algo matches in Compare mode.
      // `.filter` rather than `.find` + a null-check: if a panel for this
      // layer's algo doesn't exist yet (a racer toggled on since the last
      // panel rebuild — see home.ts's syncPanels), this layer simply draws
      // nowhere this frame instead of throwing; the next panel rebuild
      // catches up.
      const drawTo = this.comparePanels
        ? this.comparePanels.filter((p) => p.algo === layer.algo).map((p) => p.view)
        : targets;
      for (const v of drawTo) {
        v.drawDots(
          layer.order, up, c.graph.lon, c.graph.lat, color,
          // additive: true UNCONDITIONALLY (§16.8 — was `dark` until this fix,
          // which meant "wants the density treatment" was silently only ever
          // true when the theme was ALREADY dark, so MapView's own light-mode
          // `multiply` branch could never fire from this, the only real call
          // site). Every settle-flood cloud wants overlap density to read in
          // EITHER theme; which blend (`lighter` in dark, `multiply` in
          // light) is MapView's own call, not this caller's — see
          // drawDots's own doc comment.
          { additive: true, radius: DOT_RADIUS, stride: layer.stride },
        );
      }
      this.ui.setRow(layer.algo, up, maxTotal);
    }
    const showRoute = elapsedMs >= c.duration && c.path.length >= 2;
    for (const v of targets) {
      if (showRoute) v.drawRoute(c.path, c.graph.lon, c.graph.lat);
      v.drawPin(c.graph.lon[c.pinA], c.graph.lat[c.pinA], "A");
      v.drawPin(c.graph.lon[c.pinB], c.graph.lat[c.pinB], "B");
    }
  }

  private animate(token: number, duration: number): Promise<void> {
    return new Promise((resolve) => {
      const start = performance.now();
      const step = (now: number) => {
        if (token !== this.raceToken) {
          resolve();
          return;
        }
        const elapsed = now - start;
        this.renderAt(Math.min(elapsed, duration));
        if (elapsed < duration) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  /** Computes (via the worker) and replays a race between two already-
   * snapped node indices — Dijkstra and CH always, plus whichever optional
   * racers the chips currently have active (see setAlgoActive). Superseded
   * races (a newer `run()` call landing while this one is still animating)
   * bail out silently instead of fighting the newer race for the canvas. */
  async run(fromNode: number, toNode: number): Promise<void> {
    const token = ++this.raceToken;
    // ROSTER order, filtered to what's actually active this race — Dijkstra
    // and CH unconditionally, A*/Bidirectional only if their chip is on.
    // This exact array is also what gets requested from the worker, so
    // "active this race" and "computed this race" can never disagree.
    // Same call getActiveRoster() makes — see activeRoster's own comment
    // for why the two are never allowed to independently re-derive this.
    const algos: Algo[] = activeRoster(this.optionalActive);
    const [{ graph }, res] = await Promise.all([
      this.routingPromise,
      this.request({
        id: ++this.nextId,
        from: fromNode,
        to: toNode,
        algos,
        dataBase: this.dataBase,
      }),
    ]);
    if (token !== this.raceToken) return;

    const dij = res.results.dijkstra;
    const ch = res.results.ch;
    if (!dij || !ch) return; // worker only omits a key if we didn't ask for it

    const active = algos
      .map((algo) => ({ algo, label: ALGO_LABEL[algo], result: res.results[algo] }))
      .filter((a): a is { algo: Algo; label: string; result: AlgoResult } => a.result !== undefined);
    const layers: AlgoLayer[] = active.map(({ algo, result }) => {
      const order = new Uint32Array(result.settled);
      return { algo, order, total: result.settledCount, stride: strideFor(order.length, DRAW_CAP) };
    });
    const path = ch.path.length >= 2 ? ch.path : dij.path; // prefer CH's unpacked path (equivalence guarantee)

    // Fresh snapshot for this replay, not a per-frame recompute (see the
    // `colors` field comment) — covers a theme change that happened while
    // no race was in flight (so no onThemeChange redraw was needed at the
    // time) landing correctly on the NEXT race regardless.
    this.colors = themeColors();
    this.current = { graph, layers, path, pinA: fromNode, pinB: toNode, duration: REPLAY_MS, elapsed: 0 };

    if (isReducedMotion()) this.renderAt(REPLAY_MS);
    else await this.animate(token, REPLAY_MS);
    if (token !== this.raceToken) return;

    this.reportResults(active, dij, ch, graph, path);
  }

  private reportResults(
    active: { algo: Algo; label: string; result: AlgoResult }[],
    dij: AlgoResult, ch: AlgoResult, graph: Graph, path: number[],
  ): void {
    for (const a of active) this.ui.setTime(a.algo, a.result.ms);
    // The headline stat is always Dijkstra-vs-CH specifically (the site's
    // core claim), independent of which optional racers also ran.
    this.ui.setHeadline(headlineText(dij.settledCount, ch.settledCount));
    const km = pathKm(graph, path);
    this.ui.announce(
      formatRosterAnnouncement(active.map((a) => ({ label: a.label, settled: a.result.settledCount })), km),
    );
    // /how/'s closing echo reads this back — same numbers the scoreboard
    // just showed, so the two can never disagree. try/catch: private-mode
    // browsers throw on localStorage access. Keys stay dj/ch only (not
    // extended to the optional racers) — the echo's contract predates them.
    try {
      localStorage.setItem(
        "hth-last-race",
        JSON.stringify({ dj: dij.settledCount, ch: ch.settledCount, km }),
      );
    } catch {
      /* storage unavailable — the echo just falls back to meta.json means */
    }
  }
}
