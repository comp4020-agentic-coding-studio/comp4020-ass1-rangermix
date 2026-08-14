// A tiny debounce-with-cancellable-immediate-override, extracted out of
// home.ts so the cancellation logic is a pure, unit-testable unit rather
// than closures buried in DOM event handlers.
//
// The bug this exists to fix: home.ts has two ways a race can start — a
// DEBOUNCED one (pin drag/tap, so a flurry of moves doesn't spam races) and
// several DIRECT ones (Race button, preset click, "R", the one-time
// auto-run). If a direct trigger fires while a debounced call is still
// pending, the stale debounced call must never be allowed to fire later and
// silently overwrite the direct trigger's result — pins would visually
// "snap back" to the stale pair. `now()` is the single entry point every
// direct trigger goes through specifically because it cancels any pending
// `schedule()` first, and it shares the SAME timer handle `schedule()`
// itself clears/sets, so there is exactly one place a stale timer could
// hide.

export interface RaceScheduler {
  /** Debounced: cancels any previously scheduled (not yet fired) call and
   * schedules a new one `delayMs` from now. */
  schedule(a: number, b: number): void;
  /** Cancels any pending scheduled call and runs immediately. Every DIRECT
   * trigger must call this (not `run` directly) so a stale debounced call
   * from an earlier drag/tap can never fire after it. */
  now(a: number, b: number): void;
}

export function makeRaceScheduler(run: (a: number, b: number) => void, delayMs: number): RaceScheduler {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const now = (a: number, b: number): void => {
    clearTimeout(timer);
    timer = undefined;
    run(a, b);
  };

  const schedule = (a: number, b: number): void => {
    clearTimeout(timer);
    timer = setTimeout(() => now(a, b), delayMs);
  };

  return { schedule, now };
}
