import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

// The checkable lines of the Highway to Hill design spec
// (docs/superpowers/specs/2026-08-14-ch-explainer-design.md), written down
// BEFORE the implementation exists. Contracts whose feature hasn't landed
// yet are `it.todo` — the implementation plan names the task that flips
// each one to a live test. A flipped test never goes back to todo.
//
// Data-layer contracts (CH↔Dijkstra equivalence on the shipped graph,
// settled-nodes ratio, payload budget) are NOT here — they land as
// spec/data.test.ts in the pipeline task, because they need the committed
// artifacts to exist.

const DIST = resolve("dist");

// Single source of truth for the copy/testid contracts the pages must carry.
export const CONTRACTS = {
  title: "Highway to Hill",
  coreInteraction:
    "Drop two pins on Canberra. Watch Dijkstra flood the city while " +
    "Contraction Hierarchies thread a handful of shortcuts — same route, " +
    "a fraction of the work.",
  chapterHeadings: [
    "What Dijkstra actually does",
    "Contraction: remove a node without lying about distances",
    "Order is everything",
    "The hierarchy, revealed",
    "The query: only ever climb",
  ],
  testids: {
    themeToggle: "theme-toggle",
    raceCanvas: "race-canvas",
    scoreboard: "scoreboard",
    raceRun: "race-run",
    raceLive: "race-live",
    presetHill: "preset-hill",
    toys: ["toy-flood", "toy-contraction", "toy-order", "toy-hierarchy", "toy-climb"],
  },
  attribution: "OpenStreetMap contributors",
} as const;

function pageDoc(name: string): Document | undefined {
  const path = join(DIST, name);
  if (!existsSync(path)) return undefined;
  return new JSDOM(readFileSync(path, "utf8")).window.document;
}

function allPages(dir: string = DIST): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return allPages(path);
    return entry.name.endsWith(".html") ? [relative(DIST, path)] : [];
  });
}

describe("spec: static and client-side throughout (live now)", () => {
  // The brief requires the site to be static and client-side. Concretely:
  // no page pulls a script, stylesheet, or image from another origin, and
  // no shipped bundle phones home. Holds for the starter and must keep
  // holding for every page we add.
  it("no page loads assets from an absolute or protocol-relative URL", () => {
    const pages = allPages();
    expect(pages.length).toBeGreaterThan(0);
    for (const name of pages) {
      const doc = pageDoc(name);
      if (!doc) continue;
      const urls = [
        ...[...doc.querySelectorAll("script[src]")].map((el) => el.getAttribute("src")),
        ...[...doc.querySelectorAll("link[rel='stylesheet'][href]")].map((el) =>
          el.getAttribute("href"),
        ),
        ...[...doc.querySelectorAll("img[src]")].map((el) => el.getAttribute("src")),
      ];
      for (const url of urls) {
        expect(url, `${name} loads ${url} from another origin`).not.toMatch(
          /^(https?:)?\/\//,
        );
      }
    }
  });

  it("no shipped script opens a network connection to another origin", () => {
    const assets = resolve(DIST, "assets");
    if (!existsSync(assets)) return;
    for (const file of readdirSync(assets).filter((f) => f.endsWith(".js"))) {
      const src = readFileSync(join(assets, file), "utf8");
      expect(src, `${file} fetches an absolute URL`).not.toMatch(
        /fetch\(\s*["'`]https?:/,
      );
      expect(src, `${file} opens a WebSocket`).not.toMatch(/new WebSocket\(/);
    }
  });
});

describe("spec: home page (/) contracts", () => {
  // Flip order: plan Task 7 (shell), Task 8 (race wiring).
  it(`h1 is exactly "${CONTRACTS.title}"`, () => {
    const doc = pageDoc("index.html");
    expect(doc?.querySelector("h1")?.textContent?.trim()).toBe(CONTRACTS.title);
  });

  it("core-interaction sentence appears verbatim in the hero", () => {
    const doc = pageDoc("index.html");
    expect(doc?.body.textContent).toContain(CONTRACTS.coreInteraction);
  });

  it(
    `theme toggle button [data-testid=${CONTRACTS.testids.themeToggle}] in the header nav`,
    () => {
      const doc = pageDoc("index.html");
      const toggle = doc?.querySelector(
        `header nav [data-testid="${CONTRACTS.testids.themeToggle}"]`,
      );
      expect(toggle).toBeTruthy();
      expect(toggle?.tagName).toBe("BUTTON");
    },
  );

  it(
    `race canvas [data-testid=${CONTRACTS.testids.raceCanvas}] has role=img and a non-empty aria-label`,
    () => {
      const doc = pageDoc("index.html");
      const canvas = doc?.querySelector(`[data-testid="${CONTRACTS.testids.raceCanvas}"]`);
      expect(canvas?.getAttribute("role")).toBe("img");
      expect(canvas?.getAttribute("aria-label")?.trim()).toBeTruthy();
    },
  );

  it(
    `scoreboard [data-testid=${CONTRACTS.testids.scoreboard}] direct-labels both racers ("Dijkstra", "Contraction Hierarchies")`,
    () => {
      const doc = pageDoc("index.html");
      const board = doc?.querySelector(`[data-testid="${CONTRACTS.testids.scoreboard}"]`);
      expect(
        board?.querySelector('[data-algo="dijkstra"] .name')?.textContent?.trim(),
      ).toBe("Dijkstra");
      expect(board?.querySelector('[data-algo="ch"] .name')?.textContent?.trim()).toBe(
        "Contraction Hierarchies",
      );
    },
  );

  it.todo(
    `run control [data-testid=${CONTRACTS.testids.raceRun}] is a real <button> [plan T8]`,
  );
  it.todo(
    `default preset [data-testid=${CONTRACTS.testids.presetHill}] "To the Hill" (Gungahlin → Capital Hill) exists [plan T8]`,
  );
  it.todo(
    `aria-live region [data-testid=${CONTRACTS.testids.raceLive}] announces race results as text [plan T8]`,
  );

  it("OpenStreetMap ODbL attribution in the footer", () => {
    const doc = pageDoc("index.html");
    const footer = doc?.querySelector("footer")?.textContent ?? "";
    expect(footer).toContain(CONTRACTS.attribution);
    expect(footer).toContain("ODbL");
  });
});

describe("spec: how page (/how/) contracts", () => {
  // Flip order: plan Task 9 (shell + ch1-2), Task 10 (ch3-4), Task 11 (ch5).
  it.todo("how/index.html exists and passes the shared invariants [plan T9]");
  it.todo(
    "all five chapter headings appear, in spec order, exact copy from CONTRACTS.chapterHeadings [plan T9: 1-2; T10: 3-4; T11: 5]",
  );
  it.todo(
    "toy roots exist: toy-flood, toy-contraction [plan T9]; toy-order, toy-hierarchy [plan T10]; toy-climb [plan T11]",
  );
  it.todo("theme toggle present on /how/ too [plan T9]");
  it.todo(
    "footer carries OSM ODbL attribution and the Geisberger et al. 2008 reference [plan T9]",
  );
});

describe("spec: honest numbers", () => {
  // "Every user-visible number must be measured in-browser or precomputed
  // from the real graph." Mechanically checkable slice: the pages must not
  // hardcode settled-node counts; the scoreboard renders from live race
  // results only. Static HTML must ship the scoreboard EMPTY (counts appear
  // only after a race runs).
  it.todo(
    "built index.html contains no pre-filled settled-node counts in the scoreboard [plan T8]",
  );
});
