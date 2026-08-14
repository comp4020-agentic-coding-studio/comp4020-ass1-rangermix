export interface Csr {
  firstOut: Int32Array; head: Int32Array; weight: Float64Array; edge: Int32Array;
}

export interface Graph { n: number; lon: Float64Array; lat: Float64Array; fwd: Csr }

export function buildCsr(
  n: number, edges: { from: number; to: number; w: number }[],
): Csr {
  const deg = new Int32Array(n + 1);
  for (const e of edges) deg[e.from + 1]++;
  for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
  const firstOut = deg;
  const head = new Int32Array(edges.length);
  const weight = new Float64Array(edges.length);
  const edge = new Int32Array(edges.length);
  const cursor = firstOut.slice(0, n);
  edges.forEach((e, idx) => {
    const slot = cursor[e.from]++;
    head[slot] = e.to; weight[slot] = e.w; edge[slot] = idx;
  });
  return { firstOut, head, weight, edge };
}

export function transpose(n: number, c: Csr): Csr {
  const edges: { from: number; to: number; w: number }[] = [];
  const srcIdx: number[] = [];
  for (let u = 0; u < n; u++)
    for (let s = c.firstOut[u]; s < c.firstOut[u + 1]; s++) {
      edges.push({ from: c.head[s], to: u, w: c.weight[s] });
      srcIdx.push(c.edge[s]);
    }
  const t = buildCsr(n, edges);
  // remap edge ids to the ORIGINAL indices
  const remapped = new Int32Array(t.edge.length);
  for (let i = 0; i < t.edge.length; i++) remapped[i] = srcIdx[t.edge[i]];
  return { ...t, edge: remapped };
}

export function toyGraph(
  n: number, edges: [number, number, number][],
  opts: { undirected?: boolean } = {},
): Graph {
  const list = edges.map(([from, to, w]) => ({ from, to, w }));
  if (opts.undirected)
    for (const [from, to, w] of edges) list.push({ from: to, to: from, w });
  return {
    n, lon: new Float64Array(n), lat: new Float64Array(n),
    fwd: buildCsr(n, list),
  };
}
