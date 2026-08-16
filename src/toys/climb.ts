// Chapter 3's PURE logic: the step script, the default-pair search, and the
// rank-lift layout math. The DOM half (two linked views — design spec
// §16.13: the computed hierarchy on top, the real street map below, one
// chQuery run driving both in lockstep) lives in climbLinked.ts, which
// imports everything below; splitting it out keeps this module fetch/DOM
// free and directly unit-testable, same division of labor as
// toytown.ts/toytownView.ts.
//
// x stays each node's real projected x, y lifts by contraction rank for the
// nodes THIS query's climb actually touches; every other node ghosts at a
// flat baseline (design spec §14.8: "the climb toy draws only the nodes its
// query touches (rank-lifted), ghosting the rest" — a fixed per-rank step
// (right for MINITOWN's always-12 nodes) would run off the top of the
// picture once ranks range up to 54+, so the lift is rescaled per query to
// the highest rank actually touched). Everything the animation plays is
// scripted from ONE real chQuery(ch, from, to) run: its settled/settledB
// (forward/backward settle order), meet, and path are recorded once, and
// the whole step sequence is DERIVED from that recording plus the real
// ch.up/ch.downRev structure buildCh produced alongside it — nothing here
// is a hand-authored sequence. The visitor re-picks endpoints by clicking two
// nodes ON THE MAP (§16.13: the hierarchy view is display-only); the
// DEFAULT pair is found by scanning the real graph for the ordered pair
// whose winning path (a) needs a shortcut and (b) — among those — rides the
// most arterial (cls>=2) street, never a hardcoded node index, so it
// self-adapts if the toytown artifact is ever regenerated (see
// findDefaultClimbPair/countArterialSegments).
//
// Plus the closing echo below it (unchanged from the mini-town version:
// pure formatting/parsing of the visitor's own last race, or the offline
// benchmark fallback).

import type { Ch, ChEdge } from "../algos/chBuild";
import { chQuery, type ChResult } from "../algos/chQuery";
import type { Csr } from "../algos/graph";
import type { Meta } from "../data";
import type { Toytown } from "./toytown";
import { edgeClsOf, isArterial } from "./toytownView";

const BASE_Y = 260;
const TOP_Y = 24;
const LAST_RACE_KEY = "hth-last-race";

// "Enough climb" for the default-pair search: the combined forward+backward
// settle count must be at least this many nodes, so the opening animation
// shows a real multi-step convergence rather than a trivial one-hop
// adjacency. The real toytown graph's qualifying pairs clear this by a wide
// margin (measured — see the F5/G5 reports), so this floor is a genuine
// "not degenerate" guard, not a tuned-to-fit number. Exported so
// climbLinked's mount call can pass it explicitly alongside a scorer (JS/TS
// has no "skip a positional default" — see findDefaultClimbPair).
export const MIN_TOUCHED = 6;

/** Vertical pixel spacing between adjacent contraction ranks, scaled so the
 * HIGHEST rank actually touched by this query lands near the top of the
 * viewBox — see the file banner for why a fixed step (right for MINITOWN's
 * always-12-node graph) breaks once ranks range up to 54 (toytown's node
 * count). `maxRank <= 0` (nothing to climb) returns 0. */
export function rankStep(maxRank: number): number {
  return maxRank > 0 ? (BASE_Y - TOP_Y) / maxRank : 0;
}

/** Contraction rank -> vertical position at a given per-rank `step` (see
 * rankStep): rank 0 sits on the floor at BASE_Y, every rank above it lifts
 * `step` px higher (smaller y). Pure layout math, exported for direct
 * testing. */
export function rankY(rank: number, step: number): number {
  return BASE_Y - rank * step;
}

export interface HighlightEdge {
  from: number;
  to: number;
  edgeIdx: number;
}

/** Every CSR edge, indexed by its destination node — the lookup buildSteps
 * uses to find which real up/downRev edges connect a newly-settled node
 * back to the frontier that's already settled. */
export function incomingEdges(csr: Csr): Map<number, HighlightEdge[]> {
  const m = new Map<number, HighlightEdge[]>();
  for (let u = 0; u < csr.firstOut.length - 1; u++) {
    for (let s = csr.firstOut[u]; s < csr.firstOut[u + 1]; s++) {
      const v = csr.head[s];
      const entry: HighlightEdge = { from: u, to: v, edgeIdx: csr.edge[s] };
      const list = m.get(v);
      if (list) list.push(entry);
      else m.set(v, [entry]);
    }
  }
  return m;
}

export type ClimbStep =
  | { kind: "fwd"; node: number; edges: HighlightEdge[] }
  | { kind: "bwd"; node: number; edges: HighlightEdge[] }
  | { kind: "meet"; node: number }
  | { kind: "unpack"; from: number; to: number };

/** The whole animation script, derived from one real chQuery result: every
 * forward settle (with the real up-edges connecting it to the
 * already-settled frontier), every backward settle (same, over downRev),
 * one meet step, then one step per edge of the already-unpacked
 * `result.path`. Pure function of (ch, result) — same inputs, same script,
 * always; nothing here is scripted by hand. */
export function buildSteps(ch: Ch, result: ChResult): ClimbStep[] {
  const steps: ClimbStep[] = [];
  const incomingUp = incomingEdges(ch.up);
  const incomingDown = incomingEdges(ch.downRev);

  const seenFwd = new Set<number>();
  for (const node of result.settled) {
    const edges = (incomingUp.get(node) ?? []).filter((e) => seenFwd.has(e.from));
    steps.push({ kind: "fwd", node, edges });
    seenFwd.add(node);
  }

  const seenBwd = new Set<number>();
  for (const node of result.settledB) {
    const edges = (incomingDown.get(node) ?? []).filter((e) => seenBwd.has(e.from));
    steps.push({ kind: "bwd", node, edges });
    seenBwd.add(node);
  }

  steps.push({ kind: "meet", node: result.meet });

  for (let i = 0; i + 1 < result.path.length; i++) {
    steps.push({ kind: "unpack", from: result.path[i], to: result.path[i + 1] });
  }

  return steps;
}

/** Recursively unpacks a CH edge index down to the ORIGINAL (non-shortcut)
 * leaf edges it represents, appending each leaf's own index in `edges` to
 * `acc` (also returned, for chaining) — the same expansion chQuery.ts's
 * own private `expand` performs when unpacking the winning PATH, reused
 * here (a deliberate small duplicate, not an import — see stepStreetPairs)
 * so climbLinked can resolve a "fwd"/"bwd" step's possibly-shortcut
 * highlight edges back to the real streets they stand in for: a shortcut is
 * not itself a street, so drawing it as one directly on the MAP view would
 * show a road that doesn't exist. */
export function expandChEdge(edges: ChEdge[], ei: number, acc: number[] = []): number[] {
  const e = edges[ei];
  if (e.childA === -1) {
    acc.push(ei);
    return acc;
  }
  expandChEdge(edges, e.childA, acc);
  expandChEdge(edges, e.childB, acc);
  return acc;
}

/** Every REAL node pair (u, v) a single ClimbStep touches on the ground —
 * the pure mapping climbLinked's shared step scheduler uses to keep the map
 * view in lockstep with the hierarchy view, one call per revealed step
 * (design spec §16.13). A "fwd"/"bwd" step's highlighted CH edges are
 * expanded past any shortcut down to the ORIGINAL street pairs they stand
 * in for (expandChEdge above; each leaf's `.from`/`.to` are real toytown
 * node ids — see chBuild.ts's buildAdj, which builds every leaf ChEdge
 * directly off the real graph's CSR). An "unpack" step's {from, to}
 * already names a real street directly: chQuery's `result.path` is the
 * FULLY-unpacked route (chQuery.ts's own `expand` runs during path
 * reconstruction), so no further expansion is needed there. A "meet" step
 * touches no street at all (empty). Pure function of (ch, step) — same
 * inputs, same pairs, always. */
export function stepStreetPairs(ch: Ch, step: ClimbStep): [number, number][] {
  if (step.kind === "unpack") return [[step.from, step.to]];
  if (step.kind === "meet") return [];
  const out: [number, number][] = [];
  for (const e of step.edges) {
    for (const leaf of expandChEdge(ch.edges, e.edgeIdx)) {
      out.push([ch.edges[leaf].from, ch.edges[leaf].to]);
    }
  }
  return out;
}

/** Scans every ordered pair on `ch`'s graph for qualifying pairs — a real
 * shortcut on the winning path (`result.usesShortcut`, computed by chQuery
 * itself from the winning path's own compact edge chain, deliberately
 * narrower than "did the search relax through a shortcut ANYWHERE while
 * exploring" — see ChResult.usesShortcut's own doc comment) that also
 * touches "enough" of the graph to animate (see MIN_TOUCHED) — and returns
 * the BEST one: with no `scorePair`, the FIRST qualifying pair found (scan
 * order: `from` ascending, then `to`); with `scorePair` given, the
 * qualifying pair with the HIGHEST score, ties broken by scan order (design
 * spec §16.13: "prefer a default pair whose route travels the arterial if
 * one exists" — climbLinked passes `(result) => countArterialSegments(t,
 * result.path)`, so a pair that rides more of the arterial wins over one
 * that qualifies but stays entirely local). Both modes are deterministic:
 * same graph (and scorer), same pair, always.
 *
 * This is the same technique an earlier review used BY HAND to pick
 * MINITOWN's I->L pair (a sweep of all 132 ordered pairs; see this file's
 * git history), now run LIVE against whatever graph is actually loaded
 * instead of a constant baked in from a one-off offline sweep — so it
 * self-adapts if the toytown artifact is ever regenerated with different
 * node numbering, and spec/data.test.ts asserts it against the shipped
 * artifact so a regeneration that broke it would be caught in CI, not just
 * live in a browser.
 *
 * n<=80 (design spec's toy-graph target) makes the full O(n^2) scan cheap —
 * a few ms across all the real toytown artifact's ordered pairs, measured
 * (see the F5/G5 reports) — so there's no need to bound or memoize it, even
 * scoring every candidate instead of stopping at the first; it runs once
 * per mount. Returns null only if NO pair qualifies at all, which would
 * mean the artifact stopped having a real hierarchy — the caller treats
 * that as a dev-loud error, not a silently broken toy. */
export function findDefaultClimbPair(
  ch: Ch,
  minTouched = MIN_TOUCHED,
  scorePair?: (result: ChResult) => number,
): { from: number; to: number } | null {
  let best: { from: number; to: number } | null = null;
  let bestScore = -1;
  for (let from = 0; from < ch.n; from++) {
    for (let to = 0; to < ch.n; to++) {
      if (from === to) continue;
      const result = chQuery(ch, from, to);
      if (!Number.isFinite(result.dist)) continue;
      if (!result.usesShortcut) continue;
      if (result.settled.length + result.settledB.length < minTouched) continue;
      if (!scorePair) return { from, to };
      const score = scorePair(result);
      if (score > bestScore) {
        bestScore = score;
        best = { from, to };
      }
    }
  }
  return best;
}

/** Counts how many of `path`'s consecutive real-street hops are arterial
 * (cls>=2 — toytownView's isArterial), via edgeClsOf's directed (u, v)
 * lookup — the scoring findDefaultClimbPair's caller (climbLinked) uses to
 * prefer a default pair whose winning route actually rides the arterial
 * (design spec §16.12/13), rather than one that merely qualifies (uses A
 * shortcut somewhere) but happens to stay entirely on local streets. */
export function countArterialSegments(t: Toytown, path: number[]): number {
  let count = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    if (isArterial(edgeClsOf(t, path[i], path[i + 1]))) count++;
  }
  return count;
}

/** The set of nodes this query's climb actually touches — union of both
 * searches' settled nodes, the meet node (defensively: chQuery's final
 * meeting SCAN can in principle name a node that was relaxed by both sides
 * but popped/settled by neither — see chQuery.ts), and every node on the
 * unpacked path (shortcuts can unpack through a node neither search ever
 * visited directly, since the whole point of a shortcut is that the search
 * didn't need to visit it — see the file banner). These are exactly the
 * nodes the rank-lift layout draws lifted; everything else ghosts at the
 * baseline (design spec §14.8). */
export function touchedNodes(result: ChResult): Set<number> {
  const s = new Set<number>();
  for (const n of result.settled) s.add(n);
  for (const n of result.settledB) s.add(n);
  for (const n of result.path) s.add(n);
  if (result.meet >= 0) s.add(result.meet);
  return s;
}

// ---------- closing echo: the visitor's own race, echoed back ----------

export interface LastRace {
  dj: number;
  ch: number;
  km: number;
}

function isLastRace(v: unknown): v is LastRace {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.dj === "number" && typeof r.ch === "number" && typeof r.km === "number";
}

/** Parses whatever's in localStorage["hth-last-race"] — `null`/missing,
 * invalid JSON, or a record missing/mistyping a field all come back
 * `null` rather than throwing, so a corrupted or pre-format value just
 * falls back to the measured benchmark instead of breaking the page. */
export function parseLastRace(raw: string | null): LastRace | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isLastRace(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readLastRace(): LastRace | null {
  try {
    return parseLastRace(localStorage.getItem(LAST_RACE_KEY));
  } catch {
    // Private-mode / storage disabled: fall back to the measured benchmark.
    return null;
  }
}

/** "That's why 214 beat 21,480 on your own race — same 22.4 km route, a
 * fraction of the visits." — en-AU thousands separators, 1-decimal km,
 * matching src/race/controller.ts's own formatAnnouncement conventions. */
export function formatRaceEcho(last: LastRace): string {
  return (
    `That's why ${last.ch.toLocaleString("en-AU")} beat ${last.dj.toLocaleString("en-AU")} ` +
    `on your own race — same ${last.km.toFixed(1)} km route, a fraction of the visits.`
  );
}

/** Rounds the offline 300-route benchmark's settled-count columns to whole
 * numbers — the fallback numbers when no race has run yet this session. */
export function computeBenchMeans(bench: { dj: number; ch: number }[]): {
  meanDj: number;
  meanCh: number;
} {
  const n = bench.length || 1;
  const meanDj = Math.round(bench.reduce((sum, b) => sum + b.dj, 0) / n);
  const meanCh = Math.round(bench.reduce((sum, b) => sum + b.ch, 0) / n);
  return { meanDj, meanCh };
}

/** "Across 300 measured Canberra routes, Dijkstra settles ~13,871
 * intersections; CH settles ~179." — `n` is always the real bench array's
 * own length, never a hardcoded figure. */
export function formatBenchEcho(meanDj: number, meanCh: number, n: number): string {
  return (
    `Across ${n} measured Canberra routes, Dijkstra settles ` +
    `~${meanDj.toLocaleString("en-AU")} intersections; CH settles ~${meanCh.toLocaleString("en-AU")}.`
  );
}

async function fetchMeta(url: string): Promise<Meta> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status} ${res.statusText}`);
  return (await res.json()) as Meta;
}

/** Fills the chapter-5 closer with the visitor's own last race (persisted
 * by RaceController.reportResults at the moment the home page's scoreboard
 * got its final numbers) or, if none exists yet this session, the offline
 * 300-route benchmark means from meta.json — still measured numbers,
 * never invented ones. `/how/` sits one path segment below the site root,
 * so the fetch resolves against document.baseURI (which already ends in
 * `/how/`) rather than a literal path. */
export function mountClosingEcho(root: HTMLElement): void {
  const last = readLastRace();
  if (last) {
    root.textContent = formatRaceEcho(last);
    return;
  }

  const url = new URL("../data/meta.json", document.baseURI).href;
  fetchMeta(url)
    .then((meta) => {
      const { meanDj, meanCh } = computeBenchMeans(meta.bench);
      root.textContent = formatBenchEcho(meanDj, meanCh, meta.bench.length);
    })
    .catch((err: unknown) => {
      console.error("closing echo: meta.json failed to load", err);
      root.textContent = "couldn't load the measured comparison — reload to retry";
    });
}
