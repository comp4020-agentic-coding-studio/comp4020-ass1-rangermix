export type ThemeSetting = "system" | "light" | "dark";
const KEY = "hth-theme";
const ORDER: ThemeSetting[] = ["system", "dark", "light"];
// Fourth build review (spec §18.10): the theme button is icon-ONLY at every
// width now (styles.css's .theme-toggle-icon/.theme-toggle-label rule hides
// the label unconditionally, superseding build-review §16.2's ≤520px-only
// compaction) — one glyph per state, no letter suffix needed since the
// glyph itself already distinguishes system/dark/light. Purely decorative
// (aria-hidden in the markup): aria-label (below) carries the full "Theme:
// <state>" sentence a screen reader needs, since the glyph alone says
// nothing on its own.
const STATE_ICON: Record<ThemeSetting, string> = { system: "◐", dark: "☾", light: "☀" };
let listeners: (() => void)[] = [];

function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // Private-mode / storage disabled: fall back to session-only state
    return null;
  }
}

function safeSetItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — cycling still works in-memory */
  }
}

function safeRemoveItem(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* storage unavailable — cycling still works in-memory */
  }
}

function current(): ThemeSetting {
  const v = safeGetItem(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

function apply(setting: ThemeSetting): void {
  if (setting === "system")
    document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", setting);
  const full = `Theme: ${setting}`;
  for (const btn of document.querySelectorAll<HTMLButtonElement>(
    '[data-testid="theme-toggle"]',
  )) {
    // Icon-only at every width now (spec §18.10) — aria-label carries the
    // full "Theme: <state>" sentence regardless, since the on-screen glyph
    // alone says nothing to a screen reader. .theme-toggle-label is kept
    // in sync too (belt-and-braces for a CSS-disabled or print context)
    // even though styles.css never shows it any more.
    btn.setAttribute("aria-label", full);
    const label = btn.querySelector<HTMLElement>(".theme-toggle-label");
    const icon = btn.querySelector<HTMLElement>(".theme-toggle-icon");
    if (label) label.textContent = full;
    if (icon) icon.textContent = STATE_ICON[setting];
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
  if (next === "system") safeRemoveItem(KEY);
  else safeSetItem(KEY, next);
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
    ground: read("--ground"),
    panel: read("--panel"),
    ink: read("--ink"),
    muted: read("--muted"),
    road: read("--road"),
    roadMajor: read("--road-major"),
    route: read("--route"),
    // Roster round (spec §18): every racer key below is keyed by the
    // roster id verbatim (src/race/roster.ts's own RosterEntry.id strings),
    // because controller.ts's replay loop reads a racer's colour
    // dynamically as `colors[layer.algo]` / `colors[`${layer.algo}Glow`]`,
    // and `layer.algo` is always one of exactly these four strings. The
    // pre-roster-round shorthand keys this object used to ALSO carry
    // (`astar`, `bidi`, `astarGlow`, `bidiGlow` — a fixed single-A*-row/
    // single-bidi-modifier vocabulary that predates the five-racer roster
    // and was kept only for the duration of I1's concurrent controller.ts
    // rewrite, so either side of that landing would still read a valid
    // key) are gone: `layer.algo` is never literally "astar" or "bidi"
    // post-roster-round, so nothing has read them since — confirmed by
    // grepping the whole tree for `colors.astar`/`colors.bidi`/
    // `colors[\"astar\"]`/`colors[\"bidi\"]` and their Glow variants,
    // zero hits outside this function's own old definition (I3 gate).
    dijkstra: read("--c-dijkstra"),
    dijkstraGlow: read("--g-dijkstra"),
    ch: read("--c-ch"),
    chGlow: read("--g-ch"),
    "astar-straight": read("--c-astar"),
    "astar-straightGlow": read("--g-astar"),
    "astar-greedy": read("--c-astar-g"),
    "astar-greedyGlow": read("--g-astar-g"),
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
