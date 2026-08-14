// Chapter 1 toy: press play and watch Dijkstra's settle order bloom across
// the mini-town from A to L — the exact same dijkstra() that drives the
// real Canberra race, just twelve nodes instead of tens of thousands.

import { dijkstra } from "../algos/dijkstra";
import { MINITOWN, VIEWBOX, minitownEdges } from "./minitown";

const STEP_MS = 350;
const FROM_NAME = "A";
const TO_NAME = "L";

function reducedMotion(): boolean {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function svgMarkup(): string {
  const edgeLines = minitownEdges()
    .map((e) => {
      const [x1, y1] = MINITOWN.xy[e.a];
      const [x2, y2] = MINITOWN.xy[e.b];
      const cls = e.highway ? "edge-line edge-highway" : "edge-line";
      return `<line class="${cls}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />`;
    })
    .join("");
  const nodes = MINITOWN.names
    .map((name, i) => {
      const [x, y] = MINITOWN.xy[i];
      const endpoint = name === FROM_NAME || name === TO_NAME ? " node-endpoint" : "";
      return (
        `<g class="flood-node${endpoint}" data-node="${i}">` +
        `<circle cx="${x}" cy="${y}" r="12" />` +
        `<text x="${x}" y="${y}" dy="0.32em">${name}</text>` +
        `</g>`
      );
    })
    .join("");
  return (
    `<svg class="minitown-svg" viewBox="${VIEWBOX}" role="img" ` +
    `aria-label="Mini-town of twelve intersections, used to demonstrate Dijkstra's search from ${FROM_NAME} to ${TO_NAME}.">` +
    `<g class="edges">${edgeLines}</g>` +
    `<path class="route-path" d="" />` +
    `<g class="nodes">${nodes}</g>` +
    `</svg>`
  );
}

export function mountFlood(root: HTMLElement): void {
  const from = MINITOWN.names.indexOf(FROM_NAME);
  const to = MINITOWN.names.indexOf(TO_NAME);
  const result = dijkstra(MINITOWN.graph, from, to);
  const total = MINITOWN.graph.n;

  root.innerHTML =
    `<div class="minitown-stage">${svgMarkup()}</div>` +
    `<div class="toy-controls">` +
    `<button class="chip" type="button" data-action="play">&#9658; play</button>` +
    `<button class="chip" type="button" data-action="step">step</button>` +
    `<button class="chip" type="button" data-action="reset">&#8635; reset</button>` +
    `<span class="toy-counter" data-role="counter"></span>` +
    `</div>`;

  const svg = root.querySelector("svg");
  const routePath = root.querySelector<SVGPathElement>(".route-path");
  const counter = root.querySelector<HTMLElement>('[data-role="counter"]');
  const playBtn = root.querySelector<HTMLButtonElement>('[data-action="play"]');
  const stepBtn = root.querySelector<HTMLButtonElement>('[data-action="step"]');
  const resetBtn = root.querySelector<HTMLButtonElement>('[data-action="reset"]');

  let shown = 0; // how many of result.settled are currently revealed
  let timer: ReturnType<typeof setInterval> | undefined;

  function nodeEl(i: number): SVGGElement | null {
    return svg?.querySelector<SVGGElement>(`.flood-node[data-node="${i}"]`) ?? null;
  }

  function paintPath(atEnd: boolean): void {
    if (!routePath) return;
    if (!atEnd || result.path.length === 0) {
      routePath.setAttribute("d", "");
      return;
    }
    const pts = result.path.map((i) => MINITOWN.xy[i].join(",")).join(" L ");
    routePath.setAttribute("d", `M ${pts}`);
  }

  function render(): void {
    for (let i = 0; i < result.settled.length; i++) {
      nodeEl(result.settled[i])?.classList.toggle("settled", i < shown);
    }
    const done = shown >= result.settled.length;
    if (counter) counter.textContent = `settled ${shown} of ${total}`;
    paintPath(done);
    if (stepBtn) stepBtn.disabled = done;
  }

  function stop(): void {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  // Returns true if there's still more to reveal after this step.
  function step(): boolean {
    if (shown >= result.settled.length) return false;
    shown++;
    render();
    return shown < result.settled.length;
  }

  playBtn?.addEventListener("click", () => {
    stop();
    if (reducedMotion()) {
      shown = result.settled.length;
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
