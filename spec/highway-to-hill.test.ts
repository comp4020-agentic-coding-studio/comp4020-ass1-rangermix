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
    howCta: "how-cta",
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

  it(`run control [data-testid=${CONTRACTS.testids.raceRun}] is a real <button>`, () => {
    const doc = pageDoc("index.html");
    const btn = doc?.querySelector(`[data-testid="${CONTRACTS.testids.raceRun}"]`);
    expect(btn).toBeTruthy();
    expect(btn?.tagName).toBe("BUTTON");
  });

  it(
    "zoom-in [data-testid=zoom-in] and zoom-out [data-testid=zoom-out] map-zoom controls are real buttons (build-review amendment §14.2 — the keyboard/a11y zoom path)",
    () => {
      const doc = pageDoc("index.html");
      for (const testid of ["zoom-in", "zoom-out"]) {
        const btn = doc?.querySelector(`[data-testid="${testid}"]`);
        expect(btn, testid).toBeTruthy();
        expect(btn?.tagName, testid).toBe("BUTTON");
        expect(btn?.getAttribute("aria-label")?.trim(), testid).toBeTruthy();
      }
    },
  );

  it(
    `default preset [data-testid=${CONTRACTS.testids.presetHill}] "Gungahlin → Capital Hill" exists`,
    () => {
      const doc = pageDoc("index.html");
      const btn = doc?.querySelector(`[data-testid="${CONTRACTS.testids.presetHill}"]`);
      expect(btn).toBeTruthy();
      expect(btn?.tagName).toBe("BUTTON");
      expect(btn?.textContent?.trim()).toBe("Gungahlin → Capital Hill");
    },
  );

  it(
    `CTA [data-testid=${CONTRACTS.testids.howCta}] is a real anchor linking to ./how/ with non-empty text`,
    () => {
      const doc = pageDoc("index.html");
      const cta = doc?.querySelector(`[data-testid="${CONTRACTS.testids.howCta}"]`);
      expect(cta).toBeTruthy();
      expect(cta?.tagName).toBe("A");
      expect(cta?.getAttribute("href")).toBe("./how/");
      expect(cta?.textContent?.trim()).toBeTruthy();
    },
  );

  it(
    `aria-live region [data-testid=${CONTRACTS.testids.raceLive}] announces race results as text`,
    () => {
      // The region's content only becomes non-empty once a real race has
      // run in a browser, which isn't statically checkable from built HTML
      // — what IS checkable here is the contract that makes it work at all:
      // the region exists and is wired for a screen reader to hear updates.
      const doc = pageDoc("index.html");
      const region = doc?.querySelector(`[data-testid="${CONTRACTS.testids.raceLive}"]`);
      expect(region).toBeTruthy();
      expect(region?.getAttribute("aria-live")).toBe("polite");
    },
  );

  it("OpenStreetMap ODbL attribution in the footer", () => {
    const doc = pageDoc("index.html");
    const footer = doc?.querySelector("footer")?.textContent ?? "";
    expect(footer).toContain(CONTRACTS.attribution);
    expect(footer).toContain("ODbL");
  });
});

describe("spec: how page (/how/) contracts", () => {
  // Flipped in plan Task 9 (shell + ch1-2 toys). Headings and toy roots are
  // a single DOM contract that doesn't change in T10/T11 — chapters 3-5
  // ship their heading and toy-root NOW, carrying an honest placeholder
  // inside the root until T10/T11 replace it with the real toy.
  it("how/index.html exists in dist and parses", () => {
    const doc = pageDoc("how/index.html");
    expect(doc).toBeTruthy();
  });

  it("all five chapter headings appear, in spec order, exact copy from CONTRACTS.chapterHeadings", () => {
    const doc = pageDoc("how/index.html");
    const headings = [...(doc?.querySelectorAll("h2") ?? [])].map((h) =>
      h.textContent?.trim(),
    );
    expect(headings).toEqual(CONTRACTS.chapterHeadings);
  });

  it("toy roots exist: toy-flood, toy-contraction, toy-order, toy-hierarchy, toy-climb", () => {
    const doc = pageDoc("how/index.html");
    for (const id of CONTRACTS.testids.toys) {
      expect(doc?.querySelector(`[data-testid="${id}"]`), id).toBeTruthy();
    }
  });

  it("theme toggle present on /how/ too", () => {
    const doc = pageDoc("how/index.html");
    const toggle = doc?.querySelector(
      `header nav [data-testid="${CONTRACTS.testids.themeToggle}"]`,
    );
    expect(toggle).toBeTruthy();
    expect(toggle?.tagName).toBe("BUTTON");
  });

  it("footer carries OSM ODbL attribution and the Geisberger et al. 2008 reference", () => {
    const doc = pageDoc("how/index.html");
    const footer = doc?.querySelector("footer")?.textContent ?? "";
    expect(footer).toContain(CONTRACTS.attribution);
    expect(footer).toContain("ODbL");
    expect(footer).toContain("Geisberger");
  });
});

describe("spec: honest numbers", () => {
  // "Every user-visible number must be measured in-browser or precomputed
  // from the real graph." Mechanically checkable slice: the pages must not
  // hardcode settled-node counts; the scoreboard renders from live race
  // results only. Static HTML must ship the scoreboard EMPTY (counts appear
  // only after a race runs).
  it("built index.html contains no pre-filled settled-node counts in the scoreboard", () => {
    const doc = pageDoc("index.html");
    const board = doc?.querySelector(`[data-testid="${CONTRACTS.testids.scoreboard}"]`);
    expect(board).toBeTruthy();
    // Whole-board sweep (not just .val elements) so this also covers the
    // headline and catches any future addition that sneaks in a number —
    // race results only ever reach the DOM via JS after a real race runs.
    expect(board?.textContent).not.toMatch(/\d/);
  });
});
