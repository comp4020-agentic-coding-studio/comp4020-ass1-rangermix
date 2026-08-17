// Chapter 4 toy (spec §21.1): click any node to contract it with the SAME
// createContractor() the real Canberra pipeline uses, on the real toytown
// street network — then NARRATE what it decided, one neighbour pair per
// beat. A click computes everything up front (the outcome, plus the
// pre-contraction snapshot the display needs), then plays a 3-phase script
// per ordered pair: legs (the pair's two through streets highlight),
// detour (the best bypass flashes, held), verdict (the narration line
// stamps witness/free-pass or shortcut-added and the dashed curve draws —
// only now). All numbers are the contractor's own measured weights.
//
// Directedness note (F4, still binding): toytown is 36% one-way, so
// witness/shortcut bookkeeping here is per ORDERED pair (u -> w), never
// collapsed with its reverse pair. chBuild's simulateContract already
// visits each ordered (in-neighbour, out-neighbour) combination exactly
// once per contract() call, so the outcome never contains a duplicate
// ordered pair. The base ROAD layer is a separate concern and still
// collapses to one line per physical street (see toytownView's
// physicalEdges): a real two-way street is one piece of asphalt regardless
// of how many shortcut directions its endpoints later need.

import { createContractor } from "../algos/chBuild";
import { dijkstra } from "../algos/dijkstra";
import { buildCsr, type Graph } from "../algos/graph";
import { VIEWBOX, VIEWBOX_H, VIEWBOX_W, type Toytown } from "./toytown";
import {
  contextPolylineMarkup,
  declutterXY,
  drawShortcutCurve,
  driftConnectorMarkup,
  driftConnectors,
  MIN_NODE_DIST,
  NODE_CLAMP_BOUNDS,
  physicalEdges,
  roadPolylineMarkup,
  unorderedKey,
} from "./toytownView";

// 3 phases x 400ms ≈ 1.2s per pair — spec §21.1's "~1.2s auto-advance".
const PHASE_MS = 400;

function orderedKey(a: number, b: number): string {
  return `${a}->${b}`;
}

// ---------------------------------------------------------------------
// The pure verdict layer (tested in contraction.test.ts). The narration
// strings are spec contracts — pinned character-for-character.
// ---------------------------------------------------------------------

export interface PairVerdict {
  u: number;
  w: number;
  via: number;
  /** Through cost u -> via -> w, rounded to whole seconds for display. */
  throughS: number;
  /** Best detour avoiding via, rounded seconds; null = no detour exists. */
  detourS: number | null;
  /** True iff a detour exists and is no slower than through — the SAME
   * `bypass <= viaV` rule simulateContract applies, decided on the RAW
   * weights (display rounding must never flip a verdict: the curve the toy
   * draws has to match the shortcut the contractor really inserted). */
  witness: boolean;
  /** The detour's node path ([] when none) — shown even for a too-slow
   * detour: the failed alternative is the evidence the shortcut is needed. */
  detourPath: number[];
  /** The verdict line, exact (spec §21.1). */
  narration: string;
}

export function pairVerdict(
  u: number,
  w: number,
  via: number,
  through: number,
  detour: { dist: number; path: number[] } | null,
): PairVerdict {
  const throughS = Math.round(through);
  const detourS = detour === null ? null : Math.round(detour.dist);
  const witness = detour !== null && detour.dist <= through;
  const narration = witness
    ? `through: ${throughS}s · detour found: ${detourS}s ≤ ${throughS}s → free pass (witness)`
    : detour === null
      ? `through: ${throughS}s · no detour without this intersection → shortcut added (${throughS}s)`
      : `through: ${throughS}s · best detour: ${detourS}s > ${throughS}s → shortcut added (${throughS}s)`;
  return {
    u,
    w,
    via,
    throughS,
    detourS,
    witness,
    detourPath: detour === null ? [] : detour.path.slice(),
    narration,
  };
}

/** The one whole-click line a dead end gets (spec §21.1): a node whose
 * neighbours form zero ordered through pairs has nothing to ask. */
export const DEAD_END_NARRATION = "nothing meets through here — free to remove, no shortcuts";

export type PairPhase = 0 | 1 | 2;

/** The pinned 3-beat narration scheme: phase 0 (legs) shows the through
 * cost, phase 1 (detour search) adds a searching ellipsis, phase 2 lands
 * the full verdict. One scheme for every pair, witness or shortcut. */
export function phaseNarration(p: PairVerdict, phase: PairPhase): string {
  if (phase === 0) return `through: ${p.throughS}s`;
  if (phase === 1) return `through: ${p.throughS}s · detour: …`;
  return p.narration;
}

// ---------------------------------------------------------------------
// DOM half.
// ---------------------------------------------------------------------

/** The real, DIRECTED edge list straight off `g.fwd`'s CSR — never
 * symmetrized. This is the local "live graph" mirror the toy re-derives
 * witness paths from as contractions proceed; building it from anything
 * other than the graph's own real edges would let the toy find a witness
 * route along a one-way street backwards, which the real algorithm (and a
 * real driver) never could. */
function directedEdgesOf(g: Graph): { from: number; to: number; w: number }[] {
  const out: { from: number; to: number; w: number }[] = [];
  for (let u = 0; u < g.n; u++) {
    for (let s = g.fwd.firstOut[u]; s < g.fwd.firstOut[u + 1]; s++) {
      out.push({ from: u, to: g.fwd.head[s], w: g.fwd.weight[s] });
    }
  }
  return out;
}

function graphFromEdges(n: number, edges: { from: number; to: number; w: number }[]): Graph {
  return { n, lon: new Float64Array(n), lat: new Float64Array(n), fwd: buildCsr(n, edges) };
}

// Button centers, decluttered apart (see toytownView's declutterXY): the
// real toytown layout has intersections as little as ~2px apart on screen,
// which no hit-circle padding alone can make individually clickable.
// Shortcut curves still anchor to `t.xy` directly (drawShortcutCurve), so
// they stay geometrically accurate even where their endpoint's button
// nudged.
function nodeButtonsMarkup(t: Toytown): string {
  const buttonXY = declutterXY(t.xy, MIN_NODE_DIST, undefined, NODE_CLAMP_BOUNDS);
  return buttonXY
    .map(([x, y], i) => {
      const left = ((x / VIEWBOX_W) * 100).toFixed(3);
      const top = ((y / VIEWBOX_H) * 100).toFixed(3);
      return (
        `<button class="node-btn" type="button" data-node="${i}" ` +
        `style="left:${left}%;top:${top}%" aria-label="Contract intersection ${i + 1} of ${t.xy.length}"></button>`
      );
    })
    .join("");
}

function reducedMotion(): boolean {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function mountContraction(root: HTMLElement, t: Toytown): void {
  // One instance for the lifetime of this mount: later clicks must see
  // shortcuts earlier clicks already added.
  const contractor = createContractor(t.graph);
  const roads = physicalEdges(t);
  // Same declutter run nodeButtonsMarkup does internally — see flood.ts's
  // matching comment (design spec §17.5 delta 3).
  const buttonXY = declutterXY(t.xy, MIN_NODE_DIST, undefined, NODE_CLAMP_BOUNDS);

  root.innerHTML =
    `<div class="toy-stage">` +
    `<svg class="toy-svg" viewBox="${VIEWBOX}" aria-hidden="true">` +
    `<g class="context-layer">${contextPolylineMarkup(t)}</g>` +
    `<g class="edges">${roadPolylineMarkup(roads)}</g>` +
    `<g class="drift-layer">${driftConnectorMarkup(driftConnectors(t.xy, buttonXY))}</g>` +
    `<g class="shortcuts"></g>` +
    `</svg>` +
    nodeButtonsMarkup(t) +
    `</div>` +
    // The narration line (spec §21.1): directly under the stage, present
    // from mount (empty until the first click), polite so a screen reader
    // hears each verdict without it interrupting.
    `<p class="toy-narration" data-role="narration" aria-live="polite"></p>` +
    `<div class="toy-controls">` +
    `<button class="chip" type="button" data-action="play">&#9658; play</button>` +
    `<button class="chip" type="button" data-action="step">step</button>` +
    `<button class="chip" type="button" data-action="reset">&#8635; reset</button>` +
    `<span class="toy-counter" data-role="counter"></span>` +
    `</div>`;

  const svg = root.querySelector("svg");
  const shortcutsGroup = svg?.querySelector<SVGGElement>(".shortcuts");
  const narrationEl = root.querySelector<HTMLElement>('[data-role="narration"]');
  const counter = root.querySelector<HTMLElement>('[data-role="counter"]');
  const playBtn = root.querySelector<HTMLButtonElement>('[data-action="play"]');
  const stepBtn = root.querySelector<HTMLButtonElement>('[data-action="step"]');
  const resetBtn = root.querySelector<HTMLButtonElement>('[data-action="reset"]');

  // Physical-street elements for highlighting through legs / flashing a
  // detour route — keyed UNORDERED, one per real street (see
  // physicalEdges): a path can traverse a two-way street in either
  // direction and it's the SAME piece of road either way.
  const roadEls = new Map<string, SVGPolylineElement>();
  if (svg) {
    for (const el of svg.querySelectorAll<SVGPolylineElement>(".edge-line")) {
      roadEls.set(unorderedKey(Number(el.dataset.a), Number(el.dataset.b)), el);
    }
  }
  // Shortcut elements, keyed ORDERED — a directed graph can independently
  // need a u->w shortcut, a w->u shortcut, both, or neither. Collapsing
  // them would silently drop whichever direction lost the race to be drawn
  // first.
  const shortcutEls = new Map<string, SVGPathElement>();

  const baseLiveEdges = directedEdgesOf(t.graph);
  let liveEdges = baseLiveEdges.slice();

  // The active click's phase script. `phase` is -1 before the first
  // advance, then 0..2 within pairs[idx]; null = no script running.
  interface ScriptState {
    pairs: PairVerdict[];
    /** collisionRank per pair (index within this click's shortcut batch;
     * -1 for witness pairs) — precomputed so the label fan is identical
     * whether a curve lands on its beat or in an instant catch-up. */
    ranks: number[];
    drawn: boolean[];
    idx: number;
    phase: number;
    counterBase: number;
  }
  let script: ScriptState | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;

  function findRoadEl(a: number, b: number): SVGGraphicsElement | undefined {
    return shortcutEls.get(orderedKey(a, b)) ?? roadEls.get(unorderedKey(a, b));
  }

  function graphExcluding(skip: number): Graph {
    return graphFromEdges(t.graph.n, liveEdges.filter((e) => e.from !== skip && e.to !== skip));
  }

  /** Best (lowest) live weight of the directed edge from -> to — mirrors
   * the contractor's own adjacency, which keeps the best of parallel
   * edges, so through costs here are ITS numbers, not a variant. */
  function minEdgeW(from: number, to: number): number {
    let best = Infinity;
    for (const e of liveEdges) {
      if (e.from === from && e.to === to && e.w < best) best = e.w;
    }
    return best;
  }

  function legEls(p: PairVerdict): SVGGraphicsElement[] {
    const els: SVGGraphicsElement[] = [];
    const inLeg = findRoadEl(p.u, p.via);
    const outLeg = findRoadEl(p.via, p.w);
    if (inLeg) els.push(inLeg);
    if (outLeg && outLeg !== inLeg) els.push(outLeg);
    return els;
  }

  function detourEls(p: PairVerdict): SVGGraphicsElement[] {
    const els: SVGGraphicsElement[] = [];
    for (let i = 0; i + 1 < p.detourPath.length; i++) {
      const el = findRoadEl(p.detourPath[i], p.detourPath[i + 1]);
      if (el) els.push(el);
    }
    return els;
  }

  function clearPairEffects(p: PairVerdict): void {
    for (const el of legEls(p)) el.classList.remove("through-leg");
    for (const el of detourEls(p)) el.classList.remove("flash");
  }

  function setNarration(text: string): void {
    if (narrationEl) narrationEl.textContent = text;
  }

  function updateCounter(n: number): void {
    if (!counter) return;
    counter.textContent = `${n} shortcut${n === 1 ? "" : "s"} so far`;
  }

  function drawCurve(p: PairVerdict, rank: number): void {
    if (!shortcutsGroup) return;
    const path = drawShortcutCurve(shortcutsGroup, t.xy, p.u, p.w, p.via, {
      flip: p.u > p.w,
      collisionRank: rank,
      weightLabel: p.throughS,
    });
    shortcutEls.set(orderedKey(p.u, p.w), path);
  }

  function syncChips(): void {
    const active = script !== null;
    if (playBtn) playBtn.disabled = !active;
    if (stepBtn) stepBtn.disabled = !active;
  }

  function stopTimer(): void {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  function startTimer(): void {
    stopTimer();
    timer = setInterval(() => advanceOnce(), PHASE_MS);
  }

  function enterPhase(): void {
    if (!script) return;
    const p = script.pairs[script.idx];
    const phase = script.phase as PairPhase;
    setNarration(phaseNarration(p, phase));
    if (phase === 0) {
      for (const el of legEls(p)) el.classList.add("through-leg");
    } else if (phase === 1) {
      // Held, not timed out — the detour stays lit until the pair ends,
      // so the verdict beat is read AGAINST the flashing alternative.
      for (const el of detourEls(p)) el.classList.add("flash");
    } else {
      if (!p.witness && !script.drawn[script.idx]) {
        script.drawn[script.idx] = true;
        drawCurve(p, script.ranks[script.idx]);
      }
      updateCounter(script.counterBase + script.drawn.filter(Boolean).length);
    }
  }

  function advanceOnce(): void {
    if (!script) return;
    if (script.phase === 2) {
      clearPairEffects(script.pairs[script.idx]);
      script.idx++;
      script.phase = -1;
      if (script.idx >= script.pairs.length) {
        // Script complete: the last verdict's narration and the counter
        // stay put — they're state now, not animation.
        script = null;
        stopTimer();
        syncChips();
        return;
      }
    }
    script.phase++;
    enterPhase();
  }

  /** Spec §21.1: clicking another node mid-script completes the current
   * script INSTANTLY — every remaining shortcut curve lands, highlight
   * classes clear, the counter jumps to this click's final total. */
  function finishScriptInstantly(): void {
    if (!script) return;
    stopTimer();
    const s = script;
    if (s.phase >= 0) clearPairEffects(s.pairs[s.idx]);
    let drawnCount = 0;
    for (let i = 0; i < s.pairs.length; i++) {
      const p = s.pairs[i];
      if (p.witness) continue;
      if (!s.drawn[i]) {
        s.drawn[i] = true;
        drawCurve(p, s.ranks[i]);
      }
      drawnCount++;
    }
    updateCounter(s.counterBase + drawnCount);
    script = null;
    syncChips();
  }

  function markContracted(v: number): void {
    const btn = root.querySelector<HTMLButtonElement>(`.node-btn[data-node="${v}"]`);
    if (!btn) return;
    btn.disabled = true;
    btn.setAttribute("aria-label", `Intersection ${v + 1} of ${t.graph.n}, contracted`);
  }

  function onNodeClick(v: number): void {
    if (contractor.contracted(v)) return;
    finishScriptInstantly();

    // Snapshot "the graph without v" BEFORE contracting, so the detour we
    // show per pair is the same kind of bypass the algorithm just checked
    // for — reusing dijkstra() rather than re-deriving our own notion of
    // shortest path. Built from REAL directed edges (never symmetrized),
    // so it can only ever find routes the actual one-way streets allow.
    const before = graphExcluding(v);
    const outcome = contractor.contract(v);

    // Reconstruct simulateContract's own visit order (in-neighbours outer,
    // out-neighbours inner) from the SAME live-edge mirror its adjacency
    // was built from: first-occurrence order in liveEdges matches the adj
    // maps' insertion order, so the narrated sequence is the algorithm's
    // real one, not an invented display order.
    const inOrder: number[] = [];
    const outOrder: number[] = [];
    {
      const seenIn = new Set<number>();
      const seenOut = new Set<number>();
      for (const e of liveEdges) {
        if (e.to === v && e.from !== v && !seenIn.has(e.from)) {
          seenIn.add(e.from);
          inOrder.push(e.from);
        }
        if (e.from === v && e.to !== v && !seenOut.has(e.to)) {
          seenOut.add(e.to);
          outOrder.push(e.to);
        }
      }
    }
    // For shortcut pairs the through cost is the contractor's OWN inserted
    // weight (the honest number the curve's label must carry); for
    // witnessed pairs it's recomputed from the same live edges the
    // contractor's adjacency held.
    const shortcutW = new Map(outcome.shortcuts.map((s) => [orderedKey(s.from, s.to), s.w]));
    const pairs: PairVerdict[] = [];
    for (const u of inOrder) {
      for (const w of outOrder) {
        if (w === u) continue;
        const through = shortcutW.get(orderedKey(u, w)) ?? minEdgeW(u, v) + minEdgeW(v, w);
        const d = dijkstra(before, u, w);
        const detour = d.path.length > 1 ? { dist: d.dist, path: d.path } : null;
        pairs.push(pairVerdict(u, w, v, through, detour));
      }
    }

    // The algorithm's graph changed the moment contract() returned —
    // update the live mirror NOW. Drawing lags behind on purpose (that's
    // the script), but any LATER click's witness search must see this
    // click's shortcuts.
    liveEdges = liveEdges.filter((e) => e.from !== v && e.to !== v);
    for (const s of outcome.shortcuts) liveEdges.push({ from: s.from, to: s.to, w: s.w });

    markContracted(v);

    if (pairs.length === 0) {
      // Dead end (spec §21.1): nothing meets through — one line, no phases.
      setNarration(DEAD_END_NARRATION);
      updateCounter(contractor.totalShortcuts());
      syncChips();
      return;
    }

    const ranks: number[] = [];
    let nextRank = 0;
    for (const p of pairs) ranks.push(p.witness ? -1 : nextRank++);
    const counterBase = contractor.totalShortcuts() - outcome.shortcuts.length;

    if (reducedMotion()) {
      // No phases: full end state instantly — every curve, the final
      // count, and the LAST pair's verdict as the narration (state, not
      // animation).
      for (let i = 0; i < pairs.length; i++) {
        if (!pairs[i].witness) drawCurve(pairs[i], ranks[i]);
      }
      setNarration(pairs[pairs.length - 1].narration);
      updateCounter(contractor.totalShortcuts());
      syncChips();
      return;
    }

    script = {
      pairs,
      ranks,
      drawn: pairs.map(() => false),
      idx: 0,
      phase: -1,
      counterBase,
    };
    updateCounter(counterBase);
    advanceOnce(); // pair 0's legs light immediately; the timer takes it from here
    startTimer();
    syncChips();
  }

  for (const btn of root.querySelectorAll<HTMLButtonElement>(".node-btn")) {
    const v = Number(btn.dataset.node);
    btn.addEventListener("click", () => onNodeClick(v));
  }

  // climbLinked's chip convention, adapted to a one-way script: play
  // RESUMES auto-advance (a contraction's effects are cumulative — there
  // is no replay-from-zero without undoing real graph state), step pauses
  // auto-play and advances one phase.
  playBtn?.addEventListener("click", () => {
    if (script) startTimer();
  });
  stepBtn?.addEventListener("click", () => {
    stopTimer();
    advanceOnce();
  });

  resetBtn?.addEventListener("click", () => {
    stopTimer();
    script = null;
    contractor.reset();
    liveEdges = baseLiveEdges.slice();
    shortcutEls.clear();
    if (shortcutsGroup) shortcutsGroup.innerHTML = "";
    for (const el of roadEls.values()) el.classList.remove("flash", "through-leg");
    for (const btn of root.querySelectorAll<HTMLButtonElement>(".node-btn")) {
      const v = Number(btn.dataset.node);
      btn.disabled = false;
      btn.setAttribute("aria-label", `Contract intersection ${v + 1} of ${t.graph.n}`);
    }
    setNarration("");
    updateCounter(0);
    syncChips();
  });

  updateCounter(0);
  syncChips();
}
