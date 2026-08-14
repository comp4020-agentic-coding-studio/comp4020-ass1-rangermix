// Chapter 5 toy: the same mini-town, redrawn in 2.5-D — x stays the
// original layout x, y lifts by contraction rank (higher rank = higher up)
// — plus the closing echo below it. Everything the animation plays is
// scripted from ONE real chQuery(ch, A, B) run made at mount time: its
// settled/settledB (forward/backward settle order), meet, and path
// (already unpacked into original nodes) are recorded once, and the whole
// step sequence below is DERIVED from that recording plus the real
// ch.up/ch.downRev structure buildCh produced alongside it — nothing here
// is a hand-authored sequence. A and B are the flood toy's own far pair
// (src/toys/flood.ts: A -> L), so chapter 1 and chapter 5 rhyme.

import { buildCh, type Ch } from "../algos/chBuild";
import { chQuery, type ChResult } from "../algos/chQuery";
import type { Csr } from "../algos/graph";
import type { Meta } from "../data";
import { MINITOWN, VIEWBOX, minitownEdges } from "./minitown";

const FROM_NAME = "A";
const TO_NAME = "L";
const STEP_MS = 500;
const BASE_Y = 250;
const STEP_Y = 18;
const NODE_R = 11;
const LAST_RACE_KEY = "hth-last-race";

function reducedMotion(): boolean {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Contraction rank -> vertical position: rank 0 sits on the floor at
 * BASE_Y, every rank above it lifts STEP_Y px higher (smaller y). Exported
 * as the toy's one piece of pure layout math. */
export function rankY(rank: number): number {
  return BASE_Y - rank * STEP_Y;
}

function nodeXY(rank: Int32Array, i: number): [number, number] {
  return [MINITOWN.xy[i][0], rankY(rank[i])];
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

function svgMarkup(rank: Int32Array, steps: ClimbStep[], meetNode: number): string {
  const baseEdges = minitownEdges()
    .map((e) => {
      const [x1, y1] = nodeXY(rank, e.a);
      const [x2, y2] = nodeXY(rank, e.b);
      const cls = e.highway ? "edge-line edge-highway climb-base-edge" : "edge-line climb-base-edge";
      return `<line class="${cls}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />`;
    })
    .join("");

  const searchEdges = steps
    .flatMap((s) => {
      if (s.kind !== "fwd" && s.kind !== "bwd") return [];
      return s.edges.map((e) => {
        const [x1, y1] = nodeXY(rank, e.from);
        const [x2, y2] = nodeXY(rank, e.to);
        return (
          `<line class="climb-edge climb-edge-${s.kind}" data-from="${e.from}" data-to="${e.to}" ` +
          `data-dir="${s.kind}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />`
        );
      });
    })
    .join("");

  const nodes = MINITOWN.names
    .map((name, i) => {
      const [x, y] = nodeXY(rank, i);
      const endpoint = name === FROM_NAME || name === TO_NAME ? " node-endpoint" : "";
      return (
        `<g class="climb-node${endpoint}" data-node="${i}">` +
        `<circle class="climb-ring" cx="${x}" cy="${y}" r="${NODE_R + 4}" />` +
        `<circle class="climb-fill" cx="${x}" cy="${y}" r="${NODE_R}" />` +
        `<text x="${x}" y="${y}" dy="0.32em">${name}</text>` +
        `</g>`
      );
    })
    .join("");

  const [mx, my] = nodeXY(rank, meetNode);
  const meetMarker =
    `<g class="climb-meet" data-role="meet">` +
    `<text class="meet-star" x="${mx}" y="${my - NODE_R - 8}">&#9733;</text>` +
    `<text class="meet-label" x="${mx}" y="${my - NODE_R - 8}" dy="1.1em">meet</text>` +
    `</g>`;

  return (
    `<svg class="minitown-svg" viewBox="${VIEWBOX}" role="img" ` +
    `aria-label="Mini-town redrawn by contraction rank — height stands in for rank — ` +
    `showing Contraction Hierarchies' upward query from ${FROM_NAME} to ${TO_NAME}.">` +
    `<g class="edges">${baseEdges}</g>` +
    `<g class="climb-edges">${searchEdges}</g>` +
    `<path class="route-path" d="" />` +
    `<g class="nodes">${nodes}</g>` +
    meetMarker +
    `</svg>`
  );
}

export function mountClimb(root: HTMLElement): void {
  const ch = buildCh(MINITOWN.graph);
  const from = MINITOWN.names.indexOf(FROM_NAME);
  const to = MINITOWN.names.indexOf(TO_NAME);
  const result = chQuery(ch, from, to);

  // Dev-time invariant: the toy has nothing to animate if the pair it was
  // told to use isn't connected. MINITOWN is a fixed, always-connected
  // fixture (minitown.test.ts guards that), so this should never fire —
  // if it does, that's a real bug worth a loud failure, not a silently
  // broken toy.
  if (!Number.isFinite(result.dist)) {
    throw new Error(
      `climb toy: chQuery(${FROM_NAME} -> ${TO_NAME}) on MINITOWN returned an unreachable pair (dist=${result.dist})`,
    );
  }

  const steps = buildSteps(ch, result);
  const rank = ch.rank;

  root.innerHTML =
    `<div class="minitown-stage">${svgMarkup(rank, steps, result.meet)}</div>` +
    `<div class="toy-controls">` +
    `<button class="chip" type="button" data-action="play">&#9658; play</button>` +
    `<button class="chip" type="button" data-action="step">step</button>` +
    `<button class="chip" type="button" data-action="reset">&#8635; reset</button>` +
    `<span class="toy-counter" data-role="counter"></span>` +
    `</div>`;

  const svg = root.querySelector("svg");
  const routePath = root.querySelector<SVGPathElement>(".route-path");
  const meetGroup = root.querySelector<SVGGElement>('[data-role="meet"]');
  const counter = root.querySelector<HTMLElement>('[data-role="counter"]');
  const playBtn = root.querySelector<HTMLButtonElement>('[data-action="play"]');
  const stepBtn = root.querySelector<HTMLButtonElement>('[data-action="step"]');
  const resetBtn = root.querySelector<HTMLButtonElement>('[data-action="reset"]');

  const fwdTotal = result.settled.length;
  const bwdTotal = result.settledB.length;
  const meetIndex = fwdTotal + bwdTotal;
  const unpackTotal = steps.length - meetIndex - 1;

  let shown = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  function nodeEl(i: number): SVGGElement | null {
    return svg?.querySelector<SVGGElement>(`.climb-node[data-node="${i}"]`) ?? null;
  }

  function edgeEl(a: number, b: number, dir: "fwd" | "bwd"): SVGLineElement | null {
    return (
      svg?.querySelector<SVGLineElement>(
        `.climb-edge[data-from="${a}"][data-to="${b}"][data-dir="${dir}"]`,
      ) ?? null
    );
  }

  function paintRoute(edgeCount: number): void {
    if (!routePath) return;
    if (edgeCount <= 0) {
      routePath.setAttribute("d", "");
      return;
    }
    const pts = result.path
      .slice(0, edgeCount + 1)
      .map((i) => nodeXY(rank, i).join(","))
      .join(" L ");
    routePath.setAttribute("d", `M ${pts}`);
  }

  function counterText(): string {
    if (shown === 0) return `press play to watch ${FROM_NAME} and ${TO_NAME} climb toward each other`;
    if (shown <= fwdTotal) return `forward climb from ${FROM_NAME}: ${shown} of ${fwdTotal} settled`;
    if (shown <= meetIndex)
      return `backward climb from ${TO_NAME}: ${shown - fwdTotal} of ${bwdTotal} settled`;
    if (shown === meetIndex + 1)
      return `met at ${MINITOWN.names[result.meet]} — unpacking the route next`;
    const unpacked = shown - meetIndex - 1;
    if (unpacked < unpackTotal) return `unpacking the route: ${unpacked} of ${unpackTotal} streets`;
    return `done — ${result.dist} total, ${unpackTotal} streets, met at ${MINITOWN.names[result.meet]}`;
  }

  function render(): void {
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i];
      const active = i < shown;
      if (st.kind === "fwd") {
        nodeEl(st.node)?.classList.toggle("settled-fwd", active);
        for (const e of st.edges) edgeEl(e.from, e.to, "fwd")?.classList.toggle("revealed", active);
      } else if (st.kind === "bwd") {
        nodeEl(st.node)?.classList.toggle("settled-bwd", active);
        for (const e of st.edges) edgeEl(e.from, e.to, "bwd")?.classList.toggle("revealed", active);
      } else if (st.kind === "meet") {
        meetGroup?.classList.toggle("shown", active);
      }
    }
    paintRoute(Math.max(0, Math.min(unpackTotal, shown - meetIndex - 1)));
    if (counter) counter.textContent = counterText();
    if (stepBtn) stepBtn.disabled = shown >= steps.length;
  }

  function stop(): void {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  // Returns true if there's still more to reveal after this step.
  function step(): boolean {
    if (shown >= steps.length) return false;
    shown++;
    render();
    return shown < steps.length;
  }

  playBtn?.addEventListener("click", () => {
    stop();
    if (reducedMotion()) {
      shown = steps.length;
      render();
      return;
    }
    timer = setInterval(() => {
      if (!step()) stop();
    }, STEP_MS);
  });

  stepBtn?.addEventListener("click", () => {
    stop();
    step();
  });

  resetBtn?.addEventListener("click", () => {
    stop();
    shown = 0;
    render();
  });

  render();
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
