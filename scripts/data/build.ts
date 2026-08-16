// Turns parsed OSM ways into a routing graph: split at junctions, weight each
// hop by travel time, expand oneway semantics, keep only the largest
// strongly-connected component, then contract degree-2 through-nodes to a
// fixed point. Every stage up to buildRoutingGraph is a pure function over
// in-memory data — no network, no filesystem — so it's exercised entirely by
// fixtures/mini.json in build.test.ts.
//
// Below that: emit() runs the CH build over the real routing graph and
// writes the three frozen artifacts (public/data/{render,routing,meta}.json);
// emitToytown() cuts a second, much smaller bbox-restricted subgraph through
// the SAME buildRoutingGraph pipeline and writes public/data/toytown.json
// (see that function's own comment). The CLI main() at the bottom wires
// fetch.ts's cached Overpass extract through parseOsm -> buildRoutingGraph
// -> emit() and -> cutToytown() -> emitToytown() when this file is run
// directly (`pnpm data:build`).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { haversineM, parseOsm, SPEEDS, type OsmWay, type OverpassJson, type ParsedOsm } from "./osm.ts";
import { buildCsr, type Graph } from "../../src/algos/graph.ts";
import { buildChOrdered } from "../../src/algos/chBuild.ts";
import { dijkstraCsr } from "../../src/algos/dijkstra.ts";
import { chQuery } from "../../src/algos/chQuery.ts";

export { haversineM, parseOsm, SPEEDS };
export type { OsmWay, ParsedOsm, OverpassJson, OverpassElement, OverpassNode, OverpassWay } from "./osm.ts";

export interface PipeEdge {
  from: number; to: number; w: number; cls: number; geometry: [number, number][];
}

export interface RoutingGraph {
  lon: number[]; lat: number[]; edges: PipeEdge[];
}

// Render class buckets (later task styles the map by this): 0 =
// residential/living_street/unclassified, 1 = tertiary(+link), 2 =
// secondary/primary(+link), 3 = trunk/motorway(+link).
const CLS: Record<string, number> = {
  residential: 0, living_street: 0, unclassified: 0,
  tertiary: 1, tertiary_link: 1,
  secondary: 2, secondary_link: 2, primary: 2, primary_link: 2,
  trunk: 3, trunk_link: 3, motorway: 3, motorway_link: 3,
};

// A node is a junction (a real graph node, as opposed to a shape point
// inside a segment) if it's a way endpoint, or referenced more than once
// overall — whether that's twice within one way or once each across two
// separate ways sharing it.
function findJunctions(ways: OsmWay[]): Set<number> {
  const refCount = new Map<number, number>();
  const junctions = new Set<number>();
  for (const way of ways) {
    if (way.refs.length === 0) continue;
    junctions.add(way.refs[0]);
    junctions.add(way.refs[way.refs.length - 1]);
    for (const id of way.refs) refCount.set(id, (refCount.get(id) ?? 0) + 1);
  }
  for (const [id, count] of refCount) if (count > 1) junctions.add(id);
  return junctions;
}

// Splits one way into segments between consecutive junction nodes, and
// expands each segment into 1 (oneway) or 2 (two-way) directed PipeEdges
// using original OSM node ids for from/to — buildRoutingGraph reindexes to
// compact array indices once the full edge set is known.
function edgesForWay(
  way: OsmWay, junctions: Set<number>, nodes: Map<number, [number, number]>,
): PipeEdge[] {
  const cls = CLS[way.highway];
  const speedKmh = way.maxspeed ?? SPEEDS[way.highway];
  const edges: PipeEdge[] = [];
  let segStart = 0;
  for (let i = 1; i < way.refs.length; i++) {
    if (!junctions.has(way.refs[i])) continue;
    const segRefs = way.refs.slice(segStart, i + 1);
    const geometry: [number, number][] = segRefs.map((id) => {
      const c = nodes.get(id);
      if (!c) throw new Error(`way ${way.id} references unknown node ${id}`);
      return c;
    });
    let meters = 0;
    for (let h = 1; h < geometry.length; h++)
      meters += haversineM(
        geometry[h - 1][0], geometry[h - 1][1], geometry[h][0], geometry[h][1],
      );
    const w = meters / (speedKmh / 3.6);
    const from = segRefs[0];
    const to = segRefs[segRefs.length - 1];
    if (way.oneway === "yes") {
      edges.push({ from, to, w, cls, geometry });
    } else if (way.oneway === "-1") {
      // runs against ref order: emit the single edge reversed
      edges.push({ from: to, to: from, w, cls, geometry: [...geometry].reverse() });
    } else {
      edges.push({ from, to, w, cls, geometry });
      edges.push({ from: to, to: from, w, cls, geometry: [...geometry].reverse() });
    }
    segStart = i;
  }
  return edges;
}

// Iterative post-order DFS (Kosaraju pass 1) — explicit stack so a ~100k-node
// real graph can't blow the call stack.
function postOrder(n: number, adj: number[][]): number[] {
  const visited = new Uint8Array(n);
  const order: number[] = [];
  for (let start = 0; start < n; start++) {
    if (visited[start]) continue;
    const stack: { node: number; i: number }[] = [{ node: start, i: 0 }];
    visited[start] = 1;
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const neighbors = adj[top.node];
      if (top.i < neighbors.length) {
        const next = neighbors[top.i++];
        if (!visited[next]) { visited[next] = 1; stack.push({ node: next, i: 0 }); }
      } else {
        order.push(top.node);
        stack.pop();
      }
    }
  }
  return order;
}

// Kosaraju pass 2: flood-fill the transposed graph in reverse finish order —
// each fill is one strongly-connected component.
function componentsOf(
  n: number, revAdj: number[][], order: number[],
): { comp: Int32Array; sizes: number[] } {
  const comp = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  for (let i = order.length - 1; i >= 0; i--) {
    const start = order[i];
    if (comp[start] !== -1) continue;
    const id = sizes.length;
    let size = 0;
    const stack: number[] = [start];
    comp[start] = id;
    while (stack.length > 0) {
      const u = stack.pop()!;
      size++;
      for (const v of revAdj[u]) if (comp[v] === -1) { comp[v] = id; stack.push(v); }
    }
    sizes.push(size);
  }
  return { comp, sizes };
}

/** Iterative Kosaraju SCC over a dense 0..n-1 index space; returns the node
 * indices belonging to the single largest strongly-connected component. */
function largestSccIndices(n: number, edges: PipeEdge[]): Set<number> {
  const adj: number[][] = Array.from({ length: n }, () => []);
  const revAdj: number[][] = Array.from({ length: n }, () => []);
  for (const e of edges) { adj[e.from].push(e.to); revAdj[e.to].push(e.from); }
  const order = postOrder(n, adj);
  const { comp, sizes } = componentsOf(n, revAdj, order);
  let best = 0;
  for (let c = 1; c < sizes.length; c++) if (sizes[c] > sizes[best]) best = c;
  const keep = new Set<number>();
  for (let v = 0; v < n; v++) if (comp[v] === best) keep.add(v);
  return keep;
}

interface LiveEdge { w: number; cls: number; geometry: [number, number][] }
// node -> neighbor -> parallel edges between that pair (almost always length
// 1; kept as a list so contraction can tell a genuine parallel edge apart
// from the single-edge shape the through-patterns require).
type Adj = Map<number, Map<number, LiveEdge[]>>;

function addLiveEdge(out: Adj, inn: Adj, from: number, to: number, e: LiveEdge): void {
  if (!out.has(from)) out.set(from, new Map());
  const row = out.get(from)!;
  if (!row.has(to)) row.set(to, []);
  row.get(to)!.push(e);
  if (!inn.has(to)) inn.set(to, new Map());
  const rowIn = inn.get(to)!;
  if (!rowIn.has(from)) rowIn.set(from, []);
  rowIn.get(from)!.push(e);
}

function removeLiveEdge(out: Adj, inn: Adj, from: number, to: number, e: LiveEdge): void {
  const arr = out.get(from)?.get(to);
  if (arr) {
    const i = arr.indexOf(e);
    if (i >= 0) arr.splice(i, 1);
    if (arr.length === 0) out.get(from)!.delete(to);
  }
  const arrIn = inn.get(to)?.get(from);
  if (arrIn) {
    const i = arrIn.indexOf(e);
    if (i >= 0) arrIn.splice(i, 1);
    if (arrIn.length === 0) inn.get(to)!.delete(from);
  }
}

// Does v match the two-way through-pattern ({u->v,v->u,v->w,w->v}, u != w)
// or the oneway through-pattern ({u->v,v->w}, u != w)? "Exactly" means no
// parallel edges at v either — a duplicate disqualifies it.
function throughPattern(
  out: Adj, inn: Adj, v: number,
): { u: number; w: number; twoWay: boolean } | null {
  const outRow = out.get(v);
  const inRow = inn.get(v);
  // A self-loop at v (v->v — a closed OSM way with no other junction on it,
  // e.g. an unbranched roundabout) makes v its own neighbor, which breaks
  // BOTH patterns' "exactly two/one DISTINCT other node(s)" assumption:
  // outKeys/inKeys below would include v itself, u/w could come out equal
  // to v, and the removeLiveEdge/addLiveEdge pair below corrupts its own
  // out.get(v)/inn.get(v) bookkeeping (self-referential row mutated out
  // from under itself) and throws. It's also the semantically correct
  // call, not just a crash workaround: traversing the loop is an optional
  // detour, not a mandatory through-hop, so folding its length into a
  // straight-line shortcut would silently misweight every route past v.
  // Leave v as a permanent survivor instead — its self-loop and other
  // edges just pass through to the final graph unmerged.
  if (outRow?.has(v) || inRow?.has(v)) return null;
  const outKeys = outRow ? [...outRow.keys()] : [];
  const inKeys = inRow ? [...inRow.keys()] : [];
  if (
    outKeys.length === 2 && inKeys.length === 2 &&
    outKeys.every((k) => outRow!.get(k)!.length === 1) &&
    inKeys.every((k) => inRow!.get(k)!.length === 1)
  ) {
    const outSet = new Set(outKeys);
    const inSet = new Set(inKeys);
    if (outSet.size === 2 && [...outSet].every((k) => inSet.has(k))) {
      const [u, w] = outKeys;
      if (u !== w) return { u, w, twoWay: true };
    }
  }
  if (
    outKeys.length === 1 && inKeys.length === 1 &&
    outRow!.get(outKeys[0])!.length === 1 && inRow!.get(inKeys[0])!.length === 1
  ) {
    const w = outKeys[0];
    const u = inKeys[0];
    if (u !== w) return { u, w, twoWay: false };
  }
  return null;
}

function mergeGeometry(a: [number, number][], b: [number, number][]): [number, number][] {
  return [...a, ...b.slice(1)]; // drop b's first point: it duplicates a's last (both are v)
}

// Repeatedly removes through-nodes, merging their two edges into one direct
// edge (summed weight, concatenated geometry, min cls), until no node
// matches either pattern. Operates on the (possibly sparse) SCC-surviving
// index space; nodeIds may have gaps and that's fine — everything here is
// Map/Set-keyed rather than dense-array-indexed.
function contractChains(
  nodeIds: Iterable<number>, edges: PipeEdge[],
): { survivors: Set<number>; edges: PipeEdge[] } {
  const out: Adj = new Map();
  const inn: Adj = new Map();
  const survivors = new Set(nodeIds);
  for (const e of edges) addLiveEdge(out, inn, e.from, e.to, { w: e.w, cls: e.cls, geometry: e.geometry });

  let changed = true;
  while (changed) {
    changed = false;
    for (const v of survivors) {
      const pat = throughPattern(out, inn, v);
      if (!pat) continue;
      const { u, w, twoWay } = pat;
      const uv = inn.get(v)!.get(u)![0];
      const vw = out.get(v)!.get(w)![0];
      removeLiveEdge(out, inn, u, v, uv);
      removeLiveEdge(out, inn, v, w, vw);
      addLiveEdge(out, inn, u, w, {
        w: uv.w + vw.w, cls: Math.min(uv.cls, vw.cls),
        geometry: mergeGeometry(uv.geometry, vw.geometry),
      });
      if (twoWay) {
        const vu = out.get(v)!.get(u)![0];
        const wv = inn.get(v)!.get(w)![0];
        removeLiveEdge(out, inn, v, u, vu);
        removeLiveEdge(out, inn, w, v, wv);
        addLiveEdge(out, inn, w, u, {
          w: wv.w + vu.w, cls: Math.min(wv.cls, vu.cls),
          geometry: mergeGeometry(wv.geometry, vu.geometry),
        });
      }
      out.delete(v);
      inn.delete(v);
      survivors.delete(v);
      changed = true;
    }
  }

  const finalEdges: PipeEdge[] = [];
  for (const [from, row] of out)
    for (const [to, arr] of row)
      for (const e of arr) finalEdges.push({ from, to, w: e.w, cls: e.cls, geometry: e.geometry });
  return { survivors, edges: finalEdges };
}

/** Junction-splits, weights, oneway-expands, SCC-filters, and chain-contracts
 * parsed OSM ways into the final routing graph (compact node indices). */
export function buildRoutingGraph(parsed: ParsedOsm): RoutingGraph {
  const junctions = findJunctions(parsed.ways);
  const rawEdges = parsed.ways.flatMap((way) => edgesForWay(way, junctions, parsed.nodes));

  // Assign dense temp indices (0..n-1) to every OSM node id touched by an
  // edge — SCC needs array-indexable adjacency.
  const touched: number[] = [];
  const idToTemp = new Map<number, number>();
  for (const e of rawEdges)
    for (const id of [e.from, e.to])
      if (!idToTemp.has(id)) { idToTemp.set(id, touched.length); touched.push(id); }
  const indexedEdges = rawEdges.map((e) => ({
    ...e, from: idToTemp.get(e.from)!, to: idToTemp.get(e.to)!,
  }));

  const keep = largestSccIndices(touched.length, indexedEdges);
  const sccEdges = indexedEdges.filter((e) => keep.has(e.from) && keep.has(e.to));

  const { survivors, edges: contracted } = contractChains(keep, sccEdges);

  // Final compaction: only surviving temp indices make it into lon/lat.
  const finalOrder = [...survivors].sort((a, b) => a - b);
  const finalIndex = new Map(finalOrder.map((tempIdx, i) => [tempIdx, i]));
  const lon: number[] = [];
  const lat: number[] = [];
  for (const tempIdx of finalOrder) {
    const coord = parsed.nodes.get(touched[tempIdx])!;
    lon.push(coord[0]);
    lat.push(coord[1]);
  }
  const edges: PipeEdge[] = contracted.map((e) => ({
    ...e, from: finalIndex.get(e.from)!, to: finalIndex.get(e.to)!,
  }));

  return { lon, lat, edges };
}

// ---------------------------------------------------------------------
// emit(): CH-build the routing graph and write the three frozen artifacts.
//
// Coordinates and weights are quantized to the shipped grid FIRST, then
// immediately dequantized — every float used from that point on (the Graph
// the CH build and the benchmark run on) is bit-identical to what a decoder
// (src/data-node.ts) reconstructs from the artifacts later, so the
// exact-equality assertions in spec/data.test.ts can never drift by a
// rounding hair. Coordinates: 1e-5°, integer, relative to this routing
// graph's own bbox min corner. Weights: deciseconds, `Math.max(1, ...)` so
// no edge ever quantizes to zero.
// ---------------------------------------------------------------------

const COORD_SCALE = 1e5; // 1e-5 degree grid, matches render.json's line encoding

// mulberry32 — seeded RNG so the benchmark pairs are reproducible (same
// generator as src/algos/*.test.ts).
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function boundingBox(points: Iterable<readonly [number, number]>): [number, number, number, number] {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const [lon, lat] of points) {
    if (lon < minLon) minLon = lon;
    if (lat < minLat) minLat = lat;
    if (lon > maxLon) maxLon = lon;
    if (lat > maxLat) maxLat = lat;
  }
  return [minLon, minLat, maxLon, maxLat];
}

function fmtKB(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export interface EmitResult {
  nodes: number;
  originalEdges: number;
  shortcuts: number;
  buildMs: number;
  meanDjSettled: number;
  meanChSettled: number;
  settledRatio: number;
  gz: { render: number; routing: number; meta: number; total: number };
}

/** Runs the CH build and the 300-pair benchmark on `g`, and writes
 * render.json, routing.json, meta.json into `outDir`. Throws — aborting the
 * whole emit — if any benchmark pair's CH distance disagrees with
 * Dijkstra's: that's a correctness bug to surface loudly, never something
 * to paper over by re-rolling past it. */
export function emit(g: RoutingGraph, outDir: string): EmitResult {
  const n = g.lon.length;
  const pipeEdges = g.edges;

  const allPoints: [number, number][] = [];
  for (let i = 0; i < n; i++) allPoints.push([g.lon[i], g.lat[i]]);
  for (const e of pipeEdges) for (const p of e.geometry) allPoints.push(p);
  const bbox = boundingBox(allPoints);
  const [minLon, minLat] = bbox;
  const qLon = (lon: number) => Math.round((lon - minLon) * COORD_SCALE);
  const qLat = (lat: number) => Math.round((lat - minLat) * COORD_SCALE);
  const dqLon = (q: number) => minLon + q / COORD_SCALE;
  const dqLat = (q: number) => minLat + q / COORD_SCALE;

  const nodeQLon: number[] = Array.from({ length: n });
  const nodeQLat: number[] = Array.from({ length: n });
  const nodeLon = new Float64Array(n); // dequantized: what the Graph is built on
  const nodeLat = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    nodeQLon[i] = qLon(g.lon[i]);
    nodeQLat[i] = qLat(g.lat[i]);
    nodeLon[i] = dqLon(nodeQLon[i]);
    nodeLat[i] = dqLat(nodeQLat[i]);
  }
  const dequantW = pipeEdges.map((e) => Math.max(1, Math.round(e.w * 10)) / 10);

  // ---- the Graph the CH build & benchmark actually run on ----
  const csrEdges = pipeEdges.map((e, i) => ({ from: e.from, to: e.to, w: dequantW[i] }));
  const fwd = buildCsr(n, csrEdges);
  const graph: Graph = { n, lon: nodeLon, lat: nodeLat, fwd };

  console.log(`Building CH over ${n.toLocaleString()} nodes, ${pipeEdges.length.toLocaleString()} edges...`);
  const t0 = Date.now();
  const { ch, shortcutCount } = buildChOrdered(graph);
  const buildMs = Date.now() - t0;
  console.log(`CH build done in ${buildMs.toLocaleString()} ms — ${shortcutCount.toLocaleString()} shortcuts.`);

  // ---- render.json: one line per PipeEdge, same order (renderOf below
  // links routing.json's original edges back to these by index) ----
  const denom = Math.max(1, n - 1);
  // MAX, not MIN: an edge's percentile is the rank of its MORE important
  // endpoint. MIN severs arterial chains at whichever endpoint the
  // contraction heuristic happened to rank lower — two consecutive hops of
  // the same physical road (A-B, B-C) both get capped by node B's rank even
  // when B sits on a continuous major corridor, so the "top k%" reveal
  // rendered as disconnected dust instead of the promised connected spine
  // (see the hierarchy toy's own percentile calibration, which retains the
  // right FRACTION of lines either way — this only changes WHICH lines,
  // toward ones that chain together).
  const pctOf = (from: number, to: number) =>
    Math.floor((255 * Math.max(ch.rank[from], ch.rank[to])) / denom);
  const lines: number[][] = pipeEdges.map((e) => {
    const pts = e.geometry;
    const x0 = qLon(pts[0][0]);
    const y0 = qLat(pts[0][1]);
    const line: number[] = [e.cls, pctOf(e.from, e.to), x0, y0];
    let px = x0, py = y0;
    for (let i = 1; i < pts.length; i++) {
      const x = qLon(pts[i][0]);
      const y = qLat(pts[i][1]);
      line.push(x - px, y - py);
      px = x; py = y;
    }
    return line;
  });
  const renderJson = { bbox, lines };

  // ---- routing.json: full augmented ChEdge[], originals then shortcuts.
  // bbox travels with routing.json too (not just render.json) because
  // lon/lat below are quantized relative to it — see src/data-node.ts. ----
  const m = ch.edges.length;
  const rFrom: number[] = Array.from({ length: m });
  const rTo: number[] = Array.from({ length: m });
  const rW: number[] = Array.from({ length: m });
  const rChildA: number[] = Array.from({ length: m });
  const rChildB: number[] = Array.from({ length: m });
  const rSrc: number[] = Array.from({ length: m });
  const renderOf: number[] = Array.from({ length: m });
  let originalEdges = 0;
  ch.edges.forEach((e, i) => {
    rFrom[i] = e.from; rTo[i] = e.to;
    rW[i] = Math.max(1, Math.round(e.w * 10));
    rChildA[i] = e.childA; rChildB[i] = e.childB; rSrc[i] = e.src;
    if (e.childA < 0) { renderOf[i] = e.src; originalEdges++; } else { renderOf[i] = -1; }
  });
  const routingJson = {
    n, bbox,
    lon: nodeQLon, lat: nodeQLat,
    from: rFrom, to: rTo, w: rW,
    childA: rChildA, childB: rChildB, src: rSrc,
    rank: Array.from(ch.rank),
    renderOf,
  };

  // ---- benchmark: 300 seeded, reachable, coordinate-distinct pairs on
  // this SAME quantized graph, aborting loudly on any CH/Dijkstra mismatch.
  // (The routing graph is always one strongly-connected component by
  // construction — see buildRoutingGraph above — so unreachable pairs
  // shouldn't occur in practice; the re-roll guards against it anyway.) ----
  const rand = mulberry32(2026);
  const bench: { from: number; to: number; dds: number; dj: number; ch: number }[] = [];
  const MAX_TRIES = 300 * 2000;
  let tries = 0;
  while (bench.length < 300) {
    if (++tries > MAX_TRIES)
      throw new Error(`could not find 300 reachable benchmark pairs after ${tries} tries`);
    const a = Math.floor(rand() * n);
    const b = Math.floor(rand() * n);
    if (a === b) continue;
    if (nodeLon[a] === nodeLon[b] && nodeLat[a] === nodeLat[b]) continue; // coordinate-distinct
    const dj = dijkstraCsr(n, graph.fwd, a, b);
    if (dj.dist === Infinity) continue; // reachable pairs only; re-roll
    const chRes = chQuery(ch, a, b);
    const djDds = Math.round(dj.dist * 10);
    const chDds = Math.round(chRes.dist * 10);
    if (chRes.dist === Infinity || chDds !== djDds)
      throw new Error(
        `CH/Dijkstra mismatch for ${a}->${b}: dijkstra=${dj.dist} (${djDds}dds) ` +
        `ch=${chRes.dist} (${chDds}dds) — aborting emit, this is a correctness bug`,
      );
    bench.push({
      from: a, to: b, dds: djDds,
      dj: dj.settled.length,
      ch: chRes.settled.length + chRes.settledB.length,
    });
  }
  const meanDjSettled = bench.reduce((s, b) => s + b.dj, 0) / bench.length;
  const meanChSettled = bench.reduce((s, b) => s + b.ch, 0) / bench.length;
  const settledRatio = meanChSettled / meanDjSettled;

  const metaJson = {
    built: new Date().toISOString(),
    nodes: n,
    originalEdges,
    shortcuts: shortcutCount,
    buildMs,
    bench,
  };

  // ---- write + gzip-check the budget ----
  mkdirSync(outDir, { recursive: true });
  const renderPath = resolve(outDir, "render.json");
  const routingPath = resolve(outDir, "routing.json");
  const metaPath = resolve(outDir, "meta.json");
  writeFileSync(renderPath, JSON.stringify(renderJson));
  writeFileSync(routingPath, JSON.stringify(routingJson));
  writeFileSync(metaPath, JSON.stringify(metaJson));

  const gzRender = gzipSync(readFileSync(renderPath)).length;
  const gzRouting = gzipSync(readFileSync(routingPath)).length;
  const gzMeta = gzipSync(readFileSync(metaPath)).length;
  const gzTotal = gzRender + gzRouting + gzMeta;

  console.log("--- stats ---");
  console.log(`nodes:          ${n.toLocaleString()}`);
  console.log(`original edges: ${originalEdges.toLocaleString()}`);
  console.log(`shortcuts:      ${shortcutCount.toLocaleString()}`);
  console.log(`CH build time:  ${buildMs.toLocaleString()} ms`);
  console.log(
    `mean settled:   dijkstra ${meanDjSettled.toFixed(1)}, ch ${meanChSettled.toFixed(1)} ` +
    `(ratio ${(settledRatio * 100).toFixed(2)}%)`,
  );
  console.log(
    `gzip sizes:     render ${fmtKB(gzRender)}, routing ${fmtKB(gzRouting)}, ` +
    `meta ${fmtKB(gzMeta)}, total ${fmtKB(gzTotal)}`,
  );

  return {
    nodes: n, originalEdges, shortcuts: shortcutCount, buildMs,
    meanDjSettled, meanChSettled, settledRatio,
    gz: { render: gzRender, routing: gzRouting, meta: gzMeta, total: gzTotal },
  };
}

// ---------------------------------------------------------------------
// Toytown: a small drivable subgraph cut from the SAME cached extract, for
// the /how/ toys. Loaded by src/toys/toytown.ts and used by the four
// interactive toys (hierarchy runs on full-Canberra render.json). Reuses
// buildRoutingGraph verbatim on a bbox-restricted way list — same drivable
// filter, same largest-SCC keep, same chain contraction as the main Canberra
// graph — so this is a real subgraph, not a second pipeline to keep in sync.
//
// Unlike routing.json, toytown.json carries no CH data: the /how/ toys
// build their own CH from the decoded graph at load time (see src/toys/climb.ts
// for the CH-build call) — shipping precomputed shortcuts here would just be
// dead weight for a ≤80-node graph a browser can CH-build in milliseconds.
// What IS shipped: node coordinates and, per edge, its full geometry AND its
// road class (`cls`, the same 0-3 buckets as render.json's lines — see the
// CLS table up top). Geometry is for drawing real street shapes instead of
// straight lines; cls is so spec/data.test.ts's "hierarchy-rich" sensor
// (§16.12) can check the cut against the SHIPPED artifact in CI, which never
// has the gitignored cache a re-derivation would need. No toy currently
// reads cls — they colour by algorithm state, not road class — so
// src/toys/toytown.ts's decoder is untouched; the field just rides along.
// ---------------------------------------------------------------------

// Re-cut for spec §16.12 (2026-08-16 polish round, task G4). User feedback
// on the ANU-campus cut this constant used to hold: "use a place with clear
// hierarchy of roads... [ANU] is all small streets, no visible arterial
// spine" — true of the whole campus core, which tops out at tertiary
// (cls <= 1). Moved to Northbourne Avenue's southern end at Vernon
// Circle/City Hill, where it meets Barry Drive, London Circuit, Alinga
// Street and Cooyong Street: Northbourne + Vernon Circle + a short stretch
// of Elouera Street tag highway=trunk (cls 3) end to end here (each split
// into short intersection-to-intersection ways, not one giant way, so
// whole-way bbox inclusion doesn't drop them), Cooyong/Barry/Mort/Lonsdale
// tag primary (cls 2), and a dozen unclassified/residential/living_street
// locals (Bunda, Akuna, Genge, Petrie, Moore, Donaldson, Rudd St...) feed
// into them — three hierarchy tiers in one small cut, not just one arterial
// through a grid. Grid-searched box centers and sizes along the corridor
// (scratch run, not committed — see the task report for the full candidate
// table) for: 40-80 post-contraction nodes, >=1 edge with cls>=2, >=60%
// edges cls 0, and the arterial spanning most of the CUT'S OWN shipped bbox
// rather than clipping a corner (checked by projecting cls>=2 edges'
// geometry extent over emitToytown's tight-fit bbox below, since that — not
// this filter box — is what the toy actually renders against). Landed on
// this box: 62 nodes / 116 edges, cls histogram {0: 79, 1: 2, 2: 18, 3: 17}
// (68% cls 0, 30% cls>=2), arterial spanning 86% of the shipped bbox's
// longitude and 98% of its latitude — comfortably inside the node target
// with a real, visible spine rather than a corner clip.
const TOYTOWN_BBOX: [number, number, number, number] = [149.12805, -35.28145, 149.13455, -35.27295];

export interface ToytownEmitResult { nodes: number; edges: number; gzBytes: number }

/** Keeps only ways whose EVERY referenced node falls inside `bbox` — a way
 * with even one node outside is dropped whole rather than clipped, so every
 * kept way's geometry stays fully resolvable from `nodes` with no dangling
 * ends at the box edge. */
export function waysWithinBbox(
  ways: OsmWay[], nodes: Map<number, [number, number]>,
  bbox: [number, number, number, number],
): OsmWay[] {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const inBbox = (id: number): boolean => {
    const c = nodes.get(id);
    return c !== undefined && c[0] >= minLon && c[0] <= maxLon && c[1] >= minLat && c[1] <= maxLat;
  };
  return ways.filter((w) => w.refs.length > 0 && w.refs.every(inBbox));
}

/** Cuts the small toy subgraph from `parsed` (the SAME parsed OSM build.ts's
 * main() already holds — no second parse) through the identical
 * buildRoutingGraph pipeline the main graph uses. Deliberately independent
 * of the main graph's `--drop-living-street` budget lever: toytown is tiny
 * regardless of that flag, and living_street ways (Bunda Street's mall
 * frontage, in the current cut) are exactly the kind of texture worth
 * keeping at this zoomed-in scale. */
export function cutToytown(
  parsed: ParsedOsm, bbox: [number, number, number, number] = TOYTOWN_BBOX,
): RoutingGraph {
  return buildRoutingGraph({ nodes: parsed.nodes, ways: waysWithinBbox(parsed.ways, parsed.nodes, bbox) });
}

export interface ToytownHierarchyStats {
  edges: number;
  cls0: number;
  cls0Frac: number;
  maxCls: number;
  hasArterial: boolean; // >= 1 edge with cls >= 2 (secondary/primary/trunk/motorway)
}

/** Road-class mix of a toytown cut: how much is local streets (cls 0) vs
 * whether it contains a real arterial (cls >= 2) — the two thresholds task
 * G4's tuning grid-searched the bbox against (see TOYTOWN_BBOX's comment).
 * Two call sites, deliberately not sharing a single source of truth:
 * emitToytown below logs this over the freshly-cut RoutingGraph (the number
 * this task's tuning table and bbox comment are built from); the "hierarchy-
 * rich" sensor in spec/data.test.ts checks the same two thresholds again but
 * against the `cls` field emitToytown writes into toytown.json, not by
 * calling this function — the spec test runs against the committed artifact
 * in CI, which never has the gitignored cache this function's RoutingGraph
 * input requires. */
export function toytownHierarchyStats(g: RoutingGraph): ToytownHierarchyStats {
  const edges = g.edges.length;
  const cls0 = g.edges.filter((e) => e.cls === 0).length;
  const maxCls = edges > 0 ? Math.max(...g.edges.map((e) => e.cls)) : -1;
  return { edges, cls0, cls0Frac: edges > 0 ? cls0 / edges : 0, maxCls, hasArterial: maxCls >= 2 };
}

/** Quantizes `g` (relative to ITS OWN bbox, not the main graph's) and
 * writes public/data/toytown.json. Geometry encoding: each edge's
 * `geometry` is its full point list (endpoints included, matching
 * PipeEdge.geometry) as ABSOLUTE quantized [x, y] integer pairs on the same
 * 1e-5deg grid as everywhere else in this file — see
 * src/toys/toytown.ts's decodeToytown for the matching decoder. Deliberately
 * NOT delta-encoded like render.json's lines: at toytown's scale (dozens of
 * nodes, ~100 edges) the byte savings are noise against the 4 MB budget,
 * and absolute coordinates decode with no running-position bookkeeping —
 * simplicity wins over density here. */
export function emitToytown(g: RoutingGraph, outDir: string): ToytownEmitResult {
  const n = g.lon.length;
  const allPoints: [number, number][] = [];
  for (let i = 0; i < n; i++) allPoints.push([g.lon[i], g.lat[i]]);
  for (const e of g.edges) for (const p of e.geometry) allPoints.push(p);
  const bbox = boundingBox(allPoints);
  const [minLon, minLat] = bbox;
  const qLon = (lon: number) => Math.round((lon - minLon) * COORD_SCALE);
  const qLat = (lat: number) => Math.round((lat - minLat) * COORD_SCALE);

  const lon = g.lon.map(qLon);
  const lat = g.lat.map(qLat);
  const edges = g.edges.map((e) => ({
    from: e.from, to: e.to,
    w: Math.max(1, Math.round(e.w * 10)),
    cls: e.cls,
    geometry: e.geometry.map(([elon, elat]): [number, number] => [qLon(elon), qLat(elat)]),
  }));

  const json = { bbox, n, lon, lat, edges };
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, "toytown.json");
  writeFileSync(outPath, JSON.stringify(json));
  const gzBytes = gzipSync(readFileSync(outPath)).length;

  const hierarchy = toytownHierarchyStats(g);
  console.log("--- toytown ---");
  console.log(`bbox:  ${JSON.stringify(bbox)}`);
  console.log(`nodes: ${n}`);
  console.log(`edges: ${edges.length}`);
  console.log(
    `hierarchy: cls0 ${hierarchy.cls0}/${hierarchy.edges} (${(hierarchy.cls0Frac * 100).toFixed(0)}%), ` +
    `maxCls ${hierarchy.maxCls}, hasArterial ${hierarchy.hasArterial}`,
  );
  console.log(`gzip:  ${fmtKB(gzBytes)}`);

  return { nodes: n, edges: edges.length, gzBytes };
}

// ---------------------------------------------------------------------
// CLI: `pnpm data:build` (node --experimental-strip-types scripts/data/build.ts)
// Reads the cached Overpass extract fetch.ts saved, builds the routing
// graph, and emits the artifacts. Guarded so importing build.ts's pure
// functions (e.g. from build.test.ts) never runs the pipeline as a side
// effect of import — only running this file directly does.
//
// `--drop-living-street` re-filters the ALREADY-FETCHED cache at parse time
// (dropping the lowest-value, highest-shape-point-density road class) —
// the budget lever from the plan's binding resolution #7, for if the
// gzipped total ever comes in over the 4 MB spec test's budget.
// ---------------------------------------------------------------------

async function main(): Promise<void> {
  const cachePath = resolve("scripts/data/cache/canberra.json");
  if (!existsSync(cachePath)) {
    console.error(`missing ${cachePath} — run "pnpm data:fetch" first.`);
    process.exitCode = 1;
    return;
  }
  const dropLivingStreet = process.argv.includes("--drop-living-street");
  const raw = JSON.parse(readFileSync(cachePath, "utf8")) as OverpassJson;
  const parsed = parseOsm(raw);
  const ways = dropLivingStreet
    ? parsed.ways.filter((w) => w.highway !== "living_street")
    : parsed.ways;
  if (dropLivingStreet)
    console.log(`--drop-living-street: kept ${ways.length.toLocaleString()}/${parsed.ways.length.toLocaleString()} ways`);
  const routing = buildRoutingGraph({ nodes: parsed.nodes, ways });
  console.log(
    `Parsed ${routing.lon.length.toLocaleString()} nodes, ` +
    `${routing.edges.length.toLocaleString()} edges from ${cachePath}`,
  );
  emit(routing, resolve("public/data"));

  const toytownRouting = cutToytown(parsed);
  console.log(
    `Toytown cut: ${toytownRouting.lon.length.toLocaleString()} nodes, ` +
    `${toytownRouting.edges.length.toLocaleString()} edges (bbox ${JSON.stringify(TOYTOWN_BBOX)})`,
  );
  emitToytown(toytownRouting, resolve("public/data"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error("build failed:", err instanceof Error ? (err.stack ?? err.message) : err);
    process.exitCode = 1;
  });
}
