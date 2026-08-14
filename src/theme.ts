export type ThemeSetting = "system" | "light" | "dark";
const KEY = "hth-theme";
const ORDER: ThemeSetting[] = ["system", "dark", "light"];
let listeners: (() => void)[] = [];

function current(): ThemeSetting {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

function apply(setting: ThemeSetting): void {
  if (setting === "system")
    document.documentElement.removeAttribute("data-theme");
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
