// Chapter 1 toy: press play (or just scroll it into view — see how.ts's
// visibility gate) and watch Dijkstra's settle order bloom across a real
// Canberra city-centre street network from a default far pair — the exact
// same dijkstra() that drives the real Canberra race, just 55 streets
// instead of tens of thousands. The visitor can re-pick their own start/end pair by
// clicking two intersections (toytownView's advancePick: first=start,
// second=end+re-run, third=reset+new start); every re-pick calls the SAME
// real dijkstra(), never a scripted replay.

import type { Graph } from "../algos/graph";
import { dijkstra } from "../algos/dijkstra";
import { VIEWBOX, VIEWBOX_H, VIEWBOX_W, type Toytown } from "./toytown";
import {
  advancePick,
  contextPolylineMarkup,
  declutterXY,
  driftConnectorMarkup,
  driftConnectors,
  IDLE_PICK,
  MIN_NODE_DIST,
  physicalEdges,
  roadPolylineMarkup,
  type PickState,
} from "./toytownView";

const STEP_MS = 80; // 55 nodes x 80ms ~= a 4.5s full flood — brisk, not draggy

function reducedMotion(): boolean {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The toy's default "far pair": a double-sweep (two dijkstra() passes,
 * starting from an arbitrary node) — the standard cheap approximation of a
 * graph's diameter endpoints. Like every other number this site shows,
 * this is COMPUTED from the real loaded graph, never hand-picked node
 * indices: `dijkstra(g, from, -1)` settles every reachable node in
 * non-decreasing distance order, so the LAST settled node is already the
 * farthest one from `from` — no separate per-node distance array needed. */
export function findFarPair(g: Graph): { from: number; to: number } {
  const first = dijkstra(g, 0, -1);
  const far1 = first.settled[first.settled.length - 1] ?? 0;
  const second = dijkstra(g, far1, -1);
  const far2 = second.settled[second.settled.length - 1] ?? far1;
  return { from: far1, to: far2 };
}

/** Button centers, decluttered apart (see toytownView's declutterXY): the
 * real toytown layout has intersections as little as ~2px apart on screen,
 * which no hit-circle padding alone can make individually clickable. The
 * route path and every other geometry-accurate draw stays on `t.xy` — only
 * the button LAYER moves. */
function nodeButtonsMarkup(t: Toytown): string {
  const buttonXY = declutterXY(t.xy, MIN_NODE_DIST, undefined, [0, 0, VIEWBOX_W, VIEWBOX_H]);
  return buttonXY
    .map(([x, y], i) => {
      const left = ((x / VIEWBOX_W) * 100).toFixed(3);
      const top = ((y / VIEWBOX_H) * 100).toFixed(3);
      return (
        `<button class="node-btn" type="button" data-node="${i}" ` +
        `style="left:${left}%;top:${top}%" aria-label="Intersection ${i + 1} of ${t.xy.length}"></button>`
      );
    })
    .join("");
}

function labelFor(i: number, n: number, from: number, to: number): string {
  const base = `Intersection ${i + 1} of ${n}`;
  if (i === from) return `${base}, start`;
  if (i === to) return `${base}, end`;
  return base;
}

export function mountFlood(root: HTMLElement, t: Toytown): { playDefault: () => void } {
  const roads = physicalEdges(t);
  // Same declutter run nodeButtonsMarkup does internally (pure/deterministic
  // — recomputing is cheap at toytown's ~55-node scale) so the drift
  // connectors below (design spec §17.5 delta 3) know each button's TRUE
  // vs SHOWN position without threading a return value through the markup
  // helper.
  const buttonXY = declutterXY(t.xy, MIN_NODE_DIST, undefined, [0, 0, VIEWBOX_W, VIEWBOX_H]);

  root.innerHTML =
    `<div class="toy-stage">` +
    `<svg class="toy-svg" viewBox="${VIEWBOX}" role="img" ` +
    `aria-label="Street network used to demonstrate Dijkstra's search.">` +
    `<g class="context-layer" aria-hidden="true">${contextPolylineMarkup(t)}</g>` +
    `<g class="edges">${roadPolylineMarkup(roads)}</g>` +
    `<g class="drift-layer" aria-hidden="true">${driftConnectorMarkup(driftConnectors(t.xy, buttonXY))}</g>` +
    `<path class="route-path" d="" />` +
    `</svg>` +
    nodeButtonsMarkup(t) +
    `</div>` +
    `<p class="toy-subhead">Click two intersections to race your own pair — first
      is the start, second is the end.</p>` +
    `<div class="toy-controls">` +
    `<button class="chip" type="button" data-action="play">&#9658; play</button>` +
    `<button class="chip" type="button" data-action="step">step</button>` +
    `<button class="chip" type="button" data-action="reset">&#8635; reset</button>` +
    `<span class="toy-counter" data-role="counter"></span>` +
    `</div>`;

  const routePath = root.querySelector<SVGPathElement>(".route-path");
  const counter = root.querySelector<HTMLElement>('[data-role="counter"]');
  const playBtn = root.querySelector<HTMLButtonElement>('[data-action="play"]');
  const stepBtn = root.querySelector<HTMLButtonElement>('[data-action="step"]');
  const resetBtn = root.querySelector<HTMLButtonElement>('[data-action="reset"]');

  const nodeButtons = new Map<number, HTMLButtonElement>();
  for (const btn of root.querySelectorAll<HTMLButtonElement>(".node-btn")) {
    nodeButtons.set(Number(btn.dataset.node), btn);
  }

  let from = 0;
  let to = 0;
  let result = dijkstra(t.graph, 0, 0);
  let shown = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pick: PickState = IDLE_PICK;

  function stop(): void {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  function paintPath(atEnd: boolean): void {
    if (!routePath) return;
    if (!atEnd || result.path.length === 0) {
      routePath.setAttribute("d", "");
      return;
    }
    const pts = result.path.map((i) => t.xy[i].join(",")).join(" L ");
    routePath.setAttribute("d", `M ${pts}`);
  }

  function render(): void {
    for (let i = 0; i < result.settled.length; i++) {
      nodeButtons.get(result.settled[i])?.classList.toggle("settled", i < shown);
    }
    const done = shown >= result.settled.length;
    if (counter) counter.textContent = `settled ${shown} of ${t.graph.n}`;
    paintPath(done);
    if (stepBtn) stepBtn.disabled = done;
  }

  // Returns true if there's still more to reveal after this step.
  function step(): boolean {
    if (shown >= result.settled.length) return false;
    shown++;
    render();
    return shown < result.settled.length;
  }

  function playFromCurrent(): void {
    stop();
    shown = 0;
    if (reducedMotion()) {
      shown = result.settled.length;
      render();
      return;
    }
    render();
    timer = setInterval(() => {
      if (!step()) stop();
    }, STEP_MS);
  }

  function setPair(newFrom: number, newTo: number): void {
    stop();
    from = newFrom;
    to = newTo;
    result = dijkstra(t.graph, from, to);
    shown = 0;
    for (const [i, btn] of nodeButtons) {
      btn.classList.remove("settled");
      btn.classList.toggle("endpoint-a", i === from);
      btn.classList.toggle("endpoint-b", i === to);
      // Echoes the home page's own map-pin convention ("A"/"B" discs) —
      // aria-label carries the same info for screen readers regardless.
      btn.textContent = i === from ? "A" : i === to ? "B" : "";
      btn.setAttribute("aria-label", labelFor(i, t.graph.n, from, to));
    }
    render();
  }

  for (const [i, btn] of nodeButtons) {
    btn.addEventListener("click", () => {
      const { next, complete } = advancePick(pick, i);
      pick = next;
      for (const [j, b] of nodeButtons) {
        b.classList.toggle("pending-start", j === pick.start && pick.end === null);
      }
      if (complete) {
        setPair(complete[0], complete[1]);
        playFromCurrent();
      }
    });
  }

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

  const start = findFarPair(t.graph);
  setPair(start.from, start.to);

  return { playDefault: () => playFromCurrent() };
}
