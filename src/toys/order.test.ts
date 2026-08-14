import { describe, expect, it } from "vitest";
import { buildCh, orderedShortcutCount } from "../algos/chBuild";
import { MINITOWN } from "./minitown";
import { degreeDescendingOrder, heuristicOrder, seededShuffleOrder } from "./order";

// Chapter-3 toy's honesty contract: every tile's number is a REAL,
// deterministic run of the real CH build on the real mini-town — never a
// scripted figure. These tests pin the inequalities the chapter's copy
// claims actually hold on MINITOWN, and that "random" is reproducible per
// seed (a visitor who reloads sees the same "random" tile, not a new
// shuffle masquerading as the one they saw before).

describe("order toy: MINITOWN shortcut counts", () => {
  const g = MINITOWN.graph;
  const smartOrder = heuristicOrder(g);
  const smartCount = orderedShortcutCount(g, smartOrder);

  it("smart count is a real, non-trivial number (sanity check)", () => {
    expect(smartCount).toBeGreaterThan(0);
  });

  it.each([1, 2, 3, 4, 5])(
    "seed %i: random-order count is >= the smart (heuristic) count",
    (seed) => {
      const randomCount = orderedShortcutCount(g, seededShuffleOrder(seed, g.n));
      expect(randomCount).toBeGreaterThanOrEqual(smartCount);
    },
  );

  it("worst (high-degree-first) order count is >= the smart count", () => {
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
      expect([...order].sort((a, b) => a - b)).toEqual(
        Array.from({ length: g.n }, (_, i) => i),
      );
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
