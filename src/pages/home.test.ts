// Pure-function test only. home.ts's `boot()` is the DOM-wiring half (real
// canvas/Worker/matchMedia/timers) — untested here by design, same
// rationale as controller.ts's stateful class and mapRenderer.ts's MapView
// (verified by eye once wired into the page, per those files' own
// comments). `autoRunPins` is the one piece of the auto-run decision that's
// pure — no DOM, no matchMedia, no timer — so it's the only thing pulled
// out and exported for direct testing.

import { describe, expect, it } from "vitest";
import { autoRunPins, diffPanels } from "./home";

describe("autoRunPins (the auto-run timer's fire condition — motion-preference independent, per design spec §5.1)", () => {
  it("returns the pinned pair once both pins are placed", () => {
    expect(autoRunPins(3, 7)).toEqual([3, 7]);
  });

  it("returns null with either pin still unset — order doesn't matter", () => {
    expect(autoRunPins(null, 7)).toBeNull();
    expect(autoRunPins(3, null)).toBeNull();
    expect(autoRunPins(null, null)).toBeNull();
  });

  it("does not special-case pin index 0 (falsy but a valid node id)", () => {
    expect(autoRunPins(0, 1)).toEqual([0, 1]);
    expect(autoRunPins(1, 0)).toEqual([1, 0]);
  });
});

// Compare mode (build-review §14.3): diffPanels is the pure add/keep/remove
// set logic behind syncPanels() (DOM-wiring, untested here by design, same
// rationale as the rest of boot() — verified live instead), so a racer
// toggle or a view-mode switch only creates/destroys the panels that
// actually changed instead of tearing down and rebuilding the whole grid.
describe("diffPanels (panel-set diffing: current panel algos vs. the next desired active-racer set)", () => {
  it("both empty: nothing to add, keep, or remove", () => {
    expect(diffPanels([], [])).toEqual({ keep: [], add: [], remove: [] });
  });

  it("starting from nothing (view-mode switched to Compare for the first time): every racer in next is an add", () => {
    expect(diffPanels([], ["dijkstra", "ch"])).toEqual({ keep: [], add: ["dijkstra", "ch"], remove: [] });
  });

  it("no change: everything currently shown stays, nothing added or removed", () => {
    expect(diffPanels(["dijkstra", "ch"], ["dijkstra", "ch"])).toEqual({
      keep: ["dijkstra", "ch"],
      add: [],
      remove: [],
    });
  });

  it("a racer toggled ON: existing panels are kept as-is, the new one is the only add", () => {
    expect(diffPanels(["dijkstra", "ch"], ["dijkstra", "astar", "ch"])).toEqual({
      keep: ["dijkstra", "ch"],
      add: ["astar"],
      remove: [],
    });
  });

  it("racers toggled OFF: they move to remove, survivors stay in keep", () => {
    expect(diffPanels(["dijkstra", "astar", "bidi", "ch"], ["dijkstra", "ch"])).toEqual({
      keep: ["dijkstra", "ch"],
      add: [],
      remove: ["astar", "bidi"],
    });
  });

  it("simultaneous add and remove (one racer swapped for another) in a single diff", () => {
    expect(diffPanels(["dijkstra", "astar", "ch"], ["dijkstra", "bidi", "ch"])).toEqual({
      keep: ["dijkstra", "ch"],
      add: ["bidi"],
      remove: ["astar"],
    });
  });

  it("switching OFF Compare mode entirely: next is empty, every current panel is a remove", () => {
    expect(diffPanels(["dijkstra", "astar", "ch"], [])).toEqual({
      keep: [],
      add: [],
      remove: ["dijkstra", "astar", "ch"],
    });
  });

  it("keep and remove preserve CURRENT's own order; add preserves NEXT's own order — a plain set-membership diff, not a re-sort by ROSTER order", () => {
    const result = diffPanels(["ch", "astar", "dijkstra"], ["dijkstra", "bidi", "ch"]);
    expect(result.keep).toEqual(["ch", "dijkstra"]);
    expect(result.remove).toEqual(["astar"]);
    expect(result.add).toEqual(["bidi"]);
  });
});
