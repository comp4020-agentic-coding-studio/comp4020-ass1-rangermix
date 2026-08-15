// Pure-function test only. how.ts's `boot()` is the DOM-wiring half (real
// fetch/IntersectionObserver/DOM) — untested here by design, same rationale
// as home.ts's own boot() (see home.test.ts). `makeAutoPlayGate` is the one
// piece of the auto-start-on-scroll decision that's pure — no DOM, no
// fetch, no IntersectionObserver — so it's the only thing pulled out and
// exported for direct testing.

import { describe, expect, it } from "vitest";
import { makeAutoPlayGate } from "./how";

describe("makeAutoPlayGate: fires once BOTH mounted and visible are true, whichever is last", () => {
  it("visible() first, then ready(): plays immediately on ready()", () => {
    const gate = makeAutoPlayGate();
    let played = 0;
    gate.visible();
    gate.ready(() => played++);
    expect(played).toBe(1);
  });

  it("ready() first, then visible(): does NOT play until visible() fires", () => {
    const gate = makeAutoPlayGate();
    let played = 0;
    gate.ready(() => played++);
    expect(played).toBe(0);
    gate.visible();
    expect(played).toBe(1);
  });

  it("plays exactly once even if visible() fires more than once", () => {
    const gate = makeAutoPlayGate();
    let played = 0;
    gate.ready(() => played++);
    gate.visible();
    gate.visible();
    expect(played).toBe(1);
  });

  it("never plays if ready() is never called", () => {
    const gate = makeAutoPlayGate();
    gate.visible();
    // No assertion beyond "doesn't throw" — there's no play callback to
    // have fired, and the gate mustn't crash without one.
    expect(true).toBe(true);
  });

  it("a fresh gate with neither call yet has not played", () => {
    const gate = makeAutoPlayGate();
    let played = 0;
    // Calling ready() with no prior visible() must not synchronously fire.
    gate.ready(() => played++);
    expect(played).toBe(0);
  });
});
