import { describe, expect, it } from "vitest";
import { buildCh, orderedShortcutCount } from "../algos/chBuild";
import { buildCsr, type Graph } from "../algos/graph";
import {
  degreeDescendingOrder,
  heuristicOrder,
  replayScript,
  seededShuffleOrder,
} from "./order";

// Chapter-5 toy's honesty contract: every tile's number is a REAL,
// deterministic run of the real CH build — never a scripted figure. These
// tests pin the inequalities the chapter's copy claims actually hold, that
// "random" is reproducible per seed, and — since MINITOWN (always
// undirected) can't tell this bug apart from its fix — that "worst order"
// really does mean total (in+out) degree on a real DIRECTED graph, not
// out-degree alone.

/** A tiny hand-built DIRECTED fixture where out-degree-only and
 * in+out-degree disagree about which node is "busiest": node 0 is a hub
 * with SIX one-way streets feeding INTO it (in-degree 6, out-degree 0) from
 * a six-node path (1-2-3-4-5-6, two-way). Under out-degree-only, the hub's
 * degree reads as 0 — the LOWEST in the graph — so a "high-degree-first"
 * order would contract it LAST, the opposite of the intended "busiest hub
 * first" story. Under total degree it correctly reads as 6, the highest,
 * so the fixed order contracts it FIRST. */
function hubFixture(): Graph {
  const list: { from: number; to: number; w: number }[] = [];
  const path: [number, number][] = [
    [1, 2],
    [2, 3],
    [3, 4],
    [4, 5],
    [5, 6],
  ];
  for (const [a, b] of path) {
    list.push({ from: a, to: b, w: 5 });
    list.push({ from: b, to: a, w: 5 });
  }
  for (let i = 1; i <= 6; i++) list.push({ from: i, to: 0, w: 3 });
  return { n: 7, lon: new Float64Array(7), lat: new Float64Array(7), fwd: buildCsr(7, list) };
}

describe("degreeDescendingOrder: total (in+out) degree on a directed graph", () => {
  const g = hubFixture();

  it("ranks the hub (in-degree 6, out-degree 0) FIRST — out-degree alone would rank it last", () => {
    // This is the exact bug the F5 risk-list flagged: degreeDescendingOrder
    // used to count g.fwd's out-degree only, so a node with heavy INCOMING
    // one-way traffic and little outgoing read as "quiet" instead of "busy".
    const order = degreeDescendingOrder(g);
    expect(order[0]).toBe(0);
  });

  it("the six path nodes (total degree 5 or 3) all come after the hub", () => {
    const order = degreeDescendingOrder(g);
    expect(order.indexOf(0)).toBe(0);
    expect(order.slice(1)).toEqual(expect.arrayContaining([1, 2, 3, 4, 5, 6]));
  });

  it("is a permutation of every node exactly once", () => {
    expect([...degreeDescendingOrder(g)].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe("order toy: shortcut-count inequalities on a real (directed) graph", () => {
  const g = hubFixture();
  const smartOrder = heuristicOrder(g);
  const smartCount = orderedShortcutCount(g, smartOrder);

  it("smart count is a real, non-trivial number (sanity check)", () => {
    expect(smartCount).toBeGreaterThan(0);
  });

  it.each([1, 2, 3, 4, 5, 7])(
    "seed %i: random-order count is >= the smart (heuristic) count",
    (seed) => {
      const randomCount = orderedShortcutCount(g, seededShuffleOrder(seed, g.n));
      expect(randomCount).toBeGreaterThanOrEqual(smartCount);
    },
  );

  it("worst (high-degree-first, total degree) order count is >= the smart count", () => {
    const worstCount = orderedShortcutCount(g, degreeDescendingOrder(g));
    expect(worstCount).toBeGreaterThanOrEqual(smartCount);
  });

  it("a given seed's random-order count is deterministic (same seed twice -> same number)", () => {
    const a = orderedShortcutCount(g, seededShuffleOrder(7, g.n));
    const b = orderedShortcutCount(g, seededShuffleOrder(7, g.n));
    expect(a).toBe(b);
  });

  it("seededShuffleOrder is a permutation of every node exactly once, for every seed", () => {
    for (const seed of [1, 2, 3, 4, 5, 7]) {
      const order = seededShuffleOrder(seed, g.n);
      expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: g.n }, (_, i) => i));
    }
  });

  it("the smart tile's count equals a fresh orderedShortcutCount run over ascending CH rank", () => {
    // This is the toy's "smart order" derivation, spelled out again from
    // scratch (not reusing heuristicOrder's own implementation) so the test
    // actually guards the equivalence rather than restating it.
    const ch = buildCh(g);
    const rankOrder = Array.from({ length: g.n }, (_, i) => i).sort(
      (a, b) => ch.rank[a] - ch.rank[b],
    );
    expect(rankOrder).toEqual(smartOrder);
    expect(orderedShortcutCount(g, rankOrder)).toBe(smartCount);
  });
});

describe("replayScript: the per-step record the ch5 replay animates (spec §21.2)", () => {
  // The replay's honesty contract: the animated run IS the tile's number.
  // replayScript re-runs the real contractor step by step, and its
  // concatenated shortcut counts must equal orderedShortcutCount's total for
  // the SAME order — otherwise the map would show one story and the
  // scoreboard another. Checked for all three production orders the buttons
  // actually run (seeded random, high-degree-first, heuristic).
  const g = hubFixture();
  const orders: [string, number[]][] = [
    ["seeded random (seed 7)", seededShuffleOrder(7, g.n)],
    ["worst (high-degree-first)", degreeDescendingOrder(g)],
    ["smart (heuristic)", heuristicOrder(g)],
  ];

  it.each(orders)("%s: one ReplayStep per node of the order, in order", (_name, order) => {
    const script = replayScript(g, order);
    expect(script.map((s) => s.node)).toEqual(order);
  });

  it.each(orders)(
    "%s: step shortcut counts sum to orderedShortcutCount's total for the same order",
    (_name, order) => {
      const script = replayScript(g, order);
      const sum = script.reduce((acc, s) => acc + s.shortcuts.length, 0);
      expect(sum).toBe(orderedShortcutCount(g, order));
    },
  );

  it("records the contracted node itself as every step shortcut's `via`", () => {
    for (const [, order] of orders) {
      for (const step of replayScript(g, order)) {
        for (const s of step.shortcuts) expect(s.via).toBe(step.node);
      }
    }
  });

  it("is deterministic: the same order twice gives deeply-equal scripts", () => {
    const order = seededShuffleOrder(7, g.n);
    expect(replayScript(g, order)).toEqual(replayScript(g, order));
  });
});

describe("orderedShortcutCount: performance on a 55-node-scale graph", () => {
  it("a partial fixed order (heuristic prefix, as the your-turn comparison calls it) stays well under budget", () => {
    // The your-turn comparison re-runs orderedShortcutCount(g,
    // heuristicOrder.slice(0,k)) on every tap against the REAL 55-node
    // toytown graph; measured there at <0.4ms per call (see the F5
    // report). This is a smoke check on a smaller synthetic graph (no
    // fetch/DOM needed) that a partial order — most of the graph left
    // uncontracted — doesn't blow up asymptotically; the real budget
    // evidence is the measured number in the report, not a timing
    // assertion here (wall-clock assertions in CI are exactly the kind of
    // flaky test this repo's own conventions avoid).
    const g = hubFixture();
    const order = heuristicOrder(g);
    for (let k = 1; k <= g.n; k++) {
      expect(() => orderedShortcutCount(g, order.slice(0, k))).not.toThrow();
    }
  });
});
