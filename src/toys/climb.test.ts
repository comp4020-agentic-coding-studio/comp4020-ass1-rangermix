import { describe, expect, it } from "vitest";
import { buildCh } from "../algos/chBuild";
import { chQuery } from "../algos/chQuery";
import { toyGraph } from "../algos/graph";
import {
  buildSteps,
  computeBenchMeans,
  findDefaultClimbPair,
  formatBenchEcho,
  formatRaceEcho,
  incomingEdges,
  parseLastRace,
  rankStep,
  rankY,
  touchedNodes,
} from "./climb";

// The climb toy's whole animation is scripted from ONE real chQuery run —
// these tests pin that the derived step script is actually faithful to
// that run (never a hand-authored substitute). A small hand-built directed
// fixture stands in for toytown here (mirroring toytown.test.ts's own
// synthetic-fixture convention): a 5-node path (0-1-2-3-4, undirected)
// where contracting node 3 creates a real 2<->4 shortcut — the same
// pairing this file's git history shows an earlier review picked I->L on
// MINITOWN for, now reproduced on a fixture built for these tests alone
// (MINITOWN itself no longer exists — see docs/superpowers/plans
// /2026-08-15-feedback-round.md Task F5).

function pathFixture() {
  return toyGraph(
    5,
    [
      [0, 1, 4],
      [1, 2, 4],
      [2, 3, 4],
      [3, 4, 4],
    ],
    { undirected: true },
  );
}

describe("rankStep: per-rank vertical spacing, rescaled to the touched max", () => {
  it("is 0 when there is nothing to climb (maxRank <= 0)", () => {
    expect(rankStep(0)).toBe(0);
    expect(rankStep(-1)).toBe(0);
  });

  it("is positive and finite for a real max rank", () => {
    const step = rankStep(18);
    expect(step).toBeGreaterThan(0);
    expect(Number.isFinite(step)).toBe(true);
  });

  it("a smaller touched max rank gives a LARGER per-rank step (same vertical budget, fewer ranks to spread across)", () => {
    expect(rankStep(5)).toBeGreaterThan(rankStep(50));
  });
});

describe("rankY: contraction rank -> vertical position", () => {
  const step = 18;

  it("higher rank draws higher on screen (smaller y)", () => {
    expect(rankY(5, step)).toBeLessThan(rankY(2, step));
    expect(rankY(0, step)).toBeGreaterThan(rankY(1, step));
  });

  it("is a straight linear lift: equal rank steps move equal pixel amounts", () => {
    const delta = rankY(0, step) - rankY(1, step);
    expect(delta).toBe(step);
    expect(rankY(6, step) - rankY(7, step)).toBe(step);
  });
});

describe("incomingEdges", () => {
  it("indexes every CSR edge under its destination node, preserving the total count", () => {
    const ch = buildCh(pathFixture());
    const incoming = incomingEdges(ch.up);
    let total = 0;
    for (const [to, edges] of incoming) {
      for (const e of edges) {
        expect(e.to).toBe(to);
        expect(e.from).toBeGreaterThanOrEqual(0);
        expect(e.from).toBeLessThan(ch.n);
      }
      total += edges.length;
    }
    expect(total).toBe(ch.up.edge.length);
  });
});

describe("buildSteps: the climb toy's animation script, derived from a real chQuery run", () => {
  const ch = buildCh(pathFixture());
  const from = 0;
  const to = 4; // verified (see chQuery.usesShortcut tests in ch.test.ts): winning path uses the 2<->4 shortcut
  const result = chQuery(ch, from, to);

  it("0 -> 4 is reachable and its winning path really does use the shortcut", () => {
    expect(Number.isFinite(result.dist)).toBe(true);
    expect(result.usesShortcut).toBe(true);
  });

  it("step count = forward settles + backward settles + one meet + one per unpacked edge", () => {
    const steps = buildSteps(ch, result);
    expect(steps).toHaveLength(
      result.settled.length + result.settledB.length + 1 + (result.path.length - 1),
    );
  });

  it("the first step settles the forward search's own start node, with no incoming highlight edge", () => {
    const steps = buildSteps(ch, result);
    expect(steps[0]).toEqual({ kind: "fwd", node: from, edges: [] });
  });

  it("every forward step's highlighted edges are real ch.up edges landing on an already-settled node", () => {
    const steps = buildSteps(ch, result);
    const seen = new Set<number>();
    for (const st of steps) {
      if (st.kind !== "fwd") continue;
      for (const e of st.edges) {
        expect(seen.has(e.from)).toBe(true);
        expect(e.to).toBe(st.node);
        expect(ch.edges[e.edgeIdx].from).toBe(e.from);
        expect(ch.edges[e.edgeIdx].to).toBe(e.to);
      }
      seen.add(st.node);
    }
  });

  it("every backward step's highlighted edges are real ch.downRev edges landing on an already-settled node", () => {
    const steps = buildSteps(ch, result);
    const seen = new Set<number>();
    for (const st of steps) {
      if (st.kind !== "bwd") continue;
      for (const e of st.edges) {
        expect(seen.has(e.from)).toBe(true);
        expect(e.to).toBe(st.node);
      }
      seen.add(st.node);
    }
  });

  it("the meet step names exactly the node chQuery itself reports as the meeting point", () => {
    const steps = buildSteps(ch, result);
    expect(steps.find((s) => s.kind === "meet")).toEqual({ kind: "meet", node: result.meet });
  });

  it("the unpack steps retrace ChResult.path edge by edge, start to finish", () => {
    const steps = buildSteps(ch, result);
    const unpackSteps = steps.filter((s) => s.kind === "unpack");
    expect(unpackSteps).toHaveLength(result.path.length - 1);
    unpackSteps.forEach((s, i) => {
      expect(s).toEqual({ kind: "unpack", from: result.path[i], to: result.path[i + 1] });
    });
  });

  it("is a pure function of (ch, result): same inputs produce the same script every time", () => {
    expect(buildSteps(ch, result)).toEqual(buildSteps(ch, result));
  });
});

describe("touchedNodes: the rank-lift layout's lifted set", () => {
  it("includes both endpoints, the meet node, and every node on the unpacked path", () => {
    const ch = buildCh(pathFixture());
    const result = chQuery(ch, 0, 4);
    const touched = touchedNodes(result);
    expect(touched.has(0)).toBe(true);
    expect(touched.has(4)).toBe(true);
    expect(touched.has(result.meet)).toBe(true);
    for (const n of result.path) expect(touched.has(n)).toBe(true);
  });

  it("is a proper subset of all nodes when the graph is bigger than what one query touches", () => {
    // A 9-node path: querying the two ends touches every node (it's a
    // path), so use a short middle hop instead to get a genuine subset.
    const g = toyGraph(
      9,
      Array.from({ length: 8 }, (_, i) => [i, i + 1, 4] as [number, number, number]),
      { undirected: true },
    );
    const ch = buildCh(g);
    const result = chQuery(ch, 4, 5); // adjacent middle nodes: a short, local query
    const touched = touchedNodes(result);
    expect(touched.size).toBeLessThan(g.n);
  });
});

describe("findDefaultClimbPair: scans for the first pair whose winning path needs a shortcut", () => {
  it("finds 0->4 on the path fixture (the first ordered pair, scan order, whose winning path uses the shortcut)", () => {
    const ch = buildCh(pathFixture());
    // minTouched=0 so the tiny 5-node fixture (max settled+settledB is
    // small) isn't excluded by the real toytown-sized default floor.
    expect(findDefaultClimbPair(ch, 0)).toEqual({ from: 0, to: 4 });
  });

  it("the returned pair really does satisfy both conditions the function promises", () => {
    const ch = buildCh(pathFixture());
    const pair = findDefaultClimbPair(ch, 0);
    expect(pair).not.toBeNull();
    if (!pair) return;
    const result = chQuery(ch, pair.from, pair.to);
    expect(result.usesShortcut).toBe(true);
    expect(Number.isFinite(result.dist)).toBe(true);
  });

  it("returns null when no pair can meet an impossibly high minTouched floor", () => {
    const ch = buildCh(pathFixture());
    expect(findDefaultClimbPair(ch, 10_000)).toBeNull();
  });

  it("is deterministic: same graph, same pair every call", () => {
    const ch = buildCh(pathFixture());
    expect(findDefaultClimbPair(ch, 0)).toEqual(findDefaultClimbPair(ch, 0));
  });
});

describe("closing echo: parsing the visitor's own last race (honest fallback contract)", () => {
  it("accepts a well-formed record", () => {
    expect(parseLastRace(JSON.stringify({ dj: 21480, ch: 214, km: 22.4 }))).toEqual({
      dj: 21480,
      ch: 214,
      km: 22.4,
    });
  });

  it("rejects null/missing storage", () => {
    expect(parseLastRace(null)).toBeNull();
    expect(parseLastRace("")).toBeNull();
  });

  it("rejects invalid JSON instead of throwing", () => {
    expect(() => parseLastRace("not json")).not.toThrow();
    expect(parseLastRace("not json")).toBeNull();
  });

  it("rejects a record missing a field", () => {
    expect(parseLastRace(JSON.stringify({ dj: 1, ch: 2 }))).toBeNull();
  });

  it("rejects a record with the wrong field types", () => {
    expect(parseLastRace(JSON.stringify({ dj: "x", ch: 2, km: 3 }))).toBeNull();
  });

  it("rejects a non-object JSON value", () => {
    expect(parseLastRace(JSON.stringify([1, 2, 3]))).toBeNull();
    expect(parseLastRace("42")).toBeNull();
  });
});

describe("closing echo: copy formatting matches the spec wording exactly", () => {
  it("formatRaceEcho: en-AU thousands separators, 1-decimal km", () => {
    expect(formatRaceEcho({ dj: 21480, ch: 214, km: 22.4 })).toBe(
      "That's why 214 beat 21,480 on your own race — same 22.4 km route, a fraction of the visits.",
    );
  });

  it("computeBenchMeans rounds to whole numbers", () => {
    expect(
      computeBenchMeans([
        { dj: 10, ch: 1 },
        { dj: 11, ch: 2 },
        { dj: 12, ch: 3 },
      ]),
    ).toEqual({ meanDj: 11, meanCh: 2 });
  });

  it("formatBenchEcho reports the real measured-route count and rounded means", () => {
    expect(formatBenchEcho(13871, 179, 300)).toBe(
      "Across 300 measured Canberra routes, Dijkstra settles ~13,871 intersections; CH settles ~179.",
    );
  });
});
