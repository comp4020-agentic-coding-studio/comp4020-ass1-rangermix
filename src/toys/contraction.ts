// Chapter 4 toy: click any node to contract it with the SAME
// createContractor() the real Canberra pipeline uses, on the real toytown
// street network. For every neighbour pair it touches, the algorithm tells
// us whether it found a witness (a detour that was already just as short)
// or had to add a shortcut — this module's only extra job is drawing that
// truthfully, INCLUDING when the graph is directed: toytown is 36% one-way,
// so witness/shortcut bookkeeping here is per ORDERED pair (u -> w), never
// collapsed with its reverse pair the way an earlier, always-undirected
// mini-town version safely could. chBuild's simulateContract already visits
// each ordered (in-neighbour, out-neighbour) combination exactly once per
// contract() call, so `outcome.witnessed`/`.shortcuts` never contain a
// duplicate ordered pair to begin with — the fix here is deleting the old
// unordered dedup, not adding a new one. The base ROAD layer is a separate
// concern and still collapses to one line per physical street (see
// toytownView's physicalEdges): a real two-way street is one piece of
// asphalt regardless of how many shortcut directions its endpoints later
// need.

import { createContractor } from "../algos/chBuild";
import { dijkstra } from "../algos/dijkstra";
import { buildCsr, type Graph } from "../algos/graph";
import { VIEWBOX, VIEWBOX_H, VIEWBOX_W, type Toytown } from "./toytown";
import { declutterXY, MIN_NODE_DIST, physicalEdges, roadPolylineMarkup } from "./toytownView";

const FLASH_MS = 800;
const SVG_NS = "http://www.w3.org/2000/svg";
const CURVE_OFFSET = 16;
// How far the k-th label of a busy contraction gets pushed past the plain
// midpoint, along its OWN curve's normal (see drawShortcut) — a deliberately
// simple per-shortcut-rank stagger, not real collision detection.
const LABEL_STAGGER = 10;
const LABEL_PAD_X = 3;
const LABEL_PAD_Y = 1.5;
const LABEL_RADIUS = 3;

function orderedKey(a: number, b: number): string {
  return `${a}->${b}`;
}

function unorderedKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

// Unit normal of the (a, b) chord, pointed away from `via` so a curve (or a
// label walking the same line) bows around the gap the contracted node left
// rather than through it. `flip` points to the OPPOSITE side instead — used
// so a directed pair's two independent shortcuts (u->w AND w->u, which
// toytown's one-ways make genuinely different events, each with its own
// weight) don't draw as two identical overlapping curves. Shared by
// controlPoint (the curve's midpoint bow) and drawShortcut (the label's
// collision stagger) so both walk out from the chord along the same line.
function curveNormal(
  xy: [number, number][],
  a: number,
  b: number,
  via: number,
  flip: boolean,
): [number, number] {
  const [x1, y1] = xy[a];
  const [x2, y2] = xy[b];
  const [vx, vy] = xy[via];
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
  if (flip) {
    nx = -nx;
    ny = -ny;
  }
  return [nx, ny];
}

// Bows the shortcut's curve away from the node it bypasses, so it visually
// arcs around the gap that node left behind instead of cutting straight
// through where it used to sit.
function controlPoint(
  xy: [number, number][],
  a: number,
  b: number,
  via: number,
  flip: boolean,
): [number, number] {
  const [x1, y1] = xy[a];
  const [x2, y2] = xy[b];
  const [nx, ny] = curveNormal(xy, a, b, via, flip);
  return [(x1 + x2) / 2 + nx * CURVE_OFFSET, (y1 + y2) / 2 + ny * CURVE_OFFSET];
}

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
// Shortcut curves still anchor to `t.xy` directly (drawShortcut), so they
// stay geometrically accurate even where their endpoint's button nudged.
function nodeButtonsMarkup(t: Toytown): string {
  const buttonXY = declutterXY(t.xy, MIN_NODE_DIST, undefined, [0, 0, VIEWBOX_W, VIEWBOX_H]);
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

export function mountContraction(root: HTMLElement, t: Toytown): void {
  // One instance for the lifetime of this mount: later clicks must see
  // shortcuts earlier clicks already added.
  const contractor = createContractor(t.graph);
  const roads = physicalEdges(t);

  root.innerHTML =
    `<div class="toy-stage">` +
    `<svg class="toy-svg" viewBox="${VIEWBOX}" aria-hidden="true">` +
    `<g class="edges">${roadPolylineMarkup(roads)}</g>` +
    `<g class="shortcuts"></g>` +
    `</svg>` +
    nodeButtonsMarkup(t) +
    `</div>` +
    `<div class="toy-controls">` +
    `<button class="chip" type="button" data-action="reset">&#8635; reset</button>` +
    `<span class="toy-counter" data-role="counter"></span>` +
    `</div>`;

  const svg = root.querySelector("svg");
  const shortcutsGroup = svg?.querySelector<SVGGElement>(".shortcuts");
  const counter = root.querySelector<HTMLElement>('[data-role="counter"]');
  const resetBtn = root.querySelector<HTMLButtonElement>('[data-action="reset"]');

  // Physical-street elements for flashing a witness route through them —
  // keyed UNORDERED, one per real street (see physicalEdges): a witness
  // path can traverse a two-way street in either direction and it's the
  // SAME piece of road either way, so there is exactly one element to find
  // regardless of which direction the witness search walked it.
  const roadEls = new Map<string, SVGPolylineElement>();
  if (svg) {
    for (const el of svg.querySelectorAll<SVGPolylineElement>(".edge-line")) {
      roadEls.set(unorderedKey(Number(el.dataset.a), Number(el.dataset.b)), el);
    }
  }
  // Shortcut elements, keyed ORDERED — a directed graph can independently
  // need a u->w shortcut, a w->u shortcut, both, or neither. Collapsing
  // them (an unordered key here — the bug this file replaces) would
  // silently drop whichever direction lost the race to be drawn first.
  const shortcutEls = new Map<string, SVGPathElement>();

  const baseLiveEdges = directedEdgesOf(t.graph);
  let liveEdges = baseLiveEdges.slice();

  function findRoadEl(a: number, b: number): SVGGraphicsElement | undefined {
    return shortcutEls.get(orderedKey(a, b)) ?? roadEls.get(unorderedKey(a, b));
  }

  function graphExcluding(skip: number): Graph {
    return graphFromEdges(t.graph.n, liveEdges.filter((e) => e.from !== skip && e.to !== skip));
  }

  function flashPath(path: number[]): void {
    const els: SVGGraphicsElement[] = [];
    for (let i = 0; i + 1 < path.length; i++) {
      const el = findRoadEl(path[i], path[i + 1]);
      if (el) els.push(el);
    }
    for (const el of els) el.classList.add("flash");
    setTimeout(() => {
      for (const el of els) el.classList.remove("flash");
    }, FLASH_MS);
  }

  // `collisionRank` is this shortcut's index within the batch a single
  // contraction just produced (0 for the first/only one). A busy
  // intersection can add several shortcuts that all bow away from the SAME
  // via node, so their plain midpoint label positions cluster and overlap —
  // the review's "5 labels collided on a normal first click" finding, on a
  // 4-way ANU intersection. Fix is two-part: an opaque background chip
  // (below, sized to the real rendered text via getBBox) so any label stays
  // readable over what's behind it, plus this deterministic stagger that
  // walks each label further along its OWN curve's normal by its rank —
  // simple, not real collision detection, but it turns a stack into a fan.
  function drawShortcut(a: number, b: number, w: number, via: number, collisionRank: number): void {
    if (!shortcutsGroup) return;
    const [x1, y1] = t.xy[a];
    const [x2, y2] = t.xy[b];
    const flip = a > b;
    const [cx, cy] = controlPoint(t.xy, a, b, via, flip);
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("class", "shortcut-path");
    path.setAttribute("d", `M ${x1},${y1} Q ${cx},${cy} ${x2},${y2}`);
    shortcutsGroup.appendChild(path);

    const [nx, ny] = curveNormal(t.xy, a, b, via, flip);
    const lx = cx + nx * collisionRank * LABEL_STAGGER;
    const ly = cy + ny * collisionRank * LABEL_STAGGER;

    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("class", "shortcut-label");
    label.setAttribute("x", String(lx));
    label.setAttribute("y", String(ly));
    label.textContent = String(Math.round(w));
    // Appended before measuring: getBBox() only reflects real rendered
    // geometry once the element is actually in the (live) document.
    shortcutsGroup.appendChild(label);

    const box = label.getBBox();
    const bg = document.createElementNS(SVG_NS, "rect");
    bg.setAttribute("class", "shortcut-label-bg");
    bg.setAttribute("x", String(box.x - LABEL_PAD_X));
    bg.setAttribute("y", String(box.y - LABEL_PAD_Y));
    bg.setAttribute("width", String(box.width + LABEL_PAD_X * 2));
    bg.setAttribute("height", String(box.height + LABEL_PAD_Y * 2));
    bg.setAttribute("rx", String(LABEL_RADIUS));
    shortcutsGroup.insertBefore(bg, label);

    shortcutEls.set(orderedKey(a, b), path);
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
    btn.setAttribute("aria-label", `Intersection ${v + 1} of ${t.graph.n}, contracted`);
  }

  function onNodeClick(v: number): void {
    if (contractor.contracted(v)) return;

    // Snapshot "the graph without v" BEFORE contracting, so the witness
    // path we draw is the same kind of bypass the algorithm just checked
    // for — reusing dijkstra() rather than re-deriving our own notion of
    // shortest path. Built from REAL directed edges (never symmetrized),
    // so it can only ever find routes the actual one-way streets allow.
    const before = graphExcluding(v);
    const outcome = contractor.contract(v);

    for (const w of outcome.witnessed) {
      const path = dijkstra(before, w.from, w.to).path;
      if (path.length > 1) flashPath(path);
    }

    liveEdges = liveEdges.filter((e) => e.from !== v && e.to !== v);
    outcome.shortcuts.forEach((s, collisionRank) => {
      liveEdges.push({ from: s.from, to: s.to, w: s.w });
      drawShortcut(s.from, s.to, s.w, v, collisionRank);
    });

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
    for (const el of roadEls.values()) el.classList.remove("flash");
    for (const btn of root.querySelectorAll<HTMLButtonElement>(".node-btn")) {
      const v = Number(btn.dataset.node);
      btn.disabled = false;
      btn.setAttribute("aria-label", `Contract intersection ${v + 1} of ${t.graph.n}`);
    }
    updateCounter();
  });

  updateCounter();
}
