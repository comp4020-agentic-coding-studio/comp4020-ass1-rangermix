import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { buildCh, type Ch } from "../src/algos/chBuild";
import { transpose, type Graph } from "../src/algos/graph";
import { dijkstraCsr } from "../src/algos/dijkstra";
import { chQuery } from "../src/algos/chQuery";
import { chFromArtifact, graphFromArtifact, type RoutingArtifact } from "../src/data-node";
import { decodeToytown, type Toytown, type ToytownArtifact } from "../src/toys/toytown";
import { findDefaultClimbPair } from "../src/toys/climb";
import { findFarPair } from "../src/toys/flood";

// The data-layer contracts: CH<->Dijkstra equivalence on the SHIPPED
// Canberra graph, the settled-nodes headline ratio, and the payload budget.
// These need the committed public/data/*.json artifacts to exist, which is
// why they're skipped (not failed) when they're absent — e.g. before the
// pipeline task has run in a fresh clone that predates them.

const DATA = resolve("public/data");
const have = ["render.json", "routing.json", "meta.json"].every((f) =>
  existsSync(resolve(DATA, f)),
);
const haveToytown = have && existsSync(resolve(DATA, "toytown.json"));

interface MetaArtifact {
  bench: { from: number; to: number; dds: number; dj: number; ch: number }[];
}

describe.skipIf(!have)("shipped Canberra artifacts", () => {
  // describe.skipIf still EXECUTES this callback body while vitest collects
  // tests (it only skips the `it`s within it) — so the artifact reads must
  // live in beforeAll, not as top-level statements here, or they'd throw
  // ENOENT the moment `have` is false and defeat the skip entirely.
  let routing: RoutingArtifact;
  let meta: MetaArtifact;
  let graph: Graph;
  let ch: Ch;

  beforeAll(() => {
    routing = JSON.parse(readFileSync(resolve(DATA, "routing.json"), "utf8"));
    meta = JSON.parse(readFileSync(resolve(DATA, "meta.json"), "utf8"));
    graph = graphFromArtifact(routing);
    ch = chFromArtifact(routing);
  });

  it("stays inside the 4 MB gzipped budget", () => {
    let total = 0;
    for (const f of ["render.json", "routing.json", "meta.json"])
      total += gzipSync(readFileSync(resolve(DATA, f))).length;
    expect(total).toBeLessThan(4 * 1024 * 1024);
  });

  it("CH distance equals Dijkstra on all 300 benchmark pairs", () => {
    for (const b of meta.bench) {
      const got = chQuery(ch, b.from, b.to);
      expect(Math.round(got.dist * 10), `${b.from}->${b.to}`).toBe(b.dds);
    }
  });

  it("re-verifies 30 pairs against a fresh in-test Dijkstra", () => {
    for (const b of meta.bench.slice(0, 30)) {
      const dj = dijkstraCsr(graph.n, graph.fwd, b.from, b.to);
      expect(Math.round(dj.dist * 10)).toBe(b.dds);
    }
  });

  it("headline claim: mean CH settled ≤ 5% of Dijkstra settled", () => {
    const bench = meta.bench as { dj: number; ch: number }[];
    const meanDj = bench.reduce((s, b) => s + b.dj, 0) / bench.length;
    const meanCh = bench.reduce((s, b) => s + b.ch, 0) / bench.length;
    expect(meanCh / meanDj).toBeLessThan(0.05);
  });
});

describe.skipIf(have)("artifacts missing", () => {
  it.todo("run pnpm data:fetch && pnpm data:build, commit public/data");
});

// The toytown-layer contracts (Task F4, design spec §14.8; re-cut to the
// Northbourne Avenue corridor for §16.12): the small real-street subgraph
// that replaces the hand-made 12-node mini-town under the /how/ toys. Same
// skip-if-absent pattern as above, gated on the committed
// public/data/toytown.json existing (and — via `have` — the main artifacts
// too, since the combined-budget test below reads all four files).
describe.skipIf(!haveToytown)("toytown artifact (Northbourne-corridor /how/ subgraph)", () => {
  let artifact: ToytownArtifact;
  let toytown: Toytown;

  beforeAll(() => {
    artifact = JSON.parse(readFileSync(resolve(DATA, "toytown.json"), "utf8"));
    toytown = decodeToytown(artifact);
  });

  it("has between 40 and 80 nodes — the design spec's toy-graph target range", () => {
    expect(artifact.n).toBeGreaterThanOrEqual(40);
    expect(artifact.n).toBeLessThanOrEqual(80);
  });

  it("is strongly connected: node 0 reaches every node, and every node reaches node 0", () => {
    const { graph } = toytown;
    // Forward reachability from 0 (to=-1 means "don't stop early", same
    // convention src/toys/minitown.test.ts already uses for MINITOWN).
    const fwd = dijkstraCsr(graph.n, graph.fwd, 0, -1);
    expect(new Set(fwd.settled).size).toBe(graph.n);
    // Backward reachability from 0, via the transposed graph — "every node
    // reaches 0" on the original graph is exactly "0 reaches every node" on
    // the transpose. Forward + backward reachability from the SAME node
    // together prove strong connectivity (any u, v: u -> 0 via the
    // transpose result, 0 -> v via the forward result, so u -> v).
    const rev = transpose(graph.n, graph.fwd);
    const bwd = dijkstraCsr(graph.n, rev, 0, -1);
    expect(new Set(bwd.settled).size).toBe(graph.n);
  });

  it("CH distance equals Dijkstra distance for every ordered pair (exhaustive: n <= 80)", () => {
    const { graph } = toytown;
    const ch = buildCh(graph);
    for (let a = 0; a < graph.n; a++) {
      for (let b = 0; b < graph.n; b++) {
        if (a === b) continue;
        const dj = dijkstraCsr(graph.n, graph.fwd, a, b);
        const chRes = chQuery(ch, a, b);
        expect(chRes.dist, `${a}->${b}: CH unreachable`).toBeLessThan(Infinity);
        expect(Math.round(chRes.dist * 10), `${a}->${b}`).toBe(Math.round(dj.dist * 10));
      }
    }
  });

  it("keeps public/data's total gzipped size, INCLUDING toytown.json, under the 4 MB budget", () => {
    let total = 0;
    for (const f of ["render.json", "routing.json", "meta.json", "toytown.json"])
      total += gzipSync(readFileSync(resolve(DATA, f))).length;
    expect(total).toBeLessThan(4 * 1024 * 1024);
  });

  // F5 regression sensor (design spec §14.10 ch3): the climb toy's DEFAULT
  // pair is found live by scanning the real graph for the first ordered
  // pair whose winning path traverses a shortcut (never a hardcoded node
  // index — see src/toys/climb.ts's findDefaultClimbPair and mountClimb's
  // own dev-loud throw if this ever comes up empty in a browser). This test
  // is the SAME check run against the SHIPPED artifact in CI, so an
  // artifact regeneration that broke chapter 3's whole premise fails here
  // instead of only surfacing live in a browser.
  it("has at least one ordered pair whose CH winning path traverses a real shortcut (the climb toy's default-pair search must never come up empty)", () => {
    const ch = buildCh(toytown.graph);
    const pair = findDefaultClimbPair(ch);
    expect(pair).not.toBeNull();
  });

  // F5 sensor (design spec §14.10 ch1): the flood toy's default "far pair"
  // (a double-sweep from an arbitrary node — see src/toys/flood.ts's
  // findFarPair) should genuinely exercise "Dijkstra floods the whole
  // town" on the real graph, not settle for a handful of nearby
  // intersections.
  it("findFarPair's default pair settles a substantial majority of the graph", () => {
    const { from, to } = findFarPair(toytown.graph);
    expect(from).not.toBe(to);
    const r = dijkstraCsr(toytown.graph.n, toytown.graph.fwd, from, to);
    expect(r.settled.length).toBeGreaterThanOrEqual(Math.ceil(toytown.graph.n * 0.5));
  });

  // G4 sensor (design spec §16.12, 2026-08-16 polish round): the toytown cut
  // must be a REAL hierarchy — a genuine arterial (cls >= 2: secondary,
  // primary, trunk or motorway in build.ts's CLS table) feeding a
  // majority-local grid — not another uniform residential block like the
  // ANU-campus cut this one replaced (user feedback: "use a place with
  // clear hierarchy of roads... [ANU is] all small streets, no visible
  // arterial spine"). Pinned here so a future re-cut can't regress it back
  // to an all-local box. `cls` isn't declared on ToytownArtifact (src/data.ts)
  // since no toy reads it — it rides along on each edge purely so this
  // sensor can check the cut against the SHIPPED artifact in CI, which
  // never has the gitignored cache a re-derivation would need (see
  // build.ts's toytownHierarchyStats and TOYTOWN_BBOX's own comment for the
  // tuning story). Cast locally rather than widening the shared type, since
  // nothing else needs the field.
  it("is hierarchy-rich: at least one cls>=2 (secondary/primary/trunk/motorway) edge, and at least 50% cls-0 (local street) edges", () => {
    const edges = artifact.edges as unknown as { cls: number }[];
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.some((e) => e.cls >= 2)).toBe(true);
    const cls0 = edges.filter((e) => e.cls === 0).length;
    expect(cls0 / edges.length).toBeGreaterThanOrEqual(0.5);
  });
});

describe.skipIf(haveToytown)("toytown artifact missing", () => {
  it.todo("run pnpm data:build (needs the cached extract already fetched), commit public/data/toytown.json");
});
