// Chapter 2 toy: click any node to contract it with the SAME
// createContractor() the real Canberra pipeline uses. For every neighbour
// pair it touches, the algorithm tells us whether it found a witness (a
// detour that was already just as short) or had to add a shortcut — this
// module's only extra job is drawing that truthfully: witnessed pairs flash
// the actual bypass route, found by running dijkstra() (again, the real
// code) over a local mirror of the graph that mutates in lockstep with the
// contractor, so it always reflects earlier shortcuts too.

import { createContractor } from "../algos/chBuild";
import { dijkstra } from "../algos/dijkstra";
import {
  MINITOWN,
  VIEWBOX,
  VIEWBOX_H,
  VIEWBOX_W,
  graphFromEdges,
  minitownEdges,
} from "./minitown";

const FLASH_MS = 800;
const SVG_NS = "http://www.w3.org/2000/svg";
const CURVE_OFFSET = 22;

function pairKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

// Bows the shortcut's curve away from the node it bypasses, so it visually
// arcs around the gap that node left behind instead of cutting straight
// through where it used to sit.
function controlPoint(a: number, b: number, via: number): [number, number] {
  const [x1, y1] = MINITOWN.xy[a];
  const [x2, y2] = MINITOWN.xy[b];
  const [vx, vy] = MINITOWN.xy[via];
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  let nx = -(y2 - y1);
  let ny = x2 - x1;
  const len = Math.hypot(nx, ny) || 1;
  nx /= len;
  ny /= len;
  if ((mx - vx) * nx + (my - vy) * ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  return [mx + nx * CURVE_OFFSET, my + ny * CURVE_OFFSET];
}

function baseSvgMarkup(): string {
  let lines = "";
  let labels = "";
  for (const e of minitownEdges()) {
    const [x1, y1] = MINITOWN.xy[e.a];
    const [x2, y2] = MINITOWN.xy[e.b];
    const cls = e.highway ? "edge-line edge-highway" : "edge-line";
    lines += `<line class="${cls}" data-a="${e.a}" data-b="${e.b}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />`;
    labels += `<text class="edge-weight" x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2}">${e.w}</text>`;
  }
  return (
    `<svg class="minitown-svg" viewBox="${VIEWBOX}" aria-hidden="true">` +
    `<g class="edges">${lines}</g>` +
    `<g class="edge-weights">${labels}</g>` +
    `<g class="shortcuts"></g>` +
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

export function mountContraction(root: HTMLElement): void {
  // One instance for the lifetime of this mount, per T3's contract: later
  // clicks must see shortcuts earlier clicks already added.
  const contractor = createContractor(MINITOWN.graph);

  root.innerHTML =
    `<div class="minitown-stage">${baseSvgMarkup()}${nodeButtonsMarkup()}</div>` +
    `<div class="toy-controls">` +
    `<button class="chip" type="button" data-action="reset">&#8635; reset</button>` +
    `<span class="toy-counter" data-role="counter"></span>` +
    `</div>`;

  const svg = root.querySelector("svg");
  const shortcutsGroup = svg?.querySelector<SVGGElement>(".shortcuts");
  const counter = root.querySelector<HTMLElement>('[data-role="counter"]');
  const resetBtn = root.querySelector<HTMLButtonElement>('[data-action="reset"]');

  const edgeEls = new Map<string, SVGLineElement>();
  if (svg) {
    for (const el of svg.querySelectorAll<SVGLineElement>(".edge-line")) {
      edgeEls.set(pairKey(Number(el.dataset.a), Number(el.dataset.b)), el);
    }
  }
  const shortcutEls = new Map<string, SVGPathElement>();

  // A local mirror of the graph (as a flat directed edge list), kept in
  // lockstep with the contractor: shrinks by v's edges and grows by v's
  // shortcuts after every contract() call. Only used to FIND witness paths
  // to draw — the contractor itself is the source of truth for shortcuts,
  // witnesses, and the running count.
  const baseLiveEdges: { from: number; to: number; w: number }[] = [];
  for (const e of minitownEdges()) {
    baseLiveEdges.push({ from: e.a, to: e.b, w: e.w });
    baseLiveEdges.push({ from: e.b, to: e.a, w: e.w });
  }
  let liveEdges = baseLiveEdges.slice();

  function findEl(a: number, b: number): SVGGraphicsElement | undefined {
    const k = pairKey(a, b);
    return shortcutEls.get(k) ?? edgeEls.get(k);
  }

  function graphExcluding(skip: number) {
    return graphFromEdges(liveEdges.filter((e) => e.from !== skip && e.to !== skip));
  }

  function flashPath(path: number[]): void {
    const els: SVGGraphicsElement[] = [];
    for (let i = 0; i + 1 < path.length; i++) {
      const el = findEl(path[i], path[i + 1]);
      if (el) els.push(el);
    }
    for (const el of els) el.classList.add("flash");
    setTimeout(() => {
      for (const el of els) el.classList.remove("flash");
    }, FLASH_MS);
  }

  function drawShortcut(a: number, b: number, w: number, via: number): void {
    if (!shortcutsGroup) return;
    const [x1, y1] = MINITOWN.xy[a];
    const [x2, y2] = MINITOWN.xy[b];
    const [cx, cy] = controlPoint(a, b, via);
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("class", "shortcut-path");
    path.setAttribute("d", `M ${x1},${y1} Q ${cx},${cy} ${x2},${y2}`);
    shortcutsGroup.appendChild(path);
    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("class", "shortcut-label");
    label.setAttribute("x", String(cx));
    label.setAttribute("y", String(cy));
    label.textContent = String(w);
    shortcutsGroup.appendChild(label);
    shortcutEls.set(pairKey(a, b), path);
  }

  function updateCounter(): void {
    if (!counter) return;
    const n = contractor.totalShortcuts();
    counter.textContent = `${n} shortcut${n === 1 ? "" : "s"} so far`;
  }

  function markContracted(v: number): void {
    const btn = root.querySelector<HTMLButtonElement>(`.node-btn[data-node="${v}"]`);
    if (!btn) return;
    btn.disabled = true;
    btn.setAttribute("aria-label", `Node ${MINITOWN.names[v]}, contracted`);
  }

  function onNodeClick(v: number): void {
    if (contractor.contracted(v)) return;

    // Snapshot "the graph without v" BEFORE contracting, so the witness
    // path we draw is the same kind of bypass the algorithm just checked
    // for — reusing dijkstra() rather than re-deriving our own notion of
    // shortest path.
    const before = graphExcluding(v);
    const outcome = contractor.contract(v);

    const seenWitness = new Set<string>();
    for (const w of outcome.witnessed) {
      const k = pairKey(w.from, w.to);
      if (seenWitness.has(k)) continue; // undirected pair checked from both sides
      seenWitness.add(k);
      const path = dijkstra(before, w.from, w.to).path;
      if (path.length > 1) flashPath(path);
    }

    liveEdges = liveEdges.filter((e) => e.from !== v && e.to !== v);
    const seenShortcut = new Set<string>();
    for (const s of outcome.shortcuts) {
      liveEdges.push({ from: s.from, to: s.to, w: s.w });
      const k = pairKey(s.from, s.to);
      if (seenShortcut.has(k)) continue; // draw the u<->w pair once, not twice
      seenShortcut.add(k);
      drawShortcut(s.from, s.to, s.w, v);
    }

    markContracted(v);
    updateCounter();
  }

  for (const btn of root.querySelectorAll<HTMLButtonElement>(".node-btn")) {
    const v = Number(btn.dataset.node);
    btn.addEventListener("click", () => onNodeClick(v));
  }

  resetBtn?.addEventListener("click", () => {
    contractor.reset();
    liveEdges = baseLiveEdges.slice();
    shortcutEls.clear();
    if (shortcutsGroup) shortcutsGroup.innerHTML = "";
    for (const el of edgeEls.values()) el.classList.remove("flash");
    for (const btn of root.querySelectorAll<HTMLButtonElement>(".node-btn")) {
      const name = MINITOWN.names[Number(btn.dataset.node)];
      btn.disabled = false;
      btn.setAttribute("aria-label", `Contract node ${name}`);
    }
    updateCounter();
  });

  updateCounter();
}
