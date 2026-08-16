// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { decodeToytown, type ToytownArtifact } from "./toytown";
import {
  advancePick,
  asArrowKey,
  contextPolylineMarkup,
  declutterXY,
  driftConnectorMarkup,
  driftConnectors,
  edgeClsOf,
  IDLE_PICK,
  isArterial,
  nextRovingIndex,
  physicalEdges,
  roadPolylineMarkup,
  svgPan,
  svgUserPoint,
  svgZoomAbout,
  unorderedKey,
  vbPercentXY,
  wireRovingNodeButtons,
} from "./toytownView";

// A tiny synthetic 3-node fixture, deliberately mixing a TWO-WAY pair
// (0<->1, different weights per direction — real one-ways can have
// asymmetric travel times, so the dedup must not assume symmetry) with a
// ONE-WAY-only pair (1->2, no reverse edge at all) — the exact shape
// contraction.ts's F4 review risk-list flagged: MINITOWN was always
// undirected, so a bug in this dedup would never show up against it. The
// two physical streets also deliberately differ in road class (0-1 local,
// 1-2 arterial — task G5) so the cls-passthrough/styling tests below have
// both cases to check.
const ARTIFACT: ToytownArtifact = {
  bbox: [149.1, -35.3, 149.11, -35.29],
  n: 3,
  lon: [0, 500, 1000],
  lat: [0, 0, 500],
  edges: [
    { from: 0, to: 1, w: 50, cls: 0, geometry: [[0, 0], [500, 0]] },
    { from: 1, to: 0, w: 60, cls: 0, geometry: [[500, 0], [0, 0]] },
    { from: 1, to: 2, w: 70, cls: 3, geometry: [[500, 0], [1000, 500]] },
  ],
};

describe("physicalEdges: collapses real directed edges to one line per street", () => {
  const t = decodeToytown(ARTIFACT);
  const edges = physicalEdges(t);

  it("returns exactly one entry per PHYSICAL street, not one per directed edge", () => {
    // 3 directed edges, 2 physical streets (0-1 two-way, 1-2 one-way).
    expect(edges).toHaveLength(2);
  });

  it("marks the two-way pair (both 0->1 and 1->0 exist) as NOT oneway", () => {
    const pair = edges.find((e) => (e.a === 0 && e.b === 1) || (e.a === 1 && e.b === 0));
    expect(pair).toBeTruthy();
    expect(pair?.oneway).toBe(false);
  });

  it("marks the one-way-only pair (1->2, no 2->1) as oneway — detected, not assumed", () => {
    const pair = edges.find((e) => (e.a === 1 && e.b === 2) || (e.a === 2 && e.b === 1));
    expect(pair).toBeTruthy();
    expect(pair?.oneway).toBe(true);
  });

  it("never fabricates a physical edge that has no directed edge backing it at all", () => {
    const keys = new Set(edges.map((e) => (e.a < e.b ? `${e.a}-${e.b}` : `${e.b}-${e.a}`)));
    expect(keys.has("0-2")).toBe(false);
  });

  it("every returned geometry is a real edge's geometry (non-empty point list)", () => {
    for (const e of edges) expect(e.geometry.length).toBeGreaterThanOrEqual(2);
  });

  it("carries through the physical street's cls (task G5)", () => {
    const local = edges.find((e) => (e.a === 0 && e.b === 1) || (e.a === 1 && e.b === 0));
    const arterial = edges.find((e) => (e.a === 1 && e.b === 2) || (e.a === 2 && e.b === 1));
    expect(local?.cls).toBe(0);
    expect(arterial?.cls).toBe(3);
  });
});

describe("roadPolylineMarkup", () => {
  const t = decodeToytown(ARTIFACT);
  const edges = physicalEdges(t);
  const markup = roadPolylineMarkup(edges);

  it("draws one <polyline> per physical edge", () => {
    expect(markup.match(/<polyline/g)).toHaveLength(edges.length);
  });

  it("tags the one-way street's line with edge-oneway, and the two-way street's without it", () => {
    const oneway = edges.find((e) => e.oneway);
    const twoway = edges.find((e) => !e.oneway);
    expect(markup).toContain(`data-a="${oneway?.a}" data-b="${oneway?.b}"`);
    // Slice out just the one-way line to check it carries the class...
    const onewayLine = markup
      .split("<polyline")
      .find((chunk) => chunk.includes(`data-a="${oneway?.a}" data-b="${oneway?.b}"`));
    expect(onewayLine).toContain("edge-oneway");
    // ...and the two-way line does not.
    const twowayLine = markup
      .split("<polyline")
      .find((chunk) => chunk.includes(`data-a="${twoway?.a}" data-b="${twoway?.b}"`));
    expect(twowayLine).not.toContain("edge-oneway");
  });

  it("tags the arterial street (cls 3) with edge-arterial, and the local street (cls 0) without it", () => {
    const arterial = edges.find((e) => e.cls === 3);
    const local = edges.find((e) => e.cls === 0);
    const arterialLine = markup
      .split("<polyline")
      .find((chunk) => chunk.includes(`data-a="${arterial?.a}" data-b="${arterial?.b}"`));
    expect(arterialLine).toContain("edge-arterial");
    const localLine = markup
      .split("<polyline")
      .find((chunk) => chunk.includes(`data-a="${local?.a}" data-b="${local?.b}"`));
    expect(localLine).not.toContain("edge-arterial");
  });
});

describe("isArterial: the cls>=2 arterial threshold (design spec §16.12/13)", () => {
  it("cls 0 (residential/unclassified) and 1 (tertiary) are locals, not arterial", () => {
    expect(isArterial(0)).toBe(false);
    expect(isArterial(1)).toBe(false);
  });

  it("cls 2 (secondary) and up are arterial", () => {
    expect(isArterial(2)).toBe(true);
    expect(isArterial(3)).toBe(true);
    expect(isArterial(4)).toBe(true);
  });
});

describe("edgeClsOf: looks up a single directed edge's cls by (u, v)", () => {
  const t = decodeToytown(ARTIFACT);

  it("finds the real cls for an existing directed edge", () => {
    expect(edgeClsOf(t, 0, 1)).toBe(0);
    expect(edgeClsOf(t, 1, 2)).toBe(3);
  });

  it("the two directions of a two-way street can carry independently-looked-up (here equal) cls", () => {
    expect(edgeClsOf(t, 1, 0)).toBe(0);
  });

  it("returns -1 for a pair with no direct edge at all", () => {
    expect(edgeClsOf(t, 0, 2)).toBe(-1);
    expect(edgeClsOf(t, 2, 1)).toBe(-1); // 1->2 exists, but toytown's edge is one-way: no 2->1
  });
});

describe("unorderedKey: the a<->b lookup key shared by contraction's witness-flash and climb's touched-street highlighting", () => {
  it("is the same key regardless of argument order", () => {
    expect(unorderedKey(3, 9)).toBe(unorderedKey(9, 3));
  });

  it("distinguishes different pairs", () => {
    expect(unorderedKey(1, 2)).not.toBe(unorderedKey(1, 3));
  });
});

describe("advancePick: the three-click endpoint re-pick cycle", () => {
  it("first click on idle state sets it as the pending start, nothing completes", () => {
    const r = advancePick(IDLE_PICK, 5);
    expect(r).toEqual({ next: { start: 5, end: null }, complete: null });
  });

  it("clicking the pending start again is a no-op (can't query a node against itself)", () => {
    const r = advancePick({ start: 5, end: null }, 5);
    expect(r).toEqual({ next: { start: 5, end: null }, complete: null });
  });

  it("second click (a different node) sets the end AND fires complete", () => {
    const r = advancePick({ start: 5, end: null }, 9);
    expect(r).toEqual({ next: { start: 5, end: 9 }, complete: [5, 9] });
  });

  it("third click (state already complete) resets AND becomes the new start — not a dead click", () => {
    const r = advancePick({ start: 5, end: 9 }, 3);
    expect(r).toEqual({ next: { start: 3, end: null }, complete: null });
  });

  it("the cycle repeats indefinitely: start, end+complete, reset+start, end+complete, ...", () => {
    let state = IDLE_PICK;
    let step = advancePick(state, 1);
    state = step.next;
    expect(step.complete).toBeNull();
    step = advancePick(state, 2);
    state = step.next;
    expect(step.complete).toEqual([1, 2]);
    step = advancePick(state, 3);
    state = step.next;
    expect(step.complete).toBeNull();
    expect(state).toEqual({ start: 3, end: null });
    step = advancePick(state, 4);
    expect(step.complete).toEqual([3, 4]);
  });
});

describe("declutterXY: nudges near-coincident points apart", () => {
  function minPairDist(pts: [number, number][]): number {
    let min = Infinity;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        min = Math.min(min, Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]));
      }
    }
    return min;
  }

  it("leaves points that are already far enough apart untouched", () => {
    const pts: [number, number][] = [
      [0, 0],
      [100, 0],
      [0, 100],
    ];
    expect(declutterXY(pts, 24)).toEqual(pts);
  });

  it("separates two points 1.7px apart (the real toytown case found live) to at least minDist", () => {
    const pts: [number, number][] = [
      [200, 200],
      [201.7, 200],
    ];
    const out = declutterXY(pts, 24);
    expect(Math.hypot(out[0][0] - out[1][0], out[0][1] - out[1][1])).toBeGreaterThanOrEqual(
      24 - 0.01,
    );
  });

  it("separates two EXACTLY coincident points deterministically (same input, same output every call)", () => {
    const pts: [number, number][] = [
      [50, 50],
      [50, 50],
    ];
    const a = declutterXY(pts, 24);
    const b = declutterXY(pts, 24);
    expect(a).toEqual(b);
    expect(Math.hypot(a[0][0] - a[1][0], a[0][1] - a[1][1])).toBeGreaterThanOrEqual(24 - 0.01);
  });

  it("resolves a dense cluster of 20 near-identical points to all pairwise >= minDist apart", () => {
    const pts: [number, number][] = Array.from({ length: 20 }, (_, i) => [
      100 + (i % 5) * 0.3,
      100 + Math.floor(i / 5) * 0.3,
    ]);
    const out = declutterXY(pts, 24);
    expect(minPairDist(out)).toBeGreaterThanOrEqual(24 - 0.05);
  });

  it("preserves the point count and never introduces NaN/Infinity", () => {
    const pts: [number, number][] = [
      [0, 0],
      [0, 0],
      [5, 5],
      [200, 5],
    ];
    const out = declutterXY(pts, 24);
    expect(out).toHaveLength(pts.length);
    for (const [x, y] of out) {
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    }
  });

  it("does not mutate the input array", () => {
    const pts: [number, number][] = [
      [10, 10],
      [10.5, 10],
    ];
    const original = pts.map((p) => [...p]);
    declutterXY(pts, 24);
    expect(pts).toEqual(original);
  });

  describe("with bounds: a dense cluster near an edge can't escape the viewBox", () => {
    it("keeps every point inside [minX,minY,maxX,maxY] even under heavy repulsion pressure", () => {
      // 10 points crammed into the bottom-right corner of a 460x300 box —
      // exactly the shape that pushed real flood-toy buttons below the
      // stage into the controls underneath it (see the F5 report).
      const pts: [number, number][] = Array.from({ length: 10 }, (_, i) => [
        455 + (i % 3) * 0.5,
        295 + Math.floor(i / 3) * 0.5,
      ]);
      const out = declutterXY(pts, 35, 60, [0, 0, 460, 300]);
      for (const [x, y] of out) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(460);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(300);
      }
    });

    it("without bounds, the same cramped-corner cluster DOES escape the box (regression guard for the bug itself)", () => {
      const pts: [number, number][] = Array.from({ length: 10 }, (_, i) => [
        455 + (i % 3) * 0.5,
        295 + Math.floor(i / 3) * 0.5,
      ]);
      const out = declutterXY(pts, 35, 60);
      const anyOutside = out.some(([x, y]) => x < 0 || x > 460 || y < 0 || y > 300);
      expect(anyOutside).toBe(true);
    });

    it("a point starting outside the given bounds is pulled back in immediately", () => {
      const pts: [number, number][] = [
        [-50, 500],
        [200, 150],
      ];
      const out = declutterXY(pts, 24, 60, [0, 0, 460, 300]);
      expect(out[0][0]).toBeGreaterThanOrEqual(0);
      expect(out[0][1]).toBeLessThanOrEqual(300);
    });
  });
});

// ---------------------------------------------------------------------
// H3 (refine round, design spec §17.5/.6): the context layer, drift
// connectors, and the hierarchy panel's SVG viewBox zoom.
// ---------------------------------------------------------------------

describe("contextPolylineMarkup: the faint §17.5 context layer", () => {
  it('draws one <polyline class="context-line"> per context polyline, with points but no data-a/data-b', () => {
    const artifact: ToytownArtifact = {
      ...ARTIFACT,
      context: [
        [
          [100, 100],
          [200, 200],
        ],
        [
          [300, 100],
          [400, 100],
          [400, 200],
        ],
      ],
    };
    const t = decodeToytown(artifact);
    const markup = contextPolylineMarkup(t);
    expect(markup.match(/<polyline/g)).toHaveLength(2);
    expect(markup).toContain('class="context-line"');
    expect(markup).not.toContain("data-a");
  });

  it("draws nothing when the artifact has no context field at all (older/hand-built artifacts)", () => {
    const t = decodeToytown(ARTIFACT); // ARTIFACT (this file's shared fixture) has no `context`
    expect(contextPolylineMarkup(t)).toBe("");
  });
});

describe("driftConnectors: which nodes' decluttered button drifted past the threshold (§17.5 delta 3)", () => {
  it("flags a node whose shown position is more than the threshold away from its true position", () => {
    const trueXY: [number, number][] = [[100, 100]];
    const shownXY: [number, number][] = [[110, 100]]; // 10 units away
    expect(driftConnectors(trueXY, shownXY, 6)).toEqual([{ truePos: [100, 100], shownPos: [110, 100] }]);
  });

  it("does not flag a node within the threshold", () => {
    const trueXY: [number, number][] = [[100, 100]];
    const shownXY: [number, number][] = [[103, 100]]; // 3 units away
    expect(driftConnectors(trueXY, shownXY, 6)).toEqual([]);
  });

  it("preserves per-node correspondence, skipping only the untouched nodes", () => {
    const trueXY: [number, number][] = [
      [0, 0],
      [50, 50],
      [100, 100],
    ];
    const shownXY: [number, number][] = [
      [0, 0],
      [50, 60], // only this one moved (10 units)
      [100, 100],
    ];
    expect(driftConnectors(trueXY, shownXY, 6)).toEqual([{ truePos: [50, 50], shownPos: [50, 60] }]);
  });

  // H5 gate fix: default threshold raised 6 -> 8 to thin the congested-hub
  // starburst (see the function's own comment) — pinned here with NO third
  // argument so a future accidental revert back to 6 fails this test rather
  // than only showing up as a by-eye regression.
  it("defaults its threshold to 8 (H5 gate fix, raised from 6) when no threshold argument is passed", () => {
    const trueXY: [number, number][] = [[0, 0]];
    expect(driftConnectors(trueXY, [[7, 0]])).toEqual([]); // 7 units: under the new default, no connector
    expect(driftConnectors(trueXY, [[9, 0]])).toEqual([{ truePos: [0, 0], shownPos: [9, 0] }]); // 9 units: over it
  });
});

describe("driftConnectorMarkup", () => {
  it("draws one <line> per connector, from the true position to the shown position", () => {
    const markup = driftConnectorMarkup([{ truePos: [1, 2], shownPos: [3, 4] }]);
    expect(markup).toContain('x1="1" y1="2" x2="3" y2="4"');
    expect(markup.match(/<line/g)).toHaveLength(1);
  });

  it("draws nothing for an empty connector list", () => {
    expect(driftConnectorMarkup([])).toBe("");
  });
});

describe("svgZoomAbout: anchor-preserving SVG viewBox zoom (design spec §17.6)", () => {
  const BASE = { x: 0, y: 0, w: 460, h: 300 };

  it("zooming in shrinks the viewBox (narrower w/h reads as MORE zoomed in)", () => {
    const out = svgZoomAbout(BASE, 2, 230, 150, 460, 300);
    expect(out.w).toBeCloseTo(230, 5);
    expect(out.h).toBeCloseTo(150, 5);
  });

  it("keeps the anchor point at the SAME fractional position within the viewBox after zooming", () => {
    const px = 100;
    const py = 80;
    const beforeFracX = (px - BASE.x) / BASE.w;
    const beforeFracY = (py - BASE.y) / BASE.h;
    const after = svgZoomAbout(BASE, 3, px, py, 460, 300);
    expect((px - after.x) / after.w).toBeCloseTo(beforeFracX, 6);
    expect((py - after.y) / after.h).toBeCloseTo(beforeFracY, 6);
  });

  it("clamps the zoom level at 6x: repeated zoom-in stops shrinking the viewBox further", () => {
    let vb = BASE;
    for (let i = 0; i < 20; i++) vb = svgZoomAbout(vb, 2, 230, 150, 460, 300);
    expect(vb.w).toBeCloseTo(460 / 6, 5);
    expect(vb.h).toBeCloseTo(300 / 6, 5);
  });

  it("clamps the zoom level at 1x: zooming out never grows the viewBox past the base extent", () => {
    const zoomedIn = svgZoomAbout(BASE, 3, 230, 150, 460, 300);
    const out = svgZoomAbout(zoomedIn, 0.01, 230, 150, 460, 300);
    expect(out.w).toBeCloseTo(460, 5);
    expect(out.h).toBeCloseTo(300, 5);
    expect(out.x).toBeCloseTo(0, 5);
    expect(out.y).toBeCloseTo(0, 5);
  });

  it("clamps pan so the viewBox never drifts outside [0,w0] x [0,h0], even zoomed hard at a corner", () => {
    const out = svgZoomAbout(BASE, 6, 0, 0, 460, 300);
    expect(out.x).toBeGreaterThanOrEqual(0);
    expect(out.y).toBeGreaterThanOrEqual(0);
    expect(out.x + out.w).toBeLessThanOrEqual(460 + 1e-6);
    expect(out.y + out.h).toBeLessThanOrEqual(300 + 1e-6);
  });

  it("leaves vb unchanged when the base extent is degenerate (w0 or h0 <= 0)", () => {
    expect(svgZoomAbout(BASE, 2, 100, 100, 0, 300)).toEqual(BASE);
    expect(svgZoomAbout(BASE, 2, 100, 100, 460, 0)).toEqual(BASE);
  });
});

describe("svgPan", () => {
  it("shifts the viewBox by (dx, dy)", () => {
    const vb = { x: 10, y: 10, w: 100, h: 100 };
    expect(svgPan(vb, 5, -3, 460, 300)).toEqual({ x: 15, y: 7, w: 100, h: 100 });
  });

  it("clamps so the viewBox never drifts outside [0,w0] x [0,h0]", () => {
    const vb = { x: 0, y: 0, w: 100, h: 100 };
    const out = svgPan(vb, -50, 1000, 460, 300);
    expect(out.x).toBe(0); // can't go below 0
    expect(out.y).toBe(200); // clamped to h0 - h = 300 - 100
  });
});

describe('svgUserPoint: screen px -> viewBox user-space (inverse of preserveAspectRatio="none")', () => {
  it("maps the box's top-left/bottom-right corners to the viewBox's own corners", () => {
    const vb = { x: 0, y: 0, w: 460, h: 300 };
    expect(svgUserPoint(vb, 920, 600, 0, 0)).toEqual([0, 0]);
    expect(svgUserPoint(vb, 920, 600, 920, 600)).toEqual([460, 300]);
  });

  it('scales each axis independently, matching preserveAspectRatio="none" (not a shared uniform scale)', () => {
    // The hierarchy panel rendered at 460 wide x 440 tall (task H3's own
    // taller stage) — x and y must each divide by their OWN box dimension.
    const vb = { x: 0, y: 0, w: 460, h: 300 };
    const [x, y] = svgUserPoint(vb, 460, 440, 230, 220);
    expect(x).toBeCloseTo(230, 5); // half of 460px wide -> half of 460 viewBox units
    expect(y).toBeCloseTo(150, 5); // half of 440px tall -> half of 300 viewBox units, NOT half of 440
  });

  it("offsets by the current viewBox's own x/y when already zoomed/panned", () => {
    const vb = { x: 50, y: 20, w: 100, h: 100 };
    expect(svgUserPoint(vb, 100, 100, 0, 0)).toEqual([50, 20]);
  });
});

describe("wheel handler preventDefault (build/refine-round fix — hierarchy zoom must not scroll the page)", () => {
  it("a wheel handler registered with { passive: false } calls preventDefault to block page scroll", () => {
    const element = document.createElement("div");
    let preventDefaultCalled = false;

    // Register a wheel handler matching the pattern in climbLinked.ts with { passive: false }
    element.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        preventDefaultCalled = true;
      },
      { passive: false },
    );

    // Create and dispatch a cancelable synthetic WheelEvent
    const wheelEvent = new WheelEvent("wheel", { cancelable: true });
    element.dispatchEvent(wheelEvent);

    expect(preventDefaultCalled).toBe(true);
    expect(wheelEvent.defaultPrevented).toBe(true);
  });
});

describe("vbPercentXY: viewBox user-space -> left/top percentage (H5 gate fix — the hierarchy right-edge clip)", () => {
  const BASE = { x: 0, y: 0, w: 460, h: 300 };

  it("with no inset, maps the viewBox's own corners to exactly 0%/100% (the pre-fix behavior)", () => {
    expect(vbPercentXY(BASE, 0, 0)).toEqual([0, 0]);
    expect(vbPercentXY(BASE, 460, 300)).toEqual([100, 100]);
  });

  it("with no inset, the centre still lands at 50%/50%", () => {
    expect(vbPercentXY(BASE, 230, 150)).toEqual([50, 50]);
  });

  it("with a non-zero inset, the viewBox's own corners land INSIDE [0,100] instead of exactly at the edge — the fix itself", () => {
    const [left, top] = vbPercentXY(BASE, 460, 300, 4);
    expect(left).toBeCloseTo(96, 5); // 100 - insetPct, not 100
    expect(top).toBeCloseTo(96, 5);
    const [left0, top0] = vbPercentXY(BASE, 0, 0, 4);
    expect(left0).toBeCloseTo(4, 5); // insetPct, not 0
    expect(top0).toBeCloseTo(4, 5);
  });

  it("a non-zero inset still leaves the centre point at exactly 50%/50% (only the extremes move)", () => {
    expect(vbPercentXY(BASE, 230, 150, 4)).toEqual([50, 50]);
  });

  it("offsets by the current viewBox's own x/y when already zoomed/panned, same as svgUserPoint's inverse", () => {
    const vb = { x: 50, y: 20, w: 100, h: 100 };
    expect(vbPercentXY(vb, 50, 20)).toEqual([0, 0]);
    expect(vbPercentXY(vb, 150, 120)).toEqual([100, 100]);
  });
});

describe("asArrowKey: event.key -> ArrowKey guard (I3 gate — roving tabindex)", () => {
  it("recognizes all four arrow keys", () => {
    expect(asArrowKey("ArrowUp")).toBe("ArrowUp");
    expect(asArrowKey("ArrowDown")).toBe("ArrowDown");
    expect(asArrowKey("ArrowLeft")).toBe("ArrowLeft");
    expect(asArrowKey("ArrowRight")).toBe("ArrowRight");
  });

  it("returns null for every other key, including ones a node-btn grid also sees (Enter/Space/Tab)", () => {
    expect(asArrowKey("Enter")).toBeNull();
    expect(asArrowKey(" ")).toBeNull();
    expect(asArrowKey("Tab")).toBeNull();
    expect(asArrowKey("a")).toBeNull();
    expect(asArrowKey("")).toBeNull();
  });
});

describe("nextRovingIndex: pure next-index math for arrow-key grid navigation (I3 gate — /how/ flood toy + climbLinked map roving tabindex)", () => {
  // A small "plus" layout plus a couple of extra points for the trickier
  // cases below. Index order deliberately does NOT match any spatial
  // order, since real toytown node ids never do either.
  const CENTER = 0; // [0, 0]
  const RIGHT = 1; // [10, 0]
  const LEFT = 2; // [-10, 0]
  const UP = 3; // [0, -10]
  const DOWN = 4; // [0, 10]
  const FAR_RIGHT = 5; // [30, 0] -- farther right than RIGHT
  const DIAGONAL = 6; // [10, 10] -- exactly 45 degrees off center
  const PLUS: [number, number][] = [
    [0, 0], // CENTER
    [10, 0], // RIGHT
    [-10, 0], // LEFT
    [0, -10], // UP
    [0, 10], // DOWN
    [30, 0], // FAR_RIGHT
    [10, 10], // DIAGONAL
  ];

  it("moves to the nearest point in each of the four directions from the center", () => {
    expect(nextRovingIndex(PLUS, CENTER, "ArrowRight")).toBe(RIGHT);
    expect(nextRovingIndex(PLUS, CENTER, "ArrowLeft")).toBe(LEFT);
    expect(nextRovingIndex(PLUS, CENTER, "ArrowUp")).toBe(UP);
    expect(nextRovingIndex(PLUS, CENTER, "ArrowDown")).toBe(DOWN);
  });

  it("prefers the NEARER of two candidates in the same direction", () => {
    // From CENTER, both RIGHT and FAR_RIGHT lie to the right; RIGHT (dist
    // 10) must win over FAR_RIGHT (dist 30).
    expect(nextRovingIndex(PLUS, CENTER, "ArrowRight")).toBe(RIGHT);
  });

  it("keeps moving further along the same direction once already at the nearer candidate", () => {
    // From RIGHT, only FAR_RIGHT still lies further right (CENTER is now
    // to the LEFT of RIGHT).
    expect(nextRovingIndex(PLUS, RIGHT, "ArrowRight")).toBe(FAR_RIGHT);
  });

  it("stays put (returns current unchanged) when nothing lies further in that direction", () => {
    // FAR_RIGHT is the rightmost point on this layout — no wrap-around.
    expect(nextRovingIndex(PLUS, FAR_RIGHT, "ArrowRight")).toBe(FAR_RIGHT);
  });

  it("a point exactly on the 45-degree diagonal is claimed by NEITHER of its two adjacent directions", () => {
    // DIAGONAL is [10, 10] from CENTER: |dx| === |dy|, so it satisfies
    // neither ArrowRight's nor ArrowDown's strict "more along that axis"
    // test — RIGHT/DOWN (both closer AND unambiguous) win instead.
    expect(nextRovingIndex(PLUS, CENTER, "ArrowRight")).not.toBe(DIAGONAL);
    expect(nextRovingIndex(PLUS, CENTER, "ArrowDown")).not.toBe(DIAGONAL);
    expect(nextRovingIndex(PLUS, CENTER, "ArrowRight")).toBe(RIGHT);
    expect(nextRovingIndex(PLUS, CENTER, "ArrowDown")).toBe(DOWN);
  });

  it("breaks an exact distance tie by keeping the first candidate found (deterministic, not iteration-order-sensitive by accident)", () => {
    const tie: [number, number][] = [
      [0, 0], // current
      [10, 1], // candidate A -- dist sqrt(101)
      [10, -1], // candidate B -- dist sqrt(101), exactly tied with A
    ];
    expect(nextRovingIndex(tie, 0, "ArrowRight")).toBe(1);
  });

  it("is defensive against an out-of-range current index (returns it unchanged rather than throwing)", () => {
    expect(nextRovingIndex(PLUS, -1, "ArrowRight")).toBe(-1);
    expect(nextRovingIndex(PLUS, 99, "ArrowRight")).toBe(99);
  });

  it("a single-point grid never moves (no other point to move to, in any direction)", () => {
    const solo: [number, number][] = [[0, 0]];
    expect(nextRovingIndex(solo, 0, "ArrowRight")).toBe(0);
    expect(nextRovingIndex(solo, 0, "ArrowUp")).toBe(0);
  });
});

describe("wireRovingNodeButtons: DOM wiring around nextRovingIndex (I3 gate)", () => {
  // @vitest-environment for this file is jsdom (see file header), so real
  // .focus()/tabIndex/dispatchEvent behavior is available here, unlike
  // home.test.ts's deliberately separate-realm fixtures.
  function buildGrid(positions: [number, number][]): { container: HTMLElement; buttons: HTMLButtonElement[] } {
    const container = document.createElement("div");
    const buttons = positions.map((_, i) => {
      const btn = document.createElement("button");
      btn.className = "node-btn";
      btn.dataset.node = String(i);
      container.appendChild(btn);
      return btn;
    });
    document.body.appendChild(container);
    return { container, buttons };
  }

  const PLUS: [number, number][] = [
    [0, 0], // 0
    [10, 0], // 1: right
    [-10, 0], // 2: left
  ];

  it("starts with exactly ONE button tabbable (index 0) and every other at tabIndex -1", () => {
    const { buttons } = buildGrid(PLUS);
    wireRovingNodeButtons(document.body, buttons, PLUS);
    expect(buttons[0].tabIndex).toBe(0);
    expect(buttons[1].tabIndex).toBe(-1);
    expect(buttons[2].tabIndex).toBe(-1);
  });

  it("an arrow key on the focused button moves both DOM focus and the roving tabIndex to the next button", () => {
    const { container, buttons } = buildGrid(PLUS);
    wireRovingNodeButtons(container, buttons, PLUS);
    buttons[0].focus();
    expect(document.activeElement).toBe(buttons[0]);

    const evt = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
    buttons[0].dispatchEvent(evt);

    expect(document.activeElement).toBe(buttons[1]); // moved to the "right" button
    expect(buttons[1].tabIndex).toBe(0);
    expect(buttons[0].tabIndex).toBe(-1);
    expect(evt.defaultPrevented).toBe(true); // arrow keys must not also scroll the page
  });

  it("a mouse click (focus without a keypress) re-anchors the roving tabIndex to the clicked button too", () => {
    const { container, buttons } = buildGrid(PLUS);
    wireRovingNodeButtons(container, buttons, PLUS);
    buttons[2].focus(); // simulates the focus a real click also produces
    expect(buttons[2].tabIndex).toBe(0);
    expect(buttons[0].tabIndex).toBe(-1);
  });

  it("a non-arrow key (e.g. Enter) is left alone — no preventDefault, no focus move — since the button's own native click handles it", () => {
    const { container, buttons } = buildGrid(PLUS);
    wireRovingNodeButtons(container, buttons, PLUS);
    buttons[0].focus();
    const evt = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    buttons[0].dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(buttons[0]);
  });

  it("no-ops safely on an empty grid", () => {
    const container = document.createElement("div");
    expect(() => wireRovingNodeButtons(container, [], [])).not.toThrow();
  });
});
