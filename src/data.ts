// Browser-side loader for the three committed data artifacts
// (public/data/{render,routing,meta}.json). Fetches with RELATIVE URLs only
// — this repo's static/client-side-only contract (see
// spec/highway-to-hill.test.ts's "no absolute-URL fetch" sensor) forbids an
// absolute origin here — and decodes routing.json via src/data-node.ts's
// pure decoders, the exact same code path spec/data.test.ts already
// exercises against the real Canberra artifacts on the Node side. No DOM
// surface beyond `fetch`/`Response` (both ambient via the "DOM" lib): this
// module has no canvas, no document, nothing MapView-shaped.

import { chFromArtifact, graphFromArtifact, type RoutingArtifact } from "./data-node";
import type { Ch } from "./algos/chBuild";
import type { Graph } from "./algos/graph";
import type { RenderData } from "./viz/mapRenderer";

/** The exact shape scripts/data/build.ts's emit() writes to
 * public/data/meta.json: build stats plus the 300-pair seeded benchmark
 * (`bench`) /how/'s copy quotes and spec/data.test.ts's headline-claim test
 * checks offline. */
export interface Meta {
  built: string;
  nodes: number;
  originalEdges: number;
  shortcuts: number;
  buildMs: number;
  bench: { from: number; to: number; dds: number; dj: number; ch: number }[];
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/** Fetches and parses public/data/render.json — the road-network geometry
 * the map paints (src/viz/mapRenderer.ts's decodeLine/visibleLines read
 * straight off this). `base` is relative to the current page, so this
 * never issues an absolute-URL request. */
export async function loadRender(base = "./data/"): Promise<RenderData> {
  return fetchJson<RenderData>(`${base}render.json`);
}

/** Fetches routing.json + meta.json and decodes the routing graph/CH via
 * src/data-node.ts's pure decoders. `renderOf` rides along for free —
 * it's already parallel to the augmented edge arrays `graph`/`ch` are
 * built from — so a caller can map a routed path's edges back to the
 * render.json lines that draw them (e.g. to highlight the route on the
 * base layer) with no separate lookup table. */
export async function loadRouting(
  base = "./data/",
): Promise<{ graph: Graph; ch: Ch; renderOf: Int32Array; meta: Meta }> {
  const [routing, meta] = await Promise.all([
    fetchJson<RoutingArtifact>(`${base}routing.json`),
    fetchJson<Meta>(`${base}meta.json`),
  ]);
  return {
    graph: graphFromArtifact(routing),
    ch: chFromArtifact(routing),
    renderOf: Int32Array.from(routing.renderOf),
    meta,
  };
}

/** The exact shape scripts/data/build.ts's emitToytown() writes to
 * public/data/toytown.json: a small Canberra city-centre drivable subgraph
 * (bboxed, drivable-filtered, largest-SCC-kept, chain-contracted — same
 * pipeline as the main graph, just cut down) for the /how/ toys to run on. Coordinates
 * are quantized ints on the same 1e-5-degree grid as routing.json, but
 * relative to THIS artifact's own bbox, not the main graph's. Each edge's
 * `geometry` is its full point list (endpoints included) as ABSOLUTE
 * quantized [x, y] pairs — not delta-encoded like render.json's lines, a
 * deliberate simplicity-over-density choice at this artifact's tiny scale
 * (see build.ts's emitToytown for the full rationale). `cls` is the same 0-3
 * road-class bucket as render.json's lines (build.ts's CLS table): it always
 * rode along in the shipped JSON (emitToytown has written it since G4), but
 * this type only started DECLARING it in task G5, once the /how/ map view
 * started reading it to style the arterial heavier/brighter than local
 * streets (src/toys/toytownView.ts's isArterial/roadPolylineMarkup) — see
 * spec/data.test.ts's hierarchy-rich sensor for the artifact-level check.
 * Decoding (dequantize + build a Graph + project to screen space) lives in
 * src/toys/toytown.ts's decodeToytown, not here — this interface only
 * describes the fetched shape, same division of labor as RenderData/
 * loadRender above. `context` (task H3, design spec §17.5) is the faint
 * backdrop layer: polylines clipped from the FULL Canberra graph's render
 * geometry down to this artifact's own bbox at build time (build.ts's
 * toytownContextPolylines), quantized the same absolute-[x,y]-pairs way as
 * `edges[].geometry`. Optional (rather than required) so a hand-built test
 * fixture that predates this field — or omits it because a test doesn't
 * care about the context layer — still typechecks; decodeToytown treats a
 * missing `context` as an empty layer (nothing extra drawn), never a
 * crash. */
export interface ToytownArtifact {
  bbox: [number, number, number, number];
  n: number;
  lon: number[];
  lat: number[];
  edges: { from: number; to: number; w: number; cls: number; geometry: [number, number][] }[];
  context?: [number, number][][];
}

/** Fetches public/data/toytown.json — the small Canberra city-centre
 * drivable subgraph the /how/ toys run on (replacing the old hand-made
 * 12-node mini-town, src/toys/minitown.ts). Raw/undecoded:
 * src/toys/toytown.ts's decodeToytown
 * does the dequantize + Graph-build + screen-projection step, same split as
 * loadRender/decodeLine. `base` is relative, same client-side-only contract
 * as every other loader in this file. */
export async function loadToytown(base = "./data/"): Promise<ToytownArtifact> {
  return fetchJson<ToytownArtifact>(`${base}toytown.json`);
}
