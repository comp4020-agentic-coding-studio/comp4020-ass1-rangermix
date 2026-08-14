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

export type Algo = "dijkstra" | "ch";

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

/** Runs the requested algorithms and shapes the wire response. Pure aside
 * from the one-time `loadRouting` fetch; exported so it's directly
 * callable/testable without a real Worker. Times each algo with
 * `performance.now()` around the call only (excludes routing load, which
 * only happens once and would otherwise make the first race look slow). */
export async function handleRequest(
  req: RaceRequest,
): Promise<{ response: RaceResponse; transfer: ArrayBuffer[] }> {
  const { graph, ch } = await getRouting(req.dataBase ?? "./data/");
  const results: Partial<Record<Algo, AlgoResult>> = {};
  const transfer: ArrayBuffer[] = [];

  if (req.algos.includes("dijkstra")) {
    const t0 = performance.now();
    const r = dijkstraCsr(graph.n, graph.fwd, req.from, req.to);
    const ms = performance.now() - t0;
    // Copy into a freshly-allocated, concretely-ArrayBuffer-backed typed
    // array before exposing `.buffer`: dijkstra.ts's own SearchResult types
    // `settled` as a bare `Uint32Array` (buffer type ArrayBufferLike, which
    // admits SharedArrayBuffer), and this wire format promises a plain,
    // transferable ArrayBuffer.
    const settled = new Uint32Array(r.settled.length);
    settled.set(r.settled);
    results.dijkstra = {
      dist: r.dist,
      ms,
      relaxed: r.relaxed,
      settledCount: settled.length,
      settled: settled.buffer,
      path: r.path,
    };
    transfer.push(settled.buffer);
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
