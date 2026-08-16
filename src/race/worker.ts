// Off-main-thread race compute. Loads the routing artifact ONCE (cached
// across every request this worker instance ever receives — RaceController
// creates one Worker per page and keeps it for the page's lifetime), then
// runs whichever roster.ts algorithms a request asks for and posts back
// timed, typed results with the settle order TRANSFERRED (zero-copy), not
// structured-cloned.
//
// This file's onmessage/postMessage glue is deliberately thin. The actual
// per-request work is `handleRequest`, a plain importable async function
// with no worker-global-scope dependency beyond `loadRouting` — everything
// it calls (dijkstraCsr, astarVariant, bidiAstar, bidijkstra, chQuery) is
// already covered by src/algos/*.test.ts, so this file adds almost no
// untested logic of its own. jsdom has no Worker, so `handleRequest` is
// exported for inspection/reuse but not exercised by a dedicated
// worker.test.ts (per the task's own note: the worker itself isn't
// unit-tested — its logic lives in tested pure code); `registry`'s own
// roster-coverage is checked indirectly, from controller.test.ts, via the
// exported `knownAlgoKeys()` below.
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
import { astarVariant, makeHeuristic, type HeuristicKind } from "../algos/astarVariants";
import { maxEdgeSpeedMps, VMAX_SAFETY_MARGIN } from "../algos/astar";
import { bidiAstar } from "../algos/bidiAstar";
import { bidijkstra } from "../algos/bidijkstra";
import { transpose } from "../algos/graph";
import { ROSTER, type RosterEntry } from "./roster";
import type { SearchResult } from "../algos/dijkstra";
import type { Csr, Graph } from "../algos/graph";

/**
 * Every possible request/response key: each roster.ts entry's `workerKey`,
 * plus (for "searchers"-family entries) its `bidiKey` — see roster.ts's own
 * header comment. Plain `string`, not a small closed union like the
 * pre-roster-round `"dijkstra"|"astar"|"bidi"|"ch"` was, because roster.ts
 * itself types workerKey/bidiKey as plain strings (its whole point is to be
 * the SINGLE place those literal values live). This is deliberately NOT the
 * same concept as a racer's stable UI identity (roster.ts's
 * `RosterEntry["id"]`, five values, re-exported by controller.ts as
 * `RacerId`) — a searcher's id never changes, but which Algo key represents
 * it flips between workerKey and bidiKey as the family bidirectional
 * modifier toggles (spec §18.6). controller.ts owns translating between the
 * two; see that file's own header comment for the exact seam.
 */
export type Algo = string;

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

// bidijkstra's and bidiAstar's backward searches need the transposed graph
// — built ONCE (from the same cached `graph` every request already shares)
// and reused, not rebuilt per query. Lazy, not eager alongside
// routingPromise: a race that never requests a `bidi:`-prefixed key should
// never pay this O(n+m) cost at all.
let gRev: Csr | undefined;
function getGRev(graph: Graph): Csr {
  if (!gRev) gRev = transpose(graph.n, graph.fwd);
  return gRev;
}

// astarVariant's and bidiAstar's heuristic ceiling — derived from the
// graph's OWN data (see astar.ts's `maxEdgeSpeedMps` doc for why a fixed
// constant measurably isn't safe enough here), computed ONCE per graph and
// cached exactly like `gRev` above, right next to it: a race that never
// requests an astar-family key should never pay this O(edges) scan either.
// `* VMAX_SAFETY_MARGIN` applied once, here, so both the worker and
// variants.test.ts's real-graph check derive the identical ceiling from the
// identical two building blocks (astar.ts exports both).
let vMax: number | undefined;
function getVMax(graph: Graph): number {
  if (vMax === undefined) vMax = maxEdgeSpeedMps(graph) * VMAX_SAFETY_MARGIN;
  return vMax;
}

/** Copies a SearchResult's settle log into a freshly-allocated, concretely
 * ArrayBuffer-backed typed array before exposing `.buffer`, and shapes the
 * rest into the wire AlgoResult — shared by every registry entry below
 * (dijkstra, every astar variant, every bidi form), which all return the
 * same single-`settled`-array SearchResult shape (CH is the odd one out:
 * two settle logs to merge, see its own branch in handleRequest). The copy
 * matters because SearchResult types `settled` as a bare `Uint32Array`
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

// Registry: one lookup function per non-CH Algo key, BUILT FROM roster.ts —
// never a hand-duplicated key list (see roster.ts's own header comment on
// why it's the single source of truth for workerKey/bidiKey: if a key ever
// changes there, this registry follows with zero code change here). CH is
// intentionally excluded from it (handled specially inside handleRequest
// below: chQuery returns TWO settle logs to merge, a genuinely different
// shape from every other entry's plain SearchResult — it stays its own
// explicit branch, exactly as it already was before this roster round, just
// now the ONLY such branch instead of one of four).
type AlgoFn = (graph: Graph, from: number, to: number) => SearchResult;

function fnFor(id: Exclude<RosterEntry["id"], "ch">, bidi: boolean): AlgoFn {
  if (id === "dijkstra") {
    return bidi
      ? (graph, from, to) => bidijkstra(graph, getGRev(graph), from, to)
      : (graph, from, to) => dijkstraCsr(graph.n, graph.fwd, from, to);
  }
  // astar-straight | astar-weighted | astar-greedy — "astar-".length === 6,
  // and every one of roster.ts's three A* ids follows that exact prefix
  // (roster.test.ts pins the id list), so this cast is safe.
  const kind = id.slice(6) as HeuristicKind;
  return bidi
    ? (graph, from, to) => bidiAstar(kind, graph, getGRev(graph), from, to, getVMax(graph))
    : (graph, from, to) => astarVariant(kind, graph, from, to, makeHeuristic(kind, graph, getVMax(graph), to));
}

const registry: Record<string, AlgoFn> = {};
for (const entry of ROSTER) {
  if (entry.id === "ch") continue; // handled specially in handleRequest, never looked up here
  registry[entry.workerKey] = fnFor(entry.id, false);
  if (entry.bidiKey) registry[entry.bidiKey] = fnFor(entry.id, true);
}

// Pre-warm gating sets (I3 gate fix): which request keys need getVMax/
// getGRev paid before the per-key timing brackets below, derived from
// ROSTER by entry lookup — never `key.includes("astar")` / `key.
// startsWith("bidi:")` substring matching against the key STRING, which
// only happened to work because every current id/prefix spells those
// substrings, not because the registry actually promises to. ASTAR_KEYS is
// every non-dijkstra, non-ch entry's own workerKey + bidiKey (exactly the
// ids `fnFor` routes through `makeHeuristic`/`astarVariant`/`bidiAstar`,
// straight or bidi form, both of which read `getVMax`); BIDI_KEYS is every
// entry's own bidiKey, whichever ones roster.ts actually defines (every
// "searchers" member, dijkstra included — `bidijkstra` needs `getGRev` too,
// even though dijkstra itself never touches `getVMax`).
const ASTAR_KEYS = new Set(
  ROSTER.filter((e) => e.id !== "dijkstra" && e.id !== "ch").flatMap((e) =>
    e.bidiKey ? [e.workerKey, e.bidiKey] : [e.workerKey],
  ),
);
const BIDI_KEYS = new Set(
  ROSTER.map((e) => e.bidiKey).filter((k): k is string => k !== undefined),
);

/** Every key `handleRequest` can resolve, including `"ch"` (special-cased,
 * not actually IN `registry` — see the comment on the loop above). Exported
 * only for controller.test.ts's "registry mapping from roster" check (every
 * roster workerKey/bidiKey resolves to a real handler), so that test
 * asserts against the SAME set handleRequest actually dispatches through
 * rather than re-deriving its own separate expectation of what should be
 * there. */
export function knownAlgoKeys(): Set<string> {
  return new Set(["ch", ...Object.keys(registry)]);
}

/** Runs the requested algorithms and shapes the wire response. Pure aside
 * from the one-time `loadRouting` fetch; exported so it's directly
 * callable/testable without a real Worker. Times each key with
 * `performance.now()` around ONLY its own registry call / chQuery call
 * (excludes routing load and the lazily-cached gRev/vMax derivations below,
 * neither of which should make an algo's FIRST race look artificially
 * slow). */
export async function handleRequest(
  req: RaceRequest,
): Promise<{ response: RaceResponse; transfer: ArrayBuffer[] }> {
  const { graph, ch } = await getRouting(req.dataBase ?? "./data/");
  const results: Partial<Record<Algo, AlgoResult>> = {};
  const transfer: ArrayBuffer[] = [];

  // Pre-warm the two lazily-cached per-graph derivations OUTSIDE every
  // key's own timing bracket below, so the FIRST race that happens to
  // include an astar/bidi racer doesn't have that one-time O(edges) cost
  // (maxEdgeSpeedMps's scan / transpose's rebuild) silently inflate its
  // reported `ms` — same "honest numbers" reasoning the pre-roster-round
  // code had (each was excluded from its own algo's `ms` bracket there
  // too), now generalised across however many astar/bidi keys one request
  // carries. Still skipped entirely when nothing in THIS request needs it
  // — a race with only the two core keys (dijkstra, ch) never pays either.
  // Gated via ASTAR_KEYS/BIDI_KEYS (ROSTER entry lookup, built once above),
  // not a substring test against the key string itself.
  if (req.algos.some((k) => ASTAR_KEYS.has(k))) getVMax(graph);
  if (req.algos.some((k) => BIDI_KEYS.has(k))) getGRev(graph);

  for (const key of req.algos) {
    const t0 = performance.now();
    if (key === "ch") {
      const r = chQuery(ch, req.from, req.to);
      const ms = performance.now() - t0;
      // Concatenate the two settle orders into one buffer for the replay —
      // the caller draws them as a single layered flood — while keeping the
      // counted total exact (settled.length + settledB.length), per the
      // binding resolution: settledCount is never derived from the merged
      // array's own length by coincidence alone, it's the same sum either
      // way.
      const merged = new Uint32Array(r.settled.length + r.settledB.length);
      merged.set(r.settled, 0);
      merged.set(r.settledB, r.settled.length);
      results[key] = {
        dist: r.dist,
        ms,
        relaxed: r.relaxed,
        settledCount: r.settled.length + r.settledB.length,
        settled: merged.buffer,
        path: r.path,
      };
      transfer.push(merged.buffer);
      continue;
    }
    const fn = registry[key];
    if (!fn) continue; // unknown key — defensive only; every real caller derives keys from roster.ts
    const r = fn(graph, req.from, req.to);
    const { result, buffer } = shapeResult(r, performance.now() - t0);
    results[key] = result;
    transfer.push(buffer);
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
