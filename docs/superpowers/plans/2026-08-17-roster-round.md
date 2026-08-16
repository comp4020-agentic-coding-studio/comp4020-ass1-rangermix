# Roster Round Implementation Plan (spec §18)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Same-checkout parallel wave with STRICT file partitions (user preference): each implementer owns exactly its listed files, `git add`s only those, runs targeted tests in-wave; the controller runs the single full roster after the wave. Per-agent preview ports 5302+.

**Goal:** Land the user's fourth build review (spec §18): the multi-heuristic
A\* roster with live suboptimality disclosure, bidirectional as a
family-wide modifier (balanced bidirectional A\*), bezel-based algo
selection, and the layout/control refinements (routes width, rainbow
Surprise, small view+size buttons above the panel, icon theme button,
splash copy order).

**Contract-first (controller, before the wave):** `src/race/roster.ts` —
pure data module defining the roster: ids (`dijkstra`, `astar-straight`,
`astar-weighted`, `astar-greedy`, `ch`), display names ("A\* — straight
line" etc.), family membership (`searchers` vs `ch`), core vs optional,
CSS hue token names, worker algo keys incl. bidirectional forms
(`bidi:<id>`). Both wave tasks consume it; neither edits it.

### I1 — Algorithm core + compute plumbing (wave, partition A)
Files ONLY: src/algos/astarVariants.ts (new), src/algos/bidiAstar.ts
(new), src/algos/variants.test.ts, src/race/worker.ts,
src/race/controller.ts, src/race/controller.test.ts, src/race/roster.ts
(READ-ONLY).
- astarVariants: straight (existing astar via vMax h), weighted (h×1.5),
  greedy (priority = h only); all return SearchResult with true settled
  logs; suboptimality is NOT hidden (dist is whatever the variant found).
- bidiAstar: balanced (Ikeda average-function) bidirectional A\* —
  p(v) = (h(v,t) − h(v,s))/2 forward, symmetric backward; termination
  topF + topB ≥ best + correction; exact for the admissible h (sweep
  equivalence tests vs dijkstra on seeded graphs + real-graph gated
  block); weighted/greedy bidi forms apply their scaling inside the
  balanced framework (no exactness claim; tests assert they return SOME
  valid route whose recomputed edge-sum matches their reported dist).
- worker: algo key registry from roster.ts (plain + `bidi:` forms);
  scratch-buffer discipline maintained; per-race results now include
  each racer's own dist so the UI can compute "+X% longer".
- controller: multi-racer result handling (up to 5 + modifier), passes
  per-row route-delta info to the UI callback; replay draws each racer's
  own cloud; THE shared drawn route on the overlay is the OPTIMAL one
  (from dijkstra/ch); a suboptimal variant's own path goes only to its
  compare panel with disclosure state. aria sentence names active racers
  + flags disclosed variants briefly.
- Targeted tests in-wave: variants + controller suites.

### I2 — Panel & chrome UI (wave, partition B)
Files ONLY: index.html, styles.css, src/pages/home.ts, src/theme.ts,
src/theme.test.ts, src/pages/home.test.ts, spec/highway-to-hill.test.ts,
src/race/roster.ts (READ-ONLY).
- Panel rebuilt from roster.ts: family bezel ("searchers") containing
  Dijkstra + 3 A\* rows + the family-level bidirectional toggle; CH row
  outside; bezel rows = whole-row click targets (aria-pressed), core rows
  fixed (no toggle affordance); every row one-line at 1920 (H1's grid
  discipline; A\* names are longer — verify); disclosure line "+X% longer
  route" renders from controller data (honest-empty until measured);
  ⇄ marker on modified rows.
- Top-of-panel small button row: view toggle (shrunk) + NEW size-toggle
  ("current"/"adaptive" — adaptive relaxes the layout max-width so the
  map extends; persisted via guarded storage; both buttons small, same
  line, testids kept/added).
- Routes section width = map width; Surprise me chip rainbow-bordered
  (static gradient, tokens-plus-gradient OK for this control; distinct
  from roster hues).
- Theme button → icon-only at all widths (◐/☾/☀ by state) + aria-label
  full; theme.ts label logic + tests updated coherently.
- Splash copy: project sentence first, then the race invitation (core
  sentence verbatim; simple words).
- Spec tests: size-toggle exists; A\* note contract text updated to the
  straight-line row's phrasing if it moved; scoreboard direct-label test
  extended to the new names; palette tokens for the two new hues land in
  styles.css (both themes, from spec §18's validated values).
- Targeted tests in-wave: home/theme/spec DOM suites (build first).

### I3 — Gate + merge
Controller roster run post-wave; reviews (both tasks) in parallel; fix
rounds as needed; full sweep (both pages, both viewports/themes: bezel
interactions, family modifier, disclosure rendering with a genuinely
suboptimal greedy route — find a pin pair that shows one; adaptive size
on an ultrawide-ish viewport; splash copy; rainbow chip; icon theme
button), final whole-branch review, ff-merge to main.
