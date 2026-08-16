# Refine Round Implementation Plan (spec §17)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Compact plan; conventions live in the codebase; dispatches carry exact deltas. Deadline-critical: due noon Monday — tasks sized to land tonight.

**Goal:** Land the user's third build review (spec §17): one-line scoreboard
rows + compact routes + A\* heuristic note, the splash screen replacing the
map overlay, the real-map context layer + zoomable roomier hierarchy view,
and the plain-English copy pass.

### H1 — Panel fit + routes + A\* note (§17.1, .2, .4)
Files: index.html, src/pages/home.ts, styles.css, spec test only if a
selector moves. One-line rows at 1920×1080 with FULL contract names
(grid: name flex/min-width-0 + count + ms + toggle fixed; tightened type);
routes chips compact (one line at 1920; 390 shows the top of the
Algorithms panel without scrolling past Routes); A\* heuristic muted line
under its row when enabled.

### H2 — Splash (§17.3)
Files: index.html, src/pages/home.ts, styles.css, spec/highway-to-hill.test.ts.
Splash overlay div in static markup carrying the h1 + core sentence + a
2-3 sentence plain-English site description + [data-testid="explore"]
button; dismiss → clean map (corner overlay markup deleted), auto-run
gated on dismissal, sessionStorage persistence ("hth-splash"), Escape also
dismisses, focus lands on the map region after dismissal; reduced-motion
unchanged. Static-markup contracts (h1, sentence) keep passing; new spec
test: explore button exists; invariants (one h1) hold.

### H3 — Context layer + hierarchy view room/zoom (§17.5, .6)
Files: scripts/data/build.ts (emit context polylines clipped to toytown
bbox into toytown.json), public/data/toytown.json, src/toys/toytown.ts
(decode context), src/toys/toytownView.ts (context layer beneath +
local-road visibility bump), src/toys/climbLinked.ts (hierarchy panel
height + zoom: wheel/buttons/drag-pan on the SVG viewBox, clamped),
styles.css, tests (decode + viewBox zoom math pure fns), spec/data.test.ts
(context present + budget). Offline rebuild from cache only.

### H4 — Plain-English copy pass (§17.7, .8)
Files: how/index.html (lede removed; chapter prose + captions rewritten),
index.html (splash description voice-matched; any home copy that reads
academic), src/toys/*.ts only where captions/status strings live in code.
Voice: short sentences, concrete verbs, technical terms allowed but
explained by use. Headings/contract strings untouched; ≤3 sentences per
chapter holds; invariants + heading tests stay green.

### H5 — Gate + merge
Sweep at 1920×1080 and 390×844 both themes (scoreboard one-line proof,
splash flow incl. session persistence + keyboard, context-layer look,
hierarchy zoom, copy render), fix wave, final whole-branch review,
ff-merge to main.
