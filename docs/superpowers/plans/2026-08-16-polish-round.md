# Polish Round Implementation Plan (spec §16)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Compact plan — the codebase carries the conventions (tokens-only CSS, CONTRACTS testids, agent-browser vs own `pnpm preview --port 5301`, commit-green, trailer). Dispatches carry exact deltas.

**Goal:** Land the user's second build review (spec §16): consolidated
scoreboard panel, geo-anchored map view with A–B auto-zoom and honest
render performance, a hierarchy-rich toy area, and the linked two-view
query demo.

**Order & rationale:** G1 (layout) → G2 (view semantics: geo-anchor, lag
bug, AB zoom, fit toggle) → G3 (perf + light density; builds on G2's
settled semantics) → G4 (toytown re-cut) → G5 (linked query demo, needs
G4) → G6 gate + merge. Reviews run in parallel with the next implementer
(read-only, hash-pinned, no roster).

### G1 — Consolidated panel + header/footer polish (§16.1–5)
Files: index.html, src/pages/home.ts, styles.css, spec/highway-to-hill.test.ts (only if a moved element's test needs its selector loosened — existence contracts keep their testids).
Scoreboard hosts every algorithm as a row (core rows fixed styling, optional rows integrated toggles, honest empty values until raced); stacked below: view-toggle, race-run, how-cta (that order); "Algorithms" eyebrow; compact icon theme button ≤520px (aria-label full); footer inner constrained to content measure, tightened padding. Live checks at 390 (no header wrap) + 1920.

### G2 — Geo-anchored view, overlay sync, A–B zoom, fit toggle (§16.6,7,9,11)
Files: src/viz/mapRenderer.ts (+test), src/pages/home.ts, index.html, styles.css, spec test (zoom-fit).
ViewStore state becomes {centerLon, centerLat, spanFactor} (geo-anchored); each MapView derives its pixel transform from geo state + its own fit — mode/panel switches inherently preserve focus. Both canvases apply the SAME derived transform in the SAME notification (fix the one-step overlay lag — audit the redraw path ordering). zoomToBounds(a, b, pad≈15%) on every race start; `zoom-fit` button above the pair toggling AB-bounds ⇄ whole-map. Pure math unit-tested (geo↔px roundtrip, bounds-zoom padding, clamp in geo terms preserving the ≥25%-visible rule).

### G3 — Interaction performance + light-mode density (§16.8,10)
Files: src/viz/mapRenderer.ts (+test), src/race/controller.ts, styles.css if needed.
Base layer: cache the stroked network as an offscreen bitmap per panel; during pan/zoom blit with drawImage under the delta transform (cheap), re-stroke crisply on interaction-end (debounced ~150ms); overlay dots batched (single path per color bucket or sprite stamp). Light mode: 'multiply' composite for settled dots so overlap deepens (mirror of dark's 'lighter'); validate visually both themes. Measure honestly with a rAF frame-time probe during scripted pan (report p50/p95 for overlay + 4-panel compare, before/after).

### G4 — Hierarchy-rich toytown re-cut (§16.12)
Files: scripts/data/build.ts (bbox + any tuning only), public/data/toytown.json, spec/data.test.ts thresholds if counts shift.
New cut centred on a clear arterial+locals area (start: Northbourne corridor around Braddon/O'Connor; tune toward 40–80 nodes with a visible spine — the cut should contain ≥1 trunk/primary way and a local grid; add a sensor: toytown contains ≥1 edge with cls ≥ 2 and ≥60% cls 0 edges, pinning "hierarchy-rich"). Shortcut-pair sensor stays green; rebuild offline from cache only.

### G5 — Linked two-view query demo (§16.13)
Files: src/toys/climb.ts (major rework, maybe split climbLinked.ts), src/toys/toytownView.ts, src/pages/how.ts, how/index.html, styles.css, tests.
Chapter 3 shows BOTH: rank-lifted hierarchy graph (top) + mini street map (bottom, real geometry); visitor picks A/B on the MAP (buttons per node as today); one chQuery run drives BOTH views' animation in lockstep (shared step scheduler; map shows touched streets/search reach, hierarchy shows the climbs + meet + unpack). Auto-start on scroll with the sensor-guaranteed default pair; reduced-motion final states; keyboard operable; toy-climb testid survives.

### G6 — Gate + merge
Sweep both pages (keyboard/reduced-motion/mid-race torture/4-combo incl. perf spot-check), fix wave, ledger triage, final whole-branch review, PROCESS note if a moment emerged, ff-merge to main.
