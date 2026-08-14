// Pure-function tests only (no Worker in jsdom/node — see worker.ts's own
// comment on why it isn't unit-tested directly). What's exercised here is
// everything the replay loop and the once-per-race announcement are built
// on: frame-fraction math and text formatting, both plain functions with no
// DOM/Worker dependency — plus dispatchResponse, the pure routing logic
// behind RaceController.request()'s resolve/reject behavior (a Map and a
// plain message object in, no Worker needed to exercise it).

import { describe, expect, it } from "vitest";
import { dispatchResponse, formatAnnouncement, formatMs, headlineText, sliceForFrame, type PendingRace } from "./controller";
import type { RaceErrorResponse, RaceResponse } from "./worker";

describe("sliceForFrame", () => {
  it("is 0 at t <= 0", () => {
    expect(sliceForFrame(1000, 0, 2500)).toBe(0);
    expect(sliceForFrame(1000, -50, 2500)).toBe(0);
  });

  it("is total at t >= duration", () => {
    expect(sliceForFrame(1000, 2500, 2500)).toBe(1000);
    expect(sliceForFrame(1000, 9999, 2500)).toBe(1000);
  });

  it("is monotone non-decreasing as elapsed increases", () => {
    const total = 1237; // deliberately not a round number
    const duration = 2500;
    let prev = -1;
    for (let t = -100; t <= duration + 100; t += 33) {
      const v = sliceForFrame(total, t, duration);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it("interpolates linearly mid-replay", () => {
    expect(sliceForFrame(1000, 1250, 2500)).toBe(500);
    expect(sliceForFrame(4000, 625, 2500)).toBe(1000);
  });

  it("never exceeds total even with floating-point overshoot", () => {
    expect(sliceForFrame(3, 2500.0001, 2500)).toBe(3);
  });

  it("handles a zero total (nothing settled) without going negative", () => {
    expect(sliceForFrame(0, 1250, 2500)).toBe(0);
    expect(sliceForFrame(0, 2500, 2500)).toBe(0);
  });
});

describe("formatMs", () => {
  it("formats to one decimal with a unit suffix", () => {
    expect(formatMs(38.24)).toBe("38.2 ms");
    expect(formatMs(0.6)).toBe("0.6 ms");
    expect(formatMs(0)).toBe("0.0 ms");
  });
});

describe("headlineText", () => {
  it("computes the percentage of settled-node work CH avoided", () => {
    expect(headlineText(21480, 214)).toBe("99.0% less work");
  });

  it("reads 0.0% when both settle the same count (no savings)", () => {
    expect(headlineText(100, 100)).toBe("0.0% less work");
  });

  it("guards the degenerate zero-Dijkstra-settled case instead of NaN/Infinity", () => {
    expect(headlineText(0, 0)).toBe("0.0% less work");
  });
});

describe("formatAnnouncement (the once-per-race aria text)", () => {
  it("matches the exact template with en-AU thousands separators and 1-decimal km", () => {
    expect(formatAnnouncement(21480, 214, 22.4)).toBe(
      "Dijkstra settled 21,480 intersections; Contraction Hierarchies settled 214. " +
        "Same 22.4 km route.",
    );
  });

  it("rounds km to one decimal", () => {
    expect(formatAnnouncement(5, 5, 1.05)).toContain("Same 1.1 km route.");
  });

  it("small counts still read correctly with no thousands separator needed", () => {
    expect(formatAnnouncement(8, 3, 0.4)).toBe(
      "Dijkstra settled 8 intersections; Contraction Hierarchies settled 3. Same 0.4 km route.",
    );
  });
});

describe("dispatchResponse (the pure logic behind request()'s resolve/reject)", () => {
  function pendingPair(): { pending: Map<number, PendingRace>; resolved: RaceResponse[]; rejected: Error[] } {
    const resolved: RaceResponse[] = [];
    const rejected: Error[] = [];
    const pending = new Map<number, PendingRace>();
    pending.set(1, {
      resolve: (res) => resolved.push(res),
      reject: (err) => rejected.push(err),
    });
    return { pending, resolved, rejected };
  }

  it("resolves the matching pending entry on a normal RaceResponse", () => {
    const { pending, resolved, rejected } = pendingPair();
    const msg: RaceResponse = { id: 1, results: {} };
    dispatchResponse(pending, msg);
    expect(resolved).toEqual([msg]);
    expect(rejected).toEqual([]);
  });

  it("rejects the matching pending entry when the worker posts { id, error } — this is what makes RaceController.request() reject on a worker-side failure instead of hanging forever", () => {
    const { pending, resolved, rejected } = pendingPair();
    const errMsg: RaceErrorResponse = { id: 1, error: "routing.json: 500 Internal Server Error" };
    dispatchResponse(pending, errMsg);
    expect(resolved).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toBeInstanceOf(Error);
    expect(rejected[0].message).toBe("routing.json: 500 Internal Server Error");
  });

  it("removes the entry from the pending map either way, so a repeat message for the same id is a no-op", () => {
    const { pending, resolved, rejected } = pendingPair();
    expect(pending.has(1)).toBe(true);
    dispatchResponse(pending, { id: 1, error: "boom" });
    expect(pending.has(1)).toBe(false);
    // A second message for the same (now-gone) id must not double-fire.
    dispatchResponse(pending, { id: 1, results: {} });
    expect(resolved).toEqual([]);
    expect(rejected).toHaveLength(1);
  });

  it("a message for an id with no pending entry is silently ignored (no throw)", () => {
    const { pending, resolved, rejected } = pendingPair();
    expect(() => dispatchResponse(pending, { id: 999, error: "nobody is waiting for this" })).not.toThrow();
    expect(resolved).toEqual([]);
    expect(rejected).toEqual([]);
  });
});
