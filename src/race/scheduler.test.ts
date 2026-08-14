import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeRaceScheduler } from "./scheduler";

describe("makeRaceScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedule() runs after the configured delay, with the scheduled pair", () => {
    const calls: [number, number][] = [];
    const scheduler = makeRaceScheduler((a, b) => calls.push([a, b]), 250);

    scheduler.schedule(1, 2);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(249);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual([[1, 2]]);
  });

  it("re-scheduling before the delay elapses coalesces to only the latest pair", () => {
    const calls: [number, number][] = [];
    const scheduler = makeRaceScheduler((a, b) => calls.push([a, b]), 250);

    scheduler.schedule(1, 2);
    vi.advanceTimersByTime(200);
    scheduler.schedule(3, 4); // re-debounce before the first ever fires
    vi.advanceTimersByTime(200); // 400ms since the first call, but only 200ms since the second
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(50); // now 250ms since the second schedule()
    expect(calls).toEqual([[3, 4]]); // the stale (1, 2) never fires at all
  });

  it("now() runs immediately, synchronously, with no delay", () => {
    const calls: [number, number][] = [];
    const scheduler = makeRaceScheduler((a, b) => calls.push([a, b]), 250);

    scheduler.now(5, 6);
    expect(calls).toEqual([[5, 6]]);
  });

  it("now() cancels a pending schedule() so the stale call never fires later — the defect this module fixes", () => {
    const calls: [number, number][] = [];
    const scheduler = makeRaceScheduler((a, b) => calls.push([a, b]), 250);

    scheduler.schedule(1, 2); // e.g. a drag/tap debounce in flight
    vi.advanceTimersByTime(100);
    scheduler.now(9, 9); // e.g. a preset click landing within the debounce window
    expect(calls).toEqual([[9, 9]]);

    vi.advanceTimersByTime(10_000); // well past when the stale timer would have fired
    expect(calls).toEqual([[9, 9]]); // still just the one call — (1, 2) never ran
  });

  it("schedule() after now() still works — the scheduler isn't left in a broken state", () => {
    const calls: [number, number][] = [];
    const scheduler = makeRaceScheduler((a, b) => calls.push([a, b]), 250);

    scheduler.now(1, 1);
    scheduler.schedule(2, 2);
    vi.advanceTimersByTime(250);
    expect(calls).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });

  it("now() called with nothing pending is a plain immediate call (no crash, no double-fire)", () => {
    const calls: [number, number][] = [];
    const scheduler = makeRaceScheduler((a, b) => calls.push([a, b]), 250);

    scheduler.now(1, 1);
    vi.advanceTimersByTime(10_000);
    expect(calls).toEqual([[1, 1]]);
  });

  it("repeated schedule() calls at steady intervals shorter than the delay never fire until the flurry stops", () => {
    const calls: [number, number][] = [];
    const scheduler = makeRaceScheduler((a, b) => calls.push([a, b]), 250);

    for (let i = 0; i < 5; i++) {
      scheduler.schedule(i, i);
      vi.advanceTimersByTime(100); // re-debounce every 100ms, under the 250ms delay
    }
    expect(calls).toEqual([]); // nothing has fired yet
    vi.advanceTimersByTime(250);
    expect(calls).toEqual([[4, 4]]); // only the last-scheduled pair ever runs
  });
});
