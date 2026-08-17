# Routes Round Implementation Plan (spec §20)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Same-checkout three-way wave, strict partitions, own-files-only `git add`, targeted tests in-wave, controller runs the roster post-wave. NOTE: the controller pre-edited src/race/roster.ts + roster.test.ts in the WORKING TREE (weighted A* removed, count 5→4) — K2 verifies and commits those files with its own work; K1/K3 never stage them.

**Goal:** Per-algorithm route colors revealed at each racer's own finish;
weighted A\* removed everywhere; 2×2 compare grid for four panels at
1080p adaptive; bidirectional greedy redefined honestly (first-meet) if
the flood diagnosis confirms; §17.6's vertical/zoom treatment moved from
the query view to "The hierarchy, revealed".

### K1 — Per-algo routes at own finish (§20.1)
Files ONLY: src/race/controller.ts, src/race/controller.test.ts,
src/viz/mapRenderer.ts, src/viz/mapRenderer.test.ts.
drawRoute gains a color (and keeps the dashed option); overlay draws each
FINISHED racer's own path in its chart hue (roster hueVar via
themeColors-equivalent lookup) at its own completion (reuse the
finalization hook); the shared ink route + first-exact reveal retire;
draw order = roster order each frame so overlapping exact routes render
deterministically; compare panels recolor per-panel routes to their hue
(dashed-when-suboptimal unchanged). Redraw paths (theme flip, zoom,
mode switch mid-race) show exactly the finished set. Tests: reveal set
math per timestamp; color/dash args; redraw reproduces finished-only.

### K2 — Weighted removal (algos side) + honest bidi-greedy (§20.2/.4)
Files ONLY: src/algos/astarVariants.ts, src/algos/bidiAstar.ts,
src/algos/heuristicKind.ts, src/algos/variants.test.ts,
src/race/worker.ts, src/race/worker.test.ts, src/race/roster.ts,
src/race/roster.test.ts (the last two: verify + commit the controller's
working-tree edits).
Remove the weighted kind end-to-end (functions, kind unions, registry,
tests). Diagnose bidi-greedy per §20.4's hypothesis (h-only keys void
the balanced termination bound → near-exhaustion); document the
diagnosis in the report with measured settle counts; implement
first-frontier-meet semantics: alternate two greedy searches, stop at
the FIRST settled-both-sides node, concatenate (recompute true route
cost from edges), disclosed-suboptimal; tests: settle count ≪
exhaustion on the real graph (artifact-gated), valid route cost,
deterministic, still disclosed when longer.

### K3 — Grid + view transfer + UI sweep (§20.3/.5 + §20.2 UI side)
Files ONLY: styles.css, index.html, how/index.html, src/pages/home.ts,
src/pages/home.test.ts, src/pages/how.ts, src/toys/hierarchy.ts,
src/toys/climbLinked.ts, spec/highway-to-hill.test.ts.
2×2 compare grid for 4 panels at desktop/adaptive (3 → 2+1; 2 →
side-by-side); sweep weighted-A\* UI remnants (hue tokens --c/g-astar-w,
any DOM/test references — roster-driven parts auto-adapt); revert the
query rank view to pre-§17.6 compact height and REMOVE its zoom
controls (climbLinked); give "The hierarchy, revealed" (hierarchy.ts's
MapView) the extra height + wheel/button zoom + drag-pan with its OWN
local view state (mapRenderer READ-ONLY — use its public APIs; if an
API gap blocks, report it, don't edit the file: K1 owns it this wave).

### K4 — Gate + merge
Roster post-wave; three reviews ∥ gate (fix-wave folding); live proofs:
4 colored routes appearing at staggered finishes (greedy's divergent
yellow route vs the exact overlap), 2×2 at 1080p adaptive, honest
first-meet bidi-greedy counts, hierarchy-revealed zoom, query view
compact again; final whole-branch review; ff-merge.
