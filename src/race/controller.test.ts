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
  replayDurationMs,
  routeColorFor,
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
 * placeholder-but-valid values for the rest (relaxed: unchecked by this
 * test). `ms` and `dist` default to this fixture's original hardcoded
 * values, so every pre-§19.4 call site that only passes settled/path is
 * unaffected — but both are now overridable: spec §19.4's per-layer pacing
 * tests need DIFFERENT racers to carry DIFFERENT measured times within the
 * SAME race (that's the entire behavior under test), and the
 * first-exact-completion route test needs a `dist` provably longer than
 * another racer's to exercise `dashed`/`deltaPct` (spec §18.4's honesty
 * rule) on a fast-but-inexact layer. */
function fakeAlgoResult(settled: number[], path: number[], ms = 5, dist = 100) {
  return {
    dist,
    ms,
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

describe("replayDurationMs (spec §19.4: THIS racer's own measured wall time × 2000, floored, never capped)", () => {
  it("scales measured ms by 2000 — the pinned examples from the build review", () => {
    expect(replayDurationMs(0.5)).toBe(1000);
    expect(replayDurationMs(2.5)).toBe(5000);
  });

  it("floors a near-zero measurement at 200 ms rather than an unwatchable sub-frame flash", () => {
    expect(replayDurationMs(0.05)).toBe(200);
    expect(replayDurationMs(0)).toBe(200);
  });

  it("does not touch a measurement already comfortably above the floor — pure scaling takes over", () => {
    expect(replayDurationMs(1)).toBe(2000);
    expect(replayDurationMs(10)).toBe(20_000);
  });

  it("has no upper cap — a slow measured racer earns an honestly long replay", () => {
    expect(replayDurationMs(50)).toBe(100_000); // 50 ms measured -> 100 s replay, uncapped
  });
});

describe("per-layer fraction math at a fixed timestamp (spec §19.4 — different racers, different durations, one shared clock)", () => {
  it("a fast (small-ms) layer reads fully settled while a slow (large-ms) layer in the SAME race, at the SAME elapsedMs, is still partial", () => {
    const chDuration = replayDurationMs(0.3); // 600 ms
    const dijDuration = replayDurationMs(5); // 10,000 ms
    const elapsedMs = 650; // past ch's own duration; nowhere near dijkstra's

    expect(sliceForFrame(214, elapsedMs, chDuration)).toBe(214); // CH: done
    const dijUp = sliceForFrame(21_480, elapsedMs, dijDuration);
    expect(dijUp).toBeGreaterThan(0);
    expect(dijUp).toBeLessThan(21_480); // Dijkstra: still mid-flood, same instant
  });

  it("the same elapsedMs against the same total gives different reveal fractions once the two durations differ — proof the racers no longer share one clock", () => {
    const total = 1000;
    const elapsedMs = 1000;
    const fastFrac = sliceForFrame(total, elapsedMs, replayDurationMs(0.4)); // 800 ms duration -> already done
    const slowFrac = sliceForFrame(total, elapsedMs, replayDurationMs(4)); // 8,000 ms duration -> 12.5% in
    expect(fastFrac).toBe(1000);
    expect(slowFrac).toBe(125);
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
    expect(activeRacers(new Set<RacerId>(["astar-straight"]), false)).toEqual([
      { algo: "dijkstra", key: "dijkstra" },
      { algo: "astar-straight", key: "astar-straight" },
      { algo: "ch", key: "ch" },
    ]);
  });

  it("every optional racer active: the full four-racer roster, in ROSTER order regardless of the Set's own insertion order", () => {
    const active = activeRacers(
      new Set<RacerId>(["astar-greedy", "astar-straight"]), false,
    );
    expect(active.map((a) => a.algo)).toEqual([
      "dijkstra", "astar-straight", "astar-greedy", "ch",
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

describe("routeColorFor (spec §20.1: a racer's OWN route colour — always the plain hueVar-mapped read, never the Glow variant dot clouds use in dark theme)", () => {
  it("resolves each roster id to its own plain-keyed entry in the colors object", () => {
    const colors: Record<string, string> = {
      dijkstra: "#d1", "astar-straight": "#as", "astar-greedy": "#ag", ch: "#c1",
    };
    expect(routeColorFor(colors, "dijkstra")).toBe("#d1");
    expect(routeColorFor(colors, "astar-straight")).toBe("#as");
    expect(routeColorFor(colors, "astar-greedy")).toBe("#ag");
    expect(routeColorFor(colors, "ch")).toBe("#c1");
  });

  it("never reads the Glow-suffixed key, even when present and different — glow is for dark map DOTS only (CLAUDE.md's palette contract), routes never branch on theme in JS", () => {
    const colors: Record<string, string> = { dijkstra: "#plain", dijkstraGlow: "#glow" };
    expect(routeColorFor(colors, "dijkstra")).toBe("#plain");
  });

  it("theme flip: the SAME call against a fresh colors snapshot returns THAT snapshot's own value — no caching, no branch, just whatever `colors` currently holds (exactly what makes a post-theme-flip redraw correct for free)", () => {
    const lightColors: Record<string, string> = { ch: "#2a78d6" };
    const darkColors: Record<string, string> = { ch: "#3987e5" };
    expect(routeColorFor(lightColors, "ch")).toBe("#2a78d6");
    expect(routeColorFor(darkColors, "ch")).toBe("#3987e5");
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
      // I3 reconciliation: I1's roster round widened worker.ts's `Algo`
      // from a small closed union to plain `string`, so `RaceResponse.
      // results` is now `Partial<Record<string, AlgoResult>>` (an index
      // signature) rather than a handful of named optional properties —
      // this fixture's two-key literal no longer structurally overlaps
      // `MessageEvent<WorkerResponse>` closely enough for a direct `as`
      // (tsc TS2352). Same `as unknown as` idiom this codebase already
      // uses for other deliberately-loose casts (worker.ts's `self as
      // unknown as Worker`, home.ts's `controller as unknown as
      // ControllerApiShim`) — this fixture only needs `.data` read back
      // through dispatchResponse, never the real MessageEvent surface.
    } as unknown as MessageEvent<WorkerResponse>);

    await runPromise;

    expect(view.drawDots).toHaveBeenCalled();
    for (const call of view.drawDots.mock.calls) {
      const opts = call[5] as { additive: boolean };
      expect(opts.additive).toBe(true);
    }
  });
});

// I3 integration fix: run()'s core-comparison lookup used to read the
// HARDCODED key `res.results.dijkstra` — correct only while familyBidi is
// off. Once setFamilyBidi(true) is active, dijkstra's ACTUAL request key is
// `bidi:dijkstra` (activeRacers()), so a real worker response never contains
// a plain `dijkstra` entry at all while bidi is on — the old code's
// `if (!dij || !ch) return;` guard silently discarded EVERY bidirectional
// race before reportResults/renderAt ever ran (no scoreboard update, no
// replay, no aria announcement). Neither wave's own unit tests constructed a
// real bidi RaceRequest through a live run() — this was caught only by an
// end-to-end live race (agent-browser, the I3 integration gate). This block
// closes that gap: it drives run() through setFamilyBidi(true) and replies
// with EXACTLY the response shape a real worker sends for that request
// (`bidi:dijkstra` + `ch`, never a plain `dijkstra` key), then asserts the
// UI actually gets updated — a silently-empty mockUi regresses this loudly
// if the hardcoded-key bug ever comes back.
describe("RaceController.run() — bidi request/response key regression (I3)", () => {
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

  it("a race started under setFamilyBidi(true) still reports results, reading dijkstra's CURRENT (bidi:dijkstra) key rather than assuming the plain one is present", async () => {
    const ui = mockUi();
    const controller = new RaceController(mockView() as unknown as MapView, ui);
    controller.setFamilyBidi(true);

    const runPromise = controller.run(0, 1);
    const worker = FakeWorker.instances.at(-1);
    expect(worker).toBeDefined();
    expect(worker?.sent).toHaveLength(1);
    const req = worker?.sent[0];
    expect(req).toBeDefined();
    // The request itself must ask for the bidi form, never the plain one —
    // otherwise this test would trivially pass for the wrong reason.
    expect(req?.algos).toContain("bidi:dijkstra");
    expect(req?.algos).not.toContain("dijkstra");

    // Exactly the response shape a real worker sends back for this request:
    // only the keys actually asked for — worker.ts's handleRequest never
    // populates a key nothing requested.
    worker?.onmessage?.({
      data: {
        id: req!.id,
        results: {
          "bidi:dijkstra": fakeAlgoResult([0, 1], [0, 1]),
          ch: fakeAlgoResult([0, 1], [0, 1]),
        },
      },
    } as unknown as MessageEvent<WorkerResponse>);

    await runPromise;

    // Before the fix: run()'s `res.results.dijkstra` lookup was always
    // undefined here, so the function returned before calling any of these
    // — the whole race silently no-op'd. After the fix, a completed bidi
    // race reports exactly as a plain one does, keyed by the STABLE
    // `RacerId` ("dijkstra"), never the request key that flipped to get
    // here (see controller.ts's own header comment on the two id spaces).
    expect(ui.setHeadline).toHaveBeenCalled();
    expect(ui.announce).toHaveBeenCalled();
    expect(ui.setRow).toHaveBeenCalledWith("dijkstra", expect.any(Number), expect.any(Number));
  });
});

// J4 gate fix (defensive, reviewer ride-along — no evidence the worker can
// actually emit this today, worker.ts's own AlgoResult.ms is always a real
// performance.now() delta): a non-finite `ms` must not poison the WHOLE
// race. Before the guard, replayDurationMs(NaN) produced a NaN layer
// duration, and Math.max(...layers.map(l => l.duration)) propagated that
// NaN into the race's overall duration — every layer's own finalization
// check (elapsedMs >= layer.duration) then permanently read false, since
// any comparison against NaN is false, stalling every row, not only the
// malformed one.
describe("RaceController.run() — non-finite measured `ms` doesn't stall the whole race (J4 gate fix, defensive)", () => {
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

  it("one racer reporting NaN ms still lets BOTH rows finalize (this file's forced reduced-motion path renders straight to the final frame, so a stall would show up as a missing setTime call)", async () => {
    const ui = mockUi();
    const controller = new RaceController(mockView() as unknown as MapView, ui);

    const runPromise = controller.run(0, 1);
    const worker = FakeWorker.instances.at(-1);
    const req = worker?.sent[0];
    worker?.onmessage?.({
      data: {
        id: req!.id,
        results: {
          dijkstra: fakeAlgoResult([0, 1], [0, 1], NaN), // malformed: a non-finite measured wall time
          ch: fakeAlgoResult([0, 1], [0, 1], 5),
        },
      },
    } as unknown as MessageEvent<WorkerResponse>);

    await runPromise; // must resolve, not hang behind a NaN overall duration

    // Both rows finalize (setTime fires once per racer) — proof the guarded
    // per-layer duration kept Math.max(...) finite instead of collapsing
    // the whole race's overall duration to NaN.
    expect(ui.setTime).toHaveBeenCalledTimes(2);
    // Final-review fix: the malformed racer's OWN setTime call must receive
    // the sanitized value (0), never the raw NaN — before this fix, only
    // `duration`'s guard was sanitized, so this call still carried NaN
    // through to the UI ("NaN ms" in the defensive case the guard exists
    // for, the exact case this test constructs).
    expect(ui.setTime).toHaveBeenCalledWith("dijkstra", 0);
    expect(ui.setHeadline).toHaveBeenCalled();
  });
});

// spec §19.4 (fifth build review): replay pacing is now per-algorithm and
// proportional to each racer's own measured wall time — this file's
// FILE-WIDE matchMedia stub (top of file) forces `prefers-reduced-motion:
// reduce` to always read true, which is exactly right for every describe
// block above (they want the instant-final path, not a rAF loop) and
// exactly wrong for what THIS block needs to exercise: the per-layer
// ANIMATED path itself, where different racers visibly complete at
// different real times. Each test below locally overrides matchMedia (via
// vi.stubGlobal, restored in afterEach — same idiom the file already uses
// for the Worker global) to force reduced motion OFF, then drives the
// resulting rAF loop with a hand-rolled clock/queue rather than
// vi.useFakeTimers(): animate() only ever calls performance.now() and
// requestAnimationFrame(), so spying on exactly those two gives full,
// explicit control over when a queued frame callback fires and what
// elapsed time it observes, without leaning on assumptions about how
// vitest's built-in fake timers interleave with a recursive rAF-driven
// Promise chain.
describe("RaceController — per-layer replay pacing (spec §19.4, the animated path)", () => {
  function mockUi(): RaceUi {
    return { setRow: vi.fn(), setTime: vi.fn(), setHeadline: vi.fn(), announce: vi.fn(), setRowDelta: vi.fn() };
  }

  function mockView() {
    return { clearOverlay: vi.fn(), drawDots: vi.fn(), drawRoute: vi.fn(), drawPin: vi.fn() };
  }

  /** A fully manual stand-in for the browser's frame clock: `advance(ms)`
   * moves the fake `performance.now()` forward and synchronously invokes
   * every callback CURRENTLY queued via requestAnimationFrame (draining the
   * queue first, so a callback that reschedules itself — animate()'s own
   * `step`, on every frame but the last — lands in the NEXT batch, never
   * re-entered within the same `advance()` call, exactly like a real
   * browser never re-runs this frame's callback list mid-frame). */
  function fakeClock() {
    let now = 0;
    let queue: FrameRequestCallback[] = [];
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
      queue.push(cb);
      return queue.length;
    });
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => now);
    return {
      advance(ms: number) {
        now += ms;
        const due = queue;
        queue = [];
        for (const cb of due) cb(now);
      },
      restore() {
        rafSpy.mockRestore();
        nowSpy.mockRestore();
      },
    };
  }

  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal(
      "matchMedia",
      ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof matchMedia,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("rows finalize individually, and race-end effects (announce/setHeadline/the localStorage echo) wait for the LAST active layer, not the first", async () => {
    const ui = mockUi();
    const controller = new RaceController(mockView() as unknown as MapView, ui);
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    const clock = fakeClock();

    const runPromise = controller.run(0, 1);
    const worker = FakeWorker.instances.at(-1);
    const req = worker?.sent[0];
    expect(req).toBeDefined();
    worker?.onmessage?.({
      data: {
        id: req!.id,
        results: {
          ch: fakeAlgoResult([0, 1], [0, 1], 0.3), // duration 600 ms
          dijkstra: fakeAlgoResult([0, 1, 2, 3], [0, 1], 5), // duration 10,000 ms
        },
      },
    } as unknown as MessageEvent<WorkerResponse>);
    // Drain the routing/request microtask chain up to animate()'s first
    // requestAnimationFrame registration — a real macrotask boundary
    // (unlike a bare `await Promise.resolve()`) reliably flushes every
    // pending .then() hop regardless of how many are chained ahead of it.
    await new Promise((r) => setTimeout(r, 0));

    // Past ch's own 600 ms duration, nowhere near dijkstra's 10,000 ms one.
    clock.advance(650);
    expect(ui.setTime).toHaveBeenCalledWith("ch", 0.3);
    expect(ui.setTime).not.toHaveBeenCalledWith("dijkstra", expect.anything());
    expect(ui.announce).not.toHaveBeenCalled();
    expect(ui.setHeadline).not.toHaveBeenCalled();
    expect(setItemSpy).not.toHaveBeenCalled();

    // Past dijkstra's own 10,000 ms duration too — the LAST active layer —
    // which is what lets animate()'s promise (and so run() itself) resolve.
    clock.advance(10_000);
    expect(ui.setTime).toHaveBeenCalledWith("dijkstra", 5);
    expect(ui.setTime).toHaveBeenCalledTimes(2); // exactly once per racer — RaceUi.setTime's own contract

    await runPromise;
    expect(ui.announce).toHaveBeenCalledTimes(1);
    expect(ui.setHeadline).toHaveBeenCalledTimes(1);
    expect(setItemSpy).toHaveBeenCalledWith("hth-last-race", expect.any(String));

    clock.restore();
    setItemSpy.mockRestore();
  });

  // spec §20.1 (sixth build review) retires the pre-§20.1 rule this block
  // used to guard ("the shared route reveals at the FIRST EXACT racer's
  // own completion") — there is no longer one shared route, only N
  // per-racer ones, each in its own hue. The property that rule was
  // ultimately protecting — a route never appears before SOMETHING real
  // backs it — survives, just narrowed from "before ANY racer finishes" to
  // "before THAT racer finishes": see the first test below, which replaces
  // the retired one, plus the timestamp/redraw/pin-order tests after it.
  it("a racer's own route never appears before ITS OWN completion — including an inexact one that finishes FIRST (the pre-§20.1 test made it wait for an EXACT racer instead; since §20.1 every racer, exact or not, reveals at its own finish, in its own hue, never gated on anyone else)", async () => {
    const ui = mockUi();
    const view = mockView();
    const controller = new RaceController(view as unknown as MapView, ui);
    controller.setRacerActive("astar-greedy", true);
    const clock = fakeClock();

    const runPromise = controller.run(0, 1);
    const worker = FakeWorker.instances.at(-1);
    const req = worker?.sent[0];
    expect(req).toBeDefined();
    expect(req?.algos).toContain("astar-greedy");
    worker?.onmessage?.({
      data: {
        id: req!.id,
        results: {
          ch: fakeAlgoResult([0, 1], [10, 12], 0.3, 100), // duration 600 ms, exact this race
          dijkstra: fakeAlgoResult([0, 1, 2, 3], [10, 11, 12], 5, 100), // duration 10,000 ms, exact this race
          "astar-greedy": fakeAlgoResult([0], [10, 14], 0.02, 130), // duration 200 ms (floor); 30% longer -> disclosed/inexact
        },
      },
    } as unknown as MessageEvent<WorkerResponse>);
    await new Promise((r) => setTimeout(r, 0));

    // Nothing has finished yet — no racer's route has appeared (the
    // surviving half of the retired property: never before ANY finish).
    expect(view.drawRoute).not.toHaveBeenCalled();

    // Past astar-greedy's 200 ms — the FIRST racer to finish overall, and
    // INEXACT this race. Pre-§20.1 this stayed hidden until an EXACT racer
    // caught up; since §20.1 it draws immediately, in its own hue — and
    // never dashed here (Overlay mode signals "not the shortest" via its
    // geometric divergence from the exact racers, not a dash pattern —
    // AlgoLayer.dashed's own doc; Compare mode's dashed test lives in its
    // own describe block below).
    view.drawRoute.mockClear();
    clock.advance(250);
    expect(view.drawRoute).toHaveBeenCalledTimes(1);
    const call0 = view.drawRoute.mock.calls[0];
    const opts0 = call0[3] as { dashed?: boolean; color?: string };
    expect(call0[0]).toEqual([10, 14]);
    expect(opts0.dashed).toBeFalsy();
    expect(opts0.color).toEqual(expect.anything());

    // Past ch's 600 ms too: ch's own route joins now (still no dash) —
    // dijkstra (10,000 ms) is nowhere close, so its own route must NOT be
    // among this frame's calls (the surviving half of the retired
    // property, narrowed to "before ITS OWN finish").
    view.drawRoute.mockClear();
    clock.advance(400); // total elapsed ~650 ms
    expect(view.drawRoute).toHaveBeenCalledTimes(2);
    const paths = view.drawRoute.mock.calls.map((call) => call[0]);
    expect(paths).toContainEqual([10, 14]); // astar-greedy, redrawn again
    expect(paths).toContainEqual([10, 12]); // ch, newly finished
    expect(paths).not.toContainEqual([10, 11, 12]); // dijkstra: not yet

    clock.advance(10_000);
    await runPromise;
    clock.restore();
  });

  it("finished-set math per timestamp (spec §20.1 item 1): with four racers at four distinct durations, exactly the ones finished as of a given elapsed draw — in ROSTER order, each in its OWN path", async () => {
    const ui = mockUi();
    const view = mockView();
    const controller = new RaceController(view as unknown as MapView, ui);
    controller.setRacerActive("astar-straight", true);
    controller.setRacerActive("astar-greedy", true);
    const clock = fakeClock();

    const runPromise = controller.run(0, 1);
    const worker = FakeWorker.instances.at(-1);
    const req = worker?.sent[0];
    expect(req).toBeDefined();
    worker?.onmessage?.({
      data: {
        id: req!.id,
        results: {
          ch: fakeAlgoResult([0, 1], [10, 12], 0.3, 100), // duration 600 ms, exact
          dijkstra: fakeAlgoResult([0, 1, 2, 3], [10, 11, 12], 2, 100), // duration 4,000 ms, exact
          "astar-straight": fakeAlgoResult([0, 1], [10, 13, 12], 0.5, 100), // duration 1,000 ms, exact
          "astar-greedy": fakeAlgoResult([0], [10, 14, 15, 12], 0.05, 130), // duration 200 ms (floor); disclosed
        },
      },
    } as unknown as MessageEvent<WorkerResponse>);
    await new Promise((r) => setTimeout(r, 0));

    // t=250: only astar-greedy (200 ms) has finished — 1 of 4.
    view.drawRoute.mockClear();
    clock.advance(250);
    expect(view.drawRoute).toHaveBeenCalledTimes(1);
    expect(view.drawRoute.mock.calls[0][0]).toEqual([10, 14, 15, 12]);

    // t=650: astar-greedy AND ch (600 ms) — exactly 2 of the 4 active
    // racers, neither astar-straight (1,000 ms) nor dijkstra (4,000 ms)
    // yet. ROSTER order (dijkstra, astar-straight, astar-greedy, ch) puts
    // astar-greedy's call before ch's.
    view.drawRoute.mockClear();
    clock.advance(400);
    expect(view.drawRoute).toHaveBeenCalledTimes(2);
    expect(view.drawRoute.mock.calls[0][0]).toEqual([10, 14, 15, 12]); // astar-greedy
    expect(view.drawRoute.mock.calls[1][0]).toEqual([10, 12]); // ch

    // t=1050: astar-straight (1,000 ms) joins too — 3 of 4, still ROSTER
    // order, dijkstra still absent.
    view.drawRoute.mockClear();
    clock.advance(400);
    expect(view.drawRoute).toHaveBeenCalledTimes(3);
    expect(view.drawRoute.mock.calls[0][0]).toEqual([10, 13, 12]); // astar-straight
    expect(view.drawRoute.mock.calls[1][0]).toEqual([10, 14, 15, 12]); // astar-greedy
    expect(view.drawRoute.mock.calls[2][0]).toEqual([10, 12]); // ch

    // t=4100: dijkstra (4,000 ms) finishes last — all four now, still
    // ROSTER order (dijkstra first).
    view.drawRoute.mockClear();
    clock.advance(3050);
    expect(view.drawRoute.mock.calls.map((call) => call[0])).toEqual([
      [10, 11, 12], // dijkstra
      [10, 13, 12], // astar-straight
      [10, 14, 15, 12], // astar-greedy
      [10, 12], // ch
    ]);

    await runPromise;
    clock.restore();
  });

  it("redrawFrame reproduces exactly the CURRENTLY-finished set at the frame's current elapsed — no clock advance, no re-run, the same racers every time it's called", async () => {
    const ui = mockUi();
    const view = mockView();
    const controller = new RaceController(view as unknown as MapView, ui);
    controller.setRacerActive("astar-greedy", true);
    const clock = fakeClock();

    const runPromise = controller.run(0, 1);
    const worker = FakeWorker.instances.at(-1);
    const req = worker?.sent[0];
    expect(req).toBeDefined();
    worker?.onmessage?.({
      data: {
        id: req!.id,
        results: {
          ch: fakeAlgoResult([0, 1], [10, 12], 0.3, 100), // duration 600 ms, exact
          dijkstra: fakeAlgoResult([0, 1, 2, 3], [10, 11, 12], 5, 100), // duration 10,000 ms, exact
          "astar-greedy": fakeAlgoResult([0], [10, 14], 0.05, 130), // duration 200 ms (floor); disclosed
        },
      },
    } as unknown as MessageEvent<WorkerResponse>);
    await new Promise((r) => setTimeout(r, 0));

    // Past astar-greedy's and ch's own durations, nowhere near dijkstra's.
    clock.advance(650);
    expect(view.drawRoute).toHaveBeenCalledTimes(2); // astar-greedy, ch — roster order

    // A redraw (theme flip / resize / mode switch — any of redrawFrame's
    // real callers) at this SAME elapsed must reproduce exactly that same
    // finished-only pair: not more (dijkstra still isn't done), not fewer,
    // without advancing the clock or re-running the replay.
    view.drawRoute.mockClear();
    controller.redrawFrame();
    expect(view.drawRoute).toHaveBeenCalledTimes(2);
    expect(view.drawRoute.mock.calls[0][0]).toEqual([10, 14]); // astar-greedy
    expect(view.drawRoute.mock.calls[1][0]).toEqual([10, 12]); // ch

    // Idempotent: calling it again reproduces the identical set and order.
    view.drawRoute.mockClear();
    controller.redrawFrame();
    expect(view.drawRoute.mock.calls.map((call) => call[0])).toEqual([[10, 14], [10, 12]]);

    clock.advance(10_000);
    await runPromise;
    clock.restore();
  });

  it("pins draw AFTER every route this frame, so they always sit visually on top (spec §20.1 item 4 — matters more now that Overlay mode can stack several routes at once)", async () => {
    const ui = mockUi();
    const order: string[] = [];
    const view = {
      clearOverlay: vi.fn(),
      drawDots: vi.fn(),
      drawRoute: vi.fn(() => {
        order.push("route");
      }),
      drawPin: vi.fn(() => {
        order.push("pin");
      }),
    };
    const controller = new RaceController(view as unknown as MapView, ui);
    const clock = fakeClock();

    const runPromise = controller.run(0, 1);
    const worker = FakeWorker.instances.at(-1);
    const req = worker?.sent[0];
    expect(req).toBeDefined();
    worker?.onmessage?.({
      data: {
        id: req!.id,
        results: {
          ch: fakeAlgoResult([0, 1], [10, 12], 0.3, 100), // duration 600 ms
          dijkstra: fakeAlgoResult([0, 1, 2, 3], [10, 11, 12], 0.3, 100), // duration 600 ms too — both finish together
        },
      },
    } as unknown as MessageEvent<WorkerResponse>);
    await new Promise((r) => setTimeout(r, 0));

    clock.advance(650); // both racers finished — two routes AND two pins draw this frame
    await runPromise;

    expect(order.filter((e) => e === "route")).toHaveLength(2);
    expect(order.filter((e) => e === "pin")).toHaveLength(2);
    // Every route entry precedes every pin entry: the pins are the LAST
    // two entries in this frame's draw order, never interleaved or first.
    expect(order.slice(-2)).toEqual(["pin", "pin"]);
    expect(order.lastIndexOf("route")).toBeLessThan(order.indexOf("pin"));

    clock.restore();
  });

  it("cancellation stops a still-animating multi-duration race instantly — the superseded race's slower layer never finalizes and its race-end effects never fire, even once enough time has passed that they otherwise would have", async () => {
    const ui = mockUi();
    const controller = new RaceController(mockView() as unknown as MapView, ui);
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    const clock = fakeClock();

    void controller.run(0, 1); // race 1 — deliberately not awaited, it's about to be superseded
    const worker = FakeWorker.instances.at(-1);
    const req1 = worker?.sent[0];
    expect(req1).toBeDefined();
    worker?.onmessage?.({
      data: {
        id: req1!.id,
        results: {
          ch: fakeAlgoResult([0, 1], [0, 1], 0.3), // duration 600 ms
          dijkstra: fakeAlgoResult([0, 1, 2, 3], [0, 1], 5), // duration 10,000 ms
        },
      },
    } as unknown as MessageEvent<WorkerResponse>);
    await new Promise((r) => setTimeout(r, 0));

    // Race 1's fast layer finishes and finalizes normally...
    clock.advance(650);
    expect(ui.setTime).toHaveBeenCalledWith("ch", 0.3);

    // ...then a NEW race supersedes it (any of run()'s real callers: a new
    // pin, a preset click, "R") while race 1's dijkstra layer is still only
    // ~6.5% settled. Race 2's own request is deliberately left unanswered —
    // that isolates "race 1 never gets to report" from "race 2 eventually
    // reports its own results": if ANY race-end effect fires below, it can
    // only be race 1's, since race 2 can structurally never reach that
    // point (its own Promise.all never settles).
    void controller.run(0, 1); // race 2
    const req2 = worker?.sent[1];
    expect(req2).toBeDefined(); // the request itself still goes out synchronously — only its reply never arrives
    await new Promise((r) => setTimeout(r, 0));

    // Advance well past where race 1's dijkstra (10,000 ms) would have
    // completed had it not been cancelled.
    clock.advance(12_000);
    await new Promise((r) => setTimeout(r, 0));

    expect(ui.setTime).not.toHaveBeenCalledWith("dijkstra", expect.anything());
    expect(ui.announce).not.toHaveBeenCalled();
    expect(ui.setHeadline).not.toHaveBeenCalled();
    expect(setItemSpy).not.toHaveBeenCalled();

    clock.restore();
    setItemSpy.mockRestore();
  });
});

// spec §20.1 item 3 (sixth build review): Compare mode's per-panel route
// reveal had no dedicated test before this — it rode along on the same
// pre-§20.1 shared `showRoute` gate the Overlay-mode tests above exercised
// directly, which (see this file's own audit above) did NOT actually give
// each panel its own reveal timing: every panel waited for the race-wide
// "first EXACT racer done" instant, even a panel whose own racer was still
// mid-replay. This block is new, not a retrofit of a weakened old one.
describe("RaceController.run() (renderAt) — Compare-mode per-panel route reveal (spec §20.1 item 3: reveal timing per panel = that racer's OWN completion; dashed-when-suboptimal unchanged)", () => {
  function mockUi(): RaceUi {
    return { setRow: vi.fn(), setTime: vi.fn(), setHeadline: vi.fn(), announce: vi.fn(), setRowDelta: vi.fn() };
  }

  function mockView() {
    return { clearOverlay: vi.fn(), drawDots: vi.fn(), drawRoute: vi.fn(), drawPin: vi.fn() };
  }

  /** See the "per-layer replay pacing" describe block above for the full
   * rationale — this is the identical hand-rolled rAF/clock stand-in,
   * duplicated locally rather than shared across describe blocks (this
   * file has no shared-helpers-across-describes convention to hook into,
   * and each block already owns its own mockUi/mockView pair the same
   * way). */
  function fakeClock() {
    let now = 0;
    let queue: FrameRequestCallback[] = [];
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
      queue.push(cb);
      return queue.length;
    });
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => now);
    return {
      advance(ms: number) {
        now += ms;
        const due = queue;
        queue = [];
        for (const cb of due) cb(now);
      },
      restore() {
        rafSpy.mockRestore();
        nowSpy.mockRestore();
      },
    };
  }

  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal(
      "matchMedia",
      ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof matchMedia,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("each panel's own route waits for THAT panel's racer, not any other panel's — and stays dashed exactly when its own racer is disclosed-suboptimal", async () => {
    const ui = mockUi();
    const controller = new RaceController(mockView() as unknown as MapView, ui);
    controller.setRacerActive("astar-greedy", true);

    const dijPanel = mockView();
    const agPanel = mockView();
    const chPanel = mockView();
    controller.setComparePanels([
      { algo: "dijkstra", view: dijPanel as unknown as MapView },
      { algo: "astar-greedy", view: agPanel as unknown as MapView },
      { algo: "ch", view: chPanel as unknown as MapView },
    ]);

    const clock = fakeClock();
    const runPromise = controller.run(0, 1);
    const worker = FakeWorker.instances.at(-1);
    const req = worker?.sent[0];
    expect(req).toBeDefined();
    worker?.onmessage?.({
      data: {
        id: req!.id,
        results: {
          ch: fakeAlgoResult([0, 1], [10, 12], 0.3, 100), // duration 600 ms, exact
          dijkstra: fakeAlgoResult([0, 1, 2, 3], [10, 11, 12], 5, 100), // duration 10,000 ms, exact
          "astar-greedy": fakeAlgoResult([0], [10, 14], 0.02, 130), // duration 200 ms (floor); 30% longer -> disclosed
        },
      },
    } as unknown as MessageEvent<WorkerResponse>);
    await new Promise((r) => setTimeout(r, 0));

    // Past astar-greedy's 200 ms only: ITS panel reveals (dashed — its own
    // result is disclosed-suboptimal), neither other panel does yet.
    clock.advance(250);
    expect(agPanel.drawRoute).toHaveBeenCalledTimes(1);
    expect(agPanel.drawRoute).toHaveBeenCalledWith(
      [10, 14], expect.anything(), expect.anything(), expect.objectContaining({ dashed: true }),
    );
    expect(chPanel.drawRoute).not.toHaveBeenCalled();
    expect(dijPanel.drawRoute).not.toHaveBeenCalled();

    // Past ch's 600 ms too: ITS panel reveals now, undashed (exact) —
    // dijkstra's panel still hasn't, nowhere near its own 10,000 ms.
    clock.advance(400); // ~650 ms total
    expect(chPanel.drawRoute).toHaveBeenCalledTimes(1);
    expect(chPanel.drawRoute).toHaveBeenCalledWith(
      [10, 12], expect.anything(), expect.anything(), expect.objectContaining({ dashed: false }),
    );
    expect(dijPanel.drawRoute).not.toHaveBeenCalled();

    clock.advance(10_000);
    await runPromise;
    clock.restore();
  });

  it(
    "a compare panel with NO matching layer in the current race draws nothing at all — no dots, " +
      "no route, for the whole race (K1's carried watch, K4 gate coverage: home.ts's syncPanels " +
      "can add a panel for a racer toggled on AFTER a race's request already went out, before the " +
      "next panel rebuild catches up — reproduced directly here via a comparePanels entry for " +
      "astar-straight, which is never made active and so has no entry in c.layers at all, rather " +
      "than via real UI timing)",
    async () => {
      const ui = mockUi();
      const controller = new RaceController(mockView() as unknown as MapView, ui);
      controller.setRacerActive("astar-greedy", true);
      // astar-straight is deliberately left inactive — its panel below has
      // no corresponding layer in this race, on purpose.

      const dijPanel = mockView();
      const agPanel = mockView();
      const chPanel = mockView();
      const orphanPanel = mockView(); // astar-straight's panel: no matching layer, ever, this race
      controller.setComparePanels([
        { algo: "dijkstra", view: dijPanel as unknown as MapView },
        { algo: "astar-greedy", view: agPanel as unknown as MapView },
        { algo: "ch", view: chPanel as unknown as MapView },
        { algo: "astar-straight", view: orphanPanel as unknown as MapView },
      ]);

      const clock = fakeClock();
      const runPromise = controller.run(0, 1);
      const worker = FakeWorker.instances.at(-1);
      const req = worker?.sent[0];
      expect(req).toBeDefined();
      worker?.onmessage?.({
        data: {
          id: req!.id,
          results: {
            ch: fakeAlgoResult([0, 1], [10, 12], 0.3, 100),
            dijkstra: fakeAlgoResult([0, 1, 2, 3], [10, 11, 12], 5, 100),
            "astar-greedy": fakeAlgoResult([0], [10, 14], 0.02, 130),
            // deliberately no "astar-straight" entry — it was never active for this race
          },
        },
      } as unknown as MessageEvent<WorkerResponse>);
      await new Promise((r) => setTimeout(r, 0));

      clock.advance(10_000); // well past every real layer's own duration
      await runPromise;
      clock.restore();

      expect(orphanPanel.drawDots).not.toHaveBeenCalled();
      expect(orphanPanel.drawRoute).not.toHaveBeenCalled();
      // Sanity check that the assertions above are specific to the orphan
      // panel, not a symptom of a race that silently failed to run at all.
      expect(dijPanel.drawRoute).toHaveBeenCalledTimes(1);
      expect(agPanel.drawRoute).toHaveBeenCalledTimes(1);
      expect(chPanel.drawRoute).toHaveBeenCalledTimes(1);
    },
  );
});
