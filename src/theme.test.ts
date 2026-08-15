// @vitest-environment jsdom

// Stub matchMedia for jsdom
window.matchMedia ??= ((q: string) => ({
  matches: false,
  media: q,
  addEventListener() {},
  removeEventListener() {},
})) as never;

import { beforeEach, describe, expect, it } from "vitest";
import { cycleTheme, effectiveTheme, initTheme } from "./theme";

describe("theme", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    // Matches the real header markup (index.html/how/index.html, build-
    // review §16.2): a label span (full "Theme: <state>" text, hidden at
    // ≤520px) and an icon span (compact form, shown only at ≤520px) —
    // jsdom doesn't apply styles.css's media query, so both are always
    // "visible" here, which is fine: these tests check what theme.ts WRITES
    // into each, not which one CSS shows.
    document.body.innerHTML =
      '<button data-testid="theme-toggle" type="button">' +
      '<span class="theme-toggle-icon" aria-hidden="true"></span>' +
      '<span class="theme-toggle-label"></span>' +
      "</button>";
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

  it("writes the full sentence into aria-label and the label span, and a compact icon+letter into the icon span, regardless of viewport (build-review §16.2)", () => {
    initTheme();
    const btn = document.querySelector<HTMLButtonElement>(
      '[data-testid="theme-toggle"]',
    );
    btn?.click(); // -> dark
    expect(btn?.getAttribute("aria-label")).toBe("Switch theme (current: dark)");
    expect(btn?.querySelector(".theme-toggle-label")?.textContent).toBe("Theme: dark");
    expect(btn?.querySelector(".theme-toggle-icon")?.textContent).toBe("◐D");
  });

  it("cycles and applies themes in-memory when localStorage throws", () => {
    // Stub localStorage to throw on all operations
    const throwError = () => {
      throw new Error("storage unavailable");
    };
    globalThis.localStorage.getItem = throwError as never;
    globalThis.localStorage.setItem = throwError as never;
    globalThis.localStorage.removeItem = throwError as never;

    // initTheme should not throw and should apply system (default) without crashing
    initTheme();
    expect(document.documentElement.getAttribute("data-theme")).toBeNull();

    // cycling should still work in-memory despite storage errors
    expect(cycleTheme()).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    expect(cycleTheme()).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    expect(cycleTheme()).toBe("system");
    expect(document.documentElement.getAttribute("data-theme")).toBeNull();
  });
});
