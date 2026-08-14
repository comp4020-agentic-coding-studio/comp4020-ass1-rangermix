import { describe, expect, it } from "vitest";
import { dijkstra } from "../algos/dijkstra";
import { MINITOWN } from "./minitown";

// The shared 12-node graph every /how/ toy draws on top of. These tests
// guard the properties the toys assume hold: fully connected (so no toy
// ever tries to animate a route that doesn't exist), every weight positive
// (so "distance order" is meaningful), and the flood toy's chosen A->L pair
// settles enough of the town to be worth watching.

describe("MINITOWN", () => {
  it("has 12 named nodes, each with a coordinate", () => {
    expect(MINITOWN.graph.n).toBe(12);
    expect(MINITOWN.names).toHaveLength(12);
    expect(MINITOWN.xy).toHaveLength(12);
    expect(MINITOWN.names).toEqual([
      "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L",
    ]);
  });

  it("is connected: dijkstra from node 0 reaches every other node", () => {
    const r = dijkstra(MINITOWN.graph, 0, -1);
    expect(new Set(r.settled).size).toBe(MINITOWN.graph.n);
  });

  it("every edge weight is positive", () => {
    const { weight } = MINITOWN.graph.fwd;
    expect(weight.length).toBeGreaterThan(0);
    for (const w of weight) expect(w).toBeGreaterThan(0);
  });

  it("the flood toy's chosen far pair (A -> L) settles at least 8 nodes", () => {
    const from = MINITOWN.names.indexOf("A");
    const to = MINITOWN.names.indexOf("L");
    expect(from).toBeGreaterThanOrEqual(0);
    expect(to).toBeGreaterThanOrEqual(0);
    const r = dijkstra(MINITOWN.graph, from, to);
    expect(r.dist).toBeLessThan(Infinity);
    expect(r.settled.length).toBeGreaterThanOrEqual(8);
  });
});
