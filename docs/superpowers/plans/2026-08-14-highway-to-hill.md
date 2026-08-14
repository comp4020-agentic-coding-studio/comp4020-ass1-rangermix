# Highway to Hill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the approved Highway to Hill explainer — a live Dijkstra-vs-CH
race on Canberra's real OSM road network plus a five-chapter interactive
explanation — deployed green by noon Mon 2026-08-17.

**Architecture:** An offline pipeline (`scripts/data/`) turns an Overpass
extract into three committed JSON artifacts (render geometry, routing graph +
CH, metadata/benchmark). The site is two static pages; all algorithms run
client-side (`src/algos/`, shared by the pipeline, the race worker, and the
toy widgets, so the toys can never drift from the real code). A worker
computes races; the main thread replays settle logs onto a two-layer canvas.
Theme (light/dark/system) lives in CSS custom properties; canvas code reads
them at draw time.

**Tech Stack:** Vite 8 multi-page (template default — every `.html` is a
page), TypeScript strict, vitest + jsdom (existing setup), no runtime
dependencies, no map/chart libraries. Node ≥ 24 for scripts.

## Global Constraints

Every task inherits these. Exact values are contracts from
`docs/superpowers/specs/2026-08-14-ch-explainer-design.md` and
`spec/highway-to-hill.test.ts` (its exported `CONTRACTS` object is the single
source for copy/testid strings — import it in spec tests, copy it exactly in
page markup).

- `h1` on `/` is exactly: `Highway to Hill`
- Core-interaction sentence, verbatim on `/`: `Drop two pins on Canberra.
  Watch Dijkstra flood the city while Contraction Hierarchies thread a
  handful of shortcuts — same route, a fraction of the work.` (em dash, not
  hyphen)
- Chapter headings on `/how/`, exact copy and order: `What Dijkstra actually
  does` · `Contraction: remove a node without lying about distances` ·
  `Order is everything` · `The hierarchy, revealed` · `The query: only ever
  climb`
- Test ids: `theme-toggle`, `race-canvas`, `scoreboard`, `race-run`,
  `race-live`, `preset-hill`, `toy-flood`, `toy-contraction`, `toy-order`,
  `toy-hierarchy`, `toy-climb`
- Palettes are FIXED, machine-validated; never invent hues. Dark chart
  steps: Dijkstra `#d95926`, A* `#9085e9`, bidi `#d55181`, CH `#3987e5`;
  dark glow (map dots only): `#f5a962` `#b48ce8` `#e87ba0` `#4fd8eb`.
  Light steps (also map dots in light — no additive blending on light):
  Dijkstra `#eb6834`, A* `#4a3aa7`, bidi `#e87ba4`, CH `#2a78d6`. Roster
  order fixed. Bidi magenta in light needs its visible label (it has one:
  scoreboard rows are always direct-labeled).
- `public/data/` total ≤ **4 MB gzipped** (enforced by spec/data.test.ts).
- Every page passes `spec/invariants.test.ts`: lang, real title, viewport
  meta, `<nav>`, exactly one `h1`, img alt.
- Static/client-side: no absolute-URL assets or fetches (live test already
  enforces).
- No invented numbers anywhere on the product pages: counters render empty
  until measured; prose stats come from `meta.json`.
- OSM attribution `© OpenStreetMap contributors` + ODbL in every page
  footer.
- Commit only green states: `pnpm check` passes at every commit. Spec todos
  flip to live tests in the task that lands their feature (never flip back).
- Verify at 1920×1080 and 390×844, light and dark (4 combos), before
  declaring any UI task done. Dev server: `pnpm dev` on port 5300.
- Deadline discipline: Tasks 1–12 are MVP (target: deployed Sat night, hard
  ceiling Sun noon). Task 13 is target tier, Sun only if green. Task 14 is
  ship prep. If behind at Sun noon: cut chapter 5's animation to the static
  diagram, then cut chapter 4's "your turn" mode, in that order — never cut
  tests, themes, or viewports.

## File Structure

```
scripts/data/
  fetch.ts             Overpass download → scripts/data/cache/canberra.json (gitignored)
  osm.ts               parse Overpass JSON → ways/nodes; speed table; oneway
  build.ts             junction split → SCC → chain-contract → CH → emit artifacts
  fixtures/mini.json   hand-written Overpass-shaped fixture for tests
src/algos/
  heap.ts              indexed binary min-heap (typed arrays)
  graph.ts             CSR types + builders + toy-graph helper
  dijkstra.ts          baseline search, returns settle log
  chBuild.ts           contraction: order heuristic, witness search, contractOne (toy API), buildCh
  chQuery.ts           bidirectional upward search + unpack
  astar.ts             (T13) A* with haversine/max-speed heuristic
  bidijkstra.ts        (T13) bidirectional Dijkstra
src/
  theme.ts             3-state theme: init, cycle, colors, change events
  snap.ts              nearest-node lookup
  presets.ts           named Canberra places (lon/lat) incl. Gungahlin→Capital Hill
  data.ts              fetch + decode render.json / routing.json / meta.json
src/viz/
  mapRenderer.ts       MapView: base+overlay canvases, projection, dots/path/pins, theme recipes
src/race/
  worker.ts            runs algorithms off-main-thread, transfers settle logs
  controller.ts        replay scheduler, scoreboard + aria-live updates
src/toys/
  minitown.ts          the shared 12-node toy graph (+ layout coords)
  flood.ts contraction.ts order.ts hierarchy.ts climb.ts   one module per chapter toy
index.html             rebuilt home page (race)
how/index.html         chapters page
styles.css             design tokens (both themes) + all page styles
spec/highway-to-hill.test.ts   flip todos here as features land
spec/data.test.ts      (T5) artifact contracts: equivalence, ratio, budget
public/data/           committed artifacts: render.json, routing.json, meta.json
```

Vite scans every non-hidden dir for `.html` (`vite.config.ts` SKIP list:
node_modules, dist, spec, scripts, reflections) — `how/index.html` just
works. `public/` is copied verbatim into `dist/`.

---

### Task 1: Theme foundation (tokens + theme.ts)

**Files:**
- Modify: `styles.css` (replace entirely)
- Create: `src/theme.ts`
- Test: `src/theme.test.ts`

**Interfaces:**
- Produces: `initTheme(): void` (reads localStorage `hth-theme`, stamps
  `data-theme` on `<html>`, wires every `[data-testid="theme-toggle"]`
  button, keeps its label current); `cycleTheme(): "system"|"light"|"dark"`
  (system → dark → light → system); `effectiveTheme(): "light"|"dark"`;
  `onThemeChange(cb: () => void): void`; `themeColors(): {ground, panel,
  ink, muted, road, roadMajor, route, dijkstra, ch, astar, bidi,
  dijkstraGlow, chGlow, astarGlow, bidiGlow}` — read live from CSS custom
  properties so canvas code always matches CSS.
- Consumes: nothing.

- [ ] **Step 1: Write failing tests**

```ts
// src/theme.test.ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { cycleTheme, effectiveTheme, initTheme } from "./theme";

describe("theme", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.body.innerHTML =
      '<button data-testid="theme-toggle" type="button"></button>';
  });

  it("defaults to system (no data-theme attribute)", () => {
    initTheme();
    expect(document.documentElement.getAttribute("data-theme")).toBeNull();
  });

  it("cycles system -> dark -> light -> system and persists", () => {
    initTheme();
    expect(cycleTheme()).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem("hth-theme")).toBe("dark");
    expect(cycleTheme()).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(cycleTheme()).toBe("system");
    expect(document.documentElement.getAttribute("data-theme")).toBeNull();
    expect(localStorage.getItem("hth-theme")).toBeNull();
  });

  it("restores a stored choice on init", () => {
    localStorage.setItem("hth-theme", "light");
    initTheme();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(effectiveTheme()).toBe("light");
  });

  it("toggle button click cycles and updates its label", () => {
    initTheme();
    const btn = document.querySelector<HTMLButtonElement>(
      '[data-testid="theme-toggle"]',
    );
    btn?.click();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(btn?.textContent).toContain("dark");
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run src/theme.test.ts`
  → FAIL ("Cannot find module './theme'").

- [ ] **Step 3: Implement `src/theme.ts`**

```ts
export type ThemeSetting = "system" | "light" | "dark";
const KEY = "hth-theme";
const ORDER: ThemeSetting[] = ["system", "dark", "light"];
let listeners: (() => void)[] = [];

function current(): ThemeSetting {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

function apply(setting: ThemeSetting): void {
  if (setting === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", setting);
  for (const btn of document.querySelectorAll<HTMLButtonElement>(
    '[data-testid="theme-toggle"]',
  )) {
    btn.textContent = `Theme: ${setting}`;
    btn.setAttribute("aria-label", `Switch theme (current: ${setting})`);
  }
  for (const cb of listeners) cb();
}

export function effectiveTheme(): "light" | "dark" {
  const s = current();
  if (s !== "system") return s;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function cycleTheme(): ThemeSetting {
  const next = ORDER[(ORDER.indexOf(current()) + 1) % ORDER.length];
  if (next === "system") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, next);
  apply(next);
  return next;
}

export function onThemeChange(cb: () => void): void {
  listeners.push(cb);
}

export function themeColors(): Record<string, string> {
  const s = getComputedStyle(document.documentElement);
  const read = (name: string) => s.getPropertyValue(name).trim();
  return {
    ground: read("--ground"), panel: read("--panel"), ink: read("--ink"),
    muted: read("--muted"), road: read("--road"), roadMajor: read("--road-major"),
    route: read("--route"), dijkstra: read("--c-dijkstra"), ch: read("--c-ch"),
    astar: read("--c-astar"), bidi: read("--c-bidi"),
    dijkstraGlow: read("--g-dijkstra"), chGlow: read("--g-ch"),
    astarGlow: read("--g-astar"), bidiGlow: read("--g-bidi"),
  };
}

export function initTheme(): void {
  listeners = [];
  for (const btn of document.querySelectorAll<HTMLButtonElement>(
    '[data-testid="theme-toggle"]',
  )) {
    btn.addEventListener("click", () => cycleTheme());
  }
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (current() === "system") apply("system");
  });
  apply(current());
}
```

- [ ] **Step 4: Replace `styles.css` with the token system** (light is the
  bare `:root`; dark overrides under BOTH the media query guarded by
  `:not([data-theme="light"])` and the explicit `[data-theme="dark"]`, so
  the toggle beats the OS both ways):

```css
:root {
  color-scheme: light;
  --ground: #f3f1ec; --panel: #ffffff; --panel-2: #faf8f4;
  --ink: #1c2330; --muted: #5a6372;
  --road: #d8d3c8; --road-major: #b3ac9d; --route: #1c2330;
  --c-dijkstra: #eb6834; --c-astar: #4a3aa7; --c-bidi: #e87ba4; --c-ch: #2a78d6;
  --g-dijkstra: #eb6834; --g-astar: #4a3aa7; --g-bidi: #e87ba4; --g-ch: #2a78d6;
  --witness: #008300; --line: #ddd8cc;
  --mono: ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, monospace;
  --sans: system-ui, "Segoe UI", sans-serif;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --ground: #0b0e14; --panel: #131826; --panel-2: #0e1420;
    --ink: #e8ecf4; --muted: #8b94a8;
    --road: #2a3348; --road-major: #3d4a68; --route: #ffffff;
    --c-dijkstra: #d95926; --c-astar: #9085e9; --c-bidi: #d55181; --c-ch: #3987e5;
    --g-dijkstra: #f5a962; --g-astar: #b48ce8; --g-bidi: #e87ba0; --g-ch: #4fd8eb;
    --witness: #7dd8a0; --line: #1c2334;
  }
}

[data-theme="dark"] {
  --ground: #0b0e14; --panel: #131826; --panel-2: #0e1420;
  --ink: #e8ecf4; --muted: #8b94a8;
  --road: #2a3348; --road-major: #3d4a68; --route: #ffffff;
  --c-dijkstra: #d95926; --c-astar: #9085e9; --c-bidi: #d55181; --c-ch: #3987e5;
  --g-dijkstra: #f5a962; --g-astar: #b48ce8; --g-bidi: #e87ba0; --g-ch: #4fd8eb;
  --witness: #7dd8a0; --line: #1c2334;
}

* { box-sizing: border-box; }

body {
  margin: 0; background: var(--ground); color: var(--ink);
  font-family: var(--sans); line-height: 1.55;
}

a { color: var(--c-ch); }

:focus-visible { outline: 2px solid var(--c-ch); outline-offset: 2px; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
```

  (Two dark scopes on purpose: the media query covers the "system" state,
  the `[data-theme="dark"]` block covers the explicit toggle, and the
  `:not([data-theme="light"])` guard lets an explicit light choice beat
  OS-dark. Page-specific styles land in T7/T9.)

- [ ] **Step 5: Run tests** — `pnpm vitest run src/theme.test.ts` → PASS
  (jsdom lacks `matchMedia`; add to the TEST file a stub before importing:
  `window.matchMedia ??= ((q: string) => ({ matches: false, media: q,
  addEventListener() {}, removeEventListener() {} })) as never;` at top of
  the test file, after the vitest imports).

- [ ] **Step 6: Full roster + commit**

```bash
pnpm check
git add styles.css src/theme.ts src/theme.test.ts
git commit -m "feat: three-state theme system with validated dual palettes"
```

---

### Task 2: Heap, graph containers, Dijkstra

**Files:**
- Create: `src/algos/heap.ts`, `src/algos/graph.ts`, `src/algos/dijkstra.ts`
- Test: `src/algos/dijkstra.test.ts` (covers all three)

**Interfaces:**
- Produces:
  - `class MinHeap { constructor(n: number); update(id: number, key: number): void; pop(): number /* -1 when empty */; get size(): number; clear(): void }`
  - `interface Csr { firstOut: Int32Array; head: Int32Array; weight: Float64Array; edge: Int32Array }` (`edge[i]` = index into the source edge list that produced slot `i`)
  - `interface Graph { n: number; lon: Float64Array; lat: Float64Array; fwd: Csr }`
  - `buildCsr(n: number, edges: {from: number; to: number; w: number}[]): Csr`
  - `transpose(n: number, c: Csr): Csr` (edge indices preserved)
  - `toyGraph(n: number, edges: [from: number, to: number, w: number][], opts?: {undirected?: boolean}): Graph` (coords all 0; undirected duplicates each edge both ways)
  - `interface SearchResult { dist: number; path: number[]; settled: Uint32Array; relaxed: number }`
  - `dijkstra(g: Graph, from: number, to: number): SearchResult` (`to === -1` searches everything; `path` empty when unreachable, `dist` = `Infinity`)
- Consumes: nothing.

- [ ] **Step 1: Write failing tests**

```ts
// src/algos/dijkstra.test.ts
import { describe, expect, it } from "vitest";
import { dijkstra } from "./dijkstra";
import { toyGraph, transpose, buildCsr } from "./graph";

// mulberry32 — seeded RNG so failures reproduce
function rng(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Brute-force Bellman-Ford as the oracle
function oracle(n: number, edges: [number, number, number][], s: number): number[] {
  const d = Array.from({ length: n }, () => Infinity);
  d[s] = 0;
  for (let i = 0; i < n; i++)
    for (const [u, v, w] of edges) if (d[u] + w < d[v]) d[v] = d[u] + w;
  return d;
}

describe("dijkstra", () => {
  it("finds the known path on a diamond", () => {
    // 0 -> 1 (1), 0 -> 2 (4), 1 -> 2 (1), 2 -> 3 (1), 1 -> 3 (5)
    const g = toyGraph(4, [[0, 1, 1], [0, 2, 4], [1, 2, 1], [2, 3, 1], [1, 3, 5]]);
    const r = dijkstra(g, 0, 3);
    expect(r.dist).toBe(3);
    expect(r.path).toEqual([0, 1, 2, 3]);
    expect(r.settled[0]).toBe(0); // settles source first
  });

  it("reports unreachable as Infinity with empty path", () => {
    const g = toyGraph(3, [[0, 1, 1]]);
    const r = dijkstra(g, 0, 2);
    expect(r.dist).toBe(Infinity);
    expect(r.path).toEqual([]);
  });

  it("matches Bellman-Ford on 30 random graphs", () => {
    const rand = rng(42);
    for (let trial = 0; trial < 30; trial++) {
      const n = 2 + Math.floor(rand() * 30);
      const edges: [number, number, number][] = [];
      for (let e = 0; e < n * 3; e++)
        edges.push([
          Math.floor(rand() * n), Math.floor(rand() * n),
          1 + Math.floor(rand() * 9),
        ]);
      const g = toyGraph(n, edges);
      const want = oracle(n, edges, 0);
      for (let t = 0; t < n; t++)
        expect(dijkstra(g, 0, t).dist, `trial ${trial} target ${t}`).toBe(want[t]);
    }
  });

  it("transpose preserves edge identity", () => {
    const c = buildCsr(3, [{ from: 0, to: 1, w: 5 }, { from: 1, to: 2, w: 7 }]);
    const t = transpose(3, c);
    // edge 1->2 becomes 2->1 slot; its edge index must still be 1
    const slot = t.firstOut[2];
    expect(t.head[slot]).toBe(1);
    expect(t.weight[slot]).toBe(7);
    expect(t.edge[slot]).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run src/algos/dijkstra.test.ts` → FAIL (modules missing).

- [ ] **Step 3: Implement**

```ts
// src/algos/heap.ts — indexed binary min-heap over node ids
export class MinHeap {
  private ids: Int32Array;
  private keys: Float64Array;
  private pos: Int32Array; // node id -> heap slot, -1 = absent
  private count = 0;

  constructor(n: number) {
    this.ids = new Int32Array(n);
    this.keys = new Float64Array(n);
    this.pos = new Int32Array(n).fill(-1);
  }

  get size(): number { return this.count; }

  clear(): void { this.pos.fill(-1); this.count = 0; }

  update(id: number, key: number): void {
    let i = this.pos[id];
    if (i === -1) { i = this.count++; this.ids[i] = id; this.pos[id] = i; }
    else if (key >= this.keys[this.ids[i]]) return;
    this.keys[id] = key;
    this.siftUp(i);
  }

  pop(): number {
    if (this.count === 0) return -1;
    const top = this.ids[0];
    this.pos[top] = -1;
    this.count--;
    if (this.count > 0) {
      this.ids[0] = this.ids[this.count];
      this.pos[this.ids[0]] = 0;
      this.siftDown(0);
    }
    return top;
  }

  key(id: number): number { return this.keys[id]; }

  private siftUp(i: number): void {
    const id = this.ids[i];
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[this.ids[p]] <= this.keys[id]) break;
      this.ids[i] = this.ids[p]; this.pos[this.ids[i]] = i; i = p;
    }
    this.ids[i] = id; this.pos[id] = i;
  }

  private siftDown(i: number): void {
    const id = this.ids[i];
    for (;;) {
      let c = i * 2 + 1;
      if (c >= this.count) break;
      if (c + 1 < this.count && this.keys[this.ids[c + 1]] < this.keys[this.ids[c]]) c++;
      if (this.keys[this.ids[c]] >= this.keys[id]) break;
      this.ids[i] = this.ids[c]; this.pos[this.ids[i]] = i; i = c;
    }
    this.ids[i] = id; this.pos[id] = i;
  }
}
```

  (Note the `update` early-return: a lazy-decrease guard — `keys` is indexed
  by node id, so compare against `this.keys[this.ids[i]]` where `ids[i] ===
  id`; the expression shown is equivalent since `ids[i] === id` there.)

```ts
// src/algos/graph.ts
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
```

```ts
// src/algos/dijkstra.ts
import { MinHeap } from "./heap";
import type { Csr, Graph } from "./graph";

export interface SearchResult {
  dist: number; path: number[]; settled: Uint32Array; relaxed: number;
}

export function dijkstraCsr(
  n: number, csr: Csr, from: number, to: number,
): SearchResult {
  const dist = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const heap = new MinHeap(n);
  const settled: number[] = [];
  let relaxed = 0;
  dist[from] = 0;
  heap.update(from, 0);
  while (heap.size > 0) {
    const u = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    settled.push(u);
    if (u === to) break;
    for (let s = csr.firstOut[u]; s < csr.firstOut[u + 1]; s++) {
      const v = csr.head[s];
      if (done[v]) continue;
      const d = dist[u] + csr.weight[s];
      relaxed++;
      if (d < dist[v]) { dist[v] = d; parent[v] = u; heap.update(v, d); }
    }
  }
  const path: number[] = [];
  if (to >= 0 && dist[to] < Infinity) {
    for (let v = to; v !== -1; v = parent[v]) path.push(v);
    path.reverse();
  }
  return {
    dist: to >= 0 ? dist[to] : NaN,
    path, settled: Uint32Array.from(settled), relaxed,
  };
}

export function dijkstra(g: Graph, from: number, to: number): SearchResult {
  return dijkstraCsr(g.n, g.fwd, from, to);
}
```

- [ ] **Step 4: Run tests** — `pnpm vitest run src/algos/dijkstra.test.ts` → PASS.
- [ ] **Step 5: `pnpm check` then commit** — `git add src/algos && git commit -m "feat: heap, CSR graph, Dijkstra with settle logs"`

---

### Task 3: CH build + query (the correctness core)

**Files:**
- Create: `src/algos/chBuild.ts`, `src/algos/chQuery.ts`
- Test: `src/algos/ch.test.ts`

**Interfaces:**
- Produces:
  - `interface ChEdge { from: number; to: number; w: number; childA: number; childB: number; src: number }` (`childA/childB` = indices into the augmented edge array for the two halves of a shortcut, `-1` for originals; `src` = original edge-list index, `-1` for shortcuts)
  - `interface Ch { n: number; rank: Int32Array; edges: ChEdge[]; up: Csr; downRev: Csr }` — `up` = augmented edges with `rank[to] > rank[from]`, forward orientation, CSR `edge[]` pointing into `edges`; `downRev` = augmented edges with `rank[to] < rank[from]`, stored REVERSED (keyed by `to`), for the backward climb.
  - `buildCh(g: Graph): Ch`
  - `interface ContractStep { shortcuts: { from: number; to: number; w: number }[]; witnessed: { from: number; to: number }[] }`
  - `createContractor(g: Graph): { contract(v: number): ContractStep; contracted(v: number): boolean; totalShortcuts(): number; reset(): void }` — INCREMENTAL: maintains the live adjacency including shortcuts added by earlier `contract` calls, so the chapter-2 toy stays truthful when the visitor contracts several nodes in sequence.
  - `contractOne(g: Graph, v: number): ContractStep` — one-shot convenience: `createContractor(g).contract(v)`.
  - `orderedShortcutCount(g: Graph, order: number[]): number` — contracts in exactly the given order, returns total shortcuts (chapter-4 toy).
  - `interface ChResult extends SearchResult { settledB: Uint32Array; meet: number }`
  - `chQuery(ch: Ch, from: number, to: number): ChResult` — `path` is the fully UNPACKED original-node path; `settled`/`settledB` are the forward/backward settle orders; `relaxed` sums both sides.
- Consumes: Task 2's `MinHeap`, `Csr`, `Graph`, `buildCsr`, `dijkstraCsr`, `toyGraph`.

- [ ] **Step 1: Write failing tests**

```ts
// src/algos/ch.test.ts
import { describe, expect, it } from "vitest";
import { toyGraph } from "./graph";
import { dijkstra } from "./dijkstra";
import { buildCh, contractOne, orderedShortcutCount } from "./chBuild";
import { chQuery } from "./chQuery";

function rng(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("contractOne (the chapter-2 invariant)", () => {
  // A--E--C with a top path A-T-C that witnesses one pair, and no
  // alternative for the other. Weights match the mockup's toy town.
  //   A->E 4, E->C 3, A->T 3, T->C 3  (A..C via E = 7, via T = 6: witness)
  //   B->E 3, E->D 5                  (B..D via E = 8, no bypass: shortcut)
  const n = 6; // A=0 B=1 T=2 E=3 C=4 D=5
  const g = toyGraph(n, [
    [0, 3, 4], [3, 4, 3], [0, 2, 3], [2, 4, 3], [1, 3, 3], [3, 5, 5],
  ], { undirected: true });

  it("adds a shortcut only when no witness exists", () => {
    const res = contractOne(g, 3);
    const sc = res.shortcuts.map((s) => [s.from, s.to, s.w].join(","));
    expect(sc).toContain("1,5,8");        // B->D must be shortcut, w=3+5
    expect(sc).not.toContain("0,4,7");    // A->C witnessed via T (6 < 7)
    expect(res.witnessed.some((p) => p.from === 0 && p.to === 4)).toBe(true);
  });
});

describe("CH equals Dijkstra everywhere (the site's headline claim)", () => {
  it("matches on 25 random undirected graphs, all pairs", () => {
    const rand = rng(7);
    for (let trial = 0; trial < 25; trial++) {
      const n = 4 + Math.floor(rand() * 24);
      const edges: [number, number, number][] = [];
      for (let i = 1; i < n; i++) // spanning tree keeps it connected
        edges.push([Math.floor(rand() * i), i, 1 + Math.floor(rand() * 9)]);
      for (let e = 0; e < n; e++)
        edges.push([
          Math.floor(rand() * n), Math.floor(rand() * n),
          1 + Math.floor(rand() * 9),
        ]);
      const g = toyGraph(n, edges, { undirected: true });
      const ch = buildCh(g);
      for (let s = 0; s < n; s++)
        for (let t = 0; t < n; t++) {
          const want = dijkstra(g, s, t).dist;
          const got = chQuery(ch, s, t);
          expect(got.dist, `trial ${trial}: ${s}->${t}`).toBe(want);
        }
    }
  });

  it("matches on directed graphs too (one-ways)", () => {
    const rand = rng(99);
    for (let trial = 0; trial < 25; trial++) {
      const n = 4 + Math.floor(rand() * 16);
      const edges: [number, number, number][] = [];
      for (let e = 0; e < n * 3; e++)
        edges.push([
          Math.floor(rand() * n), Math.floor(rand() * n),
          1 + Math.floor(rand() * 9),
        ]);
      const g = toyGraph(n, edges);
      const ch = buildCh(g);
      for (let s = 0; s < n; s++)
        for (let t = 0; t < n; t++)
          expect(chQuery(ch, s, t).dist, `t${trial} ${s}->${t}`).toBe(
            dijkstra(g, s, t).dist,
          );
    }
  });
});

describe("unpacking", () => {
  it("returns a contiguous original-edge path with matching weight", () => {
    const rand = rng(5);
    const n = 20;
    const edges: [number, number, number][] = [];
    for (let i = 1; i < n; i++)
      edges.push([Math.floor(rand() * i), i, 1 + Math.floor(rand() * 9)]);
    for (let e = 0; e < 30; e++)
      edges.push([
        Math.floor(rand() * n), Math.floor(rand() * n),
        1 + Math.floor(rand() * 9),
      ]);
    const g = toyGraph(n, edges, { undirected: true });
    const ch = buildCh(g);
    // adjacency weight lookup for verification
    const wOf = new Map<string, number>();
    for (const [u, v, w] of edges) {
      const a = wOf.get(`${u},${v}`);
      wOf.set(`${u},${v}`, Math.min(w, a ?? Infinity));
      const b = wOf.get(`${v},${u}`);
      wOf.set(`${v},${u}`, Math.min(w, b ?? Infinity));
    }
    for (let t = 1; t < n; t++) {
      const r = chQuery(ch, 0, t);
      if (r.dist === Infinity) continue;
      expect(r.path[0]).toBe(0);
      expect(r.path[r.path.length - 1]).toBe(t);
      let sum = 0;
      for (let i = 0; i + 1 < r.path.length; i++) {
        const w = wOf.get(`${r.path[i]},${r.path[i + 1]}`);
        expect(w, `edge ${r.path[i]}->${r.path[i + 1]} must be original`)
          .toBeDefined();
        sum += w ?? 0;
      }
      expect(sum).toBe(r.dist);
    }
  });
});

describe("ordering matters (the chapter-4 claim)", () => {
  it("the heuristic order adds no more shortcuts than a bad fixed order", () => {
    // star-of-cliques shape where contracting hubs first is catastrophic
    const g = toyGraph(8, [
      [0, 1, 1], [0, 2, 1], [0, 3, 1], [0, 4, 1], [0, 5, 1], [0, 6, 1], [0, 7, 1],
    ], { undirected: true });
    const hubFirst = orderedShortcutCount(g, [0, 1, 2, 3, 4, 5, 6, 7]);
    const hubLast = orderedShortcutCount(g, [1, 2, 3, 4, 5, 6, 7, 0]);
    expect(hubLast).toBeLessThan(hubFirst);
    const ch = buildCh(g);
    // heuristic must contract the hub last (highest rank)
    expect(ch.rank[0]).toBe(7);
  });
});
```

- [ ] **Step 2: Run to verify failure** — modules missing.

- [ ] **Step 3: Implement `src/algos/chBuild.ts`**

The witness search is a bounded Dijkstra from `u` over the CURRENT remaining
graph (contracted nodes and `v` excluded), stopping when the frontier min
exceeds `limit` (the largest `w(u,v)+w(v,x)` among pairs being checked) or
after 800 settles. Maintain dynamic adjacency as `Map<number, Map<number,
number>>` (out and in), seeded from the graph, mutated as nodes contract —
at toy and pipeline scale this is fast enough (the real build runs offline).

```ts
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
```

  Performance note for the pipeline run: `witnessSearch` above scans `dist`
  linearly per pop (fine ≤ a few hundred entries — witness searches are
  local). If the real-graph build exceeds ~3 min, swap the inner loop for a
  `MinHeap` keyed by a compacted local id map — do NOT change semantics.

- [ ] **Step 4: Implement `src/algos/chQuery.ts`**

```ts
import { MinHeap } from "./heap";
import type { SearchResult } from "./dijkstra";
import type { Ch, ChEdge } from "./chBuild";

export interface ChResult extends SearchResult { settledB: Uint32Array; meet: number }

function climb(
  ch: Ch, dir: "up" | "downRev", from: number,
  dist: Float64Array, parentEdge: Int32Array, done: Uint8Array,
  settled: number[], other: Float64Array, otherDone: Uint8Array,
  best: { d: number; meet: number }, counters: { relaxed: number },
): void {
  const csr = ch[dir];
  const heap = new MinHeap(ch.n);
  dist[from] = 0; heap.update(from, 0);
  while (heap.size > 0) {
    const u = heap.pop();
    if (done[u]) continue;
    if (dist[u] > best.d) break; // termination: frontier beyond best meeting
    done[u] = 1; settled.push(u);
    if (otherDone[u] && dist[u] + other[u] < best.d) {
      best.d = dist[u] + other[u]; best.meet = u;
    }
    for (let s = csr.firstOut[u]; s < csr.firstOut[u + 1]; s++) {
      const v = csr.head[s];
      const d = dist[u] + csr.weight[s];
      counters.relaxed++;
      if (d < dist[v]) {
        dist[v] = d; parentEdge[v] = csr.edge[s]; heap.update(v, d);
        if (otherDone[v] && d + other[v] < best.d) { best.d = d + other[v]; best.meet = v; }
      }
    }
  }
}

function expand(edges: ChEdge[], ei: number, acc: number[]): void {
  const e = edges[ei];
  if (e.childA === -1) { acc.push(ei); return; }
  expand(edges, e.childA, acc);
  expand(edges, e.childB, acc);
}

export function chQuery(ch: Ch, from: number, to: number): ChResult {
  const INF = Infinity;
  const dF = new Float64Array(ch.n).fill(INF);
  const dB = new Float64Array(ch.n).fill(INF);
  const pF = new Int32Array(ch.n).fill(-1);
  const pB = new Int32Array(ch.n).fill(-1);
  const doneF = new Uint8Array(ch.n);
  const doneB = new Uint8Array(ch.n);
  const sF: number[] = []; const sB: number[] = [];
  const best = { d: INF, meet: -1 };
  const counters = { relaxed: 0 };
  // NOTE: the two climbs must interleave for correct early termination in
  // adversarial graphs; sequential is exact too (termination check is
  // conservative: frontier-min > best), just occasionally settles more.
  climb(ch, "up", from, dF, pF, doneF, sF, dB, doneB, best, counters);
  climb(ch, "downRev", to, dB, pB, doneB, sB, dF, doneF, best, counters);
  // meeting scan (covers nodes settled by only one side)
  for (let v = 0; v < ch.n; v++)
    if (dF[v] + dB[v] < best.d) { best.d = dF[v] + dB[v]; best.meet = v; }
  if (best.meet === -1)
    return { dist: INF, path: [], settled: Uint32Array.from(sF), settledB: Uint32Array.from(sB), relaxed: counters.relaxed, meet: -1 };
  // reconstruct: forward chain of up-edges to meet, then backward chain
  const upSeq: number[] = [];
  for (let v = best.meet; v !== from && pF[v] !== -1; ) {
    upSeq.push(pF[v]); v = ch.edges[pF[v]].from;
  }
  upSeq.reverse();
  const dnSeq: number[] = [];
  for (let v = best.meet; v !== to && pB[v] !== -1; ) {
    dnSeq.push(pB[v]); v = ch.edges[pB[v]].to; // downRev edges stored reversed
  }
  const originalEdges: number[] = [];
  for (const ei of upSeq) expand(ch.edges, ei, originalEdges);
  for (const ei of dnSeq) expand(ch.edges, ei, originalEdges);
  const path: number[] = [from];
  let cur = from;
  for (const ei of originalEdges) {
    const e = ch.edges[ei];
    if (e.from !== cur) throw new Error(`unpack discontinuity at edge ${ei}`);
    cur = e.to;
    path.push(cur);
  }
  return {
    dist: best.d, path,
    settled: Uint32Array.from(sF), settledB: Uint32Array.from(sB),
    relaxed: counters.relaxed, meet: best.meet,
  };
}
```

  ⚠ Orientation reasoning, in case the strict walk throws: every entry in
  `ch.edges` is stored in forward route orientation, including entries
  reached via `downRev` (the reversal lives only in the CSR keying, and
  following `.to` while walking `pB` undoes it — see the reconstruction
  loops). `expand` therefore emits original edges already in route order.
  If the discontinuity error ever fires, the unpack test in Step 1 is the
  ground truth — debug against it; do not delete the assertion.

- [ ] **Step 5: Run tests** — `pnpm vitest run src/algos/ch.test.ts` → PASS.
  These tests are the assignment's core claim; do not weaken a failing
  assertion — fix the code.
- [ ] **Step 6: `pnpm check`, commit** — `git commit -m "feat: CH preprocessing and exact bidirectional upward query"`

---

### Task 4: Pipeline parsing units (fixture-tested, no network)

**Files:**
- Create: `scripts/data/osm.ts`, `scripts/data/build.ts`,
  `scripts/data/fixtures/mini.json`
- Test: `scripts/data/build.test.ts`
- Modify: `.gitignore` (append line `scripts/data/cache/`)

**Interfaces:**
- Consumes: Task 2/3 exports from `src/algos/` (scripts import them via
  relative path `../../src/algos/...` — vitest and `node --experimental-strip-types`
  both resolve them; run scripts with `node --experimental-strip-types scripts/data/build.ts`).
- Produces:
  - `parseOsm(json: OverpassJson): { nodes: Map<number, [number, number]>; ways: OsmWay[] }` where `OsmWay = { id: number; refs: number[]; highway: string; oneway: "yes" | "-1" | "no"; maxspeed?: number }`
  - `buildRoutingGraph(parsed): { lon: number[]; lat: number[]; edges: PipeEdge[] }` with `PipeEdge = { from: number; to: number; w: number; cls: number; geometry: [number, number][] }` — junction-split, weighted (seconds), oneway-expanded, largest-SCC-filtered, degree-2 chains contracted (geometry preserved).
  - `SPEEDS: Record<string, number>` km/h table: motorway 100, motorway_link 60, trunk 90, trunk_link 60, primary 70, primary_link 50, secondary 60, secondary_link 50, tertiary 50, tertiary_link 40, unclassified 50, residential 40, living_street 10.
  - `haversineM(lon1, lat1, lon2, lat2): number`
- Fixture: hand-write `mini.json` in Overpass shape (`{ elements: [{type:"node",id,lat,lon}, {type:"way",id,nodes:[...],tags:{highway,oneway?,maxspeed?}}] }`) modelling: a 6-node grid with one oneway street, one dead-end spur (must survive SCC only if bidirectional), one degree-2 chain of 3 nodes (must contract to a single edge with 3-point geometry), and one disconnected island (must be dropped by SCC).

- [ ] **Step 1: Write failing tests** — assert on the fixture: node/edge
  counts after each stage; the chain-contracted edge's weight equals the sum
  of its hops and its geometry has all 3 points; the island is gone; the
  oneway produces one directed edge, two-ways produce two; weights =
  meters / (kmh/3.6) using `maxspeed` when present else `SPEEDS[highway]`.

```ts
// scripts/data/build.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseOsm, buildRoutingGraph, SPEEDS, haversineM } from "./build";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/mini.json", import.meta.url), "utf8"),
);

describe("pipeline units", () => {
  it("haversine sanity: 0.001° lat ≈ 111 m", () => {
    expect(haversineM(149, -35, 149, -35.001)).toBeGreaterThan(105);
    expect(haversineM(149, -35, 149, -35.001)).toBeLessThan(118);
  });

  it("parses only drivable ways and reads oneway/maxspeed", () => {
    const { ways } = parseOsm(fixture);
    expect(ways.every((w) => w.highway in SPEEDS)).toBe(true);
    expect(ways.some((w) => w.oneway === "yes")).toBe(true);
  });

  it("drops the disconnected island via SCC", () => {
    const g = buildRoutingGraph(parseOsm(fixture));
    // fixture comment records which node ids are on the island
    expect(g.lon.length).toBe(fixture.expect.sccNodes);
  });

  it("contracts the degree-2 chain, preserving weight and geometry", () => {
    const g = buildRoutingGraph(parseOsm(fixture));
    const chain = g.edges.find((e) => e.geometry.length >= 3);
    expect(chain).toBeDefined();
    expect(chain?.w).toBeCloseTo(fixture.expect.chainSeconds, 1);
  });
});
```

  (Author `mini.json` WITH an `expect` object carrying the hand-computed
  numbers — the fixture and its expectations live together; ~40 lines.)

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement `osm.ts` + `build.ts` stage functions** —
  straightforward transforms; SCC = iterative Kosaraju (explicit stack both
  passes — the real graph is ~100k raw nodes, recursion would blow); chain
  contraction rule: node v with exactly the edge multiset
  {u→v, v→u, v→w, w→v} (two-way through) or {u→v, v→w} (oneway through),
  u ≠ w, merges into u↔w / u→w with concatenated geometry; repeat to fixed
  point; never contract preset-snap candidates' nearest nodes (not needed —
  snapping happens after, on the final graph).
- [ ] **Step 4: Tests pass; `pnpm check`; commit** — `git commit -m "feat: OSM pipeline parse/build stages with fixture tests"`

---

### Task 5: Pipeline emit + the real Canberra build + data contracts

**Files:**
- Create: `scripts/data/fetch.ts`, artifacts `public/data/render.json`,
  `public/data/routing.json`, `public/data/meta.json`
- Modify: `scripts/data/build.ts` (add `emit()` + CLI main), `package.json`
  (scripts: `"data:fetch": "node --experimental-strip-types scripts/data/fetch.ts"`,
  `"data:build": "node --experimental-strip-types scripts/data/build.ts"`)
- Test: `spec/data.test.ts`

**Interfaces:**
- Produces the artifact formats every later task reads:
  - `render.json`: `{ bbox: [minLon, minLat, maxLon, maxLat], lines: number[][] }`, each line `[cls, pct, x0, y0, dx1, dy1, ...]` — coords quantized to 1e-5° relative to bbox min (integers, delta-encoded after the first point); `cls` 0–3 (residential/tertiary/secondary+primary/trunk+motorway groups); `pct` 0–255 = floor(255 * min(rankPct(endpointA), rankPct(endpointB))) — the hierarchy slider shows lines with `pct >= threshold`.
  - `routing.json`: `{ n, lon: number[], lat: number[], from: number[], to: number[], w: number[], childA: number[], childB: number[], src: number[], rank: number[], renderOf: number[] }` — `lon/lat` quantized 1e-5° rel bbox; `w` in deciseconds (int); parallel arrays = the FULL augmented `ChEdge[]` (originals then shortcuts, `childA/childB/src` as in Task 3); `renderOf[i]` = render-line index for original edge i, `-1` for shortcuts.
  - `meta.json`: `{ built: string; nodes: number; originalEdges: number; shortcuts: number; buildMs: number; bench: { from: number; to: number; dds: number; dj: number; ch: number }[] }` — 300 seeded random reachable pairs; `dds` = distance in deciseconds, `dj`/`ch` = settled counts measured offline.
  - Loader contract (implemented in T6's `src/data.ts` but FROZEN here): `loadRender(): Promise<RenderData>`, `loadRouting(): Promise<{ graph: Graph; ch: Ch; renderOf: Int32Array }>` — reconstructs `Graph.fwd` from originals (`childA < 0`) and rebuilds `up`/`downRev` CSRs from rank exactly as `buildChOrdered` does.
- Consumes: Tasks 2–4.

- [ ] **Step 1: Write `spec/data.test.ts` (fails until artifacts exist)**

```ts
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildCsr, type Graph } from "../src/algos/graph";
import { dijkstraCsr } from "../src/algos/dijkstra";
import { chQuery } from "../src/algos/chQuery";
import { chFromArtifact, graphFromArtifact } from "../src/data-node";

const DATA = resolve("public/data");
const have = ["render.json", "routing.json", "meta.json"].every((f) =>
  existsSync(resolve(DATA, f)),
);

describe.skipIf(!have)("shipped Canberra artifacts", () => {
  const routing = JSON.parse(readFileSync(resolve(DATA, "routing.json"), "utf8"));
  const meta = JSON.parse(readFileSync(resolve(DATA, "meta.json"), "utf8"));
  const graph: Graph = graphFromArtifact(routing);
  const ch = chFromArtifact(routing);

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
```

  Also create `src/data-node.ts` here: pure decode functions (no fetch/DOM)
  `graphFromArtifact(routing)` and `chFromArtifact(routing)` shared by this
  test and T6's browser loader — dequantize coords, rebuild original-only
  CSR (`src` of originals point at themselves), rebuild `up`/`downRev`
  exactly as `buildChOrdered` does (same partition loop, reusing
  `buildCsr`).

- [ ] **Step 2: Implement `fetch.ts`** — POST the query below to
  `https://overpass-api.de/api/interpreter` (fallback on non-200/timeout:
  `https://overpass.kumi.systems/api/interpreter`), save raw to
  `scripts/data/cache/canberra.json`, print byte size. 180 s timeout,
  `AbortSignal.timeout`.

```
[out:json][timeout:180];
way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"]["area"!="yes"](-35.60,148.95,-35.10,149.28);
(._;>;);
out body;
```

- [ ] **Step 3: Implement `emit()` in build.ts** — run `buildCh` on the
  routing graph (log progress every 1000 contractions), compute rank
  percentiles → render `pct`, quantize, write the three artifacts, run the
  300-pair benchmark (seeded rng(2026); re-roll unreachable pairs), print
  the stats block (nodes, edges, shortcuts, build time, mean settled ratio,
  gzip sizes).
- [ ] **Step 4: RUN IT for real** — `pnpm data:fetch && pnpm data:build`.
  Expect: nodes 15k–40k after contraction, shortcuts of the same order as
  edges, ratio well under 5%, total gz well under 4 MB. If the CH build
  exceeds ~3 min, apply the heap swap noted in Task 3 Step 3. If gz > 4 MB,
  drop `living_street` from the filter and rebuild before any cleverness.
- [ ] **Step 5: `pnpm vitest run spec/data.test.ts`** → all live tests PASS.
- [ ] **Step 6: `pnpm check`; commit artifacts + code** —
  `git add public/data scripts/data src/data-node.ts spec/data.test.ts package.json .gitignore && git commit -m "feat: Canberra graph + CH artifacts with equivalence and budget sensors"`
  (Artifacts are committed on purpose: CI must never need the network.)

---

### Task 6: Map renderer + browser data loader

**Files:**
- Create: `src/viz/mapRenderer.ts`, `src/data.ts`
- Test: `src/viz/mapRenderer.test.ts`

**Interfaces:**
- Consumes: `themeColors`, `effectiveTheme`, `onThemeChange` (T1);
  `graphFromArtifact`, `chFromArtifact` (T5); `RenderData` shape from T5.
- Produces:
  - `src/data.ts`: `loadRender(base?: string): Promise<RenderData>`;
    `loadRouting(base?: string): Promise<{ graph: Graph; ch: Ch; renderOf: Int32Array; meta: Meta }>` — `fetch("./data/render.json")` etc. (RELATIVE paths only), decode via `src/data-node.ts`.
  - `class MapView { constructor(base: HTMLCanvasElement, overlay: HTMLCanvasElement, render: RenderData); resize(): void; setPctThreshold(pct: number | null): void; drawBase(): void; project(lon: number, lat: number): [number, number]; unproject(x: number, y: number): [number, number]; clearOverlay(): void; drawDots(order: Uint32Array, upto: number, lon: Float64Array, lat: Float64Array, color: string, opts: { additive: boolean; radius: number; stride: number }): void; drawRoute(path: number[], lon: Float64Array, lat: Float64Array): void; drawPin(lonV: number, latV: number, label: "A" | "B"): void }`
  - Theme recipes INSIDE MapView: dark → dots with `globalCompositeOperation
    = "lighter"`, glow colors; light → `source-over`, chart colors, radius
    +0.3. It re-draws base on `onThemeChange` automatically.
- Pure logic (projection fit, delta decode, threshold filter, dot stride
  math) is exported as plain functions and unit-tested; actual canvas calls
  are thin and verified by eye in T7.

- [ ] **Step 1: Failing tests for the pure parts** — `fitTransform(bbox, w,
  h, pad)` maps bbox corners inside the viewport preserving aspect;
  `decodeLine([cls,pct,x0,y0,dx,dy...])` returns absolute lon/lat pairs;
  `visibleLines(lines, pct)` filters by threshold; `strideFor(len, cap)`
  returns ceil(len/cap) with cap 4000.
- [ ] **Step 2: Implement; tests pass.**
- [ ] **Step 3: `pnpm check`; commit** — `git commit -m "feat: theme-aware canvas map renderer and artifact loader"`

---

### Task 7: Home page shell (flips 6 spec todos)

**Files:**
- Modify: `index.html` (full rewrite), `styles.css` (append page styles)
- Create: `src/pages/home.ts`
- Delete: `spec/starter.test.ts`, `main.ts`
- Test: flip todos in `spec/highway-to-hill.test.ts`

**Interfaces:**
- Consumes: `initTheme` (T1), `loadRender`/`MapView` (T6).
- Produces: the DOM contract every later task hangs off — ids/testids:
  `#map-base`, `#map-overlay` (stacked canvases inside
  `[data-testid="race-canvas"]` wrapper with `role="img"` + live
  `aria-label`), `[data-testid="scoreboard"]` with two `.row`s
  (`data-algo="dijkstra"|"ch"`, each with `.name` label and empty `.val`),
  `[data-testid="race-run"]` button, preset buttons
  (`[data-testid="preset-hill"]` first), `[data-testid="race-live"]`
  visually-hidden `aria-live="polite"` region, `[data-testid="theme-toggle"]`
  in nav, footer with attribution. Boot: `initTheme()` → `loadRender()` →
  paint base; controls disabled with reason until T8 wires racing.

- [ ] **Step 1: Flip the six todos to live tests** — home page: h1, core
  sentence, theme toggle, race canvas aria, scoreboard direct labels, OSM
  attribution. Real assertions, e.g.:

```ts
it(`h1 is exactly "${CONTRACTS.title}"`, () => {
  const doc = pageDoc("index.html");
  expect(doc?.querySelector("h1")?.textContent?.trim()).toBe(CONTRACTS.title);
});

it("core-interaction sentence appears verbatim in the hero", () => {
  const doc = pageDoc("index.html");
  expect(doc?.body.textContent).toContain(CONTRACTS.coreInteraction);
});
```

  (Same shape for the rest: `[data-testid=...]` presence, scoreboard row
  labels "Dijkstra" and "Contraction Hierarchies", footer contains
  `CONTRACTS.attribution` and "ODbL".)

- [ ] **Step 2: Run — they FAIL against the starter page.**
- [ ] **Step 3: Rewrite `index.html`** — full skeleton (trimmed to the
  structural truth; classes are yours, testids/copy are not):

```html
<!doctype html>
<html lang="en-AU">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="Watch Contraction Hierarchies race Dijkstra across Canberra's real road network, then learn exactly why it wins." />
    <title>Highway to Hill — Contraction Hierarchies on Canberra's streets</title>
    <script>
      // pre-paint theme stamp: no flash in either theme
      try {
        var t = localStorage.getItem("hth-theme");
        if (t === "light" || t === "dark")
          document.documentElement.setAttribute("data-theme", t);
      } catch (e) {}
    </script>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <header class="site-head">
      <nav aria-label="Primary">
        <a href="./" aria-current="page">Highway to Hill</a>
        <a href="./how/">How it works</a>
        <button data-testid="theme-toggle" type="button">Theme: system</button>
      </nav>
    </header>
    <main class="race-layout">
      <section class="hero">
        <div class="map-stack" data-testid="race-canvas" role="img"
             aria-label="Map of Canberra's road network, ready to race.">
          <canvas id="map-base"></canvas>
          <canvas id="map-overlay"></canvas>
        </div>
        <div class="hero-copy">
          <h1>Highway to Hill</h1>
          <p class="core">Drop two pins on Canberra. Watch Dijkstra flood the
            city while Contraction Hierarchies thread a handful of shortcuts
            — same route, a fraction of the work.</p>
        </div>
        <div class="controls">
          <button data-testid="race-run" type="button" disabled>Race</button>
          <button data-testid="preset-hill" type="button">To the Hill</button>
          <button data-preset="diagonal" type="button">Full diagonal</button>
          <button data-preset="anu-airport" type="button">ANU → Airport</button>
          <button data-preset="surprise" type="button">Surprise me</button>
          <span class="load-note" id="load-note">loading the road network…</span>
        </div>
      </section>
      <aside class="board" data-testid="scoreboard" aria-label="Race scoreboard">
        <p class="headline" id="board-headline"></p>
        <div class="row" data-algo="dijkstra">
          <span class="name">Dijkstra</span><span class="val"></span>
          <div class="track"><div class="fill"></div></div>
        </div>
        <div class="row" data-algo="ch">
          <span class="name">Contraction Hierarchies</span><span class="val"></span>
          <div class="track"><div class="fill"></div></div>
        </div>
        <p class="fineprint">Times and counts are measured in your browser.
          CH did a one-off preprocessing pass before this page loaded — that
          trade is the whole story. <a href="./how/">How it works →</a></p>
      </aside>
      <p class="visually-hidden" data-testid="race-live" aria-live="polite"></p>
    </main>
    <footer class="site-foot">
      <p>Road data © OpenStreetMap contributors, ODbL. Routing is computed
        in your browser on a simplified graph (one-ways yes, turn
        restrictions no). Reference: Geisberger, Sanders, Schultes &amp;
        Delling, “Contraction Hierarchies”, WEA 2008. No stop signs — speed
        limits modelled.</p>
    </footer>
    <script type="module" src="./src/pages/home.ts"></script>
  </body>
</html>
```

- [ ] **Step 4: `src/pages/home.ts` boot** — `initTheme()`; `loadRender()`
  → `new MapView(...)`, `drawBase()`; enable nothing yet; update
  `#load-note` through loading/failure states (`failed to load — reload to
  retry` on catch); `ResizeObserver` → `view.resize()`.
- [ ] **Step 5: Delete `spec/starter.test.ts` and `main.ts`.** Append the
  race-layout styles to `styles.css` (grid: map left, board right 320px;
  phone: stacked, board becomes bottom card; `.visually-hidden` utility;
  hit targets ≥ 44px).
- [ ] **Step 6: `pnpm check`** → six new tests green, invariants green on
  both pages. Manual: 4 combos (2 viewports × 2 themes) — map paints, no
  layout breaks, toggle cycles and persists across reload.
- [ ] **Step 7: Commit** — `git commit -m "feat: home shell — map paint, theme toggle, spec copy contracts live"`

---

### Task 8: Race wiring (worker, replay, pins) — flips 4 todos

**Files:**
- Create: `src/race/worker.ts`, `src/race/controller.ts`, `src/snap.ts`,
  `src/presets.ts`
- Modify: `src/pages/home.ts`
- Test: `src/race/controller.test.ts` (pure replay math),
  `src/snap.test.ts`, flip todos (race-run, preset-hill, race-live,
  honest-numbers)

**Interfaces:**
- Consumes: T5 loader, T6 MapView, T2/T3 algorithms.
- Produces:
  - `src/presets.ts`: `PRESETS: { id: string; label: string; a: [number, number]; b: [number, number] }[]` — lon/lat: hill: Gungahlin `[149.1330,-35.1860]` → Capital Hill `[149.1245,-35.3080]`; diagonal: Belconnen `[149.0660,-35.2400]` → Tuggeranong `[149.0880,-35.4150]`; anu-airport: `[149.1190,-35.2780]` → `[149.1930,-35.3070]`.
  - `src/snap.ts`: `nearestNode(lon: number, lat: number, lonArr: Float64Array, latArr: Float64Array): number` (equirect-scaled linear scan).
  - Worker protocol: request `{ id: number; from: number; to: number; algos: ("dijkstra" | "ch")[] }`; response `{ id: number; results: Record<string, { dist: number; ms: number; relaxed: number; settledCount: number; settled: ArrayBuffer; path: number[] }> }` (settled transferred). Worker loads routing artifact ONCE on first message via `loadRouting`.
  - `controller.ts`: `sliceForFrame(total: number, elapsedMs: number, durationMs: number): number` (monotone, clamps); `class RaceController { constructor(view: MapView, ui: { setRow(algo: string, settled: number, total: number): void; setHeadline(text: string): void; announce(text: string): void }); run(fromNode: number, toNode: number): Promise<void> }` — computes via worker, replays over 2500 ms (reduced-motion: jump to final), draws Dijkstra dots then CH dots then route, updates aria-label of the canvas wrapper and the `race-live` region ONCE per race: `"Dijkstra settled {n} intersections; Contraction Hierarchies settled {m}. Same {km} km route."`
- Pin interaction (in `home.ts`): click/tap map → snap → set A then B then
  reset cycle; drag pins on pointer devices; `R` key re-runs; auto-run once
  1.5 s after routing loads (skip under reduced-motion); "Surprise me" =
  two random nodes ≥ 8 km apart (haversine on coords).

- [ ] **Step 1: Failing unit tests** — `sliceForFrame` (0 at t=0, total at
  t≥duration, monotone); `nearestNode` on a tiny grid; presets snap: load
  the REAL routing.json from disk in the test (node fs, same as
  spec/data.test.ts) and assert every preset endpoint snaps within 800 m of
  its coordinate (guards against a preset in a lake or outside the graph).
- [ ] **Step 2: Implement worker + controller + wiring.** Scoreboard bars:
  width = settled/max(settled) linear; CH bar `min-width: 2px`; counts
  `toLocaleString("en-AU")`; wall-time row appears only after measurement
  (honest numbers). Enable `race-run` when routing loads.
- [ ] **Step 3: Flip the four todos** (button is a real `<button>`; preset
  exists; aria-live region non-empty after race is NOT statically checkable
  — assert the region exists with `aria-live="polite"`; honest-numbers:
  scoreboard `.val` elements are empty in built HTML).
- [ ] **Step 4: `pnpm check`; manual 4-combo verification** — race runs,
  replay smooth, counters tick, theme switch MID-RACE re-renders correctly
  (this is the rubric's resize/torture line — also resize mid-race), phone
  tap-to-place works, `R` works, reduced-motion (emulate in devtools) shows
  final state instantly.
- [ ] **Step 5: Commit** — `git commit -m "feat: the race — worker compute, replay, pins, honest scoreboard"`

---

### Task 9: /how/ shell + chapters 1–2 (flood + contraction toys)

**Files:**
- Create: `how/index.html`, `src/pages/how.ts`, `src/toys/minitown.ts`,
  `src/toys/flood.ts`, `src/toys/contraction.ts`
- Modify: `styles.css` (chapter + toy styles)
- Test: `src/toys/minitown.test.ts`; flip how-page todos (page exists,
  toggle, attribution+reference; headings/toys partially — see note)

**Interfaces:**
- Consumes: T1 theme, T2/T3 (`dijkstra`, `createContractor` — the
  incremental API, so sequential contractions account for earlier
  shortcuts), CONTRACTS copy.
- Produces: `minitown.ts` exports `MINITOWN: { graph: Graph; xy: [number, number][]; names: string[] }` — 12 nodes, undirected weights, hand-laid coordinates in a 460×280 viewBox, a through "highway" row so the toys tell the same story as the map. All later toys import it.
- The five chapter `<section>`s all exist in this task's HTML (headings are
  a single contract), with chapters 3–5 carrying an honest
  `<p class="coming">interactive lands in the next commit</p>` placeholder
  INSIDE an already-present `data-testid="toy-order|toy-hierarchy|toy-climb"`
  root — so flip the headings todo AND the toy-roots todo here, and T10/T11
  replace placeholders with the real toys (the DOM contract doesn't change).
- Flood toy: ▶ play / step / ⟲ reset buttons drive `dijkstra(MINITOWN.graph,
  A, B)` settle order onto the SVG, settled counter live. Contraction toy:
  one `createContractor(MINITOWN.graph)` instance per mount; every node
  clickable (`<button>` wrapping each circle for keyboard) → `.contract(v)`
  → witnesses flash `--witness`, shortcuts append as dashed paths with
  weight labels, `totalShortcuts()` drives the counter; reset calls
  `.reset()` and restores the SVG.

- [ ] **Step 1: minitown unit test** — graph is connected; all weights
  positive; `dijkstra(A,B)` settles ≥ 8 nodes (so the flood is worth
  watching).
- [ ] **Step 2: Flip how-page todos to live tests, watch them fail.**
- [ ] **Step 3: Build page + toys.** `how/index.html` head/nav/footer match
  home (same inline theme stamp, `../styles.css`, `../src/pages/how.ts`,
  nav links `../` and `./`); one `h1` ("How it works"); five sections with
  the exact CONTRACTS headings; footer adds the Geisberger reference.
- [ ] **Step 4: `pnpm check`; manual 4-combo on /how/;** toys operable by
  keyboard alone.
- [ ] **Step 5: Commit** — `git commit -m "feat: how page with flood and contraction toys"`

---

### Task 10: Chapters 3–4 (order game + hierarchy reveal)

**Files:**
- Create: `src/toys/order.ts`, `src/toys/hierarchy.ts`
- Modify: `src/pages/how.ts`, `styles.css`
- Test: `src/toys/order.test.ts`

**Interfaces:**
- Consumes: `orderedShortcutCount`, `buildCh` (T3), MINITOWN (T9),
  `loadRender` + `MapView.setPctThreshold` (T6).
- Produces: order toy — three buttons run `orderedShortcutCount` with
  (a) seeded random order, (b) worst order = descending current degree,
  (c) the heuristic (`buildCh` rank order ascending); tiles show the three
  LIVE counts (no hardcoding — honest numbers); "your turn" mode: clicking
  nodes builds a user order, contract-as-you-go with running count, compare
  against heuristic. Hierarchy toy — a small MapView over the REAL
  render.json with a labelled `<input type="range">` stepping pct
  thresholds `[0, 166, 224, 250]` (≈ all / top 35% / top 12% / top 2%),
  captioned "the bridges survive to the very top".
- [ ] **Step 1: order.test.ts** — on MINITOWN: heuristic count ≤ random
  count for 5 seeds; worst ≥ heuristic; counts deterministic per seed.
- [ ] **Step 2: Implement both toys, replace the two placeholders.**
- [ ] **Step 3: `pnpm check`; manual 4-combo; commit** —
  `git commit -m "feat: ordering game and real-map hierarchy reveal"`

---

### Task 11: Chapter 5 (the climb) + closing echo

**Files:**
- Create: `src/toys/climb.ts`
- Modify: `src/pages/how.ts`, `src/race/controller.ts` (one line: persist
  last race `{dj, ch, km}` to `localStorage["hth-last-race"]`)
- Test: flip the remaining how todo (toy-climb) + chapter-5 heading part

**Interfaces:**
- Consumes: `buildCh` + `chQuery` on MINITOWN (T3/T9).
- Produces: SVG with nodes lifted by `rank` (y = base − rank·step), ▶ play
  animates the real `chQuery` forward/backward settle orders as two
  climbing highlights, meet node starred, then the unpack: shortcut path
  segments split into original edges (scripted from `ChResult.path`).
  MVP fallback (pre-authorized by spec §11): if the animation overruns its
  timebox (3 h), ship the static laid-out SVG with the meet/unpack drawn —
  keep the play button OUT rather than shipping a broken one. Closer copy
  reads `hth-last-race` and echoes: "that's why {ch} beat {dj} on your own
  race" (falls back to meta.json benchmark means when absent — still
  measured numbers).
- [ ] Steps: flip todo → fail → implement → `pnpm check` → manual → commit
  `git commit -m "feat: the climb — upward query toy with unpack"`

---

### Task 12: A11y, torture, loading polish (MVP gate)

**Files:**
- Modify: `src/pages/home.ts`, `src/race/controller.ts`, `styles.css`,
  `docs/mockup/index.html` (only if a shared style broke it — it must keep
  passing invariants untouched otherwise)
- Test: none new; this task is the manual rubric sweep + fixes

- [ ] **Step 1: Keyboard-only pass** — Tab order sane on both pages; every
  toy and the race fully operable; focus visible everywhere.
- [ ] **Step 2: Reduced-motion pass** — devtools emulation: no auto-race,
  no replay animation, final states + numbers everywhere.
- [ ] **Step 3: Slow-network pass** — devtools 3G: copy readable
  immediately, load notes visible, no layout jump when data lands; routing
  fetch failure shows the retry message.
- [ ] **Step 4: Resize + theme mid-race** — drag viewport 1920→390 during a
  replay and toggle theme mid-replay: no crash, redraw correct.
- [ ] **Step 5: 4-combo screenshot sweep** — 1920×1080 and 390×844, light
  and dark, both pages; fix what looks broken.
- [ ] **Step 6: `pnpm check` + `pnpm dlx linkinator ./dist --silent`; commit** —
  `git commit -m "polish: keyboard, reduced-motion, slow-network, resize hardening"`
  **This commit is the MVP gate: everything after is optional.**

---

### Task 13 (target tier, only if Task 12 lands by Sun evening): A* + bidirectional

**Files:**
- Create: `src/algos/astar.ts`, `src/algos/bidijkstra.ts`
- Modify: `src/race/worker.ts`, `src/race/controller.ts`, `index.html`
  (two more chips, present-but-disabled until data ready), `styles.css`
- Test: `src/algos/variants.test.ts`

**Interfaces:**
- `astar(g: Graph, from: number, to: number, h: (v: number) => number): SearchResult` — heuristic = haversine meters / 27.8 m/s (100 km/h ceiling → admissible for time weights); `bidijkstra(g: Graph, gRev: Csr, from: number, to: number): SearchResult`.
- Scoreboard grows rows in FIXED roster order Dijkstra, A*, bidi, CH with
  the validated hues (`--c-astar`, `--c-bidi` / glows). Chips toggle
  participation; roster order and colors never change with selection.
- [ ] Tests: both match `dijkstra` distances on the seeded random-graph
  sweep (reuse the Task 2 oracle pattern verbatim); A* settles ≤ Dijkstra
  on MINITOWN with real coords.
- [ ] Implement, wire chips, `pnpm check`, manual, commit
  `git commit -m "feat: A* and bidirectional Dijkstra join the race"`

---

### Task 14: Ship

- [ ] **Step 1:** Student writes `reflections/assignment-1.md` (personal —
  not agent-authored). `node scripts/check-evidence.ts` → all green.
- [ ] **Step 2:** Update PROCESS.md moments with build-phase citations
  (real hashes from Tasks 5, 8, 12 — pick the 3–4 that show judgement;
  400–600 words).
- [ ] **Step 3:** `pnpm check` + linkinator fresh; final 4-combo look.
- [ ] **Step 4:** Run the course `ship` skill (flips repo public, enables
  Pages, verifies the live URL) — leave ≥ 1 h before noon Monday for CI.
- [ ] **Step 5:** Verify the LIVE URL at both viewports, both themes —
  deployed is what's marked.

---

## Self-review (done at authoring time)

- **Spec coverage:** every §5 feature maps to T7–T11; §8 themes → T1/T6/T7;
  §9 pipeline/formats → T4/T5; §10 sensors → T2/T3 tests, spec/data.test.ts
  (T5), contract todos (T7–T11); §11 tiers → task ordering + T12 gate + T13
  conditional; HD-rubric torture lines → T8 Step 4 + T12. Chapter-4 "your
  turn" is in T10; its stretch scoring variant is correctly ABSENT.
- **Type consistency:** `Csr.edge` naming (not `edgeIdx`) used throughout;
  `ChEdge.src` (not `renderRef`) in code, with `renderOf` living in the
  artifact only; `chQuery` consumes `downRev` built reversed — T5's loader
  note repeats the same partition rule so the two constructions match.
- **Placeholder scan:** chapters 3–5 placeholders in T9 are deliberate,
  visible, honest UI states with their replacement tasks named — not plan
  placeholders. One known soft spot is called out explicitly (T3 unpack
  stitch) with its failure mode, its test, and the exact fix.
