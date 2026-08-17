import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { ROSTER } from "../src/race/roster";

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
  // §14.10 (build-review amendment, 2026-08-15): intuition (hierarchy) before
  // use (the climb query) before construction (shortcuts, then ordering) —
  // replacing the v2 order (Dijkstra, contraction, order, hierarchy, climb).
  chapterHeadings: [
    "What Dijkstra actually does",
    "The hierarchy, revealed",
    "The query: only ever climb",
    "Shortcuts: the price of forgetting",
    "Order is everything",
  ],
  testids: {
    themeToggle: "theme-toggle",
    raceCanvas: "race-canvas",
    scoreboard: "scoreboard",
    raceRun: "race-run",
    raceLive: "race-live",
    presetHill: "preset-hill",
    howCta: "how-cta",
    astarNote: "astar-note",
    sizeToggle: "size-toggle",
    splashOpen: "splash-open",
    splashSuppress: "splash-suppress",
    toys: ["toy-flood", "toy-hierarchy", "toy-climb", "toy-contraction", "toy-order"],
  },
  attribution: "OpenStreetMap contributors",
  // Fourth build review (spec §18.4/.5): the A* straight-line row's note —
  // this is now src/race/roster.ts's own `note` field for the
  // "astar-straight" entry, copied verbatim (a dedicated consistency test
  // below asserts the two never drift apart). Superseded from the third
  // build review's §17.4 wording, which lived on a single "A*" row that
  // the roster round splits into three heuristic-specific rows.
  astarHeuristic: "guided by straight-line travel time (great-circle distance ÷ fastest road)",
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

  // I3 gate named fix: the STATIC markup (before theme.ts's initTheme() ever
  // runs) used to ship the pre-§18.10 aria-label ("Switch theme (current:
  // system)") and compact icon text ("◐S") — stale relative to what
  // theme.ts itself now writes (see theme.test.ts's own "Theme: <state>"/
  // icon-only assertions), which only self-heals the instant the deferred
  // module script runs. Checked here directly against the BUILT html (not
  // theme.ts's runtime output) so the pre-hydration frame — what a visitor
  // or a screen reader actually sees first — is asserted, not assumed.
  it(
    "static (pre-hydration) theme toggle markup already carries the §18.10 aria-label and icon-only glyph, on both pages",
    () => {
      for (const page of ["index.html", "how/index.html"]) {
        const doc = pageDoc(page);
        const toggle = doc?.querySelector(`[data-testid="${CONTRACTS.testids.themeToggle}"]`);
        expect(toggle?.getAttribute("aria-label"), page).toBe("Theme: system");
        expect(toggle?.querySelector(".theme-toggle-icon")?.textContent, page).toBe("◐");
      }
    },
  );

  // §19.5 (fifth build review): the splash doubles as an About surface —
  // this ⓘ button re-opens it at any time (home.ts's open(), reusing the
  // existing dismiss() machinery). Usable in EITHER state (before or after
  // dismissal), so unlike most of the header nav's neighbours it needs no
  // `disabled` assertion here — it's deliberately never gated (see
  // GatedControls' own comment in home.ts for the "legitimate under the
  // splash" carve-out this shares with how-cta and the rest of the nav).
  it(
    `ⓘ splash-reopen button [data-testid=${CONTRACTS.testids.splashOpen}] exists in the header nav, a real button labelled "About Highway to Hill" (spec §19.5)`,
    () => {
      const doc = pageDoc("index.html");
      const btn = doc?.querySelector(`header nav [data-testid="${CONTRACTS.testids.splashOpen}"]`);
      expect(btn).toBeTruthy();
      expect(btn?.tagName).toBe("BUTTON");
      expect(btn?.getAttribute("aria-label")).toBe("About Highway to Hill");
    },
  );

  // §19.5: the splash's own "don't show this again" preference — a real
  // checkbox so its state (and native label association) needs no
  // bespoke ARIA; home.ts's loadSplashOff/saveSplashOff own the persistence
  // (untestable from static HTML, exercised in home.test.ts instead).
  it(
    `"don't show this again" checkbox [data-testid=${CONTRACTS.testids.splashSuppress}] exists inside the splash, a real checkbox input (spec §19.5)`,
    () => {
      const doc = pageDoc("index.html");
      const splash = doc?.querySelector('[data-testid="splash"]');
      const input = doc?.querySelector(`[data-testid="${CONTRACTS.testids.splashSuppress}"]`);
      expect(input).toBeTruthy();
      expect(input?.tagName).toBe("INPUT");
      expect(input?.getAttribute("type")).toBe("checkbox");
      expect(splash?.contains(input as Node)).toBe(true);
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

  // Roster round (spec §18.5/.6): the scoreboard now direct-labels every
  // roster racer (FIVE at the time this comment was first written; FOUR
  // since spec §20.2 removed weighted A* — the count itself is deliberately
  // not restated as a number below, since ROSTER.length already IS the
  // count these tests check against), not just Dijkstra/CH — sourced from
  // ROSTER itself (src/race/roster.ts, this round's contract-first single
  // source of truth) rather than a hand-copied list, so this test can't
  // silently drift from the roster the panel is meant to be built from. The
  // old per-racer "Bidirectional" row expectation is retired outright: bidi
  // is now the family-wide modifier, never a row of its own, so it has no
  // entry in ROSTER and nothing here checks for one.
  it(
    `scoreboard [data-testid=${CONTRACTS.testids.scoreboard}] direct-labels every roster racer with its exact contract name, in roster order`,
    () => {
      const doc = pageDoc("index.html");
      const board = doc?.querySelector(`[data-testid="${CONTRACTS.testids.scoreboard}"]`);
      const names = ROSTER.map(
        (r) => board?.querySelector(`[data-algo="${r.id}"] .name`)?.textContent?.trim(),
      );
      expect(names).toEqual(ROSTER.map((r) => r.name));
    },
  );

  // K4 gate guardrail (spec §20.2's own gate found the failure mode this
  // closes): the test above only ever walks ROSTER -> DOM (does every
  // roster id have a row?), so it can never notice a row that SHOULDN'T be
  // there. index.html's two `.row-optional` rows are hand-authored static
  // markup, not generated from ROSTER — home.ts's roster-driven code only
  // ever LOOKS UP a row per active roster id, it never enumerates or prunes
  // existing rows (confirmed by reading boot()'s rosterToggleEls). That is
  // exactly how the old astar-weighted row kept rendering, fully visible
  // and un-wired, for the entire time between ROSTER dropping the id and a
  // human noticing — this test's ROSTER -> DOM sibling would have stayed
  // green throughout that whole window. Walking the DOM -> ROSTER direction
  // too (every [data-algo] row's id is a real roster id, AND the counts
  // match) closes the gap: a future roster change that forgets to update
  // index.html's hand-authored rows now fails loudly here instead.
  it(
    `every [data-algo] row inside the scoreboard [data-testid=${CONTRACTS.testids.scoreboard}] corresponds to a real ROSTER id, with no stray leftover rows (reverse of the roster-order test above)`,
    () => {
      const doc = pageDoc("index.html");
      const board = doc?.querySelector(`[data-testid="${CONTRACTS.testids.scoreboard}"]`);
      const rowIds = [...(board?.querySelectorAll("[data-algo]") ?? [])].map((el) =>
        el.getAttribute("data-algo"),
      );
      const rosterIds = ROSTER.map((r) => r.id);
      expect(rowIds, "row count must equal roster count — no stray or missing rows").toHaveLength(
        rosterIds.length,
      );
      for (const id of rowIds)
        expect(rosterIds, `row data-algo="${id}" has no matching ROSTER entry`).toContain(id);
    },
  );

  it("every inexact racer's roster note renders verbatim under its own row (spec §18.5)", () => {
    const doc = pageDoc("index.html");
    const board = doc?.querySelector(`[data-testid="${CONTRACTS.testids.scoreboard}"]`);
    for (const r of ROSTER) {
      if (!r.note) continue;
      const note = board?.querySelector(`[data-algo="${r.id}"] .row-note`);
      expect(note, r.id).toBeTruthy();
      expect(note?.textContent?.trim(), r.id).toBe(r.note);
    }
  });

  it(
    `A* — straight line's heuristic note [data-testid=${CONTRACTS.testids.astarNote}] sits under its own row, copy verbatim from roster.ts`,
    () => {
      const doc = pageDoc("index.html");
      const board = doc?.querySelector(`[data-testid="${CONTRACTS.testids.scoreboard}"]`);
      const row = board?.querySelector('[data-algo="astar-straight"]');
      const note = row?.querySelector(`[data-testid="${CONTRACTS.testids.astarNote}"]`);
      expect(note, "note must live inside the astar-straight row").toBeTruthy();
      expect(note?.textContent?.trim()).toBe(CONTRACTS.astarHeuristic);
    },
  );

  it("CONTRACTS.astarHeuristic matches roster.ts's astar-straight note exactly (single source of truth stays in sync)", () => {
    const entry = ROSTER.find((r) => r.id === "astar-straight");
    expect(entry?.note).toBe(CONTRACTS.astarHeuristic);
  });

  it(
    `size toggle [data-testid=${CONTRACTS.testids.sizeToggle}] is a real button (spec §18.9 — current/adaptive map-size control)`,
    () => {
      const doc = pageDoc("index.html");
      const btn = doc?.querySelector(`[data-testid="${CONTRACTS.testids.sizeToggle}"]`);
      expect(btn).toBeTruthy();
      expect(btn?.tagName).toBe("BUTTON");
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
    "fit-toggle [data-testid=zoom-fit] is a real button, labelled, and sits ABOVE zoom-in/zoom-out in the zoom control stack (second build review §16.7 — toggles A-B-bounds zoom vs. whole-map fit)",
    () => {
      const doc = pageDoc("index.html");
      const fit = doc?.querySelector('[data-testid="zoom-fit"]');
      const zoomIn = doc?.querySelector('[data-testid="zoom-in"]');
      expect(fit).toBeTruthy();
      expect(fit?.tagName).toBe("BUTTON");
      expect(fit?.getAttribute("aria-label")?.trim()).toBeTruthy();
      expect(zoomIn).toBeTruthy();
      // "ABOVE" the pair, concretely: an earlier sibling within the same
      // zoom-controls stack (a column, first child = top), not just
      // "present somewhere on the page".
      const siblings = [...(fit?.parentElement?.children ?? [])];
      expect(siblings.indexOf(fit as Element)).toBeLessThan(siblings.indexOf(zoomIn as Element));
    },
  );

  it(
    "view toggle [data-testid=view-toggle] is a real button, aria-pressed present (build-review amendment §14.3 — Overlay/Compare, aria-pressed reflects Compare)",
    () => {
      const doc = pageDoc("index.html");
      const btn = doc?.querySelector('[data-testid="view-toggle"]');
      expect(btn).toBeTruthy();
      expect(btn?.tagName).toBe("BUTTON");
      // Static shipped markup always starts in Overlay (JS decides Compare
      // at runtime from localStorage) — pinned to the exact default value.
      expect(btn?.getAttribute("aria-pressed")).toBe("false");
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
    "explore button [data-testid=explore] is a real button that dismisses the splash (third build review §17.3)",
    () => {
      const doc = pageDoc("index.html");
      const btn = doc?.querySelector('[data-testid="explore"]');
      expect(btn).toBeTruthy();
      expect(btn?.tagName).toBe("BUTTON");
      expect(btn?.textContent?.trim()).toBe("Explore the race →");
    },
  );

  // I3 gate named fix: role=dialog/aria-modal — cheap correct semantics now
  // that applySplashInert (home.ts) already makes the controls that OPERATE
  // the hidden map/race (`inert`, not merely `disabled`) unreachable while
  // the splash is up. aria-labelledby points at the h1 itself rather than
  // duplicating its text into a separate aria-label, so the dialog's
  // accessible name can never drift from the page's own visible title.
  it(
    'splash [data-testid=splash] is role="dialog" aria-modal="true", labelled by its own h1',
    () => {
      const doc = pageDoc("index.html");
      const splash = doc?.querySelector('[data-testid="splash"]');
      const h1 = doc?.querySelector("h1");
      expect(splash?.getAttribute("role")).toBe("dialog");
      expect(splash?.getAttribute("aria-modal")).toBe("true");
      const labelledby = splash?.getAttribute("aria-labelledby");
      expect(labelledby).toBeTruthy();
      expect(h1?.id).toBe(labelledby);
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
    // Whole-board sweep EXCLUDING .name/.row-note — spec §18.5's contract
    // strings are static roster copy, not a measurement, so a future name
    // or note that happens to carry a digit (weighted A*'s old "1.5×", since
    // removed by §20.2, used to be exactly this case) still shouldn't trip
    // this check. Every OTHER element that could carry a measured number
    // (.val, .ms, the headline, the .row-delta disclosure) must still be
    // completely digit-free until a real race runs — race results only
    // ever reach the DOM via JS after that happens.
    const clone = board?.cloneNode(true) as Element | undefined;
    for (const el of clone?.querySelectorAll(".name, .row-note") ?? []) el.remove();
    expect(clone?.textContent).not.toMatch(/\d/);
  });
});
