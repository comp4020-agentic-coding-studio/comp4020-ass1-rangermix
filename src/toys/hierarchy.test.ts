// Pure-function tests only (no fetch, no canvas, no DOM) — see hierarchy.ts's
// own doc comment on percentileThreshold for the bug this exists to guard:
// the "top X%" labels must actually retain that fraction of lines against
// whatever data is loaded, not a byte constant guessed once and left to
// drift (166/224/250 retained 10.2% / 0.75% / 0.025% against the real
// Canberra artifact, not 35% / 12% / 2%).

import { describe, expect, it } from "vitest";
import { computePctSteps, percentileThreshold } from "./hierarchy";

// A `lines`-shaped fixture with pct values 0..99, each exactly once (only
// `line[1]`/pct matters to these functions — the other slots are unused
// filler so the fixture reads as a real `number[][]`).
function pctFixture(values: number[]): number[][] {
  return values.map((v) => [0, v]);
}

const HUNDRED = pctFixture(Array.from({ length: 100 }, (_, i) => i)); // 0..99

describe("percentileThreshold", () => {
  it("finds the exact threshold for a clean 0-99 distribution: keepFrac=0.35 keeps exactly the top 35", () => {
    const t = percentileThreshold(HUNDRED, 0.35);
    expect(t).toBe(65);
    expect(HUNDRED.filter((l) => l[1] >= t)).toHaveLength(35);
  });

  it("keepFrac=0.12 keeps exactly the top 12", () => {
    const t = percentileThreshold(HUNDRED, 0.12);
    expect(t).toBe(88);
    expect(HUNDRED.filter((l) => l[1] >= t)).toHaveLength(12);
  });

  it("keepFrac=0.02 keeps exactly the top 2 — the exact step the live bug was found on (real data showed 0.025% instead of 2%)", () => {
    const t = percentileThreshold(HUNDRED, 0.02);
    expect(t).toBe(98);
    expect(HUNDRED.filter((l) => l[1] >= t)).toHaveLength(2);
  });

  it("keepFrac=1 keeps everything (threshold at the minimum)", () => {
    const t = percentileThreshold(HUNDRED, 1);
    expect(HUNDRED.filter((l) => l[1] >= t)).toHaveLength(100);
  });

  it("a small, unsorted, duplicate-containing fixture still resolves correctly", () => {
    const g = pctFixture([5, 1, 1, 9, 3]); // sorted: 1,1,3,5,9
    // keepFrac=0.4 -> idx=floor(5*0.6)=3 -> sorted[3]=5 -> keeps {5,9} = 2/5 = 40%
    const t = percentileThreshold(g, 0.4);
    expect(t).toBe(5);
    expect(g.filter((l) => l[1] >= t)).toHaveLength(2);
  });

  it("an empty lines array returns 0 rather than throwing or returning undefined", () => {
    expect(percentileThreshold([], 0.5)).toBe(0);
  });
});

describe("computePctSteps", () => {
  it("returns 4 steps: null (every road) then the three data-derived thresholds, in order", () => {
    const steps = computePctSteps(HUNDRED);
    expect(steps).toHaveLength(4);
    expect(steps[0]).toBeNull();
    expect(steps[1]).toBe(65); // top 35%
    expect(steps[2]).toBe(88); // top 12%
    expect(steps[3]).toBe(98); // top 2%
  });

  it("each non-null step actually retains its labelled fraction of the input", () => {
    const steps = computePctSteps(HUNDRED);
    const fracs = [1, 0.35, 0.12, 0.02];
    steps.forEach((t, i) => {
      const kept = t === null ? HUNDRED.length : HUNDRED.filter((l) => l[1] >= t).length;
      expect(kept, `step ${i}`).toBe(Math.round(fracs[i] * 100));
    });
  });
});
