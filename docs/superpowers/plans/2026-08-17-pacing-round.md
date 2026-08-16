# Pacing Round Implementation Plan (spec §19)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Same-checkout THREE-WAY parallel wave, strict file partitions (user's standing preference): own-files-only `git add`, targeted tests in-wave, controller runs the single roster after; per-agent preview ports 5302/5303/5304.

**Goal:** Land spec §19: overscan+periodic pan cache (no empty edges while
panning), per-algorithm honest replay pacing (measured ms × 2000),
adaptive-size vertical extension, and responsive size-button visibility.

### J1 — Pan cache overscan + periodic refresh (§19.3)
Files ONLY: src/viz/mapRenderer.ts, src/viz/mapRenderer.test.ts.
Overscan the crisp base capture (~1.6× viewport per axis, clamped to
content extent) so ordinary pans blit real pixels; during sustained
interaction refresh the crisp stroke on a ≥0.5 s cadence (reuse the
stagger discipline so 5 compare panels don't re-stroke same-tick); pure
math (overscan rect, refresh-due predicate) unit-tested; cache-key
fingerprint extended for the overscan bounds.

### J2 — Per-algorithm replay pacing (§19.4)
Files ONLY: src/race/controller.ts, src/race/controller.test.ts.
`replayDurationMs(ms) = ms × 2000` per racer (pure, tested; no cap; tiny
floor only if 0 ms measured → minimum 200 ms, documented); per-layer
progress uses its own duration; row finalization (counts lock, delta
shows) at its own completion; race-end effects (announce, is-hot hook,
hth-last-race) at LAST completion; cancellation instant; reduced-motion
instant-final unchanged. Aria adds each racer's replay seconds? NO —
aria unchanged beyond existing content (avoid chatter).

### J3 — Adaptive vertical + size-button visibility (§19.1–.2)
Files ONLY: index.html, styles.css, src/pages/home.ts,
src/pages/home.test.ts, spec/highway-to-hill.test.ts (only if an
assertion needs the new class hooks).
Adaptive mode: map height grows to viewport minus header minus routes
strip (CSS custom property + dvh math or a resize-computed inline var —
pick the robust one; compare grid rows adapt too); Routes stays visible
(no fold loss, verify 1080p + 1440p-tall); size button hidden (CSS) when
the viewport is too narrow for adaptive to add width (media query at the
binding width; static markup keeps the element — spec test unaffected).

### J4 — Gate + merge
Controller roster post-wave; three reviews in parallel; integrated live
sweep (pan continuously without stopping across the whole map both
themes; all-5 race with visibly different replay speeds — CH finishing
in ~a second while Dijkstra crawls; adaptive on tall+wide viewport with
Routes visible; size button hidden at 1024×768; regression basics),
final whole-branch review, ff-merge to main.
