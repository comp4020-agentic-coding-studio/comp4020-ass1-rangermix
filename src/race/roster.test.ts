import { describe, expect, it } from "vitest";
import { ROSTER } from "./roster";

// Structural sanity for the contract-first roster both wave tasks consume.
describe("roster contract", () => {
  it("ids are unique and count matches the roster (four racers since §20.2)", () => {
    const ids = ROSTER.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(4);
  });

  it("exactly the two core racers, and they are Dijkstra and CH", () => {
    expect(ROSTER.filter((r) => r.core).map((r) => r.id).sort()).toEqual([
      "ch",
      "dijkstra",
    ]);
  });

  it("every searcher has a bidirectional form; CH has none", () => {
    for (const r of ROSTER) {
      if (r.family === "searchers") expect(r.bidiKey, r.id).toBe(`bidi:${r.workerKey}`);
      else expect(r.bidiKey, r.id).toBeUndefined();
    }
  });

  it("inexact racers carry a note (the disclosure rule needs words on screen)", () => {
    for (const r of ROSTER.filter((r) => !r.exact))
      expect(r.note?.trim(), r.id).toBeTruthy();
  });

  it("hue/glow custom-property names are well-formed and unique", () => {
    const vars = ROSTER.flatMap((r) => [r.hueVar, r.glowVar]);
    expect(new Set(vars).size).toBe(vars.length);
    for (const v of vars) expect(v).toMatch(/^--[cg]-[a-z-]+$/);
  });
});
