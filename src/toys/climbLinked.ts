// Chapter 3's DOM half (design spec §16.13, task G5): TWO linked views in
// one toy root — the computed hierarchy (rank-lifted graph, as F5 shipped
// it) on TOP, the real street MAP (toytownView's shared road-drawing, the
// same substrate flood/contraction/order use) on the BOTTOM. The visitor
// picks A/B by clicking nodes ON THE MAP ONLY — the hierarchy view is
// display-only (its node marks carry no button role, no click handling).
// ONE real chQuery(ch, from, to) run drives BOTH views from a single shared
// `shown` step counter: every tick, both views re-render off the SAME
// `steps`/`shown` state, so a settle/meet/unpack event lands in lockstep in
// both pictures (climb.ts's buildSteps/stepStreetPairs do the actual
// event -> real-street mapping; this file just paints what they say).
//
// The map's node BUTTONS are built once (their positions are fixed real
// geography — declutterXY over `t.xy`, exactly like flood.ts) and only
// their STATE (ghost/touched/endpoint) is toggled per pair; the hierarchy's
// node MARKS are rebuilt on every pair change instead, because their
// POSITIONS depend on the rank-lift layout, which is rescaled per query
// (see climb.ts's rankStep/rankY doc comments) — same asymmetry F5's
// single-view climb had, just now split across two DOM subtrees.
//
// The map's "touched" (settle-phase) and "on-route" (unpack-phase) street
// highlighting reuses the SAME persistent `.edge-line` elements
// roadPolylineMarkup already drew for the base network — toggling classes
// on them (contraction.ts's witness-flash convention: a Map<key, element>
// keyed by toytownView's unorderedKey) rather than drawing a second overlay
// layer, so the highlighted route follows the real street curve, not a
// straight-line stand-in.

import { buildCh } from "../algos/chBuild";
import { chQuery, type ChResult } from "../algos/chQuery";
import { VIEWBOX, VIEWBOX_H, VIEWBOX_W, type Toytown } from "./toytown";
import {
  advancePick,
  contextPolylineMarkup,
  declutterXY,
  driftConnectorMarkup,
  driftConnectors,
  IDLE_PICK,
  MIN_NODE_DIST,
  NODE_CLAMP_BOUNDS,
  physicalEdges,
  roadPolylineMarkup,
  unorderedKey,
  wireRovingNodeButtons,
  type PickState,
} from "./toytownView";
import {
  buildSteps,
  countArterialSegments,
  findDefaultClimbPair,
  MIN_TOUCHED,
  rankStep,
  rankY,
  stepStreetPairs,
  touchedNodes,
  type ClimbStep,
} from "./climb";

// Slower than F5's single-view 300ms: every tick now has to register in TWO
// pictures at once, so the eye needs a beat longer per step (design spec
// §16.13: "same step cadence (~500ms)").
const STEP_MS = 500;

// Hierarchy zoom/height (design spec §17.6, task H3) lived here briefly —
// wheel/button zoom, drag-pan, and a taller stage. Sixth build review §20.5
// found that treatment landed on the WRONG view: the user meant chapter 2
// ("The hierarchy, revealed", src/toys/hierarchy.ts's real Canberra map),
// not this toy-town rank-lift diagram. Reverted here to the pre-§17.6
// compact form (plain base-space percentage positioning throughout — see
// renderHier/positionMeets below — and styles.css's .toy-stage default
// height); the zoom feature itself moved to hierarchy.ts, driving MapView's
// own zoomAt/panBy against a private view store rather than the
// svgZoomAbout/svgPan/vbPercentXY helpers this file used to call (those
// helpers stay in toytownView.ts, unchanged, for any other SVG-based toy
// that wants them later).

function reducedMotion(): boolean {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function labelFor(i: number, n: number, from: number, to: number, touched: boolean): string {
  const base = `Intersection ${i + 1} of ${n}`;
  if (i === from) return `${base}, start`;
  if (i === to) return `${base}, end`;
  return touched ? base : `${base} (not on this climb)`;
}

export function mountClimb(root: HTMLElement, t: Toytown): { playDefault: () => void } {
  const ch = buildCh(t.graph);
  const defaultPair = findDefaultClimbPair(ch, MIN_TOUCHED, (result) => countArterialSegments(t, result.path));
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

  const roads = physicalEdges(t);
  // The map's node-button layout is fixed real geography — computed ONCE,
  // unlike the hierarchy's rank-lift layout below, which is rescaled per
  // query (see recomputeHierXY).
  const mapXY = declutterXY(t.xy, MIN_NODE_DIST, undefined, NODE_CLAMP_BOUNDS);
  const mapButtonsMarkup = mapXY
    .map(([x, y], i) => {
      const left = ((x / VIEWBOX_W) * 100).toFixed(3);
      const top = ((y / VIEWBOX_H) * 100).toFixed(3);
      return (
        `<button class="node-btn climb-node-btn" type="button" data-node="${i}" ` +
        `style="left:${left}%;top:${top}%"></button>`
      );
    })
    .join("");

  root.innerHTML =
    `<div class="climb-views">` +
    `<div class="climb-view">` +
    `<p class="climb-view-label">Hierarchy — rank climbs upward</p>` +
    `<div class="toy-stage climb-hierarchy-stage">` +
    // aria-hidden lives on the SVG and the node-marks layer individually
    // rather than the outer .toy-stage — this view is display-only (this
    // file's own header comment: the visitor picks A/B on the MAP, the
    // hierarchy just mirrors state), so nothing under here is ever a
    // focusable control, but scoping it per-element rather than on the
    // shared .toy-stage class keeps it honest if that class is ever reused
    // somewhere a focusable descendant DOES belong. No preserveAspectRatio
    // override: this stage's CSS box matches its 460x300 viewBox exactly
    // (the shared base .toy-stage rule, styles.css — see this file's own
    // revert note above), so the default uniform scaling already lines up
    // with the percentage-positioned .node-mark/.climb-meet layers below.
    `<svg class="toy-svg" viewBox="${VIEWBOX}" aria-hidden="true">` +
    `<g class="climb-edges" data-role="hier-edges"></g>` +
    `<path class="route-path" data-role="hier-route" d="" />` +
    `</svg>` +
    `<div class="climb-nodes" data-role="hier-nodes" aria-hidden="true"></div>` +
    `<div class="climb-meet" data-role="hier-meet" aria-hidden="true">` +
    `<span class="meet-star">&#9733;</span><span class="meet-label">meet</span></div>` +
    `</div>` +
    `</div>` +
    `<div class="climb-view">` +
    `<p class="climb-view-label">Street map — click to pick A and B</p>` +
    `<div class="toy-stage climb-map-stage">` +
    `<svg class="toy-svg" viewBox="${VIEWBOX}" role="img" ` +
    `aria-label="Street map — click two intersections to pick your own start ` +
    `and end; the hierarchy above follows along.">` +
    // Context (§17.5) BENEATH the toy's own roads; drift connectors (§17.5
    // delta 3) ABOVE them so a displaced node's leader line reads clearly
    // over the road it's leaving from.
    `<g class="context-layer" aria-hidden="true">${contextPolylineMarkup(t)}</g>` +
    `<g class="edges" data-role="map-edges">${roadPolylineMarkup(roads)}</g>` +
    `<g class="drift-layer" aria-hidden="true">${driftConnectorMarkup(driftConnectors(t.xy, mapXY))}</g>` +
    `</svg>` +
    `<div class="climb-nodes" data-role="map-nodes">${mapButtonsMarkup}</div>` +
    `<div class="climb-meet" data-role="map-meet" aria-hidden="true">` +
    `<span class="meet-star">&#9733;</span><span class="meet-label">meet</span></div>` +
    `</div>` +
    `</div>` +
    `</div>` +
    `<p class="toy-subhead">Click two intersections on the map to pick your
      own pair — first is the start, second is the end.</p>` +
    `<div class="toy-controls">` +
    `<button class="chip" type="button" data-action="play">&#9658; play</button>` +
    `<button class="chip" type="button" data-action="step">step</button>` +
    `<button class="chip" type="button" data-action="reset">&#8635; reset</button>` +
    `<span class="toy-counter" data-role="counter"></span>` +
    `</div>`;

  const hierEdgesGroup = root.querySelector<SVGGElement>('[data-role="hier-edges"]');
  const hierRoutePath = root.querySelector<SVGPathElement>('[data-role="hier-route"]');
  const hierNodesLayer = root.querySelector<HTMLElement>('[data-role="hier-nodes"]');
  const hierMeetEl = root.querySelector<HTMLElement>('[data-role="hier-meet"]');

  const mapSvg = root.querySelector<SVGSVGElement>(".climb-map-stage svg");
  const mapNodesLayer = root.querySelector<HTMLElement>('[data-role="map-nodes"]');
  const mapMeetEl = root.querySelector<HTMLElement>('[data-role="map-meet"]');

  const counter = root.querySelector<HTMLElement>('[data-role="counter"]');
  const playBtn = root.querySelector<HTMLButtonElement>('[data-action="play"]');
  const stepBtn = root.querySelector<HTMLButtonElement>('[data-action="step"]');
  const resetBtn = root.querySelector<HTMLButtonElement>('[data-action="reset"]');

  // The base road network is drawn ONCE (it never changes across pair
  // re-picks) — this is the lookup climbLinked's touched/route highlighting
  // uses to find the ONE physical <polyline> a given real (u, v) hop shares
  // (contraction.ts's witness-flash convention, reused via toytownView's
  // shared unorderedKey).
  const roadEls = new Map<string, SVGPolylineElement>();
  if (mapSvg) {
    for (const el of mapSvg.querySelectorAll<SVGPolylineElement>(".edge-line")) {
      roadEls.set(unorderedKey(Number(el.dataset.a), Number(el.dataset.b)), el);
    }
  }

  // Map node buttons are built once (see mapButtonsMarkup above); only
  // their state (ghost/touched/endpoint/labels) changes per pair.
  const mapNodeButtons = new Map<number, HTMLButtonElement>();
  for (const btn of mapNodesLayer?.querySelectorAll<HTMLButtonElement>(".node-btn") ?? []) {
    mapNodeButtons.set(Number(btn.dataset.node), btn);
  }

  // Roving tabindex (I3 gate, a11y): same fix, same shared substrate as
  // flood.ts's map — see toytownView.ts's wireRovingNodeButtons. Only the
  // MAP's buttons need it; the hierarchy's `.node-mark`s are plain,
  // non-interactive `<div>`s by design (this file's own header comment:
  // "the hierarchy view is display-only... its node marks carry no button
  // role"), so there's no separate tab-stop problem to fix there. `mapXY`
  // is already index-aligned to node id (the same array `mapButtonsMarkup`
  // used to place these buttons), and `mapNodeButtons` has one entry per
  // `mapXY` index by construction (same loop built both).
  if (mapNodesLayer) {
    const orderedMapButtons = mapXY.map((_, i) => mapNodeButtons.get(i) as HTMLButtonElement);
    wireRovingNodeButtons(mapNodesLayer, orderedMapButtons, mapXY);
  }

  let from = defaultPair.from;
  let to = defaultPair.to;
  let result: ChResult = chQuery(ch, from, to);
  let steps: ClimbStep[] = [];
  // Node -> {fwdIdx, bwdIdx}: the step index at which each direction
  // settles this node, if it does (a node can be settled by BOTH searches
  // before they meet, so this tracks both independently rather than the
  // first match only — a plain steps.findIndex per node would silently
  // stop showing the backward ring on a node also reached from the front).
  // Shared by BOTH views — the same step index means the same moment in
  // both pictures (design spec §16.13's lockstep).
  let nodeStepIndex = new Map<number, { fwdIdx?: number; bwdIdx?: number }>();
  let rankStepPx = 0;
  let touched = new Set<number>();
  // The hierarchy's on-screen position for the CURRENT query — real x,
  // rank-lifted (touched) or baseline (ghost) y — then run through
  // declutterXY (see toytownView.ts): climb's hierarchy edges are schematic
  // straight lines (not real street geometry), so there is no "true
  // geometry" for a decluttered mark to visually drift away from. Every
  // hierarchy element reads from this SAME decluttered array, so nothing
  // seams. Recomputed wherever `touched`/`rankStepPx` change.
  let hierXY: [number, number][] = [];
  // Which physical road element FIRST becomes touched/on-route, and at
  // which step index — the earliest occurrence wins (not last-write) so a
  // street revealed at step 3 and again (via a different highlight edge)
  // at step 40 doesn't get its highlight cleared by re-processing; see
  // rebuildStreetLookups.
  let touchedFirstIdx = new Map<SVGPolylineElement, number>();
  let routeFirstIdx = new Map<SVGPolylineElement, number>();
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

  // Ghost nodes sit at the flat baseline — exactly rankY(0, step) (rank 0
  // maps to BASE_Y regardless of step, since the rank term zeroes out), so
  // no separate baseline constant needs to cross the climb.ts/climbLinked.ts
  // boundary.
  function recomputeHierXY(): void {
    const raw: [number, number][] = t.xy.map(([x], i) => [
      x,
      rankY(touched.has(i) ? ch.rank[i] : 0, rankStepPx),
    ]);
    hierXY = declutterXY(raw, MIN_NODE_DIST, undefined, NODE_CLAMP_BOUNDS);
  }

  function hierNodeXY(i: number): [number, number] {
    return hierXY[i];
  }

  function mapNodeXY(i: number): [number, number] {
    return mapXY[i];
  }

  function stop(): void {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  function paintHierRoute(edgeCount: number): void {
    if (!hierRoutePath) return;
    if (edgeCount <= 0) {
      hierRoutePath.setAttribute("d", "");
      return;
    }
    const pts = result.path
      .slice(0, edgeCount + 1)
      .map((i) => hierNodeXY(i).join(","))
      .join(" L ");
    hierRoutePath.setAttribute("d", `M ${pts}`);
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

  // Applies the CURRENT pair's ghost/endpoint/label state to the map's
  // STATIC buttons — called on mount and on every setPair; touched-fwd/
  // touched-bwd are deliberately left to render() (toggle-based, so a stale
  // class from the previous pair self-corrects the moment shown resets to
  // 0 and render() re-derives from the fresh nodeStepIndex).
  function applyMapNodeStates(): void {
    for (const [i, btn] of mapNodeButtons) {
      btn.classList.toggle("ghost", !touched.has(i));
      btn.classList.toggle("endpoint-a", i === from);
      btn.classList.toggle("endpoint-b", i === to);
      btn.textContent = i === from ? "A" : i === to ? "B" : "";
      btn.setAttribute("aria-label", labelFor(i, t.graph.n, from, to, touched.has(i)));
    }
  }

  // Clears whichever road elements the OLD pair had highlighted, then
  // rebuilds touchedFirstIdx/routeFirstIdx for the NEW pair's step script —
  // must clear first: a street touched by the previous pair but not
  // touched by this one would otherwise keep its stale highlight forever
  // (render() only ever visits elements CURRENTLY in the maps).
  function rebuildStreetLookups(): void {
    for (const el of touchedFirstIdx.keys()) el.classList.remove("touched");
    for (const el of routeFirstIdx.keys()) el.classList.remove("on-route");
    touchedFirstIdx = new Map();
    routeFirstIdx = new Map();
    steps.forEach((step, idx) => {
      for (const [u, v] of stepStreetPairs(ch, step)) {
        const el = roadEls.get(unorderedKey(u, v));
        if (!el) continue; // defensive: every real hop has a physical road element
        const target = step.kind === "unpack" ? routeFirstIdx : touchedFirstIdx;
        if (!target.has(el)) target.set(el, idx);
      }
    });
  }

  function positionMeets(): void {
    if (hierMeetEl) {
      const [x, y] = hierNodeXY(result.meet);
      hierMeetEl.style.left = `${(x / VIEWBOX_W) * 100}%`;
      hierMeetEl.style.top = `${(y / VIEWBOX_H) * 100}%`;
    }
    if (mapMeetEl) {
      const [x, y] = mapNodeXY(result.meet);
      mapMeetEl.style.left = `${(x / VIEWBOX_W) * 100}%`;
      mapMeetEl.style.top = `${(y / VIEWBOX_H) * 100}%`;
    }
  }

  // Rebuilds the hierarchy's node marks + climb-edges fully (their
  // POSITIONS depend on the rank-lift layout, which changes per pair —
  // unlike the map, whose node buttons are static and only get state
  // toggles, see applyMapNodeStates). Marks are plain <div>s (design spec
  // §16.13: "hierarchy view is display-only — its nodes need no button
  // role"), not <button>s, but reuse the SAME .climb-node-btn state classes
  // (ghost/touched-fwd/touched-bwd/endpoint-*), which style off those
  // classes alone — see styles.css's .node-mark rules.
  function renderHier(): void {
    if (!hierNodesLayer || !hierEdgesGroup) return;
    hierNodesLayer.innerHTML = t.xy
      .map((_, i) => {
        const [x, y] = hierNodeXY(i);
        const left = ((x / VIEWBOX_W) * 100).toFixed(3);
        const top = ((y / VIEWBOX_H) * 100).toFixed(3);
        const ghost = !touched.has(i) ? " ghost" : "";
        const endpoint = i === from ? " endpoint-a" : i === to ? " endpoint-b" : "";
        // Echoes the map's own A/B labelling — purely visual here (the
        // stage is aria-hidden), so a sighted visitor sees the same A/B in
        // both pictures.
        const label = i === from ? "A" : i === to ? "B" : "";
        return (
          `<div class="node-mark climb-node-btn${ghost}${endpoint}" data-node="${i}" ` +
          `style="left:${left}%;top:${top}%">${label}</div>`
        );
      })
      .join("");

    const lines: string[] = [];
    steps.forEach((s, idx) => {
      if (s.kind !== "fwd" && s.kind !== "bwd") return;
      for (const e of s.edges) {
        const [x1, y1] = hierNodeXY(e.from);
        const [x2, y2] = hierNodeXY(e.to);
        lines.push(
          `<line class="climb-edge climb-edge-${s.kind}" data-step-idx="${idx}" ` +
            `x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />`,
        );
      }
    });
    hierEdgesGroup.innerHTML = lines.join("");
  }

  // The shared per-tick paint: BOTH views read off the SAME `shown` count,
  // so a step revealed this tick lands in both pictures in the same frame
  // (design spec §16.13's lockstep).
  function render(): void {
    if (hierNodesLayer) {
      for (const mark of hierNodesLayer.querySelectorAll<HTMLElement>(".node-mark")) {
        const i = Number(mark.dataset.node);
        const idx = nodeStepIndex.get(i);
        mark.classList.toggle("touched-fwd", idx?.fwdIdx !== undefined && idx.fwdIdx < shown);
        mark.classList.toggle("touched-bwd", idx?.bwdIdx !== undefined && idx.bwdIdx < shown);
      }
    }
    for (const [i, btn] of mapNodeButtons) {
      const idx = nodeStepIndex.get(i);
      btn.classList.toggle("touched-fwd", idx?.fwdIdx !== undefined && idx.fwdIdx < shown);
      btn.classList.toggle("touched-bwd", idx?.bwdIdx !== undefined && idx.bwdIdx < shown);
    }
    for (const el of hierEdgesGroup?.querySelectorAll<SVGLineElement>(".climb-edge") ?? []) {
      const idx = Number(el.dataset.stepIdx);
      el.classList.toggle("revealed", idx < shown);
    }
    for (const [el, idx] of touchedFirstIdx) el.classList.toggle("touched", idx < shown);
    for (const [el, idx] of routeFirstIdx) el.classList.toggle("on-route", idx < shown);
    const metShown = shown > meetIndex();
    hierMeetEl?.classList.toggle("shown", metShown);
    mapMeetEl?.classList.toggle("shown", metShown);
    paintHierRoute(Math.max(0, Math.min(unpackTotal(), shown - meetIndex() - 1)));
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
    recomputeHierXY();
    applyMapNodeStates();
    rebuildStreetLookups();
    renderHier();
    positionMeets();
    shown = 0;
    render();
    playFromCurrent();
  }

  // Map node buttons are rebuilt never (positions are fixed); listeners are
  // wired once here via a single delegated handler on the layer.
  mapNodesLayer?.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>(".node-btn");
    if (!btn) return;
    const i = Number(btn.dataset.node);
    const { next, complete } = advancePick(pick, i);
    pick = next;
    for (const [j, b] of mapNodeButtons) {
      b.classList.toggle("pending-start", j === pick.start && pick.end === null);
    }
    if (complete) setPair(complete[0], complete[1]);
  });

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
  recomputeHierXY();
  applyMapNodeStates();
  rebuildStreetLookups();
  renderHier();
  positionMeets();
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
