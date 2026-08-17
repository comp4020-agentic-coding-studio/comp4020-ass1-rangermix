# Highway to Hill — design spec

**Status: v3 — v2 shipped; §14 folds in the user's build review
(2026-08-15) as binding amendments to §5. Where §14 contradicts older
text, §14 governs.**

**Status history: v2, APPROVED with amendments (user review, 2026-08-14).**
Amendments folded in below: title is *Highway to Hill*; the site ships
**both light and dark themes**; racer set and the turn-restriction
simplification approved as proposed. Implementation plan:
`docs/superpowers/plans/2026-08-14-highway-to-hill.md`.

**Title:** *Highway to Hill* (the user's pun on "Highway to Hell" — and
literal in Canberra: the default race ends at **Capital Hill**, so the hero
route is the highway to the Hill). Subtitle: *why your GPS out-thinks the
algorithm you learned in class, on Canberra's actual streets.* The `h1` on
`/` is exactly "Highway to Hill".

**One strong idea (the point of view):** Dijkstra isn't slow because computers
are slow — it's slow because it treats every intersection as equally worth
considering. Contraction Hierarchies (CH) spend effort **once**, before any
question is asked, ranking every intersection and wiring in shortcuts; after
that, every route query coasts. Speed doesn't come from searching harder. It
comes from searching a smarter map.

**The core interaction, stated plainly (the brief requires this sentence to
appear on the site):** *Drop two pins on Canberra. Watch Dijkstra flood the
city while Contraction Hierarchies thread a handful of shortcuts — same route,
a fraction of the work.*

**One dataset, one mechanic:** the dataset is Canberra's drivable road network
from OpenStreetMap; the mechanic is *poke a graph, watch a search respond*.
Every interactive element on the site — the big race, the toy widgets, the
hierarchy slider — is that one mechanic at different scales.

---

## 1. Grounding: what this design must satisfy

Assignment 1 (due **noon Mon 17 Aug 2026**, week 4): "Build an interactive
explainer of something you think more people should know or understand."
Marked 45% process / 20% artefact / 35% response. Constraints from the
published brief and this repo's template, with where the design answers each:

| Contract line | Where the design answers it | Planned check |
|---|---|---|
| "deployed and live at its public GitHub Pages URL" | static Vite site, relative asset URLs (template default) | CI deploy + `linkinator` |
| "static and client-side throughout" | all algorithms run in the browser; data precomputed offline into committed artifacts; no server | code review; no fetch to non-relative URL (spec test) |
| "starter's invariant checks pass" | every page ships nav landmark, one `h1`, lang, title, viewport, img alt | `spec/invariants.test.ts` |
| "works at both marking viewports" | §5 gives per-viewport behavior for every component; layouts are designed mobile-first then widened | manual pass at 1920×1080 and 390×844, in both themes, each work session |
| "the visitor does something that changes what they see — state the core interaction plainly" | the sentence above appears verbatim in the home hero | spec test asserts the sentence is in built `index.html` |
| "one strong idea … and nothing else" | scope tiers in §11; everything ties to the one idea; no second topic, no CMS of algorithms | design review; cut list in §11 |
| HD artefact: "holds up under … the keyboard, a resize mid-interaction, a slow connection" | §5 keyboard paths, §9 resize + loading design | manual torture pass Sunday |
| Evidence: PROCESS.md 400–600 words, reflection 150–300, CLAUDE.md, commit trail | kept alongside the build, not retrofitted | `pnpm check:evidence` |

## 2. Audience and register

Primary: a CS-adjacent visitor who has *heard of* Dijkstra (a student mid-way
through an algorithms course, a working dev, a curious tinkerer). The site
carries a 30-second "what Dijkstra does" refresher so nobody is locked out,
but it does not re-teach graphs from zero.

Secondary, designed for explicitly: **the marker doing a 60-second skim at two
viewports.** The home page alone must land the whole idea — headline, one
race, one honest scoreboard — without scrolling to page two.

Register: earnest-playful science-museum exhibit. Confident, concrete, no
hand-waving; the numbers on screen are real measurements from the visitor's
own browser, and the copy says so.

## 3. Assumptions standing in for clarifying questions

This design was produced in an autonomous session, so the questions I would
have asked are answered here as **overridable decisions**:

| Question | Decision | Why / how to override |
|---|---|---|
| Edge weights: distance or travel time? | Travel time (speed by OSM highway class) | It's what "your GPS" means; makes motorways matter. Distance toggle is stretch. |
| Directed graph (one-ways)? | Yes; turn restrictions ignored | One-ways are cheap and honest; turn restrictions triple pipeline complexity for no pedagogical gain. A footnote discloses the simplification. |
| Which rivals race CH? | MVP: plain Dijkstra. Target: + A\* and bidirectional Dijkstra toggles | Dijkstra alone already lands the wow; the variants deepen it ("even the clever ones lose"). |
| How deep into theory? | Intuition + invariants, no proofs; a "why this is still exact" prose beat | Audience and 3-day runway. The correctness *argument* (highest-node-on-path) appears as one diagram + paragraph. |
| Map rendering stack? | Hand-rolled canvas, no tile/map library | The graph *is* the map; a slippy-map dependency adds megabytes and fights the aesthetic. |
| Site structure? | Two pages (+stretch third) — see §4 | |
| Visual mode | **Both light and dark** (user amendment) — three-state toggle: system default / light / dark, persisted | Costs a second map recipe and a second validated palette; both are specified in §8 and both are MVP. |
| Title | *Highway to Hill* (user's choice) | Default race destination Capital Hill makes the pun literal. |

## 4. Structure: options weighed

- **A. One long scrollytelling page.** Strongest narrative continuity; but
  heavy (hero map + five widgets in one DOM), sticky-viz scrollytelling is the
  hardest pattern to keep honest on a 390px phone, and one slow section drags
  the whole page.
- **B. Two pages — "feel it" (`/`), "understand it" (`/how/`).** *Chosen.*
  Home is the race and the sandbox; How is the chaptered explainer with toy
  widgets. Each page has one job and its own payload; phone layout is plain
  vertical flow; the marker's 60-second skim is page one entire. Risk: the
  visitor might not click through — mitigated by making the race's ending a
  cliffhanger CTA ("how is that possible? →").
- **C. Three pages (B + dedicated `/play/` lab).** The full vision, but a
  third surface to polish at two viewports in three days violates the brief's
  own genre discipline. Kept as the stretch tier: `/play/` extras fold into
  the home page as toggles until/unless time allows.

## 5. The experience, page by page

### 5.1 `/` — The Race (hero, sandbox, scoreboard)

**Layout, desktop (1920×1080):** full-viewport theme-aware canvas of
Canberra's road network (dark: night-map glow; light: paper-map ink; Lake
Burley Griffin reads as a void either way — instantly recognizable).
Left-top: title block + the core-interaction sentence. Right: scoreboard
panel. Bottom: control strip (presets, algorithm chips, Race/Reset).

**Layout, phone (390×844):** map fills the top ~55vh; title collapses to one
line + tap hint; scoreboard is a bottom sheet, collapsed to its headline
number ("**99.2% less work**"), expandable by swipe/tap; controls become a
horizontal chip row above the sheet.

**States:**

1. *Loading* — skeleton map (blurred static PNG of the network, ~30 KB) +
   progress bar for the graph fetch; the page is readable and the copy visible
   immediately (slow-connection rubric line).
2. *Ready / idle* — pins A and B pre-placed on the signature preset
   **Gungahlin → Capital Hill** (the literal highway to the Hill; it crosses
   the lake, so the bridge-bottleneck story is in the hero route). On
   desktop, after 1.5 s idle the race auto-runs once (skipped under
   `prefers-reduced-motion`, replaced by the final still + numbers).
3. *Racing* — both algorithms have already computed in a worker (results are
   instant); the page *replays* their settle order over ~2.5 s: Dijkstra's
   settled nodes bloom as an amber flood; CH's touched nodes spark in cyan —
   a few dozen glints along arterials. Live counters tick up with the replay.
4. *Done* — the shared shortest route draws itself as a bright path; the
   scoreboard locks in: **nodes settled**, **edges relaxed**, **wall time**
   (measured, labeled "measured just now in your browser"), and a proportional
   bar visual, linear scale, so CH's bar is a sliver. Headline: "CH did the
   same job touching 0.8% of the graph." (All specific figures in this doc
   are illustrative until measured on the real build; the shipped site only
   ever shows numbers it just measured or precomputed from the real graph.) A one-line footnote: "CH did homework
   first — a one-off preprocessing pass baked into this page. That trade is
   the whole story → **How it works**."
5. *Sandbox* — at any time: drag pins (desktop) / tap map to place A then B
   (phone; a chip shows which pin is next, third tap starts over); preset
   chips ("To the Hill" (Gungahlin → Capital Hill, default), "Full diagonal"
   (Belconnen → Tuggeranong), "ANU → Airport", "Across the lake");
   algorithm chips (MVP: Dijkstra vs CH fixed; target tier adds A\* and
   bidirectional Dijkstra as additional racers, each with its own hue);
   "Race" replays; "Surprise me" picks a random far pair.

**Keyboard path (HD rubric):** preset chips and buttons are real buttons;
`R` re-runs; pins are movable via a "move pin" mode — arrow keys nudge the
active pin along nearest-node snapping, Enter confirms. All controls reachable
by Tab in a sane order; the canvas is `role="img"` with an `aria-label` that
updates to a text summary of the last race ("Dijkstra settled 21,480 nodes;
CH settled 214; same 22.4 km route" — numbers are aria-live announced once per
race, not per frame).

**Copy anchors (so tests can pin them):** the `h1` is the site title; the
core-interaction sentence appears in the hero; the scoreboard region has
`data-testid="scoreboard"`.

**What must NOT be here:** no algorithm-config soup (heap variants, heuristic
weights), no second dataset, no "compare 12 cities". One city, one mechanic.

### 5.2 `/how/` — How it works (five chapters, one toy each)

A vertical article; left rail (desktop) shows chapter progress dots; phone is
plain flow with a sticky mini-header naming the current chapter. Every toy
shares one control convention: **▶ play / step / ⟲ reset**, all buttons, all
keyboard-focusable; every toy is an SVG (crisp, cheap, touch-friendly) on the
same 12-node "mini-town" graph so the visitor never re-learns a diagram.

1. **What Dijkstra actually does (refresher).** Toy: press play, watch the
   frontier expand ring by ring from A until B settles; counter of settled
   nodes. Learning goal: settling order = distance order; it cannot know a
   node is irrelevant. *"Dijkstra is perfect and blind."*
2. **Roads already have a hierarchy.** The real-map moment: a slider over the
   full Canberra render sweeping "show every road → show only what CH ranks
   in the top k%". As k drops, suburbia fades and the arterial skeleton —
   Tuggeranong Parkway, the bridges — glows. Learning goal: CH's node order
   *discovers* the road hierarchy from pure graph structure; bottleneck nodes
   (bridges!) rank high. This is the page's money shot and it reuses the home
   page's data.
3. **Contraction: remove a node without lying about distances.** Toy: tap any
   node to contract it — it sinks/greys; for each in/out neighbor pair either
   a green *witness path* flashes ("a route around already exists — no
   shortcut needed") or a dashed **shortcut** arc snaps in with weight
   u→v→w. A disclosure ("show me the check") animates the tiny local Dijkstra
   that hunts for the witness. Learning goal: the invariant — after removing
   a node, all remaining pairwise distances are unchanged; shortcuts are the
   price, witnesses are the discount.
4. **Order is everything.** Toy-game: contract the whole mini-town three ways
   — "random order", "worst order", "smart order (edge difference)" — each
   animates and totals shortcuts added (e.g., 23 vs 41 vs 6; real numbers from
   the toy, not scripted). Then *"your turn"*: the visitor picks the order by
   tapping nodes, live shortcut count, "beat the heuristic?" Learning goal:
   node selection is the knob that decides preprocessing quality; the
   edge-difference heuristic in one sentence (add few, remove many, stay
   uniform). This chapter answers the brief's "how different node selection
   affects performance" head-on.
5. **The query: only ever climb.** The mini-town redrawn in 2.5-D, nodes
   lifted to their contraction rank. Pick A and B (or press play): two
   searches climb *upward only* — forward from A, backward from B — meet near
   the top, then the winning path *unzips*: shortcuts recursively expand back
   into real streets. One-paragraph correctness intuition beside it: every
   shortest path has a highest node; shortcuts guarantee both halves exist as
   up-paths, so the tiny up-up search misses nothing. Closer: the real
   numbers from the visitor's own last race on page one, echoed ("that's why
   214 beat 21,480"), and a link back to race again.

Chapter 5 in MVP may ship with the 2.5-D toy *static* (pre-laid SVG with
play-through animation, no free node choice) — see tiers, §11.

**Footer (both pages):** about block — what this is, data © OpenStreetMap
contributors (ODbL), Geisberger et al. 2008 reference, honest-numbers note,
link to the repo.

### 5.3 Shared chrome

Header nav (invariant): Home ·  How it works. Footer as above. No other
surfaces. `<html lang="en-AU">`, real titles per page, viewport meta —
template invariants stay green.

## 6. User journey

**The 60-second marker skim (either viewport):** land on `/` → read headline
+ core-interaction line without scrolling → the auto-race (or its
reduced-motion still) shows amber flood vs cyan sparks → scoreboard says
"99.2% less work — measured just now" → click "How is that possible?" → scan
five chapter headings that summarize the argument even unread → footer shows
data credit and references. The whole idea is legible without operating
anything; every claim on screen is a number the page just measured.

**The curious 10-minute visitor:** arrives skeptical ("routing is a solved
lecture topic") → drags the pins somewhere they know (home → uni) → the flood
covers their suburb, the sparks don't → tries to break it: pins across the
lake, adjacent pins, airport run; the ratio holds and the route is pixel-same
→ clicks through to `/how/` → plays each toy, loses to the heuristic in
chapter 4 at least once → hits the hierarchy slider and recognizes the
bridges → returns to the race, switches on A\* (target tier) and watches even
it lose → leaves able to say the idea in one sentence: *precompute an
ordering + shortcuts, then search only upward.*

**Phone-specific journey differences:** tap-to-place replaces drag; the
scoreboard arrives as a peeking bottom sheet so the map stays the hero; toys
are sized to one thumb (min 44 px targets); chapter prose is short enough
that each toy is reachable within one flick of its heading.

**Exit ramps at every depth:** stop after the hero — you still got the idea;
stop after chapter 2 — you got the intuition; finish chapter 5 — you can
implement it. Nothing downstream is required to make sense of upstream.

## 7. Pedagogical thread (the five beats)

1. Same answer, ~100× less work — *feel* it before explaining it.
2. The speed isn't magic: it was **bought earlier** (preprocessing ↔ query
   trade, stated at the moment of wow, not hidden).
3. Deleting a node can preserve all truths **if** you pay with shortcuts —
   and witnesses keep the price down.
4. *Which* node you delete next decides everything — hierarchy quality is a
   **choice**, and a good heuristic beats your intuition.
5. Query = two climbs + an unzip; correctness rests on "every path has a
   summit".

Misconceptions the copy actively kills: "CH finds approximate routes" (no —
exact, and the race shows identical paths); "it's just A\* with a better
heuristic" (no — no geometry used at query time); "preprocessing is cheating"
(it's the entire engineering point — amortization).

## 8. Visual and motion design

- **Theme system (user amendment: both themes ship, MVP):** three states —
  system default (`prefers-color-scheme`), explicit light, explicit dark —
  cycled by a header toggle on every page, persisted in `localStorage`, and
  applied via `data-theme` on `<html>` by a tiny inline head script so
  neither theme flashes on load. Canvases re-render on theme change,
  including mid-race (replay state lives in data). CSS custom properties are
  the single source of truth; canvas code reads them via
  `getComputedStyle`.
- **Surfaces & ink.** Dark: ground `#0b0e14`, panel `#131826`, ink
  `#e8ecf4`, muted `#8b94a8`, roads `#2a3348`→`#3d4a68`, route `#ffffff`.
  Light (paper-map): ground `#f3f1ec`, panel `#ffffff`, ink `#1c2330`,
  muted `#5a6372`, roads `#d8d3c8` (minor) → `#b3ac9d` (major), route
  `#1c2330`. Status green (witness "no shortcut needed"): `#7dd8a0` dark /
  `#008300` light — reserved, never a series colour.
- **Algorithm roster — fixed order, one palette per theme, both
  machine-validated** with the dataviz palette validator in roster order
  (Dijkstra, A\*, bidirectional, CH): dark steps `#d95926` / `#9085e9` /
  `#d55181` / **`#3987e5`** (all checks pass; worst adjacent ΔE 15.9
  protan; MVP pair orange↔blue ΔE 26.8); light steps `#eb6834` /
  `#4a3aa7` / `#e87ba4` / **`#2a78d6`** (all checks pass; one WARN —
  bidirectional `#e87ba4` is 2.62:1 against the light surface, which is
  legal only under the relief rule, and the scoreboard satisfies it: every
  row always carries a visible name + count label). Dark mode additionally
  has *glow variants* for additive map dots only (`#f5a962`/`#b48ce8`/
  `#e87ba0`/`#4fd8eb`), never the sole identity carrier. Light mode uses
  the chart steps directly on the map (opaque dots, no additive blending —
  glow washes out on paper). Roster order is fixed; never re-colour by
  rank.
- **Type:** system grotesk stack (`Inter`-ish via `system-ui`) — no webfont
  payload; display sizes for the headline and scoreboard numerals;
  `font-variant-numeric: tabular-nums` on all counters so ticking numbers
  don't jitter.
- **Motion rules:** exactly one thing animates at a time; replays are
  time-scaled to ~2.5 s regardless of graph size; every animation has a
  step/scrub alternative; `prefers-reduced-motion` swaps all replays for
  final-state stills with the same numbers. No parallax, no scroll-jacking.
- **Map style:** roads as 1px polylines with class-weighted alpha; settled
  nodes as dots — dark theme blends them additively so the flood reads as
  light, light theme draws them opaque so it reads as ink on paper; the
  void of the lake and the radial geometry do the aesthetic work in both.
- **Annotation voice:** captions under every toy state *what to notice*, one
  sentence, muted color — the site never makes the visitor infer the lesson.

## 9. Data and architecture

**Pipeline (offline, committed script + committed output; CI never touches
the network):** `scripts/data/build-graph.ts`, run manually:

1. Input: Geofabrik ACT extract (`.osm.pbf`, ~20 MB, not committed).
2. Filter drivable ways (`motorway…residential/unclassified`; `service` only
   where named); nodes → edges with travel-time weights (class speed table),
   one-way respected; largest strongly-connected component kept.
3. Simplify: contract degree-2 chains into single weighted edges, retaining
   full chain geometry (Douglas-Peucker ≈ 5 m) in a separate render layer.
4. CH preprocessing: priority = edge difference + deleted-neighbors, lazy
   re-evaluation; emit node order, shortcut edges with middle-node for
   unpacking. Also emit a small precomputed benchmark table (1,000 random
   query pairs: settled-node counts) used in `/how/` chapter copy.
5. Output → `public/data/` as gzip-friendly JSON of flat integer arrays
   (delta-quantized coords, CSR adjacency): estimated ~15–30k nodes /
   40–70k edges + similar shortcut count. **Budget: ≤ 4 MB gzipped total**
   (GitHub Pages compresses `.json`; a raw `.bin` wouldn't be). A spec test
   fails the build if the artifact exceeds budget.

**Runtime modules (each unit testable alone):**

- `src/graph/` — typed-array graph + loader (no DOM).
- `src/algos/` — `dijkstra.ts`, `bidijkstra.ts`, `astar.ts`, `chQuery.ts`
  (+ `chBuild.ts` used by the pipeline and the toy widgets): every algorithm
  returns `{dist, path, settleLog, relaxCount}` so the replay is data, not
  side effects.
- `src/race/` — worker wrapper (compute off-main-thread), replay scheduler
  (batches settleLog per rAF frame), scoreboard state.
- `src/viz/` — canvas renderer: static basemap drawn once to an offscreen
  layer, dynamic layer for floods/paths; DPR-aware; `ResizeObserver` re-lays
  out and *re-draws mid-race safely* (rubric line — replay state lives in
  data, so a resize just re-renders the current frame).
- `src/toys/` — the SVG mini-town widgets, driven by the same `src/algos/`
  code on a 12-node graph (one source of truth; the toys can't drift from
  the real algorithms).
- Pages: `index.html` + `how/index.html` (template's multi-page scan).

**Slow connection:** copy + layout render with zero data; graph JSON fetches
with progress UI; race controls disable until ready with visible reason.

## 10. Sensors (tests this design commits to)

- **Equivalence (the big one):** CH query distance == Dijkstra distance on
  200 random pairs of the *shipped* Canberra graph, and on adversarial toy
  graphs — proves "exact, not approximate" and guards the whole pipeline.
- **Unpacking:** every unpacked CH path is a contiguous chain of real edges
  with matching total weight.
- **Witness logic:** crafted 5-node cases where a shortcut must / must not be
  added.
- **Performance claim as test:** mean CH settled-nodes ≤ 5% of Dijkstra's
  over the benchmark pairs — the site's headline claim, enforced in CI.
- **Payload budget:** `public/data/` ≤ 4 MB gzipped.
- **Spec/DOM tests:** both pages exist with the invariants; the
  core-interaction sentence present verbatim on `/`; scoreboard,
  race controls, and each chapter's toy root present with `data-testid`s;
  no absolute-URL fetches (client-side contract).
- Existing template invariants stay on; `starter.test.ts` retired when the
  starter page is replaced (its own instruction).

## 11. Scope tiers against the clock (now → Mon noon)

**MVP — must ship (target: green + deployed by Sat night):**
data pipeline; home race Dijkstra vs CH with pins, presets, scoreboard,
loading/reduced-motion states; **both themes with the toggle** (user
amendment — this is MVP, not polish); `/how/` chapters 1–4 interactive +
chapter 5 as static-diagram-with-play; footer/attribution; all §10 tests;
both viewports clean in both themes; PROCESS.md + reflection drafted by the
*student*.

**Target — Sunday:** A\* + bidirectional racer chips; chapter 5 free-pick
2.5-D toy; unpack animation on the home route; keyboard pin-nudge mode;
aria-live race summaries; torture pass (keyboard / mid-race resize / 3G
throttle).

**Stretch — only if ahead:** "beat the heuristic" scoring; a second,
deliberately-bad CH ordering shipped for a real-map "order matters" toggle;
`/play/` page absorbing the extra toggles; distance-vs-time weight switch.

**Cut with no mercy:** anything comparing cities, algorithm-internals
config, theory proofs, tile maps, turn restrictions.

## 12. Risks

| Risk | Mitigation |
|---|---|
| CH build correctness eats the weekend | Build `chBuild` against toy graphs + equivalence tests *first*, only then run on Canberra |
| Phone canvas perf (flood = thousands of dots) | additive dots batched per frame, cap replay to ~4k drawn points (sampling the settleLog visually, counters stay exact); static layer offscreen |
| Data too big for phone | chain contraction + quantization + budget test; worst case drop `service` roads |
| PBF parsing pain on Windows | fallback: Overpass API bbox export to JSON, filtered by the same script |
| Auto-race feels like a trap / motion-sick | runs once only, respects reduced-motion, replay button is the affordance |
| Scope creep via toy polish | each toy has a "done" definition = its single learning goal lands; chapter 5 has a designed fallback |
| Dual theme doubles visual QA | tokens are the single source of truth (canvas reads CSS custom properties); every viewport pass runs theme × viewport (4 combos); palettes pre-validated per mode |

## 13. Review resolutions (user review, 2026-08-14)

1. Racer set — **approved**: Dijkstra vs CH is the MVP race; A\* and
   bidirectional are target tier.
2. Title — **changed by user**: *Highway to Hill* (pun on "Highway to
   Hell"), grounded by making Capital Hill the default race destination.
3. Chapter 4 scoring — unraised; stays as designed (three-way comparison in
   MVP, "beat the heuristic" scoring in stretch).
4. Theme — **changed by user**: both light and dark ship, with a
   system/light/dark toggle. §8 carries the validated light palette and the
   two map recipes; §11 moves the toggle into MVP.
5. Turn restrictions ignored with a disclosed footnote — **approved**.

## 14. Build review amendments (user review, 2026-08-15 — binding)

The user reviewed the shipped v2 build. Verdict: landing page good, how
page too text-heavy. These amendments govern over §5 where they collide.

**Home (`/`):**

1. **Pins reposition by drag only** — tap-to-place is removed (with its
   hint chip). Dragging an empty patch of map pans; dragging a pin (24 px
   grab radius) moves it. Keyboard users route via presets (disclosed
   a11y trade).
2. **Map zoom** — wheel (desktop) + pinch (touch) + visible +/− buttons,
   clamped ~1×–8×, panning included; pin dragging and race rendering work
   at any zoom, including mid-race redraws.
3. **Compare mode** — a view toggle (Overlay ⇄ Compare). Compare renders
   one map panel per ACTIVE racer, view-synchronized (same pan/zoom),
   each replaying its own settle cloud, route, and pins under its own
   hue; desktop side by side (2–4 panels), phone 2-up grid/stack.
   Scoreboard unchanged.
4. **Control regrouping** — racer toggles and route presets are separate,
   visibly labelled groups ("Racers", "Routes"); the run control is a
   distinct primary button ("▶ Race again"), never visually a preset.
5. **Presets named as place → place** — labels a stranger understands:
   "Gungahlin → Capital Hill" (default; replaces "To the Hill"),
   "ANU → Airport", "Belconnen → Tuggeranong" (replaces "Full diagonal"),
   plus new "Dickson → Woden" and "Kingston → Belconnen"; "Surprise me"
   stays. ("Race"-the-button being mistaken for a preset is what item 4
   fixes.)
6. **Footer restyle** — the attribution block joins the design system:
   panel treatment, mono meta voice, same measure as the page, no
   afterthought paragraph.
7. **A real CTA to /how/** — an obvious, inviting button (not a fineprint
   link), emphasized once a race finishes: "How is that possible? →".

**How page (`/how/`):**

8. **Real streets replace the mini-town** — all toys run on an ANU-area
   drivable subgraph cut from the same OSM extract (target ≈ 40–80 nodes
   after chain contraction, largest SCC, real geometry), emitted by the
   offline pipeline as a committed artifact. The climb toy draws only the
   nodes its query touches (rank-lifted), ghosting the rest.
9. **Less text** — every chapter's prose tightens to 2–3 sentences plus
   the one-line "what to notice" caption.
10. **New chapter order (intuition → use → construction):**
    1. "What Dijkstra actually does" — simplified copy; demo auto-starts
       on scroll; visitor can pick start/end by clicking nodes.
    2. "The hierarchy, revealed" — CH intuition first. Auto-loops through
       the level stops (~2.5 s each), pauses when the visitor selects a
       level, resumable.
    3. "The query: only ever climb" — auto-starts on scroll; visitor can
       pick endpoints.
    4. "Shortcuts: the price of forgetting" — a plain explanation of what
       a shortcut IS (tiny static A—B—C diagram: remove B, keep the
       distance) followed by the interactive contraction toy.
    5. "Order is everything" — the ordering heuristic + order game; "your
       turn" compares your shortcuts-so-far against the heuristic's first
       k contractions (no need to finish all nodes on a real graph).
    Auto-start behaviors respect reduced-motion (final states, no loops).

Contract updates carried by these amendments: `CONTRACTS.chapterHeadings`
becomes the §14.10 list; the preset contract text becomes
"Gungahlin → Capital Hill"; new testids `view-toggle` and `how-cta`;
toy testids keep their names (order on the page changes).

## 16. Second build review (user, 2026-08-16 — binding; governs over §5/§14 where they collide)

**Home layout:**
1. Footer content constrained to the page measure (same width as the main
   content), vertical padding tightened — no more full-width tall band.
2. Slim viewports (≤ ~520px): the theme toggle compacts to an icon-style
   button (full meaning in aria-label) so the 390px header never wraps.
3. Dijkstra and CH visually read as ALWAYS-ON (no toggle affordance, full
   presence); A\* and Bidirectional read as optional toggles (switch/chip
   affordance, dimmed-when-off but visibly enable-able).
4. The group is called **"Algorithms"**, not "Racers".
5. Consolidated right panel: algorithm selection merges INTO the scoreboard
   itself (every algorithm is a row; optional rows carry their toggle);
   below the rows, stacked full-width: **View toggle**, then **▶ Race
   again**, then **How is that possible? →**. Routes stay in the bottom
   strip.

**Home map:**
6. Starting any race zooms the viewport to the A–B bounds with pleasant
   padding (~15%).
7. A new button above the zoom pair toggles A–B-bounds zoom ⇄ whole-map
   fit (testid `zoom-fit`).
8. Light mode gets a density effect equivalent to dark's additive glow:
   overlapping dots deepen (multiply-style compositing) so search density
   reads in both themes.
9. BUG: the dot/route overlay lags one step behind the base map on
   zoom/pan. Both layers must apply the SAME view state in the SAME frame.
10. Performance: overlay view should be smooth; compare view currently
    lags significantly. Interaction-time base-layer caching (blit the
    cached bitmap during pan/zoom, re-stroke crisply on idle) and overlay
    draw batching; target ≥ ~40 fps overlay and ≥ ~30 fps 4-panel compare
    during interaction on this machine, measured honestly.
11. Switching Overlay ⇄ Compare preserves the map's focus: the view state
    becomes GEO-ANCHORED (centre + span), so different panel geometries
    show the same place.

**How page:**
12. The toy graph moves to a Canberra area with a CLEAR road hierarchy
    (an arterial with feeder locals — e.g. the Northbourne corridor);
    same 40–80 node target, same sensors (incl. the shortcut-pair one).
13. The query chapter becomes a LINKED TWO-VIEW demo: the computed
    hierarchy (rank-lifted graph) on top and the mini street map below,
    visitor picks A/B on the MAP, and the query's progress animates in
    BOTH views simultaneously.

## 17. Third build review (user, 2026-08-16 — binding; governs over earlier sections where they collide)

**Home:**
1. Route preset buttons shrink (smaller, tidier): one line at 1920×1080;
   on the 390 phone the top of the Algorithms panel becomes visible
   without scrolling past a tall Routes block.
2. Scoreboard rows: algorithm name, settled count, time, and toggle on ONE
   line at 1920×1080 (user's screenshot shows "Contraction Hierarchies"
   wrapping and the Bidirectional toggle dropping below). Display names
   stay the full contract strings; fit via typography/grid, not renames.
3. The map-corner title/description overlay is REMOVED. In its place: a
   dismissible SPLASH (user's own proposal): "Highway to Hill" (the h1),
   a brief plain-English description carrying the core-interaction
   sentence, and an "Explore" button. Dismissing reveals the clean map;
   the auto-run fires only after dismissal; dismissal persists for the
   session; reduced-motion semantics unchanged. Static markup keeps the
   h1 + sentence (contracts intact).
4. The Algorithms panel discloses A\*'s heuristic in one muted line when
   A\* is enabled: guided by a straight-line travel-time estimate
   (great-circle distance ÷ the network's fastest road speed).

**How page:**
5. The mini map shows the ACTUAL map: a faint context layer of every road
   in the toy area (clipped from the full render geometry at build time,
   shipped in toytown.json) beneath the toy graph, and local toy streets
   raised in visibility — no more floating nodes with invisible
   connections.
6. The hierarchy (rank) view gets more vertical room and becomes
   zoomable (wheel + buttons, drag-pan, clamped).
7. The page's top description block ("how it works" lede) is removed —
   the h1 and chapters carry the page.
8. Every chapter's prose and captions rewritten in straightforward,
   simple English — technical/academic words allowed, phrasing simple
   and intuitive. Chapter headings (contracts) stay.

## 18. Fourth build review (user, 2026-08-17 — binding; governs where it collides with earlier sections)

**Layout & controls:**
1. Routes section matches the MAP's width (not the full layout).
2. "Surprise me" visually signals randomness: a rainbow treatment
   (gradient border/accent) distinct from every roster hue — it is a
   control affordance, not a data series, so the chart-palette rules
   don't bind it; reduced-motion-safe (no animation required).
3. Algo on/off affordance: no switches — each toggleable algorithm row
   is enclosed in a thin BEZEL (border) and the whole bezel is the click
   target (`aria-pressed` on the row control). Off = dimmed + hollow
   bezel; on = full presence.
7. The view (overlay⇄compare) button shrinks and moves to the TOP of the
   Algorithms section.
9. A map-size control sits NEXT TO the view button, same line, both
   small: "current" (default, today's fixed layout cap) vs "adaptive"
   (the layout cap relaxes so the map extends into large viewports;
   panel width unchanged). Persisted (localStorage, guarded). Testid
   `size-toggle`.
10. The theme button becomes a simple ICON that changes with the
    selected theme (system ◐ / dark ☾ / light ☀) at ALL widths; full
    state lives in the aria-label. theme.ts and its tests update
    coherently.

**Algorithm roster (the deep change):**
4. A\* gains MULTIPLE heuristics, each its own racer row:
   - "A\* — straight line": current admissible haversine ÷ data-derived
     vMax. Exact (equivalence-tested).
   - "A\* — weighted (1.5×)": h × 1.5 — inadmissible on purpose; faster,
     may return a longer route.
   - "A\* — greedy (direction only)": pure h ordering (no g) — the
     user's "direction guided"; strongly directed, routinely suboptimal.
   **Honesty rule (binding):** every race already computes the exact
   answer (Dijkstra/CH). Any variant whose returned route is longer than
   optimal must SAY SO in its row, live: "+X% longer route", computed
   from measured distances. No variant ever silently presents a
   suboptimal route as "the" route. The map draws THE optimal route as
   the shared route; a suboptimal variant's own route may be shown on
   its compare panel with its disclosure.
5. Each A\* row is named "A\* — <heuristic>" exactly as listed above.
6. BIDIRECTIONAL becomes a family-wide MODIFIER, not a racer: one large
   thin bezel groups the "graph searchers" family (Dijkstra + all A\*
   variants) with a single "bidirectional" toggle on the bezel. When on,
   every ACTIVE family member runs its bidirectional form: Dijkstra →
   existing bidirectional Dijkstra; A\* straight-line → balanced
   bidirectional A\* (Ikeda average-function heuristic — exactness
   preserved for the admissible heuristic, equivalence-tested); weighted
   and greedy bidirectional forms reuse the balanced framework with
   their scaling applied and remain disclosed-suboptimal. Active rows
   show a ⇄ marker while modified (identity hue NEVER changes). CH sits
   outside the family bezel (its own class; its fineprint may note it is
   inherently bidirectional).

**Splash:** 8. Copy order becomes: (a) what this project/website IS
(one plain sentence), then (b) the race exploration invitation (the
core-interaction sentence stays verbatim). Simple words.

**Roster palette (validated this round, both modes, dataviz validator all
checks pass; light magenta+yellow carry the relief rule = always-visible
row labels):** display order Dijkstra, A\*-straight, A\*-weighted,
A\*-greedy, CH. Dark: `#d95926` `#9085e9` `#d55181` `#c98500` `#3987e5`;
light: `#eb6834` `#4a3aa7` `#e87ba4` `#eda100` `#2a78d6`. Glow variants:
existing four keep their mapping (A\*-weighted inherits the old bidi glow
family `#e87ba0`; A\*-greedy dark glow `#e8c063` — a lightened step of its
chart hue, map-dots only, never sole identity). The retired "bidirectional
racer" hue assignment disappears with the racer; the ⇄ modifier carries no
colour of its own.

## 19. Fifth build review (user, 2026-08-17 — binding)

1. The size button HIDES when the viewport is too small for adaptive mode
   to extend the map (static markup keeps the element; visibility is
   responsive).
2. Adaptive size extends the map BOTH horizontally and vertically; the
   vertical stretch must keep the Routes section visible (map height ≈
   viewport minus header minus routes strip — no fold-loss of Routes).
3. Panning must not reveal empty (unstroked) area while the pointer keeps
   moving: the interaction-time base cache renders with overscan margin,
   and during sustained interaction the crisp base refreshes at least
   every 0.5 s (user-authorized cost) so uncovered regions fill without
   waiting for pan-end.
4. Replay pacing becomes PER-ALGORITHM and proportional to measured
   compute: each racer's replay duration = its own measured wall time ×
   2000 (0.5 ms → 1 s, 2.5 ms → 5 s). Rows finalize when their own replay
   completes; race-end effects (aria announcement, CTA emphasis, stored
   echo) fire when the LAST active replay completes; reduced-motion
   semantics unchanged (instant finals). No cap — long honest replays
   (e.g. bidirectional greedy) are the point; the cancellation paths
   (new race, preset, toggle) must remain instant.
5. Splash on/off control (added mid-round): a small ⓘ button in the
   header nav re-opens the splash at any time (the intro doubles as the
   About surface); the splash gains a "don't show this again" preference
   (guarded persistent storage) that disables auto-show on future visits;
   the Explore/Escape dismissal semantics and control gating are
   unchanged.

## 20. Sixth build review (user, 2026-08-17 — binding)

1. Every algorithm's ROUTE draws in its own chart hue, and appears only
   when THAT algorithm's replay finishes (the single shared white/ink
   route retires). Exact racers share geometry and overdraw; a
   suboptimal racer's divergent route in its own hue is the point.
   Compare panels recolor their per-panel routes likewise (dashed-when-
   suboptimal stays).
2. Weighted A\* is REMOVED from the roster (four racers remain:
   Dijkstra, A\* — straight line, A\* — greedy, CH). Re-validated
   4-slot palettes in display order (both modes pass; light yellow
   keeps the relief-rule obligation via always-visible row labels).
3. At 1080p in adaptive + compare, four panels lay out 2×2 (not one
   row); three panels 2+1; two panels side-by-side as today.
4. Bidirectional greedy: investigate the flood-like behavior (27k
   settles). Finding-in-advance from the controller: the balanced
   framework's termination bound presumes keys are g+p lower bounds;
   greedy's h-only key voids it, degenerating to near-exhaustion. If
   confirmed, REDEFINE bidirectional greedy as first-frontier-meet
   semantics (two greedy searches, stop at first meet, concatenate at
   the meeting node, disclosed-suboptimal as usual) — small settle
   counts, honest routes, tested.
5. §17.6's vertical/zoom treatment was applied to the WRONG view: the
   user meant chapter 2 ("The hierarchy, revealed"), not the query
   chapter's rank view. Revert the query view to its compact pre-§17.6
   form (height and zoom controls); give the hierarchy-revealed
   Canberra canvas the extra vertical room AND wheel/button zoom + pan
   (its own local view state — never the home page's shared store).

## 21. Seventh build review (user, 2026-08-17 — binding)

Two items. Item 1 (query-demo nodes cropped at stage edges) was diagnosed
and fixed inline before this section landed: declutterXY's clamp bounds
equalled the stage box, so repulsion pinned node centers onto the walls
and `.climb-nodes`' overflow clip cropped them to half dots — fixed by
the shared `NODE_CLAMP_BOUNDS` inset (half the 24 px node box) with two
real-artifact sensors. Item 2 is this round: the user finds chapters 4–5
(shortcuts + ordering) "still confusing and not straightforward"; the
approved direction is the full treatment — narrate the decision AND show
the consequence AND tell one story. Diagnosis on record: ch4's click
shows all witness/shortcut outcomes at once (a firework, not a
decision), ch5's tiles show bare integers (the claimed "messier before
simpler" is never SEEN), and neither chapter ties back to ch2's ranks or
ch3's climb.

1. **Chapter 4 becomes a narrated contraction.** Clicking an
   intersection starts a stepped sequence over its neighbour pairs, one
   pair per beat (~1.2 s auto-advance, with play/step/reset chips per
   the ch3 toy's convention): (a) the pair's two through-legs highlight
   with the through cost in seconds; (b) the best detour avoiding the
   doomed intersection flashes on the real streets with its cost (or
   "no detour exists"); (c) a narration line under the stage stamps the
   verdict with the real measured numbers — witness/free pass, or
   shortcut added (the dashed curve draws and persists only now). A
   single-neighbour dead end narrates its degenerate case ("nothing
   meets through here — free to remove"). Clicking another node
   mid-sequence completes the current sequence instantly, then starts
   the new one. `prefers-reduced-motion` jumps to the end state. The
   running shortcut counter stays. All numbers are the contractor's own
   measured weights — never scripted.
2. **Chapter 5's order buttons become map replays.** Pressing an order
   button replays that contraction order on ONE shared stage: nodes
   gray out in order (~80 ms cadence, ≈5 s per full run) while
   unlabelled dashed shortcut curves accumulate live and the tile's
   count climbs. Pressing a different order clears the curves and
   replays. Tiles keep their totals + bars as the scoreboard (numbers
   remain live runs, never cached figures); reduced motion shows the
   final state instantly. "Your turn" draws the same curves as the
   visitor taps, so their own clutter accumulates against the
   heuristic's count.
3. **One story in the copy.** Chapter 4's body copy reframes
   contraction as the demolition schedule behind ch2's ranking: remove
   intersections quietest-first under one rule — no travel time may
   ever change; detour already exists = free pass (witness), otherwise
   pave a bypass (shortcut) carrying exactly the through time. Chapter
   5's copy closes the loop: contract quiet streets first and the
   survivors are exactly the big roads — the hierarchy ch2 revealed,
   and why ch3's climb works. Chapter HEADINGS stay contract-exact
   (unchanged); body copy and both "What to notice" captions rewrite.
4. **Shared drawing, tested.** The shortcut-curve helpers
   (curveNormal/controlPoint/draw) move from contraction.ts into
   toytownView.ts so both chapters draw identical curves — ch4 keeps
   weight labels (its narration device), ch5's replay omits them
   (volume is the point). New sensors: pair-sequence order + verdict
   math from real weights, replay determinism, reduced-motion jump,
   your-turn curve accumulation; order.test.ts's pinned inequalities
   and the ch4/ch5 testids stay. No new hues — existing witness-flash
   and shortcut classes carry the visuals.

## 15. References

- Geisberger, Sanders, Schultes, Delling — *Contraction Hierarchies: Faster
  and Simpler Hierarchical Routing in Road Networks*, WEA 2008.
- OpenStreetMap contributors, ODbL — attribution in site footer.
- Genre kin (for register, not imitation): Nicky Case's explorables; the
  "explorable explanations" tradition.
