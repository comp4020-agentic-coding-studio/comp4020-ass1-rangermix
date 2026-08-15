export type ThemeSetting = "system" | "light" | "dark";
const KEY = "hth-theme";
const ORDER: ThemeSetting[] = ["system", "dark", "light"];
// Slim-viewport theme toggle (build-review §16.2): "◐" stands for "theme"
// generically, the state's own first letter (S/D/L) tags which one is
// active — shown in place of the full "Theme: <state>" label at ≤520px
// (styles.css's own .theme-toggle-icon/.theme-toggle-label rule) so the
// header's three items never wrap onto a second line at 390px. Purely
// decorative: aria-label (below) carries the full sentence at every
// viewport, so nothing accessible is lost.
const COMPACT_ICON = "◐";
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
  const compact = `${COMPACT_ICON}${setting.charAt(0).toUpperCase()}`;
  for (const btn of document.querySelectorAll<HTMLButtonElement>(
    '[data-testid="theme-toggle"]',
  )) {
    // aria-label always carries the FULL sentence regardless of viewport —
    // only the VISIBLE text compacts (CSS media query) — so a screen
    // reader never loses information a sighted narrow-viewport visitor
    // also can't see (they get the same full sentence, just via aria-label
    // instead of the on-screen text).
    btn.setAttribute("aria-label", `Switch theme (current: ${setting})`);
    const label = btn.querySelector<HTMLElement>(".theme-toggle-label");
    const icon = btn.querySelector<HTMLElement>(".theme-toggle-icon");
    if (label) label.textContent = full;
    if (icon) icon.textContent = compact;
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
    dijkstra: read("--c-dijkstra"),
    ch: read("--c-ch"),
    astar: read("--c-astar"),
    bidi: read("--c-bidi"),
    dijkstraGlow: read("--g-dijkstra"),
    chGlow: read("--g-ch"),
    astarGlow: read("--g-astar"),
    bidiGlow: read("--g-bidi"),
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
