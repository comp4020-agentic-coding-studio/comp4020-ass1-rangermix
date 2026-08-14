// Chapter 3 toy: the same orderedShortcutCount/buildCh/createContractor code
// that runs the real Canberra preprocessing, run three ways on the 12-node
// mini-town so contraction ORDER — not the algorithm — visibly decides how
// many shortcuts get added. Every tile number is a live run, never a
// scripted figure (order.test.ts pins the inequalities this chapter's copy
// claims actually hold on MINITOWN). "Your turn" below reuses chapter 2's
// tap-to-contract pattern, but keeps a running total instead of drawing
// witnesses/shortcuts — this chapter's lesson is ORDER, not the contraction
// mechanic itself (already taught in chapter 2).

import { buildCh, createContractor, orderedShortcutCount } from "../algos/chBuild";
import type { Graph } from "../algos/graph";
import { MINITOWN, VIEWBOX, VIEWBOX_H, VIEWBOX_W, minitownEdges } from "./minitown";

const RANDOM_SEED = 7;

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

/** The "worst order" tile's contraction order: every node sorted by degree
 * in the ORIGINAL graph, highest first — contract the busiest hubs before
 * anything has thinned out around them, the textbook way to make CH
 * preprocessing expensive. This is the STATIC variant: degree is measured
 * once, up front, not recomputed as the graph shrinks (a live
 * recompute-at-each-step version — highest CURRENT degree — is the other
 * legitimate option the brief allows; this one is simpler and already
 * reliably worse than the heuristic on MINITOWN, which is the only claim
 * the tile makes — see order.test.ts). Labelled "high-degree-first" in the
 * UI rather than "worst possible", because a static degree order isn't
 * provably the worst one, just a bad one. */
export function degreeDescendingOrder(g: Graph): number[] {
  const degree = Array.from(
    { length: g.n },
    (_, v) => g.fwd.firstOut[v + 1] - g.fwd.firstOut[v],
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

function orderFor(kind: Kind): number[] {
  switch (kind) {
    case "random":
      return seededShuffleOrder(RANDOM_SEED, MINITOWN.graph.n);
    case "worst":
      return degreeDescendingOrder(MINITOWN.graph);
    case "smart":
      return heuristicOrder(MINITOWN.graph);
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

// The "your turn" stage's SVG: edges + weight labels only (same geometry as
// chapter 2's toy) — no shortcuts group, since this chapter never draws
// shortcut arcs (see file banner comment).
function stageSvgMarkup(): string {
  let lines = "";
  let labels = "";
  for (const e of minitownEdges()) {
    const [x1, y1] = MINITOWN.xy[e.a];
    const [x2, y2] = MINITOWN.xy[e.b];
    const cls = e.highway ? "edge-line edge-highway" : "edge-line";
    lines += `<line class="${cls}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />`;
    labels += `<text class="edge-weight" x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2}">${e.w}</text>`;
  }
  return (
    `<svg class="minitown-svg" viewBox="${VIEWBOX}" aria-hidden="true">` +
    `<g class="edges">${lines}</g>` +
    `<g class="edge-weights">${labels}</g>` +
    `</svg>`
  );
}

function nodeButtonsMarkup(): string {
  return MINITOWN.names
    .map((name, i) => {
      const [x, y] = MINITOWN.xy[i];
      const left = ((x / VIEWBOX_W) * 100).toFixed(3);
      const top = ((y / VIEWBOX_H) * 100).toFixed(3);
      return (
        `<button class="node-btn" type="button" data-node="${i}" ` +
        `style="left:${left}%;top:${top}%" aria-label="Contract node ${name}">${name}</button>`
      );
    })
    .join("");
}

export function mountOrder(root: HTMLElement): void {
  root.innerHTML =
    `<div class="order-tiles" data-role="tiles">${tilesMarkup()}</div>` +
    `<div class="toy-controls">${runButtonsMarkup()}</div>` +
    `<div class="order-yourturn">` +
    `<p class="toy-subhead">Your turn: tap nodes below in the order you'd contract them.</p>` +
    `<div class="minitown-stage">${stageSvgMarkup()}${nodeButtonsMarkup()}</div>` +
    `<div class="toy-controls">` +
    `<button class="chip" type="button" data-action="reset">&#8635; reset</button>` +
    `<span class="toy-counter" data-role="yourturn-counter"></span>` +
    `</div>` +
    `<p class="toy-result" data-role="yourturn-result" hidden></p>` +
    `</div>`;

  // ---- three-tile comparison: each button click is a fresh, independent,
  // PURE orderedShortcutCount() run — no shared/mutable state, so clicking
  // in any combination or order (or twice) always recomputes honestly.
  const counts: Partial<Record<Kind, number>> = {};

  function renderTiles(): void {
    const known = KINDS.map((k) => counts[k]).filter((v): v is number => v !== undefined);
    if (known.length === 0) return;
    const max = Math.max(...known);
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
      .map((k) => counts[k])
      .filter((v): v is number => v !== undefined);
    const smartCount = counts.smart;
    const wins =
      smartCount !== undefined && rivals.length > 0 && rivals.every((c) => smartCount <= c);
    smartTile?.classList.toggle("win", wins);
  }

  for (const btn of root.querySelectorAll<HTMLButtonElement>("[data-run]")) {
    const kind = btn.dataset.run as Kind;
    btn.addEventListener("click", () => {
      counts[kind] = orderedShortcutCount(MINITOWN.graph, orderFor(kind));
      renderTiles();
    });
  }

  // ---- "your turn": one persistent contractor for this mount's whole
  // lifetime, exactly like chapter 2's toy — later taps must see shortcuts
  // earlier taps already added, or the running count would lie.
  const contractor = createContractor(MINITOWN.graph);
  const total = MINITOWN.graph.n;
  let contractedCount = 0;

  const counter = root.querySelector<HTMLElement>('[data-role="yourturn-counter"]');
  const result = root.querySelector<HTMLElement>('[data-role="yourturn-result"]');
  const resetBtn = root.querySelector<HTMLButtonElement>('[data-action="reset"]');

  function updateCounter(): void {
    if (!counter) return;
    const n = contractor.totalShortcuts();
    const left = total - contractedCount;
    counter.textContent =
      `you: ${n} shortcut${n === 1 ? "" : "s"} so far · ${left} node${left === 1 ? "" : "s"} left`;
  }

  function markContracted(v: number): void {
    const btn = root.querySelector<HTMLButtonElement>(`.node-btn[data-node="${v}"]`);
    if (!btn) return;
    btn.disabled = true;
    btn.setAttribute("aria-label", `Node ${MINITOWN.names[v]}, contracted`);
  }

  function finish(): void {
    if (!result) return;
    const you = contractor.totalShortcuts();
    const k = orderedShortcutCount(MINITOWN.graph, heuristicOrder(MINITOWN.graph));
    const verdict =
      you < k ? "you beat the heuristic" : you > k ? "the heuristic wins this round" : "dead heat";
    result.hidden = false;
    result.textContent = `you: ${you} vs edge-difference: ${k} — ${verdict}`;
  }

  function onNodeClick(v: number): void {
    if (contractor.contracted(v)) return;
    contractor.contract(v);
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
    if (result) {
      result.hidden = true;
      result.textContent = "";
    }
    for (const btn of root.querySelectorAll<HTMLButtonElement>(".node-btn")) {
      const name = MINITOWN.names[Number(btn.dataset.node)];
      btn.disabled = false;
      btn.setAttribute("aria-label", `Contract node ${name}`);
    }
    updateCounter();
  });

  updateCounter();
}
