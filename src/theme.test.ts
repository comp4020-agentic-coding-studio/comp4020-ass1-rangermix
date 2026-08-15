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
