// Pure-function test only. home.ts's `boot()` is the DOM-wiring half (real
// canvas/Worker/matchMedia/timers) — untested here by design, same
// rationale as controller.ts's stateful class and mapRenderer.ts's MapView
// (verified by eye once wired into the page, per those files' own
// comments). `autoRunPins` is the one piece of the auto-run decision that's
// pure — no DOM, no matchMedia, no timer — so it's the only thing pulled
// out and exported for direct testing.

import { describe, expect, it } from "vitest";
import { autoRunPins } from "./home";

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
