import { describe, expect, it } from "vitest";
import { buildCh } from "../algos/chBuild";
import { chQuery, type ChResult } from "../algos/chQuery";
import { toyGraph } from "../algos/graph";
import {
  buildSteps,
  computeBenchMeans,
  countArterialSegments,
  expandChEdge,
  findDefaultClimbPair,
  formatBenchEcho,
  formatRaceEcho,
  incomingEdges,
  parseLastRace,
  rankStep,
  rankY,
  stepStreetPairs,
  touchedNodes,
} from "./climb";
import { decodeToytown, type ToytownArtifact } from "./toytown";

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

// Task G5 (design spec §16.13): among qualifying pairs, findDefaultClimbPair
// can additionally be handed a scorer and picks the MAX-scoring candidate
// instead of just the first one scan order happens to hit.
describe("findDefaultClimbPair: with a scorePair function, prefers the MAX-scoring qualifying pair over the first-scanned one", () => {
  function chainFixture(n: number) {
    return toyGraph(n, Array.from({ length: n - 1 }, (_, i) => [i, i + 1, 4] as [number, number, number]), {
      undirected: true,
    });
  }

  it("picks the pair with the highest score, not just the first qualifying pair in scan order", () => {
    const ch = buildCh(chainFixture(9));
    // Unscored: the first qualifying pair in scan order (asserted so this
    // test's premise — scoring actually CHANGES the answer — is visible,
    // not just assumed).
    expect(findDefaultClimbPair(ch, 0)).toEqual({ from: 0, to: 3 });

    // Scored by winning-path length: on an undirected chain, the longest
    // possible path spans the two extreme endpoints (0, 8) — nothing can
    // score higher, and (0, 8) is the ONLY pair reaching that span, so this
    // is a hand-verifiable, unambiguous expected winner (not (8, 0): from=0
    // scans before from=8).
    const byPathLength = (r: ChResult) => r.path.length;
    expect(findDefaultClimbPair(ch, 0, byPathLength)).toEqual({ from: 0, to: 8 });
  });

  it("the winner really does have the max score among every qualifying candidate (property, not tied to one hand-picked fixture)", () => {
    const ch = buildCh(chainFixture(9));
    const qualifying: ChResult[] = [];
    for (let from = 0; from < ch.n; from++) {
      for (let to = 0; to < ch.n; to++) {
        if (from === to) continue;
        const r = chQuery(ch, from, to);
        if (Number.isFinite(r.dist) && r.usesShortcut) qualifying.push(r);
      }
    }
    expect(qualifying.length).toBeGreaterThan(1); // otherwise "prefers the max" is untestable here

    const score = (r: ChResult) => r.path.length;
    const maxScore = Math.max(...qualifying.map(score));
    const picked = findDefaultClimbPair(ch, 0, score);
    expect(picked).not.toBeNull();
    if (!picked) return;
    expect(score(chQuery(ch, picked.from, picked.to))).toBe(maxScore);
  });

  it("falls back to null exactly as the unscored form does when nothing qualifies", () => {
    const ch = buildCh(chainFixture(9));
    expect(findDefaultClimbPair(ch, 10_000, (r) => r.path.length)).toBeNull();
  });
});

// Task G5: expandChEdge/stepStreetPairs are the lockstep scheduler's
// step -> real-street mapping — climbLinked uses these to highlight the MAP
// view in step with the hierarchy view, without ever drawing a shortcut as
// if it were a real road.
describe("expandChEdge: unpacks a possibly-shortcut CH edge down to its original leaf edges", () => {
  it("a leaf (non-shortcut) edge expands to itself, alone", () => {
    const ch = buildCh(pathFixture());
    const leafIdx = ch.edges.findIndex((e) => e.childA === -1);
    expect(leafIdx).toBeGreaterThanOrEqual(0);
    expect(expandChEdge(ch.edges, leafIdx)).toEqual([leafIdx]);
  });

  it("a shortcut expands to its two real constituent streets, childA then childB, in order", () => {
    const ch = buildCh(pathFixture());
    // Contracting node 3 (see this file's fixture banner) creates a 2->4
    // shortcut (and, independently, its own 4->2 — directed contraction
    // computes each ordered pair separately); ch.edges records the 2->4
    // one with childA/childB pointing at the two real edges (2->3, 3->4)
    // it bypassed.
    const shortcutIdx = ch.edges.findIndex((e) => e.from === 2 && e.to === 4 && e.childA !== -1);
    expect(shortcutIdx).toBeGreaterThanOrEqual(0);
    const shortcut = ch.edges[shortcutIdx];
    const leaves = expandChEdge(ch.edges, shortcutIdx);
    expect(leaves).toEqual([shortcut.childA, shortcut.childB]);
    for (const li of leaves) expect(ch.edges[li].childA).toBe(-1); // both leaves are real, non-shortcut edges
    expect(ch.edges[shortcut.childA]).toMatchObject({ from: 2, to: 3 });
    expect(ch.edges[shortcut.childB]).toMatchObject({ from: 3, to: 4 });
  });
});

describe("stepStreetPairs: maps a ClimbStep to the real (u, v) street pairs it touches on the ground", () => {
  const ch = buildCh(pathFixture());
  const result = chQuery(ch, 0, 4);
  const steps = buildSteps(ch, result);

  it("a meet step touches no street", () => {
    const meetStep = steps.find((s) => s.kind === "meet");
    expect(meetStep).toBeTruthy();
    if (!meetStep) return;
    expect(stepStreetPairs(ch, meetStep)).toEqual([]);
  });

  it("an unpack step names exactly its own (from, to) — chQuery's path is already fully unpacked", () => {
    const unpackStep = steps.find((s) => s.kind === "unpack");
    expect(unpackStep).toBeTruthy();
    if (unpackStep?.kind !== "unpack") return;
    expect(stepStreetPairs(ch, unpackStep)).toEqual([[unpackStep.from, unpackStep.to]]);
  });

  it("a fwd/bwd step backed by a SHORTCUT expands to the real streets it stands in for, not the shortcut's own (from, to)", () => {
    // The backward search settles node 2 via the 4<->2 shortcut on this
    // fixture — its street pairs must be the real 2->3 and 3->4 hops the
    // shortcut bypassed, never a fabricated 4->2 "street" (there is no such
    // road — see the file banner).
    let shortcutStep: (typeof steps)[number] | undefined;
    for (const s of steps) {
      if ((s.kind === "fwd" || s.kind === "bwd") && s.edges.some((e) => ch.edges[e.edgeIdx].childA !== -1)) {
        shortcutStep = s;
        break;
      }
    }
    expect(shortcutStep).toBeTruthy();
    if (!shortcutStep) return;
    expect(stepStreetPairs(ch, shortcutStep)).toEqual([
      [2, 3],
      [3, 4],
    ]);
  });

  it("every returned pair is a real edge in ch.edges (defensive: no fabricated street)", () => {
    for (const step of steps) {
      for (const [u, v] of stepStreetPairs(ch, step)) {
        expect(ch.edges.some((e) => e.from === u && e.to === v)).toBe(true);
      }
    }
  });
});

// Task G5 (design spec §16.12/13): the arterial-preference scoring climb's
// default-pair search uses, tested against a hand-built Toytown fixture
// (not the real artifact) so the expected counts are hand-verifiable.
describe("countArterialSegments: counts arterial (cls>=2) hops along a real path", () => {
  const artifact: ToytownArtifact = {
    bbox: [149.1, -35.3, 149.11, -35.29],
    n: 4,
    lon: [0, 500, 1000, 1500],
    lat: [0, 0, 0, 0],
    edges: [
      { from: 0, to: 1, w: 10, cls: 0, geometry: [[0, 0], [500, 0]] },
      { from: 1, to: 2, w: 10, cls: 3, geometry: [[500, 0], [1000, 0]] },
      { from: 2, to: 3, w: 10, cls: 2, geometry: [[1000, 0], [1500, 0]] },
    ],
  };
  const t = decodeToytown(artifact);

  it("counts each cls>=2 hop on the path (here: 1->2 cls3 and 2->3 cls2; 0->1 cls0 is local)", () => {
    expect(countArterialSegments(t, [0, 1, 2, 3])).toBe(2);
  });

  it("a path entirely on locals scores 0", () => {
    expect(countArterialSegments(t, [0, 1])).toBe(0);
  });

  it("a single-node path (no hops at all) scores 0", () => {
    expect(countArterialSegments(t, [0])).toBe(0);
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
