// Off-main-thread race compute. Loads the routing artifact ONCE (cached
// across every request this worker instance ever receives — RaceController
// creates one Worker per page and keeps it for the page's lifetime), then
// runs Dijkstra and/or CH per request and posts back timed, typed results
// with the settle order TRANSFERRED (zero-copy), not structured-cloned.
//
// This file's onmessage/postMessage glue is deliberately thin. The actual
// per-request work is `handleRequest`, a plain importable async function
// with no worker-global-scope dependency beyond `loadRouting` — everything
// it calls (dijkstraCsr, chQuery) is already covered by src/algos/*.test.ts,
// so this file adds almost no untested logic of its own. jsdom has no
// Worker, so `handleRequest` is exported for inspection/reuse but not
// exercised by a dedicated worker.test.ts (per the task's own note: the
// worker itself isn't unit-tested — its logic lives in tested pure code).
//
// `self` is accessed through a cast rather than adding
// `/// <reference lib="webworker" />`: this repo's tsconfig loads the "DOM"
// lib (home.ts, MapView, etc. all need it), and DOM + WebWorker together
// redeclare shared globals (`self` among them) incompatibly — TypeScript
// can't have both libs at once. `Worker` — the MAIN-THREAD handle type,
// already present via the DOM lib — happens to declare the exact
// on/postMessage shape a DedicatedWorkerGlobalScope needs
// (`postMessage(message, transfer)`, `onmessage`), so casting `self`
// through `unknown` to `Worker` gets a correctly-typed handle without a
// second, conflicting lib.

import { loadRouting } from "../data";
import { dijkstraCsr } from "../algos/dijkstra";
import { chQuery } from "../algos/chQuery";
import { astar, maxEdgeSpeedMps, VMAX_SAFETY_MARGIN } from "../algos/astar";
import { bidijkstra } from "../algos/bidijkstra";
import { transpose } from "../algos/graph";
import { haversine } from "../snap";
import type { SearchResult } from "../algos/dijkstra";
import type { Csr, Graph } from "../algos/graph";

export type Algo = "dijkstra" | "astar" | "bidi" | "ch";

export interface RaceRequest {
  id: number;
  from: number;
  to: number;
  algos: Algo[];
  dataBase?: string;
}

export interface AlgoResult {
  dist: number;
  ms: number;
  relaxed: number;
  settledCount: number;
  settled: ArrayBuffer;
  path: number[];
}

export interface RaceResponse {
  id: number;
  results: Partial<Record<Algo, AlgoResult>>;
}

/** Posted back instead of a RaceResponse when `handleRequest` throws (in
 * practice: the one-time `loadRouting` fetch failing) — without this, an
 * uncaught rejection inside the worker's onmessage handler never posts
 * anything back, and the matching `RaceController.request()` promise on the
 * main thread hangs forever. */
export interface RaceErrorResponse {
  id: number;
  error: string;
}

export type WorkerResponse = RaceResponse | RaceErrorResponse;

let routingPromise: ReturnType<typeof loadRouting> | undefined;

/** Loads the routing artifact on the first call and caches the promise for
 * every call after — `base` only matters the first time (later calls reuse
 * whatever's already loading/loaded, even if they pass a different one),
 * which is exactly "loads routing ONCE on first message". */
function getRouting(base: string): ReturnType<typeof loadRouting> {
  if (!routingPromise) routingPromise = loadRouting(base);
  return routingPromise;
}

// bidijkstra's backward search needs the transposed graph — built ONCE
// (from the same cached `graph` every request already shares) and reused,
// not rebuilt per query. Lazy, not eager alongside routingPromise: a race
// that never toggles "bidi" on should never pay this O(n+m) cost at all.
let gRev: Csr | undefined;
function getGRev(graph: Graph): Csr {
  if (!gRev) gRev = transpose(graph.n, graph.fwd);
  return gRev;
}

// astar's heuristic ceiling — derived from the graph's OWN data (see
// astar.ts's `maxEdgeSpeedMps` doc for why a fixed constant measurably
// isn't safe enough here), computed ONCE per graph and cached exactly like
// `gRev` above, right next to it: a race that never toggles "astar" on
// should never pay this O(edges) scan either. `* VMAX_SAFETY_MARGIN`
// applied once, here, so both the worker and variants.test.ts's real-graph
// check derive the identical ceiling from the identical two building
// blocks (astar.ts exports both).
let vMax: number | undefined;
function getVMax(graph: Graph): number {
  if (vMax === undefined) vMax = maxEdgeSpeedMps(graph) * VMAX_SAFETY_MARGIN;
  return vMax;
}

/** Copies a SearchResult's settle log into a freshly-allocated, concretely
 * ArrayBuffer-backed typed array before exposing `.buffer`, and shapes the
 * rest into the wire AlgoResult — shared by dijkstra/astar/bidi below,
 * which all return the same single-`settled`-array SearchResult shape (CH
 * is the odd one out: two settle logs to merge, see its own block). The
 * copy matters because SearchResult types `settled` as a bare `Uint32Array`
 * (buffer type ArrayBufferLike, which admits SharedArrayBuffer), and this
 * wire format promises a plain, transferable ArrayBuffer. */
function shapeResult(r: SearchResult, ms: number): { result: AlgoResult; buffer: ArrayBuffer } {
  const settled = new Uint32Array(r.settled.length);
  settled.set(r.settled);
  return {
    result: { dist: r.dist, ms, relaxed: r.relaxed, settledCount: settled.length, settled: settled.buffer, path: r.path },
    buffer: settled.buffer,
  };
}

/** Runs the requested algorithms and shapes the wire response. Pure aside
 * from the one-time `loadRouting` fetch; exported so it's directly
 * callable/testable without a real Worker. Times each algo with
 * `performance.now()` around the call only (excludes routing load and
 * gRev's one-time transpose, neither of which should make an algo's FIRST
 * race look artificially slow). */
export async function handleRequest(
  req: RaceRequest,
): Promise<{ response: RaceResponse; transfer: ArrayBuffer[] }> {
  const { graph, ch } = await getRouting(req.dataBase ?? "./data/");
  const results: Partial<Record<Algo, AlgoResult>> = {};
  const transfer: ArrayBuffer[] = [];

  if (req.algos.includes("dijkstra")) {
    const t0 = performance.now();
    const r = dijkstraCsr(graph.n, graph.fwd, req.from, req.to);
    const { result, buffer } = shapeResult(r, performance.now() - t0);
    results.dijkstra = result;
    transfer.push(buffer);
  }

  if (req.algos.includes("astar")) {
    const to = req.to;
    // Heuristic ceiling derived from THIS graph's own edges (getVMax,
    // above), not a fixed constant — built here, not inside astar.ts,
    // since astar() takes `h` as a parameter and stays agnostic to how the
    // caller derives it. Excluded from the `ms` bracket below: it's a
    // one-time (cached) scan, same reasoning as gRev's transpose.
    const speed = getVMax(graph);
    const h = (v: number) => haversine(graph.lon[v], graph.lat[v], graph.lon[to], graph.lat[to]) / speed;
    const t0 = performance.now();
    const r = astar(graph, req.from, req.to, h);
    const { result, buffer } = shapeResult(r, performance.now() - t0);
    results.astar = result;
    transfer.push(buffer);
  }

  if (req.algos.includes("bidi")) {
    const rev = getGRev(graph);
    const t0 = performance.now();
    const r = bidijkstra(graph, rev, req.from, req.to);
    const { result, buffer } = shapeResult(r, performance.now() - t0);
    results.bidi = result;
    transfer.push(buffer);
  }

  if (req.algos.includes("ch")) {
    const t0 = performance.now();
    const r = chQuery(ch, req.from, req.to);
    const ms = performance.now() - t0;
    // Concatenate the two settle orders into one buffer for the replay —
    // the caller draws them as a single layered flood — while keeping the
    // counted total exact (settled.length + settledB.length), per the
    // binding resolution: settledCount is never derived from the merged
    // array's own length by coincidence alone, it's the same sum either way.
    const merged = new Uint32Array(r.settled.length + r.settledB.length);
    merged.set(r.settled, 0);
    merged.set(r.settledB, r.settled.length);
    results.ch = {
      dist: r.dist,
      ms,
      relaxed: r.relaxed,
      settledCount: r.settled.length + r.settledB.length,
      settled: merged.buffer,
      path: r.path,
    };
    transfer.push(merged.buffer);
  }

  return { response: { id: req.id, results }, transfer };
}

const ctx = self as unknown as Worker;
ctx.onmessage = (e: MessageEvent<RaceRequest>) => {
  handleRequest(e.data)
    .then(({ response, transfer }) => {
      ctx.postMessage(response, transfer);
    })
    .catch((err: unknown) => {
      // Always post SOMETHING back for this id — an uncaught rejection
      // here would otherwise leave the main thread's matching request()
      // promise pending forever (a silent hang, not a visible failure).
      const message = err instanceof Error ? err.message : String(err);
      const errorResponse: RaceErrorResponse = { id: e.data.id, error: message };
      ctx.postMessage(errorResponse);
    });
};
