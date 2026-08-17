// @vitest-environment jsdom
// Chapter 4's narrated contraction (spec §21.1): the pure verdict/narration
// layer of the phase machine. Every string here is a spec contract — the
// narration lines are pinned CHARACTER-FOR-CHARACTER (middle dots, arrows,
// the ≤) because the live page shows exactly these, filled with the
// contractor's real measured seconds.
import { describe, expect, it } from "vitest";
import { DEAD_END_NARRATION, pairVerdict, phaseNarration } from "./contraction";

describe("pairVerdict: one ordered pair's witness-vs-shortcut decision (spec §21.1)", () => {
  it("witness when the detour is strictly faster than through", () => {
    const v = pairVerdict(3, 7, 5, 40, { dist: 30, path: [3, 9, 7] });
    expect(v.witness).toBe(true);
    expect(v.throughS).toBe(40);
    expect(v.detourS).toBe(30);
    expect(v.detourPath).toEqual([3, 9, 7]);
    expect(v.narration).toBe("through: 40s · detour found: 30s ≤ 40s → free pass (witness)");
  });

  it("witness AT the boundary detour == through (the algorithm's own rule is bypass <= through, not <)", () => {
    const v = pairVerdict(3, 7, 5, 40, { dist: 40, path: [3, 9, 7] });
    expect(v.witness).toBe(true);
    expect(v.narration).toBe("through: 40s · detour found: 40s ≤ 40s → free pass (witness)");
  });

  it("shortcut when the best detour is slower than through", () => {
    const v = pairVerdict(2, 8, 5, 40, { dist: 55, path: [2, 1, 8] });
    expect(v.witness).toBe(false);
    expect(v.detourS).toBe(55);
    expect(v.detourPath).toEqual([2, 1, 8]); // still shown — the too-slow detour is the evidence
    expect(v.narration).toBe("through: 40s · best detour: 55s > 40s → shortcut added (40s)");
  });

  it("shortcut when NO detour exists at all (detour null)", () => {
    const v = pairVerdict(2, 8, 5, 40, null);
    expect(v.witness).toBe(false);
    expect(v.detourS).toBeNull();
    expect(v.detourPath).toEqual([]);
    expect(v.narration).toBe("through: 40s · no detour without this intersection → shortcut added (40s)");
  });

  it("rounds raw seconds to ints for display: 39.6 -> 40, 30.4 -> 30", () => {
    const v = pairVerdict(0, 1, 2, 39.6, { dist: 30.4, path: [0, 3, 1] });
    expect(v.throughS).toBe(40);
    expect(v.detourS).toBe(30);
    expect(v.narration).toBe("through: 40s · detour found: 30s ≤ 40s → free pass (witness)");
  });

  it("decides witness on RAW weights, not the rounded display values — the verdict must match what the contractor really did", () => {
    // Raw: 40.4 > 39.6 -> the algorithm added a shortcut. Rounded both show
    // 40s; a rounded comparison would claim a witness while the curve draws.
    const v = pairVerdict(0, 1, 2, 39.6, { dist: 40.4, path: [0, 3, 1] });
    expect(v.witness).toBe(false);
    expect(v.narration).toBe("through: 40s · best detour: 40s > 40s → shortcut added (40s)");
  });

  it("copies u/w/via through untouched", () => {
    const v = pairVerdict(11, 4, 9, 12.49, null);
    expect([v.u, v.w, v.via]).toEqual([11, 4, 9]);
    expect(v.throughS).toBe(12);
  });
});

describe("phaseNarration: the one pinned 3-beat scheme (legs -> detour -> verdict)", () => {
  const witness = pairVerdict(3, 7, 5, 40, { dist: 30, path: [3, 9, 7] });
  const shortcut = pairVerdict(2, 8, 5, 40, null);

  it("phase 0 (legs) shows the through cost only", () => {
    expect(phaseNarration(witness, 0)).toBe("through: 40s");
    expect(phaseNarration(shortcut, 0)).toBe("through: 40s");
  });

  it("phase 1 (detour search) shows the through cost plus a searching ellipsis", () => {
    expect(phaseNarration(witness, 1)).toBe("through: 40s · detour: …");
    expect(phaseNarration(shortcut, 1)).toBe("through: 40s · detour: …");
  });

  it("phase 2 (verdict) is the full narration string", () => {
    expect(phaseNarration(witness, 2)).toBe(witness.narration);
    expect(phaseNarration(shortcut, 2)).toBe(shortcut.narration);
  });
});

describe("dead-end narration (spec §21.1: a single-neighbour node has zero through pairs)", () => {
  it("is the exact spec line", () => {
    expect(DEAD_END_NARRATION).toBe("nothing meets through here — free to remove, no shortcuts");
  });
});
