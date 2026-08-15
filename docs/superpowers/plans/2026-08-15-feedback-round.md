# Feedback Round Implementation Plan (spec §14)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax. Unlike the v2 plan, tasks here are compact: the codebase now carries the conventions (tokens-only CSS, testid contracts in `spec/highway-to-hill.test.ts` CONTRACTS, agent-browser verification against `pnpm preview --port 5301`, commit-green discipline, trailer line). Each dispatch supplies the exact deltas.

**Goal:** Land the user's 2026-08-15 build review (design spec §14) — home
interaction upgrades (drag-only pins, zoom, compare mode, regrouped
controls, named presets, footer, CTA) and the /how/ restructure (real ANU
streets, intuition-first chapter order, auto-starting lighter chapters).

**Global constraints:** everything from the v2 plan still binds (palettes,
honest numbers, invariants, budget ≤ 4 MB gz, both viewports × themes,
commit only green). Contract deltas land WITH their features, never ahead:
`CONTRACTS.chapterHeadings` → §14.10 list; preset-hill text →
"Gungahlin → Capital Hill"; new testids `view-toggle`, `how-cta`,
`zoom-in`, `zoom-out`.

### Task F1: Home controls, presets, CTA, footer (§14.4–7)
- Files: index.html, src/pages/home.ts, src/presets.ts, styles.css,
  spec/highway-to-hill.test.ts
- Racers/Routes as labelled `<fieldset>`-style groups; primary
  "▶ Race again" button distinct from chips; presets renamed place → place
  ("Gungahlin → Capital Hill" default, "ANU → Airport",
  "Belconnen → Tuggeranong", + new "Dickson → Woden"
  [149.1400,-35.2520 → 149.0850,-35.3450], "Kingston → Belconnen"
  [149.1470,-35.3160 → 149.0660,-35.2400], "Surprise me"); snap-distance
  test extends to the new coords; `how-cta` button-styled link under the
  scoreboard, `.is-hot` emphasis class added when a race completes; footer
  restyled into the design system (panel, mono meta voice).
- Acceptance: updated spec tests green; 4-combo screenshots.

### Task F2: Drag-only pins + pan/zoom (§14.1–2)
- Files: src/viz/mapRenderer.ts (+test), src/pages/home.ts, styles.css,
  index.html (zoom buttons)
- MapView gains a view transform: `zoomAt(cx, cy, factor)`, `panBy(dx, dy)`,
  `resetView()`, clamp scale 1–8, all project/unproject through it; pure
  math exported + unit-tested (zoom-about-point invariant: the anchor's
  screen position is unchanged). Wheel + pinch + drag-pan on empty map;
  pointerdown within 24 px of a pin drags the pin instead; tap-to-place
  and the hint chip REMOVED (spec test for the hint removed with it);
  `zoom-in`/`zoom-out` buttons (keyboard-usable). Mid-race zoom/pan just
  re-renders the current frame (state-as-data).
- Acceptance: unit tests; live checks incl. zoomed mid-race redraw.

### Task F3: Compare mode (§14.3)
- Files: src/viz/mapRenderer.ts, src/race/controller.ts,
  src/pages/home.ts, index.html, styles.css, spec test (view-toggle)
- `view-toggle` (Overlay ⇄ Compare, aria-pressed). Compare: one panel per
  active racer (grid: desktop `repeat(auto-fit, minmax(340px, 1fr))`,
  phone 2-up), each panel = base+overlay canvas pair + racer label chip;
  ONE shared view transform object observed by all panels (pan/zoom any
  panel moves all); controller renders each racer's cloud to its own
  panel in compare (overlay unchanged in overlay mode); pins drawn on
  every panel, draggable from any.
- Acceptance: 2- and 4-racer compare live-verified both viewports/themes;
  toggling mid-race safe; overlay mode pixel-identical to before.

### Task F4: ANU toy graph artifact (§14.8 data half)
- Files: scripts/data/build.ts (emit toytown), public/data/toytown.json,
  src/data.ts (loadToytown), spec/data.test.ts additions,
  src/toys/minitown.ts REPLACED by src/toys/toytown.ts (same export
  shape: graph + xy layout projected from real geometry + display names)
- Cut from the cached extract: bbox ≈ [149.106, -35.290] → [149.135,
  -35.262] (ANU/Acton/Civic/Braddon), drivable, largest SCC,
  chain-contracted; tune bbox toward 40–80 nodes; commit artifact
  (budget test still ≤ 4 MB total). Tests: node range, connectivity,
  CH==Dijkstra all-pairs on the toy artifact, budget.
- Acceptance: `pnpm data:build` regenerates from cache only (no network).

### Task F5: /how/ restructure (§14.8 toys half, 9, 10)
- Files: how/index.html, src/pages/how.ts, src/toys/*.ts,
  spec/highway-to-hill.test.ts (chapterHeadings), styles.css
- New order/headings: Dijkstra → "The hierarchy, revealed" → "The query:
  only ever climb" → "Shortcuts: the price of forgetting" (tiny static
  A–B–C removal diagram + contraction toy) → "Order is everything".
  Prose ≤ 3 sentences/chapter. All toys on the ANU graph. Auto-start on
  scroll (IntersectionObserver, once, reduced-motion → final state):
  flood + climb; both let the visitor click two nodes to re-pick
  endpoints. Hierarchy auto-loops level stops (~2.5 s), pauses on user
  selection, resume control. Order "your turn" compares your k
  contractions vs the heuristic's first k.
- Acceptance: updated contract tests green; 4-combo screenshots; toys
  keyboard-operable.

### Task F6: Gate + merge
- Full sweep (keyboard / reduced-motion / mid-race torture / 4-combo
  shots, both pages), fix wave if needed, ledger triage, PROCESS.md
  feedback-round moment, ff-merge to main.
