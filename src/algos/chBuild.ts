import { buildCsr, type Csr, type Graph } from "./graph";
import { MinHeap } from "./heap";

export interface ChEdge {
  from: number; to: number; w: number; childA: number; childB: number; src: number;
}

export interface Ch {
  n: number; rank: Int32Array; edges: ChEdge[]; up: Csr; downRev: Csr;
}

type Adj = Map<number, Map<number, { w: number; e: number }>>; // node -> to -> best

function witnessSearch(
  out: Adj, excluded: Uint8Array, skip: number,
  from: number, targets: Set<number>, limit: number,
): Map<number, number> {
  // Dijkstra from `from`, never entering `skip` or contracted nodes; returns
  // dist for every target it settled within limit.
  const dist = new Map<number, number>();
  const done = new Set<number>();
  const found = new Map<number, number>();
  dist.set(from, 0);
  let guard = 0;
  while (done.size < 4000) {
    let u = -1, best = Infinity;
    for (const [node, d] of dist) if (!done.has(node) && d < best) { best = d; u = node; }
    if (u === -1 || best > limit || ++guard > 800) break;
    done.add(u);
    if (targets.has(u)) found.set(u, best);
    if (found.size === targets.size) break;
    for (const [v, { w }] of out.get(u) ?? []) {
      if (v === skip || excluded[v] || done.has(v)) continue;
      const d = best + w;
      if (d < (dist.get(v) ?? Infinity)) dist.set(v, d);
    }
  }
  return found;
}

function buildAdj(g: Graph): { out: Adj; inn: Adj; edges: ChEdge[] } {
  const out: Adj = new Map(); const inn: Adj = new Map();
  const edges: ChEdge[] = [];
  const put = (m: Adj, a: number, b: number, w: number, e: number) => {
    let row = m.get(a);
    if (!row) { row = new Map(); m.set(a, row); }
    const prev = row.get(b);
    if (!prev || prev.w > w) row.set(b, { w, e });
  };
  for (let u = 0; u < g.n; u++)
    for (let s = g.fwd.firstOut[u]; s < g.fwd.firstOut[u + 1]; s++) {
      const v = g.fwd.head[s]; const w = g.fwd.weight[s];
      if (u === v) continue;
      const e = edges.length;
      edges.push({ from: u, to: v, w, childA: -1, childB: -1, src: g.fwd.edge[s] });
      put(out, u, v, w, e); put(inn, v, u, w, e);
    }
  return { out, inn, edges };
}

function pairsOf(out: Adj, inn: Adj, contracted: Uint8Array, v: number) {
  const ins = [...(inn.get(v) ?? [])].filter(([u]) => !contracted[u] && u !== v);
  const outs = [...(out.get(v) ?? [])].filter(([w]) => !contracted[w] && w !== v);
  return { ins, outs };
}

export interface ContractStep {
  shortcuts: { from: number; to: number; w: number }[];
  witnessed: { from: number; to: number }[];
}

export function createContractor(g: Graph) {
  let { out, inn, edges } = buildAdj(g);
  let contracted = new Uint8Array(g.n);
  let total = 0;
  const insert = (from: number, to: number, w: number) => {
    const e = edges.length;
    edges.push({ from, to, w, childA: -1, childB: -1, src: -1 });
    let row = out.get(from); if (!row) { row = new Map(); out.set(from, row); }
    const prev = row.get(to);
    if (!prev || prev.w > w) row.set(to, { w, e });
    let rin = inn.get(to); if (!rin) { rin = new Map(); inn.set(to, rin); }
    const pin = rin.get(from);
    if (!pin || pin.w > w) rin.set(from, { w, e });
  };
  return {
    contract(v: number): ContractStep {
      const { added, witnessed } = simulateContract(out, inn, contracted, v);
      for (const s of added) insert(s.from, s.to, s.w);
      contracted[v] = 1;
      total += added.length;
      return {
        shortcuts: added.map(({ from, to, w }) => ({ from, to, w })),
        witnessed,
      };
    },
    contracted: (v: number) => contracted[v] === 1,
    totalShortcuts: () => total,
    reset() {
      ({ out, inn, edges } = buildAdj(g));
      contracted = new Uint8Array(g.n);
      total = 0;
    },
  };
}

export function contractOne(g: Graph, v: number): ContractStep {
  return createContractor(g).contract(v);
}

function simulateContract(
  out: Adj, inn: Adj, contracted: Uint8Array, v: number,
) {
  const { ins, outs } = pairsOf(out, inn, contracted, v);
  const added: { from: number; to: number; w: number; eIn: number; eOut: number }[] = [];
  const witnessed: { from: number; to: number }[] = [];
  for (const [u, ie] of ins) {
    const targets = new Set(outs.map(([w]) => w).filter((w) => w !== u));
    if (targets.size === 0) continue;
    const limit = Math.max(...outs.map(([, oe]) => ie.w + oe.w));
    const wit = witnessSearch(out, contracted, v, u, targets, limit);
    for (const [w, oe] of outs) {
      if (w === u) continue;
      const viaV = ie.w + oe.w;
      const bypass = wit.get(w);
      if (bypass !== undefined && bypass <= viaV) witnessed.push({ from: u, to: w });
      else added.push({ from: u, to: w, w: viaV, eIn: ie.e, eOut: oe.e });
    }
  }
  return { added, witnessed };
}

function edgeDifference(out: Adj, inn: Adj, contracted: Uint8Array, v: number): number {
  const { ins, outs } = pairsOf(out, inn, contracted, v);
  const { added } = simulateContract(out, inn, contracted, v);
  return added.length - (ins.length + outs.length);
}

export function buildChOrdered(
  g: Graph, fixedOrder?: number[],
): { ch: Ch; shortcutCount: number } {
  const { out, inn, edges } = buildAdj(g);
  const contracted = new Uint8Array(g.n);
  const rank = new Int32Array(g.n).fill(-1);
  const deletedNeighbors = new Int32Array(g.n);
  const heap = new MinHeap(g.n);
  if (!fixedOrder)
    for (let v = 0; v < g.n; v++)
      heap.update(v, 2 * edgeDifference(out, inn, contracted, v));
  let nextRank = 0; let shortcutCount = 0;
  const applyContract = (v: number) => {
    const { added } = simulateContract(out, inn, contracted, v);
    for (const s of added) {
      const e = edges.length;
      edges.push({ from: s.from, to: s.to, w: s.w, childA: s.eIn, childB: s.eOut, src: -1 });
      let row = out.get(s.from); if (!row) { row = new Map(); out.set(s.from, row); }
      const prev = row.get(s.to);
      if (!prev || prev.w > s.w) row.set(s.to, { w: s.w, e });
      let rin = inn.get(s.to); if (!rin) { rin = new Map(); inn.set(s.to, rin); }
      const pin = rin.get(s.from);
      if (!pin || pin.w > s.w) rin.set(s.from, { w: s.w, e });
      shortcutCount++;
    }
    contracted[v] = 1; rank[v] = nextRank++;
    for (const [u] of inn.get(v) ?? []) if (!contracted[u]) deletedNeighbors[u]++;
    for (const [w] of out.get(v) ?? []) if (!contracted[w]) deletedNeighbors[w]++;
  };
  if (fixedOrder) {
    for (const v of fixedOrder) applyContract(v);
  } else {
    while (heap.size > 0) {
      const v = heap.pop();
      if (contracted[v]) continue;
      const key = 2 * edgeDifference(out, inn, contracted, v) + deletedNeighbors[v];
      // lazy re-evaluation: if the fresh key is no longer the minimum, requeue
      let stillMin = true;
      const peek = heap.pop();
      if (peek !== -1) {
        if (key > heap.key(peek)) stillMin = false;
        heap.update(peek, heap.key(peek));
      }
      if (!stillMin) { heap.update(v, key); continue; }
      applyContract(v);
    }
  }
  // partition augmented edges into up / downRev by rank
  const upE: { from: number; to: number; w: number }[] = [];
  const upIdx: number[] = [];
  const dnE: { from: number; to: number; w: number }[] = [];
  const dnIdx: number[] = [];
  edges.forEach((e, i) => {
    if (e.from === e.to) return;
    if (rank[e.to] > rank[e.from]) { upE.push({ from: e.from, to: e.to, w: e.w }); upIdx.push(i); }
    else { dnE.push({ from: e.to, to: e.from, w: e.w }); dnIdx.push(i); } // reversed
  });
  const up = buildCsr(g.n, upE);
  const upEdge = new Int32Array(up.edge.length);
  for (let i = 0; i < up.edge.length; i++) upEdge[i] = upIdx[up.edge[i]];
  const downRev = buildCsr(g.n, dnE);
  const dnEdge = new Int32Array(downRev.edge.length);
  for (let i = 0; i < downRev.edge.length; i++) dnEdge[i] = dnIdx[downRev.edge[i]];
  return {
    ch: { n: g.n, rank, edges, up: { ...up, edge: upEdge }, downRev: { ...downRev, edge: dnEdge } },
    shortcutCount,
  };
}

export function buildCh(g: Graph): Ch { return buildChOrdered(g).ch; }

export function orderedShortcutCount(g: Graph, order: number[]): number {
  return buildChOrdered(g, order).shortcutCount;
}
