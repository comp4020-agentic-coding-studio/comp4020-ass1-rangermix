// Theme-aware canvas map renderer over public/data/render.json's road-line
// artifact. Split deliberately into two halves:
//
//   1. Pure geometry/data functions (fitTransform, decodeLine, visibleLines,
//      strideFor) — no DOM, no canvas, fully unit-tested in
//      mapRenderer.test.ts.
//   2. `MapView`, a thin class wrapping two stacked <canvas> elements (a
//      static "base" layer for the road network, a dynamic "overlay" layer
//      for settle-flood dots/route/pins) that composes those pure functions
//      with real canvas 2D calls. jsdom has no canvas 2D context, so this
//      half is untested here by design — verified by eye once Task 7 wires
//      a MapView into the home page.
//
// Coordinates: render.json's `lines` are quantized to an integer 1e-5°
// grid relative to `bbox`'s [minLon, minLat] corner, delta-encoded after
// the first point (see scripts/data/build.ts's emit() and
// src/data-node.ts's matching COORD_SCALE) — decodeLine reverses exactly
// that. Projection is equirectangular with cos(midLat) x-scaling: Canberra's
// bbox is small enough (~0.4° x 0.6°) that this is visually indistinguishable
// from a proper conformal projection, at a fraction of the code.

import { effectiveTheme, onThemeChange, themeColors } from "../theme";

/** The shape of public/data/render.json: one polyline per PipeEdge, each
 * `[cls, pct, x0, y0, dx1, dy1, ...]` — see decodeLine for the coordinate
 * scheme. `cls` 0-3 (residential -> motorway); `pct` 0-255, the CH-rank
 * percentile the hierarchy slider filters on (see visibleLines). */
export interface RenderData {
  bbox: [number, number, number, number];
  lines: number[][];
}

/** A fitted map projection: screen = (lon - bbox.minLon) * cosMidLat *
 * scale + ox, (bbox.maxLat - lat) * scale + oy (see fitTransform). */
export interface Transform {
  scale: number;
  ox: number;
  oy: number;
}

const COORD_SCALE = 1e5; // matches src/data-node.ts and scripts/data/build.ts
const DEG2RAD = Math.PI / 180;

function cosMidLat(bbox: [number, number, number, number]): number {
  const midLat = (bbox[1] + bbox[3]) / 2;
  return Math.cos(midLat * DEG2RAD);
}

function projectPoint(
  bbox: [number, number, number, number], t: Transform, lon: number, lat: number,
): [number, number] {
  const cosMid = cosMidLat(bbox);
  return [(lon - bbox[0]) * cosMid * t.scale + t.ox, (bbox[3] - lat) * t.scale + t.oy];
}

/** Fits `bbox` inside a `w`x`h` viewport with `pad` px of margin on every
 * side, preserving aspect ratio (a single uniform `scale`, never separate
 * x/y scales — an equirectangular projection with cos(midLat) x-correction
 * needs exactly one scale to stay undistorted). The limiting dimension
 * exactly fills its padded span; the other is centered with slack. Y is
 * flipped so north (higher latitude) renders up. */
export function fitTransform(
  bbox: [number, number, number, number], w: number, h: number, pad: number,
): Transform {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const cosMid = cosMidLat(bbox);
  const mapW = Math.max(1e-9, (maxLon - minLon) * cosMid);
  const mapH = Math.max(1e-9, maxLat - minLat);
  const availW = Math.max(0, w - 2 * pad);
  const availH = Math.max(0, h - 2 * pad);
  const scale = Math.min(availW / mapW, availH / mapH);
  const ox = pad + (availW - mapW * scale) / 2;
  const oy = pad + (availH - mapH * scale) / 2;
  return { scale, ox, oy };
}

/** Reverses render.json's per-line encoding: `line[0]` is `cls`, `line[1]`
 * is `pct` (both metadata, not coordinates), `line[2..3]` is the first
 * point in absolute quantized units, and every following pair is a delta
 * from the running position. Returns absolute, dequantized [lon, lat]
 * pairs, one per geometry point. */
export function decodeLine(
  line: number[], bbox: [number, number, number, number],
): [number, number][] {
  const [minLon, minLat] = bbox;
  const pts: [number, number][] = [];
  let qx = line[2];
  let qy = line[3];
  pts.push([minLon + qx / COORD_SCALE, minLat + qy / COORD_SCALE]);
  for (let i = 4; i < line.length; i += 2) {
    qx += line[i];
    qy += line[i + 1];
    pts.push([minLon + qx / COORD_SCALE, minLat + qy / COORD_SCALE]);
  }
  return pts;
}

/** The hierarchy slider's filter: keep only lines whose `pct` (line[1]) is
 * at or above `pctThreshold`. `null` means unfiltered (every line visible)
 * — the base layer's default. */
export function visibleLines(lines: number[][], pctThreshold: number | null): number[][] {
  if (pctThreshold === null) return lines;
  return lines.filter((line) => line[1] >= pctThreshold);
}

/** How many of every `stride`-th settled node to draw so a flood of `len`
 * points never exceeds `cap` drawn dots per frame (perf: replay is capped
 * to ~4k drawn points per the design spec, §12 phone-canvas-perf risk) —
 * the settled COUNTER stays exact regardless, only the visual sampling
 * thins out. Always at least 1 (never 0 — a 0 stride would stall or
 * divide-by-zero a caller's `for (i = 0; i < upto; i += stride)` loop). */
export function strideFor(len: number, cap = 4000): number {
  return Math.max(1, Math.ceil(len / cap));
}

const PAD = 24; // px of margin fitTransform keeps around the fitted bbox

// Ghost-underlay alpha for the hierarchy toy's filtered steps (round 4 fix):
// once a pct threshold hides most of the network, the retained lines alone
// read as fragments floating in a void — drawing the FULL network first, at
// this near-invisible alpha, gives the eye the remembered shape of the
// whole city to read the highlighted subset against. `--road`'s own alpha
// (0.55, used for the unfiltered base layer) would still swamp the
// emphasis; this sits an order of magnitude fainter, per spec (0.05-0.08).
const GHOST_ALPHA = 0.07;

/** Owns the two stacked canvases the home page's race (and /how/'s
 * hierarchy toy, which reuses the same data) paint into: `base` is the
 * static road network, redrawn only on resize/theme-change/threshold
 * change; `overlay` is the per-frame settle-flood/route/pins layer the
 * caller (RaceController, Task 8) drives directly. MapView never redraws
 * the overlay on its own — replay state lives in the caller, not here (see
 * design spec §8: "Canvases re-render on theme change, including mid-race
 * — replay state lives in data") — so after a theme change flips the base
 * layer's colors automatically, the caller re-invokes clearOverlay/
 * drawDots/drawRoute/drawPin with whatever frame it was already showing;
 * those four methods ARE that redraw hook. */
export class MapView {
  private readonly baseCanvas: HTMLCanvasElement;
  private readonly overlayCanvas: HTMLCanvasElement;
  private readonly baseCtx: CanvasRenderingContext2D;
  private readonly overlayCtx: CanvasRenderingContext2D;
  private render: RenderData;
  private transform: Transform = { scale: 1, ox: 0, oy: 0 };
  private pctThreshold: number | null = null;
  private emphasize = false;
  private dpr = 1;
  private cssWidth = 0;
  private cssHeight = 0;

  constructor(base: HTMLCanvasElement, overlay: HTMLCanvasElement, render: RenderData) {
    this.baseCanvas = base;
    this.overlayCanvas = overlay;
    this.render = render;
    const baseCtx = base.getContext("2d");
    const overlayCtx = overlay.getContext("2d");
    if (!baseCtx || !overlayCtx) throw new Error("MapView: 2D canvas context unavailable");
    this.baseCtx = baseCtx;
    this.overlayCtx = overlayCtx;
    onThemeChange(() => this.drawBase());
    this.resize();
  }

  /** Re-reads each canvas's CSS box size, re-allocates its backing store at
   * the (capped) device pixel ratio, recomputes the fitted projection, and
   * repaints the base layer — safe to call from a ResizeObserver as often
   * as layout changes; also called once by the constructor so a freshly
   * constructed MapView is never left blank. */
  resize(): void {
    const dpr = Math.min(2, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
    this.dpr = dpr;
    for (const canvas of [this.baseCanvas, this.overlayCanvas]) {
      const rect = canvas.getBoundingClientRect();
      const cssW = Math.max(1, rect.width || canvas.clientWidth || 1);
      const cssH = Math.max(1, rect.height || canvas.clientHeight || 1);
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    this.cssWidth = this.baseCanvas.width / dpr;
    this.cssHeight = this.baseCanvas.height / dpr;
    this.baseCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.transform = fitTransform(this.render.bbox, this.cssWidth, this.cssHeight, PAD);
    this.drawBase();
  }

  /** Sets the hierarchy-slider filter (`null` = show every road) and
   * repaints the base layer immediately. `emphasize` (the toy's top-two
   * slider stops — top 12%/top 2%) strokes every retained line in the
   * CH-blue family at a touch of extra width instead of the normal
   * road/road-major greys, so the surviving skeleton reads as one connected
   * thing rather than same-weight leftover fragments. */
  setPctThreshold(pct: number | null, opts: { emphasize?: boolean } = {}): void {
    this.pctThreshold = pct;
    this.emphasize = opts.emphasize ?? false;
    this.drawBase();
  }

  project(lon: number, lat: number): [number, number] {
    return projectPoint(this.render.bbox, this.transform, lon, lat);
  }

  unproject(x: number, y: number): [number, number] {
    const [minLon, , , maxLat] = this.render.bbox;
    const cosMid = cosMidLat(this.render.bbox);
    const lon = minLon + (x - this.transform.ox) / (this.transform.scale * cosMid);
    const lat = maxLat - (y - this.transform.oy) / this.transform.scale;
    return [lon, lat];
  }

  /** Traces one render.json line into `ctx`'s current path (decode + project
   * + moveTo/lineTo) without touching stroke style — the caller sets
   * strokeStyle/lineWidth/globalAlpha and calls `stroke()`. Returns false
   * (nothing traced) for a degenerate single-point line, matching the old
   * inline `if (pts.length < 2) continue`. Shared by drawBase's ghost pass
   * and its retained-lines pass so the decode/project walk exists once. */
  private tracePath(ctx: CanvasRenderingContext2D, line: number[]): boolean {
    const pts = decodeLine(line, this.render.bbox);
    if (pts.length < 2) return false;
    ctx.beginPath();
    const [x0, y0] = this.project(pts[0][0], pts[0][1]);
    ctx.moveTo(x0, y0);
    for (let i = 1; i < pts.length; i++) {
      const [x, y] = this.project(pts[i][0], pts[i][1]);
      ctx.lineTo(x, y);
    }
    return true;
  }

  /** Paints the static road network: ground fill, then (once a pct
   * threshold is filtering the view — the hierarchy toy's "top k%" steps)
   * an ultra-faint ghost pass of the FULL, unfiltered network so the
   * retained lines read as a highlighted subset of the remembered whole
   * city rather than fragments in a void, then every visible line (per the
   * current pct threshold), class-weighted width/alpha, major roads
   * (cls >= 2) in `roadMajor`, the rest in `road` (or the CH-blue emphasis
   * family when `emphasize` is set). Called on construction, resize,
   * threshold change, and automatically on every theme change (subscribed
   * in the constructor). */
  drawBase(): void {
    const ctx = this.baseCtx;
    const colors = themeColors();
    ctx.save();
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
    ctx.fillStyle = colors.ground;
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (this.pctThreshold !== null) {
      ctx.strokeStyle = colors.road;
      ctx.globalAlpha = GHOST_ALPHA;
      ctx.lineWidth = 1;
      for (const line of this.render.lines) {
        if (this.tracePath(ctx, line)) ctx.stroke();
      }
    }
    for (const line of visibleLines(this.render.lines, this.pctThreshold)) {
      const major = line[0] >= 2;
      if (!this.tracePath(ctx, line)) continue;
      ctx.strokeStyle = this.emphasize ? colors.ch : (major ? colors.roadMajor : colors.road);
      ctx.globalAlpha = major ? 0.9 : 0.55;
      ctx.lineWidth = (major ? 1.6 : 1) + (this.emphasize ? 0.6 : 0);
      ctx.stroke();
    }
    ctx.restore();
  }

  clearOverlay(): void {
    this.overlayCtx.clearRect(0, 0, this.cssWidth, this.cssHeight);
  }

  /** Draws `order[0..upto)` sampled every `opts.stride`-th node (see
   * strideFor) as filled dots at `opts.radius`, in `color` — the caller
   * picks `color` per algorithm+theme (e.g. themeColors().dijkstraGlow in
   * dark, .dijkstra in light) since MapView has no notion of "which
   * algorithm". The theme recipe MapView itself owns: dark blends dots
   * additively ("lighter", if the caller asked for it via opts.additive —
   * light NEVER blends additively, since glow washes out on paper per the
   * design spec) and light nudges the radius up by 0.3 (opaque dots read
   * smaller on paper than glowing ones do at night). */
  drawDots(
    order: Uint32Array, upto: number, lon: Float64Array, lat: Float64Array,
    color: string, opts: { additive: boolean; radius: number; stride: number },
  ): void {
    const ctx = this.overlayCtx;
    const dark = effectiveTheme() === "dark";
    ctx.save();
    ctx.globalCompositeOperation = dark && opts.additive ? "lighter" : "source-over";
    ctx.fillStyle = color;
    const radius = dark ? opts.radius : opts.radius + 0.3;
    const stride = Math.max(1, opts.stride);
    const n = Math.min(upto, order.length);
    for (let i = 0; i < n; i += stride) {
      const node = order[i];
      const [x, y] = this.project(lon[node], lat[node]);
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Draws the shared shortest route (a sequence of node indices) as a
   * single stroked path in the theme's route color. */
  drawRoute(path: number[], lon: Float64Array, lat: Float64Array): void {
    if (path.length < 2) return;
    const ctx = this.overlayCtx;
    const colors = themeColors();
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = colors.route;
    ctx.lineWidth = 2.4;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    const [x0, y0] = this.project(lon[path[0]], lat[path[0]]);
    ctx.moveTo(x0, y0);
    for (let i = 1; i < path.length; i++) {
      const [x, y] = this.project(lon[path[i]], lat[path[i]]);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  /** Draws pin `label` ("A" or "B") as a disc + letter, entirely
   * theme-sourced (read fresh from `themeColors()` on every call, so a
   * theme switch is correct on the very next draw, mid-race included): disc
   * = `ink`, letter = `ground` — `ink`/`ground` are each theme's own
   * validated contrast pair (design spec "Surfaces & ink"), so this inverts
   * sensibly instead of just re-coloring — dark theme gets a near-white
   * disc with a near-black letter (matching the original fixed design),
   * light theme gets a near-black disc with a near-white letter (the
   * inversion that actually reads against light theme's near-white
   * ground/panel, unlike a literal white disc would). The ring is `ground`
   * again at reduced `globalAlpha` (a translucent DERIVATION of a theme
   * token via the canvas API's own alpha channel, not a hardcoded
   * rgba literal) — a soft halo in the opposite tone from the disc that
   * separates the pin from the road lines under it, in either theme. */
  drawPin(lonV: number, latV: number, label: "A" | "B"): void {
    const ctx = this.overlayCtx;
    const colors = themeColors();
    const [x, y] = this.project(lonV, latV);
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.fillStyle = colors.ink;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = colors.ground;
    ctx.globalAlpha = 0.4;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = colors.ground;
    ctx.font = "bold 11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x, y);
    ctx.restore();
  }
}
