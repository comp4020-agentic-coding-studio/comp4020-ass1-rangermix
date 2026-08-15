// Shared, pure, tested helpers every toytown-based /how/ toy (flood,
// contraction, order; climb reuses only the (a,b,oneway) shape, not the
// geometry) draws on top of. F5 replaced the hand-made, always-undirected
// 12-node mini-town with a real ANU-area subgraph (src/toys/toytown.ts) —
// this module holds the two pieces of toy logic that are both genuinely
// shared AND correctness-sensitive enough to be worth pinning with tests
// once, instead of risking four slightly-different reimplementations:
//
//  - physicalEdges: collapsing the graph's real DIRECTED edges into one
//    entry per physical street for the base-road illustration. Toytown is
//    36% one-way (no reverse counterpart) — a naive per-CSR-slot draw would
//    render every two-way street TWICE (once per direction, same curve
//    stacked on itself); this collapses that back to one line per street
//    while never fabricating a reverse direction that isn't really there
//    (see the risk this replaces: src/toys/contraction.ts used to
//    symmetrize MINITOWN's edge list by hand, which was only safe because
//    MINITOWN itself was built undirected).
//  - declutterXY: nudges near-coincident node positions apart before they
//    become button centers (see its own doc comment — live verification
//    found real pairs of toytown intersections under 2px apart on screen,
//    which no amount of hit-circle padding fixes).
//  - advancePick: the three-click endpoint re-pick cycle flood and climb
//    both offer ("first=start, second=end, third=resets" — see design spec
//    §14.10 chapters 1 and 3). Pure reducer over a tiny two-field state, so
//    the exact cycle behavior (including the "third click IS the next
//    first click" reading, not a dead reset requiring a fourth click) is
//    pinned once rather than re-derived by eye in two DOM-wiring files.

import type { Toytown } from "./toytown";

export interface PhysicalEdge {
  a: number;
  b: number;
  geometry: [number, number][];
  oneway: boolean;
}

/** Every real directed edge in `t.graph`, collapsed to ONE entry per
 * physical street (unordered node pair) — a real road is one line
 * regardless of how many travel directions it supports. `oneway` is true
 * iff only ONE of the two directions actually exists in the graph; it is
 * DETECTED from the real CSR, never assumed or fabricated. When both
 * directions exist, the first-encountered direction's geometry is used —
 * they trace the same physical curve (just point-order-reversed), so which
 * one "wins" never changes what gets drawn. */
export function physicalEdges(t: Toytown): PhysicalEdge[] {
  const { graph, edgeGeometry } = t;
  const present = new Set<string>();
  for (let u = 0; u < graph.n; u++) {
    for (let s = graph.fwd.firstOut[u]; s < graph.fwd.firstOut[u + 1]; s++) {
      present.add(`${u}>${graph.fwd.head[s]}`);
    }
  }
  const seen = new Map<string, PhysicalEdge>();
  for (let u = 0; u < graph.n; u++) {
    for (let s = graph.fwd.firstOut[u]; s < graph.fwd.firstOut[u + 1]; s++) {
      const v = graph.fwd.head[s];
      const key = u < v ? `${u}-${v}` : `${v}-${u}`;
      if (seen.has(key)) continue;
      const oneway = !present.has(`${v}>${u}`);
      seen.set(key, { a: u, b: v, geometry: edgeGeometry[graph.fwd.edge[s]], oneway });
    }
  }
  return [...seen.values()];
}

/** SVG `<polyline>` markup for every physical edge — real street geometry,
 * one line per road, one-ways carrying `.edge-oneway` (a dash treatment in
 * CSS; see styles.css) instead of a fabricated second line. Shared by every
 * toytown toy that shows the road network as its backdrop (flood,
 * contraction, order); climb draws its OWN straight rank-lifted lines
 * instead (see climb.ts — the whole point of that diagram is that its
 * y-axis is rank, not geography, so real street curves there would imply a
 * geographic meaning the picture doesn't have). */
export function roadPolylineMarkup(edges: PhysicalEdge[]): string {
  return edges
    .map((e) => {
      const cls = e.oneway ? "edge-line edge-oneway" : "edge-line";
      const points = e.geometry.map(([x, y]) => `${x},${y}`).join(" ");
      return `<polyline class="${cls}" data-a="${e.a}" data-b="${e.b}" points="${points}" />`;
    })
    .join("");
}

/** Nudges points closer together than `minDist` apart, via a simple
 * iterative pairwise-repulsion pass (each too-close pair splits the
 * shortfall, moving half the deficit each, along their connecting vector;
 * repeats until stable or `iterations` runs out). Toytown's real
 * intersection layout can put two graph nodes within a couple of SCREEN
 * PIXELS of each other — a short turn lane, or a junction OSM represents
 * as several nearby nodes — which no amount of hit-circle padding fixes if
 * the button CENTERS themselves are effectively on top of each other
 * (found live: 111 of the real toytown layout's 1,485 node pairs sit under
 * 24px apart on screen, closest pair 1.7px — see the F5 report). This
 * declutters BUTTON positions only; callers keep drawing edges/shortcuts
 * from the TRUE `xy` — this is a labeled-marker layout trick (the same
 * idea map UIs
 * use to "explode" overlapping pins), not a claim about where the
 * intersection really is. Coincident points (`dist` effectively 0) push
 * apart along a direction derived deterministically from their own
 * indices, so the result is reproducible rather than dependent on
 * floating-point noise from an exactly-zero vector. */
/** The declutter floor every toy uses for its node buttons, in VIEWBOX
 * units (not screen px — see declutterXY's own doc comment: it operates in
 * whatever coordinate space `xy` is already in, here toytown's 460x300
 * viewBox). `.node-btn`'s hit circle is 24px, but `.toy-stage` doesn't
 * always render at its full 460px `max-width`: at the 390px phone
 * viewport it renders ~324px wide (measured — `.how-layout`'s and `.toy`'s
 * mobile padding eat the rest), so 1 viewBox unit there is only
 * ~324/460 ≈ 0.70 screen px. 24 viewBox units of separation would only be
 * ~17 SCREEN px apart at that width — comfortably UNDER the hit circle,
 * putting buttons right back to overlapping (found live, verified with
 * agent-browser against the real 390px layout — see the F5 report). 35
 * viewBox units guarantees >=24 screen px even at that narrowest
 * SUPPORTED width (24 * 460/324 ≈ 34.1, rounded up with a small margin);
 * on the 1920px desktop viewport, where the stage renders at its full
 * 460px (scale 1), the same 35 units just means marginally more breathing
 * room than the 24px floor requires — never a problem, only ever a
 * (harmless) surplus. */
export const MIN_NODE_DIST = 35;

/** [minX, minY, maxX, maxY] — a box to keep every declutterXY'd point
 * inside. */
export type Bounds = [number, number, number, number];

function clampToBounds(p: [number, number], bounds: Bounds): void {
  p[0] = Math.min(bounds[2], Math.max(bounds[0], p[0]));
  p[1] = Math.min(bounds[3], Math.max(bounds[1], p[1]));
}

export function declutterXY(
  xy: [number, number][],
  minDist: number,
  iterations = 60,
  bounds?: Bounds,
): [number, number][] {
  const pts: [number, number][] = xy.map(([x, y]) => [x, y]);
  // Points already outside the viewBox (shouldn't happen for real toytown
  // data, but a caller could pass anything) are pulled back in before the
  // repulsion pass starts, so the loop below never has to reason about a
  // starting position it can't push apart from cleanly.
  if (bounds) for (const p of pts) clampToBounds(p, bounds);
  for (let iter = 0; iter < iterations; iter++) {
    let moved = false;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        let dx = pts[j][0] - pts[i][0];
        let dy = pts[j][1] - pts[i][1];
        let dist = Math.hypot(dx, dy);
        if (dist >= minDist) continue;
        moved = true;
        if (dist < 1e-6) {
          const angle = ((i * 47 + j * 97) % 360) * (Math.PI / 180);
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          dist = 1;
        }
        const push = (minDist - dist) / 2;
        const ux = dx / dist;
        const uy = dy / dist;
        pts[i][0] -= ux * push;
        pts[i][1] -= uy * push;
        pts[j][0] += ux * push;
        pts[j][1] += uy * push;
        // A dense cluster near an edge/corner of the viewBox has nowhere
        // to push OUTWARD into without leaving it — found live: without
        // this, repulsion happily shoved node buttons below the visible
        // stage, overlapping the toy's own controls underneath it (see the
        // F5 report). Clamping immediately (not just once at the end)
        // keeps every later iteration reasoning about in-bounds positions,
        // same as the up-front clamp above.
        if (bounds) {
          clampToBounds(pts[i], bounds);
          clampToBounds(pts[j], bounds);
        }
      }
    }
    if (!moved) break;
  }
  return pts;
}

export interface PickState {
  start: number | null;
  end: number | null;
}

export const IDLE_PICK: PickState = { start: null, end: null };

export interface PickAdvance {
  next: PickState;
  /** Non-null exactly on the click that completes a pair — the caller's
   * cue to re-run the toy against [start, end]. */
  complete: [number, number] | null;
}

/** One click's worth of the endpoint re-pick cycle (design spec §14.10:
 * "visitor picks new endpoints by clicking two nodes — first=start,
 * second=end, third=resets"). The third click is read as "resets AND is
 * simultaneously the next first" (its own new `start`) rather than a dead
 * click that only clears — that's what makes the cycle repeat forever with
 * no wasted taps: 1st picks start, 2nd picks end + fires `complete`, 3rd
 * resets + picks the new start, 4th picks its end + fires `complete`, ...
 * Clicking the pending start again (before an end is chosen) is a no-op —
 * you can't query a node against itself. */
export function advancePick(state: PickState, node: number): PickAdvance {
  if (state.start === null) {
    return { next: { start: node, end: null }, complete: null };
  }
  if (state.end === null) {
    if (node === state.start) return { next: state, complete: null };
    return { next: { start: state.start, end: node }, complete: [state.start, node] };
  }
  return { next: { start: node, end: null }, complete: null };
}
