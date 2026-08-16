import { describe, expect, it } from "vitest";
import { ROSTER } from "./roster";
import { getHeuristicKind } from "../algos/heuristicKind";

describe("getHeuristicKind (registry heuristic-kind lookup)", () => {
  it("covers exactly the roster's astar ids (astar-straight, astar-weighted, astar-greedy)", () => {
    const astarIds = ROSTER.filter((e) => e.id.startsWith("astar")).map((e) => e.id);
    expect(astarIds).toEqual(["astar-straight", "astar-weighted", "astar-greedy"]);
    for (const id of astarIds) {
      const kind = getHeuristicKind(id);
      expect(["straight", "weighted", "greedy"]).toContain(kind);
    }
  });

  it("maps astar-straight to 'straight'", () => {
    expect(getHeuristicKind("astar-straight")).toBe("straight");
  });

  it("maps astar-weighted to 'weighted'", () => {
    expect(getHeuristicKind("astar-weighted")).toBe("weighted");
  });

  it("maps astar-greedy to 'greedy'", () => {
    expect(getHeuristicKind("astar-greedy")).toBe("greedy");
  });

  it("throws on unknown astar ids", () => {
    expect(() => getHeuristicKind("astar-unknown")).toThrow("Unknown astar id: astar-unknown");
    expect(() => getHeuristicKind("dijkstra")).toThrow("Unknown astar id: dijkstra");
    expect(() => getHeuristicKind("ch")).toThrow("Unknown astar id: ch");
  });
});
