// Replay scheduler + scoreboard/aria wiring for the home page race. Compute
// happens in worker.ts (off-main-thread); this file owns the Worker handle,
// the rAF replay loop, and turning worker results into MapView draw calls
// and UI updates. Split the same way mapRenderer.ts is: pure, exported,
// tested math (sliceForFrame, the text formatters, activeRacers,
// routeDeltaPct) versus a thin stateful class that composes them with real
// Worker/canvas/DOM calls (untested here by design — verified by eye once
// wired into home.ts, same rationale as MapView's own canvas half).
//
// ROSTER SEAM (read this before wiring the UI side — spec §18's deep
// change): every racer's STABLE identity is `RacerId` (below) —
// roster.ts's own `RosterEntry["id"]`, five values, unaffected by any
// toggle. It is NOT the same as `Algo` (worker.ts), which is the
// WORKER-FACING request/response key space (nine possible values: each
// roster entry's workerKey, plus bidiKey for the four "searchers"-family
// entries) — a searcher's `RacerId` never changes, but which `Algo` key
// represents it flips between workerKey and bidiKey as the family
// bidirectional modifier toggles (spec §18.6; CH has no bidiKey, so its
// key never flips). Every UI-facing surface in this file — `RaceUi`'s own
// methods, `ALGO_LABEL`, `ComparePanel.algo`, `AlgoLayer.algo`,
// `getActiveRoster()`'s return — is keyed by `RacerId`, matching
// theme.ts's own roster-round palette keys (`colors[layer.algo]` /
// `colors[\`${layer.algo}Glow\`]` read `--c-<id>` / `--g-<id>` verbatim,
// see theme.ts's own comment) and matching a compare panel's/scoreboard
// row's `data-algo` attribute, which should be set to the roster id so a
// row's identity (hue, position, label) never changes when the family bidi
// modifier toggles — only its ⇄ marker should (spec §18.6: "identity hue
// NEVER changes"). Only `RaceRequest.algos` / `RaceResponse.results` (the
// worker boundary) ever see the request-key (`Algo`) space; this class
// translates between the two via `activeRacers()` below, and nothing else
// in this file should need to.

import { loadRouting } from "../data";
import { haversine } from "../snap";
import { effectiveTheme, onThemeChange, themeColors } from "../theme";
import { strideFor, type MapView } from "../viz/mapRenderer";
import { ROSTER, type RosterEntry } from "./roster";
import type { Graph } from "../algos/graph";
import type { Algo, AlgoResult, RaceRequest, RaceResponse, WorkerResponse } from "./worker";

/** A racer's STABLE UI identity — roster.ts's own `RosterEntry["id"]`, five
 * values, never affected by the family bidirectional modifier (that's
 * `Algo`'s job — see this file's header comment for the full seam). */
export type RacerId = RosterEntry["id"];

/** One Compare-mode panel: the racer it's dedicated to (a `RacerId` — a
 * panel's identity, like a scoreboard row's, never changes when the family
 * bidi modifier toggles), and the MapView that draws ONLY that racer's
 * cloud (plus the shared pins — and, per spec §18.4, that racer's OWN
 * route rather than necessarily the shared optimal one; see renderAt).
 * Built by home.ts's syncPanels() from RaceController.getActiveRoster()
 * and handed to setComparePanels(); RaceController never constructs a
 * MapView itself, here or anywhere else — panel lifecycle is entirely
 * home.ts's. */
export interface ComparePanel {
  algo: RacerId;
  view: MapView;
}

const REPLAY_MS = 2500;
const DOT_RADIUS = 1.8;
const DRAW_CAP = 4000; // see mapRenderer.strideFor: visual sampling cap per frame

// Display-name lookup, sourced from roster.ts's own `name` field (never a
// second hand-maintained copy — see roster.ts's header comment on why it's
// the single source of truth) so the aria sentence, the scoreboard row, and
// a compare panel's chip can never disagree with roster.ts's own contract-
// exact strings (roster.test.ts pins the id list this is built from).
export const ALGO_LABEL: Record<RacerId, string> = Object.fromEntries(
  ROSTER.map((r) => [r.id, r.name] as const),
) as Record<RacerId, string>;

/** ROSTER filtered to the racers active given `activeOptional` (core
 * racers — Dijkstra, CH — always included, roster.ts's own `core` flag)
 * and mapped to the WORKER-FACING request key each would race under RIGHT
 * NOW: `bidiKey` when `familyBidi` is on AND the racer is in the
 * "searchers" family (spec §18.6 — CH is never affected, it has no
 * bidiKey to switch to regardless), else `workerKey`. Roster display order
 * throughout (roster.ts's own array order IS spec §18's display order
 * already — no separate ordering array to keep in sync, unlike the
 * pre-roster-round fixed `ROSTER: Algo[]` this replaces). Pure and
 * exported so this exact derivation — the one both run() (what gets
 * computed) and getActiveRoster() (what home.ts builds Compare panels for)
 * must agree on — is unit-testable without a Worker, and the two call
 * sites structurally cannot disagree (both call this, neither re-derives
 * it) — same rationale the pre-roster-round activeRoster had, extended
 * from a 2-flag optional set to the full five-racer roster plus a
 * family-wide modifier. */
export function activeRacers(
  activeOptional: ReadonlySet<RacerId>, familyBidi: boolean,
): { algo: RacerId; key: Algo }[] {
  return ROSTER.filter((r) => r.core || activeOptional.has(r.id)).map((r) => ({
    algo: r.id,
    key: familyBidi && r.family === "searchers" && r.bidiKey ? r.bidiKey : r.workerKey,
  }));
}

/** spec §18.4's honesty rule, as a number: how much longer (as a
 * percentage of the true optimal distance) a racer's OWN reported route
 * is, rounded to 1 decimal. Never negative — a racer can't beat the true
 * shortest path, only match or lose to it, so a spurious negative from
 * floating-point noise on an EXACT racer clamps to 0 rather than ever
 * rendering as "shorter than optimal". `optimalDist <= 0` (a from===to
 * query) also clamps to 0 rather than dividing by zero. Pure and exported
 * so this is unit-testable without a real race — see controller.test.ts's
 * "delta math" cases. The UI renders 0 as "no disclosure" (an exact racer,
 * or an inexact one that happened to find the optimum this time) — that
 * choice lives in setRowDelta's caller (reportResults below) and in
 * whatever the UI does with a 0, not in this function. */
export function routeDeltaPct(racerDist: number, optimalDist: number): number {
  if (optimalDist <= 0) return 0;
  const pct = ((racerDist - optimalDist) / optimalDist) * 100;
  return Math.round(Math.max(0, pct) * 10) / 10;
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
 * exact string. Only active racers are named (an inactive row's algorithm
 * never appears), which is why this takes the caller's own already-filtered
 * `entries` rather than a fixed algorithm list. Settled counts use en-AU
 * thousands separators (matches the scoreboard rows); km is the haversine
 * length of the SHARED (optimal) route — never a per-racer distance.
 * "intersections" establishes the unit after the FIRST racer only — every
 * later clause reads as the same count of the same thing. An entry with a
 * positive `deltaPct` (spec §18.4's honesty rule) gets an extra clause,
 * "took a X% longer route", appended to its own settled-count clause — an
 * entry with no `deltaPct` (or exactly 0) reads exactly as it always did,
 * which is what keeps formatAnnouncement's pinned two-racer contract
 * (below) byte-identical: dijkstra/CH are always exact, so they never carry
 * a `deltaPct` at all. */
export function formatRosterAnnouncement(
  entries: { label: string; settled: number; deltaPct?: number }[], km: number,
): string {
  const clauses = entries.map((e, i) => {
    const count = e.settled.toLocaleString("en-AU");
    const base = i === 0 ? `${e.label} settled ${count} intersections` : `${e.label} settled ${count}`;
    return e.deltaPct && e.deltaPct > 0 ? `${base}, took a ${e.deltaPct.toFixed(1)}% longer route` : base;
  });
  return `${clauses.join("; ")}. Same ${km.toFixed(1)} km route.`;
}

/** The MVP two-racer announcement (Dijkstra, CH) — kept as its own function
 * (not inlined at call sites) because it's still exactly what a race with
 * every optional racer OFF produces, and its exact copy is a pinned test
 * contract. Implemented as a call into formatRosterAnnouncement rather than
 * a second copy of the sentence-building logic, so the two can never drift
 * apart. Dijkstra/CH are always exact, so neither entry carries a
 * `deltaPct` — this output is therefore unaffected by spec §18.4's
 * disclosure clause and stays byte-identical to the pre-roster-round
 * string. */
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
  setRow(algo: RacerId, settled: number, total: number): void;
  /** Called once per algo after a race completes (never before) — the
   * caller uses this to lazily create the "wall time" tile/row, which is
   * exactly what makes it "appear only after measurement": it has no
   * static markup to hide, it just doesn't exist until this fires. */
  setTime(algo: RacerId, ms: number): void;
  setHeadline(text: string): void;
  /** Fires ONCE per race (not per frame) with the same announcement text
   * the aria-label and the race-live region both carry. */
  announce(text: string): void;
  /** spec §18.4's honesty rule, live: called once per active racer after
   * every race (reportResults below), `pct` already the exact value
   * `routeDeltaPct` computed (rounded to 1 decimal, never negative) — the
   * UI's job is only to render it, never to re-derive or re-round it.
   * `pct <= 0` means "not disclosed this race" (an exact racer, or an
   * inexact one that happened to find the optimum) — the honest-empty
   * case: implementations should clear any previously-shown disclosure
   * rather than ever printing "+0% longer route" (see home.ts's own
   * `setRowDelta` for the reference implementation this seam was written
   * against: it clears `.row-delta`'s text back to "" on `pct <= 0`, which
   * a `:not(:empty)` CSS rule collapses out of layout. The board row is the
   * disclosure surface; compare-panel chips signal the same delta via the
   * dashed route overlay, the same dual-signal pattern `setRow` already
   * uses for settled counts). Keyed by RacerId (roster id), NOT the request
   * key that flips with the family bidi modifier — see this file's header
   * comment. */
  setRowDelta(algo: RacerId, pct: number): void;
}

/** One racer's replay data for one frame — ROSTER-ordered inside Frame.layers
 * (only ACTIVE racers present), so draw order and bar-scale max both fall
 * out of "iterate the array", never a per-algo if/else. `path` is THIS
 * racer's OWN found route (may differ from the shared `Frame.path` for a
 * disclosed variant — spec §18.4) — carried through so Compare-mode panels
 * can draw it (see renderAt); the overlay's single shared view never reads
 * a layer's own `path`, only `Frame.path`. */
interface AlgoLayer {
  algo: RacerId;
  order: Uint32Array;
  total: number;
  stride: number;
  path: number[];
  /** spec §18.4's honesty rule, carried through to Compare-mode's per-panel
   * route rendering: true when THIS racer's own distance is longer than the
   * shared optimal (`routeDeltaPct(result.dist, optimalDist) > 0` — the
   * exact same predicate reportResults uses to decide whether a row's
   * numeric "+X% longer route" disclosure shows). renderAt's Compare-mode
   * branch passes this straight to MapView.drawRoute's `dashed` option, so
   * a disclosed variant's own panel shows a dashed route — the visual echo
   * of its numeric disclosure — without touching route colour/width (see
   * mapRenderer.ts's drawRoute doc). Always false on the overlay's single
   * shared route (it's always the true optimal path — see run()'s own
   * comment on `path` — so renderAt's overlay branch never reads this
   * field, only the Compare branch does). */
  dashed: boolean;
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
  // themeColors() reads ~14+ CSS custom properties via getComputedStyle —
  // cheap once, wasteful at 60fps inside renderAt's per-frame hot path — so
  // it's cached here and refreshed only when it can actually have changed:
  // once at construction, again at the start of every replay (run()), and
  // on a real theme change.
  private colors: Record<string, string>;
  // Which OPTIONAL racers (the three A* variants — spec §18's bezel rows)
  // are currently toggled on. Dijkstra and CH need no entry here: roster.ts
  // marks them `core: true`, and activeRacers() always includes core
  // racers regardless of this set's contents. Replaces the pre-roster-
  // round two-flag `optionalActive: Set<"astar"|"bidi">` — "bidi" is no
  // longer a member of ANY such set; see `familyBidi` below, a genuinely
  // different kind of toggle. Lives on the controller rather than being
  // threaded through every run() call because run() has several
  // independent callers (pin drag, presets, "R", the auto-run) that all
  // need to respect whatever the bezel rows currently say.
  private readonly activeOptional = new Set<RacerId>();
  // spec §18.6: the "searchers" family's single bidirectional MODIFIER.
  // When true, every ACTIVE searchers-family racer (Dijkstra always, plus
  // whichever A* variants are in `activeOptional`) races under its bidiKey
  // form instead of its workerKey form — see activeRacers(). CH is never
  // affected (it has no bidiKey; it sits outside the family bezel).
  private familyBidi = false;

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

  /** Flips one optional searcher row's toggle state (astar-straight/
   * weighted/greedy — spec §18's bezel rows) for every FUTURE run() call.
   * Dijkstra/CH have no equivalent: they're core (roster.ts's own `core`
   * flag), always active regardless of this. Replaces the pre-roster-round
   * `setAlgoActive("astar"|"bidi", active)` — "bidi" is now
   * setFamilyBidi below, a genuinely different kind of toggle (a
   * family-wide MODIFIER, not a sixth racer — spec §18.6), not a variant
   * of this method. Passing a core id is a harmless no-op (activeRacers()
   * includes core racers unconditionally either way). */
  setRacerActive(id: RacerId, active: boolean): void {
    if (active) this.activeOptional.add(id);
    else this.activeOptional.delete(id);
  }

  /** Flips the "searchers" family's bidirectional modifier (spec §18.6's
   * bezel-level toggle) for every FUTURE run() call. Affects every ACTIVE
   * searcher (Dijkstra always, plus whichever A* variants are toggled on
   * via setRacerActive) — never CH, which sits outside the family bezel
   * and has no bidiKey to switch to (roster.ts's own contract: only
   * `family: "searchers"` entries carry one). */
  setFamilyBidi(active: boolean): void {
    this.familyBidi = active;
  }

  /** The racer ids that WOULD run in the next run() call, in ROSTER order
   * — Dijkstra and CH always, plus whichever optional racers are currently
   * toggled on (see setRacerActive). Returns STABLE `RacerId`s, never the
   * request key that flips with the family bidi modifier (see this file's
   * header comment) — a Compare-mode panel's identity must not change just
   * because the modifier toggled. home.ts's syncPanels() calls this to
   * decide the Compare-mode panel set (build-review §14.3: "one panel per
   * ACTIVE racer") without keeping its own separate copy of "which
   * optional racers are on" that could drift from this class's own. */
  getActiveRoster(): RacerId[] {
    return activeRacers(this.activeOptional, this.familyBidi).map((a) => a.algo);
  }

  /** Switches the render target between overlay (draw every racer's cloud
   * onto ONE shared view — pass `null`, the default) and Compare (draw
   * each racer's cloud onto its OWN panel view, pins on every panel, and
   * each panel's OWN route — pass the panel set) — see renderAt for
   * exactly how `comparePanels` changes what gets drawn where. Safe
   * mid-race: replay state lives in `this.current` (state-as-data, same
   * rule mid-race resize/theme-change already relies on), so switching
   * modes just re-renders that SAME frame at its current elapsed time onto
   * the new target(s) via redrawFrame() — never a new race. A no-op redraw
   * before any race has run (redrawFrame's own no-op guard). */
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
  // subscription and onThemeChange callback), never from this class.
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
    // Compare mode never touches this branch at all.
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
          // additive: true UNCONDITIONALLY (§16.8) — every settle-flood
          // cloud wants overlap density to read in EITHER theme; which
          // blend (`lighter` in dark, `multiply` in light) is MapView's
          // own call, not this caller's — see drawDots's own doc comment.
          { additive: true, radius: DOT_RADIUS, stride: layer.stride },
        );
      }
      this.ui.setRow(layer.algo, up, maxTotal);
    }
    const showRoute = elapsedMs >= c.duration && c.path.length >= 2;
    for (const v of targets) {
      v.drawPin(c.graph.lon[c.pinA], c.graph.lat[c.pinA], "A");
      v.drawPin(c.graph.lon[c.pinB], c.graph.lat[c.pinB], "B");
    }
    if (showRoute) {
      if (this.comparePanels) {
        // Compare mode: each panel draws ITS OWN racer's route, which may
        // legitimately differ from the shared optimal one (spec §18.4's
        // honesty rule: a disclosed variant's compare panel shows the
        // route it ACTUALLY found, never silently substituted for the
        // optimal one — the overlay's single shared view below is where
        // "the" optimal route always lives). Falls back to the shared
        // `c.path` only if this racer's own path is degenerate (defensive
        // — every completed race result has a valid own-path; also covers
        // a panel whose racer toggled off mid-race, before the next panel
        // rebuild catches up). Panel isolation (one racer's cloud+route
        // per panel) already makes two different routes legible from WHICH
        // panel they're on; `dashed` (AlgoLayer's own precomputed
        // routeDeltaPct>0 flag — see its doc) adds the colour-free "not the
        // shortest" signal spec §18.4 asks for directly on a disclosed
        // panel's own route, without touching its identity colour. A
        // fallback-to-`c.path` draw (degenerate own-path) is never dashed
        // — `c.path` is always the true optimal route, see the comment
        // above — hence `layer?.dashed` only, not applied unconditionally.
        for (const panel of this.comparePanels) {
          const layer = c.layers.find((l) => l.algo === panel.algo);
          const routePath = layer && layer.path.length >= 2 ? layer.path : c.path;
          const dashed = layer && layer.path.length >= 2 ? layer.dashed : false;
          panel.view.drawRoute(routePath, c.graph.lon, c.graph.lat, { dashed });
        }
      } else {
        for (const v of targets) v.drawRoute(c.path, c.graph.lon, c.graph.lat);
      }
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
   * racers are toggled on (setRacerActive) racing in either their plain or
   * (setFamilyBidi) bidirectional form. Superseded races (a newer run()
   * call landing while this one is still animating) bail out silently
   * instead of fighting the newer race for the canvas. */
  async run(fromNode: number, toNode: number): Promise<void> {
    const token = ++this.raceToken;
    // Roster order, filtered to what's actually active this race and
    // resolved to each racer's CURRENT request key (plain or bidi — see
    // activeRacers's own doc). This exact array is also what gets
    // requested from the worker, so "active this race" and "computed this
    // race" can never disagree — same call getActiveRoster() makes (via
    // the same activeRacers()), see that method's own comment for why the
    // two are never allowed to independently re-derive this.
    const active0 = activeRacers(this.activeOptional, this.familyBidi);
    const algos: Algo[] = active0.map((a) => a.key);
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

    // The core comparison — always requested (roster.ts: dijkstra/ch are
    // `core: true`). CH has no bidi form (roster.ts: no `bidiKey`), so its
    // request key is always the literal `"ch"` regardless of the modifier —
    // that lookup stays hardcoded safely. Dijkstra's is NOT: it flips to
    // `"bidi:dijkstra"` exactly like every other searchers-family racer once
    // setFamilyBidi(true) is active (activeRacers()), so it must be looked
    // up via `active0`'s own resolved key for the dijkstra entry (always
    // present — dijkstra is core), not the hardcoded string `"dijkstra"`.
    //
    // I3 integration fix: a hardcoded `res.results.dijkstra` here was a real
    // live-race bug, caught only by an end-to-end bidi race (neither wave's
    // own unit tests constructed a real bidi RaceRequest through run()) —
    // the worker only ever POPULATES the key it was actually ASKED for
    // (worker.ts's handleRequest), so once familyBidi requests
    // `bidi:dijkstra` instead of `dijkstra`, `res.results.dijkstra` is
    // always `undefined` and the guard below silently returned before
    // reportResults/renderAt ever ran — the ENTIRE race (scoreboard, replay,
    // aria announcement) silently no-op'd the instant bidi was toggled on,
    // not merely a stale settled-count.
    //
    // Reading dist/settledCount off whichever form actually ran is exactly
    // right, not merely safe: dijkstra/bidijkstra agree on DISTANCE exactly
    // (equivalence-tested in variants.test.ts), and the app's own "every
    // number is measured live" ethos means the headline SHOULD reflect
    // bidirectional's genuinely-lower settled count once that's what's
    // racing, not a phantom plain-form number nothing actually computed this
    // race. Only `dij.path` can legitimately differ under ties, and it's
    // read below ONLY as a fallback for a degenerate `ch.path` (< 2 nodes,
    // i.e. a from===to query) — a case already so degenerate that which
    // form's (equally degenerate) path fills it is immaterial; spec §18.4's
    // "the overlay's shared route is THE optimal one" is about not
    // substituting a DIFFERENT racer's route, which this doesn't do.
    const dijKey = active0.find((a) => a.algo === "dijkstra")?.key;
    const dij = dijKey ? res.results[dijKey] : undefined;
    const ch = res.results.ch;
    if (!dij || !ch) return; // worker only omits a key if we didn't ask for it

    const active = active0
      .map((a) => ({ algo: a.algo, label: ALGO_LABEL[a.algo], result: res.results[a.key] }))
      .filter((a): a is { algo: RacerId; label: string; result: AlgoResult } => a.result !== undefined);

    // spec §18.4's honesty rule: every racer's OWN measured distance
    // against the true optimum. dijkstra and CH always agree on distance
    // (equivalence-tested elsewhere), so either works as `optimalDist`;
    // routeDeltaPct clamps floating-point noise and the from===to
    // degenerate case to 0 rather than a spurious negative or a
    // divide-by-zero. Computed ONCE here and threaded through to both
    // AlgoLayer.dashed (Compare-mode's per-panel route styling, below) and
    // reportResults' own per-row disclosure (passed through, not
    // recomputed there) — one source of truth, never two accumulators
    // that could drift apart.
    const optimalDist = Math.min(dij.dist, ch.dist);

    // The {algo, path, routeDeltaPct}-per-racer data shape this seam
    // agrees on (controller.ts <-> the UI task's compare-panel rendering —
    // "extend the panel render seam minimally, the UI task styles it"):
    // `algo` and `path` are carried through the replay Frame via
    // AlgoLayer (below), read by renderAt's Compare-mode route drawing;
    // `dashed` is routeDeltaPct's own >0 predicate, precomputed here so
    // renderAt (a per-frame hot path) never has to — see AlgoLayer.dashed's
    // own doc. The exact percentage itself is NOT stored on the frame —
    // it's computed again in reportResults, after replay, and pushed to
    // the UI via ui.setRowDelta(algo, pct), which a real implementation
    // mirrors into both the scoreboard row AND that racer's compare-panel
    // chip (see RaceUi.setRowDelta's own doc).
    const layers: AlgoLayer[] = active.map(({ algo, result }) => {
      const order = new Uint32Array(result.settled);
      return {
        algo,
        order,
        total: result.settledCount,
        stride: strideFor(order.length, DRAW_CAP),
        path: result.path,
        dashed: routeDeltaPct(result.dist, optimalDist) > 0,
      };
    });
    const path = ch.path.length >= 2 ? ch.path : dij.path; // THE shared optimal route — see the comment above

    // Fresh snapshot for this replay, not a per-frame recompute (see the
    // `colors` field comment) — covers a theme change that happened while
    // no race was in flight (so no onThemeChange redraw was needed at the
    // time) landing correctly on the NEXT race regardless.
    this.colors = themeColors();
    this.current = { graph, layers, path, pinA: fromNode, pinB: toNode, duration: REPLAY_MS, elapsed: 0 };

    if (isReducedMotion()) this.renderAt(REPLAY_MS);
    else await this.animate(token, REPLAY_MS);
    if (token !== this.raceToken) return;

    this.reportResults(active, dij, ch, graph, path, optimalDist);
  }

  private reportResults(
    active: { algo: RacerId; label: string; result: AlgoResult }[],
    dij: AlgoResult, ch: AlgoResult, graph: Graph, path: number[], optimalDist: number,
  ): void {
    for (const a of active) this.ui.setTime(a.algo, a.result.ms);
    // The headline stat is always Dijkstra-vs-CH specifically (the site's
    // core claim), independent of which optional racers also ran or
    // whether the family bidi modifier is on (dij/ch here are always the
    // plain, always-exact core keys — see run()'s own comment on why the
    // shared overlay route is anchored to them the same way).
    this.ui.setHeadline(headlineText(dij.settledCount, ch.settledCount));
    const km = pathKm(graph, path);
    // `optimalDist` is run()'s own computation, passed through rather than
    // re-derived here — see that call site's comment for why (also feeds
    // AlgoLayer.dashed). Reused for both the aria sentence and each row's
    // live disclosure below — one source of truth, never two accumulators
    // that could drift apart.
    const deltas = active.map((a) => ({ algo: a.algo, pct: routeDeltaPct(a.result.dist, optimalDist) }));
    const deltaByAlgo = new Map(deltas.map((d) => [d.algo, d.pct] as const));
    this.ui.announce(
      formatRosterAnnouncement(
        active.map((a) => ({ label: a.label, settled: a.result.settledCount, deltaPct: deltaByAlgo.get(a.algo) })),
        km,
      ),
    );
    for (const d of deltas) this.ui.setRowDelta(d.algo, d.pct);
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
