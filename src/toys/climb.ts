// Chapter 3 toy: toytown redrawn in 2.5-D — x stays each node's real
// projected x, y lifts by contraction rank for the nodes THIS query's climb
// actually touches; every other node ghosts at a flat baseline (design spec
// §14.8: "the climb toy draws only the nodes its query touches (rank-lifted),
// ghosting the rest" — a fixed per-rank step (right for MINITOWN's always-12
// nodes) would run off the top of the picture once ranks range up to 54, so
// the lift is rescaled per query to the highest rank actually touched).
// Everything the animation plays is scripted from ONE real chQuery(ch, from,
// to) run: its settled/settledB (forward/backward settle order), meet, and
// path are recorded once, and the whole step sequence is DERIVED from that
// recording plus the real ch.up/ch.downRev structure buildCh produced
// alongside it — nothing here is a hand-authored sequence. The visitor can
// re-pick endpoints by clicking two nodes; the DEFAULT pair is found by
// scanning the real graph for the first ordered pair whose winning path
// actually needs a shortcut (see findDefaultClimbPair) — never a hardcoded
// node index, so it self-adapts if the toytown artifact is ever regenerated.
//
// Plus the closing echo below it (unchanged from the mini-town version:
// pure formatting/parsing of the visitor's own last race, or the offline
// benchmark fallback).

import { buildCh, type Ch } from "../algos/chBuild";
import { chQuery, type ChResult } from "../algos/chQuery";
import type { Csr } from "../algos/graph";
import type { Meta } from "../data";
import { VIEWBOX, VIEWBOX_H, VIEWBOX_W, type Toytown } from "./toytown";
import { advancePick, declutterXY, IDLE_PICK, MIN_NODE_DIST, type PickState } from "./toytownView";

const STEP_MS = 300;
const BASE_Y = 260;
const TOP_Y = 24;
const LAST_RACE_KEY = "hth-last-race";

// "Enough climb" for the default-pair search: the combined forward+backward
// settle count must be at least this many nodes, so the opening animation
// shows a real multi-step convergence rather than a trivial one-hop
// adjacency. The real toytown graph's first-scanned qualifying pair clears
// this by a wide margin (18, measured — see the F5 report), so this floor
// is a genuine "not degenerate" guard, not a tuned-to-fit number.
const MIN_TOUCHED = 6;

function reducedMotion(): boolean {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

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

/** Scans every ordered pair on `ch`'s graph for the FIRST one whose CH
 * winning path (a) traverses at least one real shortcut — `result.
 * usesShortcut`, computed by chQuery itself from the winning path's own
 * compact edge chain, deliberately narrower than "did the search relax
 * through a shortcut ANYWHERE while exploring" (a bidirectional search
 * settles many nodes that never end up on the final answer — see
 * ChResult.usesShortcut's own doc comment) — and (b) touches "enough" of
 * the graph to animate (see MIN_TOUCHED). This is the same technique an
 * earlier review used BY HAND to pick MINITOWN's I->L pair (a sweep of all
 * 132 ordered pairs; see this file's git history), now run LIVE against
 * whatever graph is actually loaded instead of a constant baked in from a
 * one-off offline sweep — so it self-adapts if the toytown artifact is ever
 * regenerated with different node numbering, and spec/data.test.ts asserts
 * it against the shipped artifact so a regeneration that broke it would be
 * caught in CI, not just live in a browser.
 *
 * n<=80 (design spec's toy-graph target) makes the full O(n^2) scan cheap —
 * a few ms across all 2,970 ordered pairs on the real 55-node toytown
 * artifact, measured (see the F5 report) — so there's no need to bound or
 * memoize it; it runs once per mount. Returns null only if NO pair
 * qualifies at all, which would mean the artifact stopped having a real
 * hierarchy — the caller treats that as a dev-loud error, not a silently
 * broken toy. */
export function findDefaultClimbPair(
  ch: Ch,
  minTouched = MIN_TOUCHED,
): { from: number; to: number } | null {
  for (let from = 0; from < ch.n; from++) {
    for (let to = 0; to < ch.n; to++) {
      if (from === to) continue;
      const result = chQuery(ch, from, to);
      if (!Number.isFinite(result.dist)) continue;
      if (!result.usesShortcut) continue;
      if (result.settled.length + result.settledB.length < minTouched) continue;
      return { from, to };
    }
  }
  return null;
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

function labelFor(i: number, n: number, from: number, to: number, touched: boolean): string {
  const base = `Intersection ${i + 1} of ${n}`;
  if (i === from) return `${base}, start`;
  if (i === to) return `${base}, end`;
  return touched ? base : `${base} (not on this climb)`;
}

export function mountClimb(root: HTMLElement, t: Toytown): { playDefault: () => void } {
  const ch = buildCh(t.graph);
  const defaultPair = findDefaultClimbPair(ch);
  if (!defaultPair) {
    // Dev-loud on purpose: this is an artifact-integrity signal (the
    // toytown graph stopped having any pair whose winning path uses a
    // shortcut), not a user-input problem — see findDefaultClimbPair's own
    // comment and spec/data.test.ts's matching regression sensor.
    throw new Error(
      "climb toy: no ordered pair on the toytown graph has a CH winning path that " +
        "uses a shortcut — chapter 3's whole point breaks. Regenerate/inspect public/data/toytown.json.",
    );
  }

  root.innerHTML =
    `<div class="toy-stage">` +
    `<svg class="toy-svg" viewBox="${VIEWBOX}" role="img" ` +
    `aria-label="Toytown redrawn by contraction rank — height stands in for rank — ` +
    `showing Contraction Hierarchies' upward query.">` +
    `<g class="climb-edges" data-role="edges"></g>` +
    `<path class="route-path" d="" />` +
    `</svg>` +
    `<div class="climb-nodes" data-role="nodes"></div>` +
    `<div class="climb-meet" data-role="meet" aria-hidden="true">` +
    `<span class="meet-star">&#9733;</span><span class="meet-label">meet</span></div>` +
    `</div>` +
    `<p class="toy-subhead">Click two intersections to climb your own pair — first
      is the start, second is the end.</p>` +
    `<div class="toy-controls">` +
    `<button class="chip" type="button" data-action="play">&#9658; play</button>` +
    `<button class="chip" type="button" data-action="step">step</button>` +
    `<button class="chip" type="button" data-action="reset">&#8635; reset</button>` +
    `<span class="toy-counter" data-role="counter"></span>` +
    `</div>`;

  const edgesGroup = root.querySelector<SVGGElement>('[data-role="edges"]');
  const routePath = root.querySelector<SVGPathElement>(".route-path");
  const nodesLayer = root.querySelector<HTMLElement>('[data-role="nodes"]');
  const meetEl = root.querySelector<HTMLElement>('[data-role="meet"]');
  const counter = root.querySelector<HTMLElement>('[data-role="counter"]');
  const playBtn = root.querySelector<HTMLButtonElement>('[data-action="play"]');
  const stepBtn = root.querySelector<HTMLButtonElement>('[data-action="step"]');
  const resetBtn = root.querySelector<HTMLButtonElement>('[data-action="reset"]');

  // Node buttons are rebuilt on every setPair (their position AND their
  // touched/ghost state both depend on the current query), so listeners are
  // (re-)wired inside setPair too, keyed by a single delegated handler on
  // the layer instead of one closure per node per pair-change.
  nodesLayer?.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>(".node-btn");
    if (!btn) return;
    const i = Number(btn.dataset.node);
    const { next, complete } = advancePick(pick, i);
    pick = next;
    if (nodesLayer) {
      for (const b of nodesLayer.querySelectorAll<HTMLButtonElement>(".node-btn")) {
        b.classList.toggle("pending-start", Number(b.dataset.node) === pick.start && pick.end === null);
      }
    }
    if (complete) setPair(complete[0], complete[1]);
  });

  let from = defaultPair.from;
  let to = defaultPair.to;
  let result: ChResult = chQuery(ch, from, to);
  let steps: ClimbStep[] = [];
  // Node -> {fwdIdx, bwdIdx}: the step index at which each direction
  // settles this node, if it does (a node can be settled by BOTH searches
  // before they meet, so this tracks both independently rather than the
  // first match only — a plain steps.findIndex per node would silently
  // stop showing the backward ring on a node also reached from the front).
  let nodeStepIndex = new Map<number, { fwdIdx?: number; bwdIdx?: number }>();
  let rankStepPx = 0;
  let touched = new Set<number>();
  // Every node's on-screen position for the CURRENT query — real x, rank-
  // lifted (touched) or baseline (ghost) y — then run through declutterXY
  // (see toytownView.ts): unlike flood/contraction/order, climb's edges are
  // already schematic straight lines (not real street geometry), so there
  // is no "true geometry" for a decluttered button to visually drift away
  // from — buttons, climb-edges, the route path, and the meet marker all
  // read from this SAME decluttered array, so nothing seams. Recomputed
  // wherever `touched`/`rankStepPx` change (setPair and the initial paint).
  let displayXY: [number, number][] = [];
  let shown = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pick: PickState = IDLE_PICK;

  function computeNodeStepIndex(s: ClimbStep[]): Map<number, { fwdIdx?: number; bwdIdx?: number }> {
    const m = new Map<number, { fwdIdx?: number; bwdIdx?: number }>();
    s.forEach((step, idx) => {
      if (step.kind !== "fwd" && step.kind !== "bwd") return;
      const entry = m.get(step.node) ?? {};
      if (step.kind === "fwd") entry.fwdIdx = idx;
      else entry.bwdIdx = idx;
      m.set(step.node, entry);
    });
    return m;
  }

  function recomputeDisplayXY(): void {
    const raw: [number, number][] = t.xy.map(([x], i) => [
      x,
      touched.has(i) ? rankY(ch.rank[i], rankStepPx) : BASE_Y,
    ]);
    displayXY = declutterXY(raw, MIN_NODE_DIST, undefined, [0, 0, VIEWBOX_W, VIEWBOX_H]);
  }

  function nodeXY(i: number): [number, number] {
    return displayXY[i];
  }

  function stop(): void {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  function paintRoute(edgeCount: number): void {
    if (!routePath) return;
    if (edgeCount <= 0) {
      routePath.setAttribute("d", "");
      return;
    }
    const pts = result.path
      .slice(0, edgeCount + 1)
      .map((i) => nodeXY(i).join(","))
      .join(" L ");
    routePath.setAttribute("d", `M ${pts}`);
  }

  const fwdTotal = () => result.settled.length;
  const bwdTotal = () => result.settledB.length;
  const meetIndex = () => fwdTotal() + bwdTotal();
  const unpackTotal = () => steps.length - meetIndex() - 1;

  function counterText(): string {
    if (shown === 0) return "press play to watch the climb from both ends";
    const fT = fwdTotal();
    const bT = bwdTotal();
    const mi = meetIndex();
    const uT = unpackTotal();
    if (shown <= fT) return `forward climb: ${shown} of ${fT} settled`;
    if (shown <= mi) return `backward climb: ${shown - fT} of ${bT} settled`;
    if (shown === mi + 1) return `met — unpacking the route next`;
    const unpacked = shown - mi - 1;
    if (unpacked < uT) return `unpacking the route: ${unpacked} of ${uT} streets`;
    return `done — ${result.dist.toFixed(0)}s, ${uT} streets`;
  }

  function render(): void {
    if (!nodesLayer) return;
    for (const btn of nodesLayer.querySelectorAll<HTMLButtonElement>(".node-btn")) {
      const i = Number(btn.dataset.node);
      const idx = nodeStepIndex.get(i);
      const fwdActive = idx?.fwdIdx !== undefined && idx.fwdIdx < shown;
      const bwdActive = idx?.bwdIdx !== undefined && idx.bwdIdx < shown;
      btn.classList.toggle("touched-fwd", fwdActive);
      btn.classList.toggle("touched-bwd", bwdActive);
    }
    for (const el of edgesGroup?.querySelectorAll<SVGLineElement>(".climb-edge") ?? []) {
      const idx = Number(el.dataset.stepIdx);
      el.classList.toggle("revealed", idx < shown);
    }
    if (meetEl) meetEl.classList.toggle("shown", shown > meetIndex());
    paintRoute(Math.max(0, Math.min(unpackTotal(), shown - meetIndex() - 1)));
    if (counter) counter.textContent = counterText();
    if (stepBtn) stepBtn.disabled = shown >= steps.length;
  }

  function step(): boolean {
    if (shown >= steps.length) return false;
    shown++;
    render();
    return shown < steps.length;
  }

  function playFromCurrent(): void {
    stop();
    shown = 0;
    if (reducedMotion()) {
      shown = steps.length;
      render();
      return;
    }
    render();
    timer = setInterval(() => {
      if (!step()) stop();
    }, STEP_MS);
  }

  function positionMeet(): void {
    if (!meetEl) return;
    const [x, y] = nodeXY(result.meet);
    meetEl.style.left = `${(x / VIEWBOX_W) * 100}%`;
    meetEl.style.top = `${(y / VIEWBOX_H) * 100}%`;
  }

  function renderNodesAndEdges(): void {
    if (!nodesLayer || !edgesGroup) return;
    nodesLayer.innerHTML = t.xy
      .map((_, i) => {
        const [x, y] = nodeXY(i);
        const left = ((x / VIEWBOX_W) * 100).toFixed(3);
        const top = ((y / VIEWBOX_H) * 100).toFixed(3);
        const ghost = !touched.has(i) ? " ghost" : "";
        const endpoint = i === from ? " endpoint-a" : i === to ? " endpoint-b" : "";
        // Echoes the home page's own map-pin convention ("A"/"B" discs) —
        // aria-label carries the same info for screen readers regardless.
        const label = i === from ? "A" : i === to ? "B" : "";
        return (
          `<button class="node-btn climb-node-btn${ghost}${endpoint}" type="button" data-node="${i}" ` +
          `style="left:${left}%;top:${top}%" ` +
          `aria-label="${labelFor(i, t.graph.n, from, to, touched.has(i))}">${label}</button>`
        );
      })
      .join("");

    const lines: string[] = [];
    steps.forEach((s, idx) => {
      if (s.kind !== "fwd" && s.kind !== "bwd") return;
      for (const e of s.edges) {
        const [x1, y1] = nodeXY(e.from);
        const [x2, y2] = nodeXY(e.to);
        lines.push(
          `<line class="climb-edge climb-edge-${s.kind}" data-step-idx="${idx}" ` +
            `x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />`,
        );
      }
    });
    edgesGroup.innerHTML = lines.join("");
    positionMeet();
  }

  function setPair(newFrom: number, newTo: number): void {
    stop();
    const r = chQuery(ch, newFrom, newTo);
    if (!Number.isFinite(r.dist)) return; // toytown is strongly connected; defensive only
    from = newFrom;
    to = newTo;
    result = r;
    steps = buildSteps(ch, result);
    nodeStepIndex = computeNodeStepIndex(steps);
    touched = touchedNodes(result);
    const maxRank = Math.max(0, ...[...touched].map((i) => ch.rank[i]));
    rankStepPx = rankStep(maxRank);
    recomputeDisplayXY();
    shown = 0;
    renderNodesAndEdges();
    render();
    playFromCurrent();
  }

  // Initial paint at the default pair WITHOUT auto-playing — how.ts's
  // scroll-visibility gate calls playDefault() once this toy is actually in
  // view (design spec §14.10: auto-start on scroll, not on mount).
  steps = buildSteps(ch, result);
  nodeStepIndex = computeNodeStepIndex(steps);
  touched = touchedNodes(result);
  {
    const maxRank = Math.max(0, ...[...touched].map((i) => ch.rank[i]));
    rankStepPx = rankStep(maxRank);
  }
  recomputeDisplayXY();
  renderNodesAndEdges();
  render();

  playBtn?.addEventListener("click", () => playFromCurrent());
  stepBtn?.addEventListener("click", () => {
    stop();
    step();
  });
  resetBtn?.addEventListener("click", () => {
    stop();
    shown = 0;
    render();
  });

  return { playDefault: () => playFromCurrent() };
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
