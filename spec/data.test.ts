import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import type { Ch } from "../src/algos/chBuild";
import type { Graph } from "../src/algos/graph";
import { dijkstraCsr } from "../src/algos/dijkstra";
import { chQuery } from "../src/algos/chQuery";
import { chFromArtifact, graphFromArtifact, type RoutingArtifact } from "../src/data-node";

// The data-layer contracts: CH<->Dijkstra equivalence on the SHIPPED
// Canberra graph, the settled-nodes headline ratio, and the payload budget.
// These need the committed public/data/*.json artifacts to exist, which is
// why they're skipped (not failed) when they're absent — e.g. before the
// pipeline task has run in a fresh clone that predates them.

const DATA = resolve("public/data");
const have = ["render.json", "routing.json", "meta.json"].every((f) =>
  existsSync(resolve(DATA, f)),
);

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
