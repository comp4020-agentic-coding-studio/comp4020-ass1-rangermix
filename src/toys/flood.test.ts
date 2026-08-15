import { describe, expect, it } from "vitest";
import { toyGraph } from "../algos/graph";
import { findFarPair } from "./flood";

// findFarPair is the toy's "default far pair" — a double-sweep (two real
// dijkstra() passes) rather than a hand-picked node index, so it stays
// correct on whatever graph is loaded (and self-adapts if the toytown
// artifact is ever regenerated with different node numbering).

describe("findFarPair: double-sweep far-pair approximation", () => {
  it("finds the true two endpoints of a straight line graph", () => {
    // 0 - 1 - 2 - 3 - 4, unit weights: the diameter is exactly the two ends.
    const g = toyGraph(
      5,
      [
        [0, 1, 1],
        [1, 2, 1],
        [2, 3, 1],
        [3, 4, 1],
      ],
      { undirected: true },
    );
    const { from, to } = findFarPair(g);
    expect(new Set([from, to])).toEqual(new Set([0, 4]));
  });

  it("returns two distinct nodes on a graph with more than one node", () => {
    const g = toyGraph(
      6,
      [
        [0, 1, 2],
        [1, 2, 3],
        [2, 3, 1],
        [3, 4, 4],
        [4, 5, 2],
        [1, 5, 10],
      ],
      { undirected: true },
    );
    const { from, to } = findFarPair(g);
    expect(from).not.toBe(to);
    expect(from).toBeGreaterThanOrEqual(0);
    expect(to).toBeGreaterThanOrEqual(0);
  });

  it("is deterministic: same graph, same pair every call", () => {
    const g = toyGraph(
      5,
      [
        [0, 1, 1],
        [1, 2, 1],
        [2, 3, 1],
        [3, 4, 1],
      ],
      { undirected: true },
    );
    expect(findFarPair(g)).toEqual(findFarPair(g));
  });

  it("works on a directed (one-way) graph too — a ring that can only be walked one way", () => {
    const g = toyGraph(4, [
      [0, 1, 1],
      [1, 2, 1],
      [2, 3, 1],
      [3, 0, 1],
    ]); // directed, no { undirected: true }
    const { from, to } = findFarPair(g);
    expect(from).not.toBe(to);
    // Both endpoints must be real, reachable nodes on this 4-node ring.
    expect([0, 1, 2, 3]).toContain(from);
    expect([0, 1, 2, 3]).toContain(to);
  });
});
