import { describe, expect, it } from "vitest";
import { buildCh } from "../algos/chBuild";
import { chQuery } from "../algos/chQuery";
import {
  buildSteps,
  computeBenchMeans,
  formatBenchEcho,
  formatRaceEcho,
  incomingEdges,
  parseLastRace,
  rankY,
} from "./climb";
import { MINITOWN } from "./minitown";

// The climb toy's whole animation is scripted from ONE real chQuery run —
// these tests pin that the derived step script is actually faithful to
// that run (never a hand-authored substitute), using the same real
// buildCh/chQuery MINITOWN pipeline every other /how/ toy tests against.

describe("rankY: contraction rank -> vertical position", () => {
  it("higher rank draws higher on screen (smaller y)", () => {
    expect(rankY(5)).toBeLessThan(rankY(2));
    expect(rankY(0)).toBeGreaterThan(rankY(1));
  });

  it("is a straight linear lift: equal rank steps move equal pixel amounts", () => {
    const step = rankY(0) - rankY(1);
    expect(step).toBeGreaterThan(0);
    expect(rankY(6) - rankY(7)).toBe(step);
  });
});

describe("incomingEdges", () => {
  it("indexes every CSR edge under its destination node, preserving the total count", () => {
    const ch = buildCh(MINITOWN.graph);
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

describe("buildSteps: the climb toy's animation script, derived from a real chQuery(A, L) run", () => {
  const ch = buildCh(MINITOWN.graph);
  const from = MINITOWN.names.indexOf("A");
  const to = MINITOWN.names.indexOf("L");
  const result = chQuery(ch, from, to);

  it("A -> L is reachable — the sanity check the toy's own dev-time assertion relies on", () => {
    expect(Number.isFinite(result.dist)).toBe(true);
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
