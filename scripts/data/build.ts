// Turns parsed OSM ways into a routing graph: split at junctions, weight each
// hop by travel time, expand oneway semantics, keep only the largest
// strongly-connected component, then contract degree-2 through-nodes to a
// fixed point. Every stage is a pure function over in-memory data — no
// network, no filesystem — so it's exercised entirely by fixtures/mini.json
// in build.test.ts. fetch.ts (a later task) is what actually hits Overpass
// and calls these on the real Canberra extract.

import { haversineM, parseOsm, SPEEDS, type OsmWay, type ParsedOsm } from "./osm.ts";

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
