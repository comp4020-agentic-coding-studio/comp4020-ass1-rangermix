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
import type { Algo, AlgoResult, RaceRequest, RaceResponse } from "./worker";

const REPLAY_MS = 2500;
const DOT_RADIUS = 1.8;
const DRAW_CAP = 4000; // see mapRenderer.strideFor: visual sampling cap per frame

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

/** The once-per-race aria text: canvas wrapper aria-label AND the
 * `race-live` region share this exact string. Settled counts use en-AU
 * thousands separators (matches the scoreboard rows); km is the haversine
 * route length, one decimal — never the graph's own travel-TIME distance. */
export function formatAnnouncement(dijSettled: number, chSettled: number, km: number): string {
  return (
    `Dijkstra settled ${dijSettled.toLocaleString("en-AU")} intersections; ` +
    `Contraction Hierarchies settled ${chSettled.toLocaleString("en-AU")}. ` +
    `Same ${km.toFixed(1)} km route.`
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

interface Frame {
  graph: Graph;
  dijOrder: Uint32Array;
  dijTotal: number;
  dijStride: number;
  chOrder: Uint32Array;
  chTotal: number;
  chStride: number;
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
  private readonly pending = new Map<number, (res: RaceResponse) => void>();
  private nextId = 0;
  private raceToken = 0;
  private current: Frame | null = null;

  constructor(view: MapView, ui: RaceUi) {
    this.view = view;
    this.ui = ui;
    // The worker module's own relative fetches resolve against the BUNDLE
    // location (dist/assets/), not the page, so the page (here: the
    // controller that owns the worker) computes the real data base once
    // and sends it along with every request.
    this.dataBase = new URL("./data/", document.baseURI).href;
    this.routingPromise = loadRouting(this.dataBase);
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<RaceResponse>) => {
      const resolve = this.pending.get(e.data.id);
      if (resolve) {
        this.pending.delete(e.data.id);
        resolve(e.data);
      }
    };
    // Replay state lives in `this.current`, not in the canvas — so a theme
    // change mid-race is just "redraw the same frame with fresh colors"
    // (MapView repaints its own base layer on the same event already).
    onThemeChange(() => this.redrawFrame());
  }

  private request(req: RaceRequest): Promise<RaceResponse> {
    return new Promise((resolve) => {
      this.pending.set(req.id, resolve);
      this.worker.postMessage(req);
    });
  }

  /** Re-renders whatever frame was last shown (final or mid-replay) with
   * fresh theme colors and the current canvas size — the resize/theme-change
   * redraw hook. A no-op before any race has run (nothing to redraw yet). */
  redrawFrame(): void {
    if (this.current) this.renderAt(this.current.elapsed);
  }

  private renderAt(elapsedMs: number): void {
    const c = this.current;
    if (!c) return;
    c.elapsed = elapsedMs;
    const dark = effectiveTheme() === "dark";
    const colors = themeColors();
    const upDij = sliceForFrame(c.dijTotal, elapsedMs, c.duration);
    const upCh = sliceForFrame(c.chTotal, elapsedMs, c.duration);

    this.view.clearOverlay();
    this.view.drawDots(c.dijOrder, upDij, c.graph.lon, c.graph.lat, dark ? colors.dijkstraGlow : colors.dijkstra, {
      additive: dark,
      radius: DOT_RADIUS,
      stride: c.dijStride,
    });
    this.view.drawDots(c.chOrder, upCh, c.graph.lon, c.graph.lat, dark ? colors.chGlow : colors.ch, {
      additive: dark,
      radius: DOT_RADIUS,
      stride: c.chStride,
    });
    if (elapsedMs >= c.duration && c.path.length >= 2) this.view.drawRoute(c.path, c.graph.lon, c.graph.lat);
    this.view.drawPin(c.graph.lon[c.pinA], c.graph.lat[c.pinA], "A");
    this.view.drawPin(c.graph.lon[c.pinB], c.graph.lat[c.pinB], "B");

    // Bar width is "% of max" on a SHARED scale (design contract: CH's bar
    // reads as a sliver next to Dijkstra's full one) — each row's own total
    // as its own denominator would make both bars end at 100%, erasing the
    // entire visual point of the comparison.
    const maxTotal = Math.max(c.dijTotal, c.chTotal);
    this.ui.setRow("dijkstra", upDij, maxTotal);
    this.ui.setRow("ch", upCh, maxTotal);
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

  /** Computes (via the worker) and replays a Dijkstra-vs-CH race between two
   * already-snapped node indices. Superseded races (a newer `run()` call
   * landing while this one is still animating) bail out silently instead of
   * fighting the newer race for the canvas. */
  async run(fromNode: number, toNode: number): Promise<void> {
    const token = ++this.raceToken;
    const [{ graph }, res] = await Promise.all([
      this.routingPromise,
      this.request({
        id: ++this.nextId,
        from: fromNode,
        to: toNode,
        algos: ["dijkstra", "ch"],
        dataBase: this.dataBase,
      }),
    ]);
    if (token !== this.raceToken) return;

    const dij = res.results.dijkstra;
    const ch = res.results.ch;
    if (!dij || !ch) return; // worker only omits a key if we didn't ask for it

    const dijOrder = new Uint32Array(dij.settled);
    const chOrder = new Uint32Array(ch.settled);
    const path = ch.path.length >= 2 ? ch.path : dij.path; // prefer CH's unpacked path (equivalence guarantee)

    this.current = {
      graph,
      dijOrder,
      dijTotal: dij.settledCount,
      dijStride: strideFor(dijOrder.length, DRAW_CAP),
      chOrder,
      chTotal: ch.settledCount,
      chStride: strideFor(chOrder.length, DRAW_CAP),
      path,
      pinA: fromNode,
      pinB: toNode,
      duration: REPLAY_MS,
      elapsed: 0,
    };

    if (isReducedMotion()) this.renderAt(REPLAY_MS);
    else await this.animate(token, REPLAY_MS);
    if (token !== this.raceToken) return;

    this.reportResults(dij, ch, graph, path);
  }

  private reportResults(dij: AlgoResult, ch: AlgoResult, graph: Graph, path: number[]): void {
    this.ui.setTime("dijkstra", dij.ms);
    this.ui.setTime("ch", ch.ms);
    this.ui.setHeadline(headlineText(dij.settledCount, ch.settledCount));
    const km = pathKm(graph, path);
    this.ui.announce(formatAnnouncement(dij.settledCount, ch.settledCount, km));
  }
}
