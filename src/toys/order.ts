// Chapter 5 toy: the same orderedShortcutCount/buildCh/createContractor code
// that runs the real Canberra preprocessing, run three ways on the real
// toytown street network so contraction ORDER — not the algorithm — visibly
// decides how many shortcuts get added. Every tile number is a live run,
// never a scripted figure (order.test.ts pins the inequalities this
// chapter's copy claims actually hold). "Your turn" below reuses chapter
// 4's tap-to-contract pattern, but compares your RUNNING total against
// what the heuristic's own first k contractions would have cost — live,
// after every tap, no need to contract all 55 nodes to see how you're
// doing.

import { buildCh, createContractor, orderedShortcutCount } from "../algos/chBuild";
import { transpose, type Graph } from "../algos/graph";
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
} from "./toytownView";

const RANDOM_SEED = 7;

/** ~80ms per contraction: a full 62-node replay lands in ≈5s — long
 * enough to SEE the worst order bury the map early, short enough to invite
 * pressing all three buttons (spec §21.2's ~80ms cadence). */
const REPLAY_STEP_MS = 80;

// Same convention as climbLinked/flood/hierarchy: reduced-motion visitors
// get final states, never intervals.
function prefersReducedMotion(): boolean {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// mulberry32 — the same small seeded PRNG used in src/algos/dijkstra.test.ts
// and src/algos/ch.test.ts: deterministic so the "random order" tile
// reproduces the exact same shuffle on every click and every reload,
// instead of quietly reshuffling and undermining "counts are deterministic".
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A Fisher-Yates shuffle of 0..n-1 driven by mulberry32(seed) — same seed,
 * same permutation, forever (order.test.ts's determinism check). */
export function seededShuffleOrder(seed: number, n: number): number[] {
  const rand = mulberry32(seed);
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/** The "worst order" tile's contraction order: every node sorted by TOTAL
 * degree (in-degree + out-degree) in the ORIGINAL graph, highest first —
 * contract the busiest hubs before anything has thinned out around them,
 * the textbook way to make CH preprocessing expensive. Toytown is a real
 * DIRECTED graph (36% one-way streets), so out-degree alone would
 * mislabel a node with many INCOMING one-ways but few outgoing ones as
 * "low degree" — total degree (via the transposed graph for in-degree) is
 * what "busiest hub" honestly means once direction is real, not a
 * simplification that only happened to be free on the always-undirected
 * mini-town this replaced. This is the STATIC variant: degree is measured
 * once, up front, not recomputed as the graph shrinks (a live
 * recompute-at-each-step version is the other legitimate option the brief
 * allows; this one is simpler and already reliably worse than the
 * heuristic — see order.test.ts). Labelled "high-degree-first" in the UI
 * rather than "worst possible", because a static degree order isn't
 * provably the worst one, just a bad one. */
export function degreeDescendingOrder(g: Graph): number[] {
  const outDeg = Array.from(
    { length: g.n },
    (_, v) => g.fwd.firstOut[v + 1] - g.fwd.firstOut[v],
  );
  const rev = transpose(g.n, g.fwd);
  const degree = Array.from(
    { length: g.n },
    (_, v) => outDeg[v] + (rev.firstOut[v + 1] - rev.firstOut[v]),
  );
  return Array.from({ length: g.n }, (_, i) => i).sort(
    (a, b) => degree[b] - degree[a] || a - b,
  );
}

/** The "smart order" tile's contraction order: every node sorted by its own
 * CH rank, ascending (rank ascending = contracted earlier — see chBuild's
 * `Ch.rank` doc comment) — exactly the order buildCh's edge-difference
 * heuristic already chose. Re-running orderedShortcutCount over this order
 * reproduces buildCh's own shortcut count (order.test.ts pins the
 * equivalence): the tile's number isn't a cached figure, it's the
 * heuristic's actual order replayed live. */
export function heuristicOrder(g: Graph): number[] {
  const { rank } = buildCh(g);
  return Array.from({ length: g.n }, (_, i) => i).sort((a, b) => rank[a] - rank[b]);
}

type Kind = "random" | "worst" | "smart";
const KINDS: Kind[] = ["random", "worst", "smart"];
const KIND_LABEL: Record<Kind, string> = {
  random: "random order",
  worst: "worst order",
  smart: "smart order",
};
const KIND_NOTE: Record<Kind, string> = {
  random: "seeded shuffle",
  worst: "high-degree-first",
  smart: "edge-difference heuristic",
};

export interface ReplayStep {
  node: number;
  shortcuts: { a: number; b: number; via: number; w: number }[];
}

/** The per-contraction record the ch5 replay animates: one entry per node
 * of `order`, in order, each carrying the shortcuts THAT contraction added
 * (endpoints a→b, the contracted node as `via`, real measured weight).
 * Pure — a fresh contractor per call, so the same order always yields the
 * same script, and the concatenated shortcut counts equal
 * orderedShortcutCount(g, order) (order.test.ts pins both): the animated
 * run IS the tile's number, not a parallel story. */
export function replayScript(g: Graph, order: number[]): ReplayStep[] {
  const contractor = createContractor(g);
  return order.map((node) => ({
    node,
    shortcuts: contractor
      .contract(node)
      .shortcuts.map(({ from, to, w }) => ({ a: from, b: to, via: node, w })),
  }));
}

function orderFor(g: Graph, kind: Kind): number[] {
  switch (kind) {
    case "random":
      return seededShuffleOrder(RANDOM_SEED, g.n);
    case "worst":
      return degreeDescendingOrder(g);
    case "smart":
      return heuristicOrder(g);
  }
}

function tilesMarkup(): string {
  return KINDS.map(
    (kind) =>
      `<div class="tile" data-tile="${kind}">` +
      `<span class="k">${KIND_LABEL[kind]} (${KIND_NOTE[kind]})</span>` +
      `<div class="n" data-role="count">–</div>` +
      `<div class="bar" data-role="bar"></div>` +
      `<span class="k">shortcuts</span>` +
      `</div>`,
  ).join("");
}

function runButtonsMarkup(): string {
  return KINDS.map(
    (kind) =>
      `<button class="chip" type="button" data-run="${kind}">${KIND_LABEL[kind]}</button>`,
  ).join("");
}

// Button centers, decluttered apart (see toytownView's declutterXY): the
// real toytown layout has intersections as little as ~2px apart on screen,
// which no hit-circle padding alone can make individually clickable.
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

// The replay stage's nodes: .node-btn's display-only twin (.node-mark, a
// div — no role, no focus, no pointer events) at the SAME decluttered
// positions as the your-turn buttons below, so the two maps read as the
// same town.
function nodeMarksMarkup(buttonXY: [number, number][]): string {
  return buttonXY
    .map(([x, y], i) => {
      const left = ((x / VIEWBOX_W) * 100).toFixed(3);
      const top = ((y / VIEWBOX_H) * 100).toFixed(3);
      return `<div class="node-mark" data-node="${i}" style="left:${left}%;top:${top}%"></div>`;
    })
    .join("");
}

export function mountOrder(root: HTMLElement, t: Toytown): void {
  const roads = physicalEdges(t);
  // Same declutter run nodeButtonsMarkup does internally — see flood.ts's
  // matching comment (design spec §17.5 delta 3).
  const buttonXY = declutterXY(t.xy, MIN_NODE_DIST, undefined, NODE_CLAMP_BOUNDS);

  root.innerHTML =
    `<div class="order-tiles" data-role="tiles">${tilesMarkup()}</div>` +
    `<div class="toy-controls">${runButtonsMarkup()}</div>` +
    // ONE shared replay stage all three order buttons play onto (spec
    // §21.2) — display only (aria-hidden, .node-mark divs, no buttons):
    // the same town as "your turn" below, but it exists to be WATCHED,
    // not tapped, so the clutter each order causes is seen, not read.
    `<div class="toy-stage order-replay-stage" aria-hidden="true">` +
    `<svg class="toy-svg" viewBox="${VIEWBOX}">` +
    `<g class="context-layer">${contextPolylineMarkup(t)}</g>` +
    `<g class="edges">${roadPolylineMarkup(roads)}</g>` +
    `<g class="drift-layer">${driftConnectorMarkup(driftConnectors(t.xy, buttonXY))}</g>` +
    `<g class="shortcuts"></g>` +
    `</svg>` +
    nodeMarksMarkup(buttonXY) +
    `</div>` +
    `<div class="order-yourturn">` +
    `<p class="toy-subhead">Your turn: tap intersections below in the order you'd
      contract them — watch how you're doing against the heuristic as you go.</p>` +
    `<div class="toy-stage">` +
    `<svg class="toy-svg" viewBox="${VIEWBOX}" aria-hidden="true">` +
    `<g class="context-layer">${contextPolylineMarkup(t)}</g>` +
    `<g class="edges">${roadPolylineMarkup(roads)}</g>` +
    `<g class="drift-layer">${driftConnectorMarkup(driftConnectors(t.xy, buttonXY))}</g>` +
    `<g class="shortcuts"></g>` +
    `</svg>` +
    nodeButtonsMarkup(t) +
    `</div>` +
    `<div class="toy-controls">` +
    `<button class="chip" type="button" data-action="reset">&#8635; reset</button>` +
    `<span class="toy-counter" data-role="yourturn-counter"></span>` +
    `</div>` +
    `<p class="toy-result" data-role="yourturn-result" hidden></p>` +
    `</div>`;

  // ---- three-tile comparison: each button click replays a fresh, PURE
  // replayScript() run (whose totals order.test.ts pins equal to
  // orderedShortcutCount) — no shared/mutable state across runs, so
  // clicking in any combination or order (or twice) always recomputes
  // honestly. `counts` holds what each tile currently DISPLAYS (a live
  // running count mid-replay, the full total after); `completed` holds
  // only FINISHED runs' totals — the .win badge derives from `completed`
  // alone, so it never flickers off mid-replay while a rival's live count
  // is briefly below smart's total (L2 review m3).
  const counts: Partial<Record<Kind, number>> = {};
  const completed: Partial<Record<Kind, number>> = {};

  function renderTiles(): void {
    const known = KINDS.map((k) => counts[k]).filter((v): v is number => v !== undefined);
    if (known.length === 0) return;
    // The floor of 1 only matters in the first replay frames, when the sole
    // known count can still be 0 — without it 0/0 makes the bar width NaN.
    const max = Math.max(...known, 1);
    for (const kind of KINDS) {
      const count = counts[kind];
      if (count === undefined) continue;
      const tile = root.querySelector<HTMLElement>(`.tile[data-tile="${kind}"]`);
      const n = tile?.querySelector<HTMLElement>('[data-role="count"]');
      const bar = tile?.querySelector<HTMLElement>('[data-role="bar"]');
      if (n) n.textContent = String(count);
      if (bar) {
        bar.style.width = `${(count / max) * 100}%`;
        bar.style.minWidth = "2px";
      }
    }
    const smartTile = root.querySelector<HTMLElement>('.tile[data-tile="smart"]');
    const rivals = (["random", "worst"] as const)
      .map((k) => completed[k])
      .filter((v): v is number => v !== undefined);
    const smartCount = completed.smart;
    const wins =
      smartCount !== undefined && rivals.length > 0 && rivals.every((c) => smartCount <= c);
    smartTile?.classList.toggle("win", wins);
  }

  // ---- the replay engine: pressing an order button plays that order's
  // replayScript on the shared stage at REPLAY_STEP_MS per contraction —
  // node grays out, its shortcuts curve in (unlabelled — volume is the
  // point, spec §21.4), the tile's count climbs. The script is a fresh,
  // pure run per press (no shared state), and its total IS
  // orderedShortcutCount's number for that order (order.test.ts pins it),
  // so the final tile figures are exactly what the instant version showed.
  const replayStage = root.querySelector<HTMLElement>(".order-replay-stage");
  const replayShortcuts = replayStage?.querySelector<SVGGElement>(".shortcuts");
  let replayTimer: number | null = null;
  // The running replay's (kind, final total): when another press interrupts
  // it, its tile completes to the full run's REAL total instantly — the
  // scoreboard never keeps a half-run figure (same convention as ch4's
  // mid-script node switch, spec §21.1).
  let running: { kind: Kind; total: number } | null = null;

  function clearReplayStage(): void {
    if (replayShortcuts) replayShortcuts.innerHTML = "";
    for (const mark of replayStage?.querySelectorAll(".node-mark.contracted") ?? []) {
      mark.classList.remove("contracted");
    }
  }

  function cancelReplay(): void {
    if (replayTimer !== null) {
      clearInterval(replayTimer);
      replayTimer = null;
    }
    if (running) {
      // The interrupted run completes to its full honest total (the run's
      // own pinned sum, §21.1's convention) — which also makes it a
      // FINISHED run for the .win badge.
      counts[running.kind] = running.total;
      completed[running.kind] = running.total;
      running = null;
    }
  }

  function drawStepCurves(step: ReplayStep, group: SVGGElement | null | undefined): void {
    if (!group) return;
    for (const s of step.shortcuts) {
      drawShortcutCurve(group, t.xy, s.a, s.b, s.via, { flip: s.a > s.b });
    }
  }

  function runReplay(kind: Kind): void {
    cancelReplay();
    clearReplayStage();
    const script = replayScript(t.graph, orderFor(t.graph, kind));
    const total = script.reduce((acc, step) => acc + step.shortcuts.length, 0);

    const applyStep = (step: ReplayStep): void => {
      replayStage
        ?.querySelector(`.node-mark[data-node="${step.node}"]`)
        ?.classList.add("contracted");
      drawStepCurves(step, replayShortcuts);
    };

    if (prefersReducedMotion()) {
      // No interval: the full end state — every mark contracted, every
      // curve drawn, the final count — lands instantly.
      for (const step of script) applyStep(step);
      counts[kind] = total;
      completed[kind] = total;
      renderTiles();
      return;
    }

    running = { kind, total };
    let k = 0;
    let runningTotal = 0;
    counts[kind] = 0;
    // Re-running a kind: its old total no longer stands while the replay
    // is in flight, so it leaves the .win comparison until it finishes.
    delete completed[kind];
    renderTiles();
    // Unreachable via the three production orders (always full n=62
    // permutations), but an empty order must complete immediately rather
    // than leave a timer calling script[0] forever (L2 review m1).
    if (script.length === 0) {
      completed[kind] = total;
      running = null;
      renderTiles();
      return;
    }
    replayTimer = window.setInterval(() => {
      const step = script[k];
      applyStep(step);
      runningTotal += step.shortcuts.length;
      counts[kind] = runningTotal;
      k++;
      if (k === script.length) {
        clearInterval(replayTimer as number);
        replayTimer = null;
        running = null;
        completed[kind] = runningTotal;
      }
      renderTiles();
    }, REPLAY_STEP_MS);
  }

  for (const btn of root.querySelectorAll<HTMLButtonElement>("[data-run]")) {
    const kind = btn.dataset.run as Kind;
    btn.addEventListener("click", () => runReplay(kind));
  }

  // ---- "your turn": one persistent contractor for this mount's whole
  // lifetime — later taps must see shortcuts earlier taps already added, or
  // the running count would lie. The heuristic's FULL order is computed
  // once (pure function of the graph alone, independent of the visitor's
  // choices) and re-sliced to the current k on every tap — measured at
  // <0.4ms per call on the real 55-node toytown graph (see the F5 report),
  // comfortably under the 50ms-per-tap budget, so no memoization is needed
  // beyond this one-time heuristicOrder() call.
  const contractor = createContractor(t.graph);
  const heuristic = heuristicOrder(t.graph);
  const total = t.graph.n;
  let contractedCount = 0;

  const counter = root.querySelector<HTMLElement>('[data-role="yourturn-counter"]');
  const result = root.querySelector<HTMLElement>('[data-role="yourturn-result"]');
  const resetBtn = root.querySelector<HTMLButtonElement>('[data-action="reset"]');
  // The your-turn stage's own curve layer: every tap draws the shortcuts
  // THAT contraction just added (unlabelled, same drawing as the replay
  // above), so the visitor's clutter accumulates on their own map exactly
  // as the replayed orders' clutter does on the shared one (spec §21.2).
  const yourturnShortcuts = root.querySelector<SVGGElement>(".order-yourturn .shortcuts");

  function updateCounter(): void {
    if (!counter) return;
    const you = contractor.totalShortcuts();
    if (contractedCount === 0) {
      counter.textContent = `you: 0 shortcuts · ${total} intersections left`;
      return;
    }
    const heuristicAtK = orderedShortcutCount(t.graph, heuristic.slice(0, contractedCount));
    const verdict =
      you < heuristicAtK ? "ahead" : you > heuristicAtK ? "behind" : "tied";
    const left = total - contractedCount;
    counter.textContent =
      `you: ${you} vs heuristic's first ${contractedCount}: ${heuristicAtK} (${verdict}) · ` +
      `${left} intersection${left === 1 ? "" : "s"} left`;
  }

  function markContracted(v: number): void {
    const btn = root.querySelector<HTMLButtonElement>(`.node-btn[data-node="${v}"]`);
    if (!btn) return;
    btn.disabled = true;
    btn.setAttribute("aria-label", `Intersection ${v + 1} of ${total}, contracted`);
  }

  function finish(): void {
    if (!result) return;
    const you = contractor.totalShortcuts();
    const k = orderedShortcutCount(t.graph, heuristic);
    const verdict =
      you < k ? "you beat the heuristic" : you > k ? "the heuristic wins this round" : "dead heat";
    result.hidden = false;
    result.textContent = `all ${total} contracted — you: ${you} vs heuristic: ${k} — ${verdict}`;
  }

  function onNodeClick(v: number): void {
    if (contractor.contracted(v)) return;
    const outcome = contractor.contract(v);
    if (yourturnShortcuts) {
      for (const s of outcome.shortcuts) {
        drawShortcutCurve(yourturnShortcuts, t.xy, s.from, s.to, v, {
          flip: s.from > s.to,
        });
      }
    }
    contractedCount++;
    markContracted(v);
    updateCounter();
    if (contractedCount === total) finish();
  }

  for (const btn of root.querySelectorAll<HTMLButtonElement>(".node-btn")) {
    const v = Number(btn.dataset.node);
    btn.addEventListener("click", () => onNodeClick(v));
  }

  resetBtn?.addEventListener("click", () => {
    contractor.reset();
    contractedCount = 0;
    if (yourturnShortcuts) yourturnShortcuts.innerHTML = "";
    if (result) {
      result.hidden = true;
      result.textContent = "";
    }
    for (const btn of root.querySelectorAll<HTMLButtonElement>(".node-btn")) {
      const v = Number(btn.dataset.node);
      btn.disabled = false;
      btn.setAttribute("aria-label", `Contract intersection ${v + 1} of ${total}`);
    }
    updateCounter();
  });

  updateCounter();
}
