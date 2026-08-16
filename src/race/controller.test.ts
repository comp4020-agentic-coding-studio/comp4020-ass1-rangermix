// @vitest-environment jsdom
//
// Mostly pure-function tests (no Worker in jsdom/node — see worker.ts's own
// comment on why it isn't unit-tested directly). What's exercised here is
// everything the replay loop and the once-per-race announcement are built
// on: frame-fraction math and text formatting, both plain functions with no
// DOM/Worker dependency — plus dispatchResponse, the pure routing logic
// behind RaceController.request()'s resolve/reject behavior (a Map and a
// plain message object in, no Worker needed to exercise it).
//
// One exception (§16.10 review round 2, finding 3 — a real production bug,
// `additive: dark` instead of `additive: true`, had shipped with NO
// regression test): the "RaceController.run() (renderAt) — additive:true
// regression" describe block below constructs a REAL RaceController, using
// the SAME view/ui constructor seam every other caller (home.ts) already
// goes through, with a lightweight FakeWorker standing in for the real
// off-main-thread Worker (jsdom has none — same rationale as worker.ts's
// own comment) and a mocked `../data` module standing in for the real
// fetch-based routing load. jsdom (not the file's usual bare-node
// environment) is needed for exactly this one block: RaceController's own
// constructor reads `document.baseURI`. Forcing the reduced-motion branch
// (see the matchMedia stub below) keeps this test doing real work rather
// than fighting a rAF loop: RaceController.run() renders straight to the
// final frame synchronously under `prefers-reduced-motion: reduce`, no
// timer/animation plumbing needed to reach the drawDots call under test.

// Stub matchMedia for jsdom (same idiom as theme.test.ts's own stub), but
// discriminating on the query string rather than a single flat false: this
// file specifically wants `prefers-reduced-motion: reduce` to read as
// TRUE (see the block comment above for why), while other queries (e.g.
// theme.ts's own prefers-color-scheme read inside RaceController's
// effectiveTheme() call) don't matter to what this test asserts.
window.matchMedia ??= ((q: string) => ({
  matches: q.includes("prefers-reduced-motion"),
  media: q,
  addEventListener() {},
  removeEventListener() {},
})) as never;

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeRacers,
  dispatchResponse,
  formatAnnouncement,
  formatMs,
  formatRosterAnnouncement,
  headlineText,
  pathKm,
  RaceController,
  rejectAllPending,
  routeDeltaPct,
  sliceForFrame,
  type PendingRace,
  type RacerId,
  type RaceUi,
} from "./controller";
import { knownAlgoKeys, type RaceErrorResponse, type RaceRequest, type RaceResponse, type WorkerResponse } from "./worker";
import { ROSTER } from "./roster";
import { toyGraph } from "../algos/graph";
import type { MapView } from "../viz/mapRenderer";

// The real `../data.ts` fetches JSON over the network — unreachable (and
// unwanted) from this test, which only needs SOME graph for drawDots'
// coordinate lookups to have something to read. Self-contained (no
// reference to outer test-file bindings): vi.mock factories run during
// module-graph resolution, before this file's OWN top-level `const`s have
// necessarily initialized, so a fresh dynamic import inside the factory
// sidesteps that ordering hazard entirely rather than risking a TDZ bug.
vi.mock("../data", async () => {
  const { toyGraph: buildGraph } = await import("../algos/graph");
  return {
    loadRouting: vi.fn().mockResolvedValue({ graph: buildGraph(2, [[0, 1, 100]], { undirected: true }) }),
  };
});

/** A minimal stand-in for the real off-main-thread Worker (jsdom has none —
 * see the file-header comment) that captures every posted request and lets
 * the test manually dispatch a fake response through the SAME onmessage
 * handler RaceController's constructor wires up — exactly the seam a real
 * worker message would arrive through, just driven by hand instead of a
 * real thread. `instances` is a static registry (not a single module-level
 * variable) so each test that constructs its own RaceController can grab
 * exactly the FakeWorker that controller made, even across multiple tests
 * in the same run. */
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  sent: RaceRequest[] = [];
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(msg: RaceRequest): void {
    this.sent.push(msg);
  }
  terminate(): void {
    /* no-op — nothing in this suite needs teardown-observable behavior */
  }
}

/** A minimal, wire-shaped AlgoResult — every field renderAt/reportResults
 * actually reads (settledCount, settled node-index buffer, path) with
 * placeholder-but-valid values for the rest (dist/ms/relaxed: unchecked by
 * this test). */
function fakeAlgoResult(settled: number[], path: number[]) {
  return {
    dist: 100,
    ms: 5,
    relaxed: settled.length,
    settledCount: settled.length,
    settled: Uint32Array.from(settled).buffer,
    path,
  };
}

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

describe("pathKm (haversine hop-sum, hand-computed against the same R=6,371,000 m sphere snap.ts uses)", () => {
  it("is 0 for an empty or single-node path — never NaN", () => {
    const g = toyGraph(2, [[0, 1, 1]]);
    expect(pathKm(g, [])).toBe(0);
    expect(pathKm(g, [0])).toBe(0);
  });

  it("matches R * dLon exactly on the equator, where the haversine formula degenerates to a pure great-circle arc", () => {
    // On the equator (lat=0 both ends) the haversine term collapses to
    // a = sin^2(dLon/2), so distance = 2R*atan2(sin(dLon/2), cos(dLon/2)) =
    // R*dLon-in-radians exactly, no small-angle approximation involved.
    // R=6,371,000 m, dLon=1 degree=pi/180 rad -> 111.19492664... km.
    const g = toyGraph(2, [[0, 1, 1]]);
    g.lon[0] = 0;
    g.lat[0] = 0;
    g.lon[1] = 1;
    g.lat[1] = 0;
    expect(pathKm(g, [0, 1])).toBeCloseTo(111.195, 2);
  });

  it("sums hop lengths across a multi-node path — two 1-degree-of-latitude hops on the same meridian, double the single-hop figure above (same exact-arc reasoning, dLon=0 this time)", () => {
    const g = toyGraph(3, [[0, 1, 1], [1, 2, 1]]);
    g.lon[0] = 149;
    g.lat[0] = -35;
    g.lon[1] = 149;
    g.lat[1] = -34;
    g.lon[2] = 149;
    g.lat[2] = -33;
    expect(pathKm(g, [0, 1, 2])).toBeCloseTo(222.39, 1);
  });
});

describe("activeRacers (ROSTER filtered to active racers, each resolved to its CURRENT request key — the one derivation run() and getActiveRoster() both use, so they can never disagree on what's active or which key currently represents it)", () => {
  it("with no optional racers active and familyBidi off, only dijkstra and ch race, plain keys, in ROSTER order", () => {
    expect(activeRacers(new Set(), false)).toEqual([
      { algo: "dijkstra", key: "dijkstra" },
      { algo: "ch", key: "ch" },
    ]);
  });

  it("an optional A* variant inserts at its ROSTER position (between dijkstra and ch), not appended at the end", () => {
    expect(activeRacers(new Set<RacerId>(["astar-weighted"]), false)).toEqual([
      { algo: "dijkstra", key: "dijkstra" },
      { algo: "astar-weighted", key: "astar-weighted" },
      { algo: "ch", key: "ch" },
    ]);
  });

  it("every optional racer active: the full five-racer roster, in ROSTER order regardless of the Set's own insertion order", () => {
    const active = activeRacers(
      new Set<RacerId>(["astar-greedy", "astar-straight", "astar-weighted"]), false,
    );
    expect(active.map((a) => a.algo)).toEqual([
      "dijkstra", "astar-straight", "astar-weighted", "astar-greedy", "ch",
    ]);
  });

  it("dijkstra and ch are never excludable — they race regardless of what's in the optional set", () => {
    const active = activeRacers(new Set<RacerId>(), false).map((a) => a.algo);
    expect(active).toContain("dijkstra");
    expect(active).toContain("ch");
  });

  it("familyBidi on switches every ACTIVE searchers-family racer to its bidiKey, but leaves ch on its plain key (ch has no bidiKey — spec §18.6, CH sits outside the family bezel)", () => {
    expect(activeRacers(new Set<RacerId>(["astar-straight"]), true)).toEqual([
      { algo: "dijkstra", key: "bidi:dijkstra" },
      { algo: "astar-straight", key: "bidi:astar-straight" },
      { algo: "ch", key: "ch" },
    ]);
  });

  it("familyBidi on with no optional racers still flips dijkstra alone (dijkstra is core — always active — and IS a searchers-family member)", () => {
    expect(activeRacers(new Set(), true)).toEqual([
      { algo: "dijkstra", key: "bidi:dijkstra" },
      { algo: "ch", key: "ch" },
    ]);
  });
});

describe("routeDeltaPct (spec §18.4's honesty rule, as a number — 1 decimal, never negative)", () => {
  it("is 0 when the racer's distance already equals the optimal", () => {
    expect(routeDeltaPct(100, 100)).toBe(0);
  });

  it("computes a positive percentage, rounded to 1 decimal, when the racer is longer", () => {
    expect(routeDeltaPct(123, 100)).toBe(23);
    expect(routeDeltaPct(110.25, 100)).toBeCloseTo(10.3, 5);
  });

  it("clamps a spuriously-negative delta (floating-point noise on an exact racer) to 0, never a negative percentage", () => {
    expect(routeDeltaPct(99.999999, 100)).toBe(0);
  });

  it("guards a zero/degenerate optimal distance (a from===to query) instead of dividing by zero", () => {
    expect(routeDeltaPct(0, 0)).toBe(0);
  });
});

describe("formatRosterAnnouncement's disclosure clause (spec §18.4: aria names active racers, appends ', took a X% longer route' for disclosed rows)", () => {
  it("appends the disclosure clause for an entry with a positive deltaPct", () => {
    expect(
      formatRosterAnnouncement(
        [
          { label: "Dijkstra", settled: 100, deltaPct: 0 },
          { label: "A* — greedy", settled: 40, deltaPct: 23 },
        ],
        5,
      ),
    ).toBe(
      "Dijkstra settled 100 intersections; A* — greedy settled 40, took a 23.0% longer route. Same 5.0 km route.",
    );
  });

  it("omits the disclosure clause when deltaPct is 0 or absent — exactly the pre-disclosure sentence shape", () => {
    expect(formatRosterAnnouncement([{ label: "Dijkstra", settled: 100, deltaPct: 0 }], 5)).toBe(
      "Dijkstra settled 100 intersections. Same 5.0 km route.",
    );
    expect(formatRosterAnnouncement([{ label: "Dijkstra", settled: 100 }], 5)).toBe(
      "Dijkstra settled 100 intersections. Same 5.0 km route.",
    );
  });
});

describe("worker registry coverage (every roster workerKey/bidiKey resolves to a real handler — worker.ts's registry is BUILT FROM roster.ts, this checks that promise holds)", () => {
  it("every roster entry's workerKey, and every searchers-family entry's bidiKey, is a known algo key", () => {
    const known = knownAlgoKeys();
    for (const entry of ROSTER) {
      expect(known.has(entry.workerKey), entry.workerKey).toBe(true);
      if (entry.bidiKey) expect(known.has(entry.bidiKey), entry.bidiKey).toBe(true);
    }
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

describe("rejectAllPending (the Worker onerror/onmessageerror path — a whole-worker failure, not one request's)", () => {
  it("rejects every pending entry with an Error carrying the given reason, and empties the map", () => {
    const resolved: RaceResponse[] = [];
    const rejected: Error[] = [];
    const pending = new Map<number, PendingRace>();
    pending.set(1, { resolve: (r) => resolved.push(r), reject: (e) => rejected.push(e) });
    pending.set(2, { resolve: (r) => resolved.push(r), reject: (e) => rejected.push(e) });

    rejectAllPending(pending, "race worker failed to load: script error");

    expect(resolved).toEqual([]);
    expect(rejected).toHaveLength(2);
    for (const err of rejected) {
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe("race worker failed to load: script error");
    }
    expect(pending.size).toBe(0);
  });

  it("is a no-op on an empty map (no throw) — the failure-before-any-request-was-sent case", () => {
    const pending = new Map<number, PendingRace>();
    expect(() => rejectAllPending(pending, "race worker posted an undeliverable message")).not.toThrow();
    expect(pending.size).toBe(0);
  });
});

// §16.10 review round 2, finding 3: the `additive: dark` -> `additive: true`
// production bug (see the G3 report's "Bug 1") shipped with no regression
// test — nothing in this file exercised a real replay frame at all, only
// the pure helpers around it. This block closes that gap using the
// RaceController constructor's own view/ui seam (the SAME one home.ts's
// real boot() goes through) with a mock/spy MapView standing in as the
// render target, so the assertion is against an ACTUAL drawDots call
// renderAt makes, not a re-implementation of its logic.
describe("RaceController.run() (renderAt) — additive:true regression", () => {
  function mockUi(): RaceUi {
    return { setRow: vi.fn(), setTime: vi.fn(), setHeadline: vi.fn(), announce: vi.fn(), setRowDelta: vi.fn() };
  }

  function mockView() {
    return { clearOverlay: vi.fn(), drawDots: vi.fn(), drawRoute: vi.fn(), drawPin: vi.fn() };
  }

  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("every drawDots call a completed race's replay makes has opts.additive === true, in both themes — dark/light is MapView's OWN read (opts.additive is only ever the caller's density-wanted intent), so this caller must never gate it on the theme again", async () => {
    const view = mockView();
    const controller = new RaceController(view as unknown as MapView, mockUi());

    const runPromise = controller.run(0, 1);
    const worker = FakeWorker.instances.at(-1);
    expect(worker).toBeDefined();
    expect(worker?.sent).toHaveLength(1); // the request went out synchronously, before this line — see request()'s own comment
    const req = worker?.sent[0];
    expect(req).toBeDefined();

    // Manually drive the response through the SAME onmessage handler a real
    // worker message would arrive through (dispatchResponse) — resolves
    // request()'s pending promise, unblocking run()'s own Promise.all.
    worker?.onmessage?.({
      data: {
        id: req!.id,
        results: {
          dijkstra: fakeAlgoResult([0, 1], [0, 1]),
          ch: fakeAlgoResult([0, 1], [0, 1]),
        },
      },
    } as MessageEvent<WorkerResponse>);

    await runPromise;

    expect(view.drawDots).toHaveBeenCalled();
    for (const call of view.drawDots.mock.calls) {
      const opts = call[5] as { additive: boolean };
      expect(opts.additive).toBe(true);
    }
  });
});
