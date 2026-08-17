# Narration Round Implementation Plan (spec §21, item 2–4)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Same-checkout three-way wave, strict partitions, own-files-only `git add`, targeted tests in-wave, controller runs the roster post-wave. NOTE: the controller pre-edited TWO shared files in the WORKING TREE before the wave: `src/toys/toytownView.ts` (shortcut-curve helpers moved in from contraction.ts — L1 verifies + commits them with its own work) and `styles.css` (all new classes both tasks need — READ-ONLY for every wave task; if a class is missing or wrong, REPORT it in your report, do not edit the file; the gate fixes it).

**Goal:** Chapter 4's click becomes a stepped, narrated witness-vs-shortcut
decision; chapter 5's order buttons become live map replays that show the
clutter; both chapters' copy tells one story tied back to chapters 2–3.

**Architecture:** No algorithm changes — both toys already run the real
`createContractor`. The work is sequencing and rendering what it already
decides: a per-pair phase machine in contraction.ts, an interval-driven
replay in order.ts, and one shared curve-drawing helper in toytownView.ts
so both chapters draw identical dashed shortcuts.

**Tech Stack:** existing (TS + SVG + vitest/jsdom). No new deps, no new hues.

## Global Constraints

- Chapter HEADINGS are spec contracts — do not change any `<h2>` text.
- Every user-visible number is measured from the real graph — never scripted.
- `prefers-reduced-motion: reduce` always gets the full end state instantly.
- Palette discipline: only existing CSS custom properties; invent no hues.
- Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Commit only when your targeted tests are green; never a red state.

---

### L1 — Chapter 4 narrated contraction (§21.1 + §21.4 helper move)

**Files:**
- Modify: `src/toys/contraction.ts` (rebuild click into phase machine)
- Modify+commit: `src/toys/toytownView.ts` (controller's pre-moved helpers — verify, adjust if broken, commit)
- Modify: `src/toys/toytownView.test.ts` (helper geometry tests)
- Create: `src/toys/contraction.test.ts` (pure sequencing + verdict text)
- Read-only: `styles.css` (`.toy-narration`, `.edge-line.through-leg` etc. are pre-written; report gaps)

**Interfaces:**
- Produces (in toytownView.ts, consumed verbatim by L2 — do not rename):
  ```ts
  export function curveNormal(xy: [number, number][], a: number, b: number,
    via: number, flip: boolean): [number, number];
  export function controlPoint(xy: [number, number][], a: number, b: number,
    via: number, flip: boolean): [number, number];
  export interface ShortcutCurveOpts {
    flip: boolean;            // caller convention: a > b
    collisionRank?: number;   // label stagger rank, default 0
    weightLabel?: number;     // seconds; omit entirely for unlabelled (ch5)
  }
  /** Appends a dashed curve (class "shortcut-path") bowing away from `via`
   * to `group`; when weightLabel is set, also the label text + bg chip
   * (classes "shortcut-label"/"shortcut-label-bg"). Returns the path. */
  export function drawShortcutCurve(group: SVGGElement,
    xy: [number, number][], a: number, b: number, via: number,
    opts: ShortcutCurveOpts): SVGPathElement;
  ```
- Consumes: `createContractor` unchanged; existing `.flash` road class.

Behavior (spec §21.1, binding):
- Click node v → compute once, up front: the outcome (contract(v) on the
  persistent contractor as today), the pre-contraction snapshot data the
  display needs (through costs from the live edges INTO/OUT OF v; best
  detour path+cost per ordered pair via dijkstra on the graph-without-v
  snapshot — the machinery the current file already has), then play a
  PHASE SCRIPT over the pairs. Export the script builder pure:
  ```ts
  export interface PairVerdict {
    u: number; w: number; via: number;
    throughS: number;             // rounded seconds
    detourS: number | null;       // null = no detour exists
    witness: boolean;             // detourS !== null && detourS <= throughS
    detourPath: number[];         // [] when none
    narration: string;            // exact strings below
  }
  export function pairVerdict(u: number, w: number, via: number,
    through: number, detour: { dist: number; path: number[] } | null): PairVerdict;
  ```
  Narration strings, EXACT (tests pin them; `{t}`/`{d}` are rounded ints):
  - witness: `through: {t}s · detour found: {d}s ≤ {t}s → free pass (witness)`
  - shortcut (detour exists): `through: {t}s · best detour: {d}s > {t}s → shortcut added ({t}s)`
  - shortcut (none): `through: {t}s · no detour without this intersection → shortcut added ({t}s)`
  - zero pairs (dead end), one line for the whole click:
    `nothing meets through here — free to remove, no shortcuts`
- Phase machine: 3 phases per pair, 400 ms each (≈1.2 s/pair):
  1. `legs` — the pair's two through streets get class `through-leg`
     (find via the existing roadEls/shortcutEls lookup, both legs), and
     the narration line shows `through: {t}s …` (prefix only is fine —
     simplest: show the full narration at phase 3; phases 1–2 show
     `through: {t}s` then `through: {t}s · detour: …`; pick ONE scheme,
     implement it, and pin it in tests).
  2. `detour` — flash the detour path streets (existing `.flash` class,
     but held, not timed out, until the pair ends) or nothing when none.
  3. `verdict` — full narration text lands; if shortcut: draw the curve
     NOW via drawShortcutCurve (weightLabel set), bump the counter.
  Clear `through-leg`/held `.flash` when the pair ends.
- Controls: `play`/`step`/`reset` chips (climbLinked's convention).
  Clicking a node starts auto-play of ITS script. `step` advances one
  phase (pausing auto-play). Clicking ANOTHER node mid-script: apply the
  current script's remaining verdict effects instantly (curves+counter),
  then start the new node's script. `reset` = full toy reset (as today).
- Reduced motion: no phases — apply all effects instantly, narration line
  shows the LAST pair's verdict plus the counter (state, not animation).
- The narration line: `<p class="toy-narration" data-role="narration" aria-live="polite">`
  directly under the stage, present from mount (empty until first click).

Steps: (1) verify+commit controller's toytownView.ts helper move with
geometry tests RED→GREEN (controlPoint bows away from via; flip mirrors;
drawShortcutCurve with/without label appends the right elements — jsdom);
(2) contraction.test.ts: pairVerdict verdict/threshold/rounding cases RED;
(3) implement pairVerdict GREEN; (4) rebuild the click path + phase machine;
(5) targeted suites green; (6) commit (message names §21.1).

### L2 — Chapter 5 order replays + your-turn curves (§21.2)

**Files:**
- Modify: `src/toys/order.ts`
- Modify: `src/toys/order.test.ts`
- Read-only: `styles.css` (`.order-replay-stage`, `.node-mark.contracted` pre-written; report gaps)
- Read-only: `src/toys/toytownView.ts` (consume L1's Interfaces block above verbatim — it is pre-written in the working tree; import and go, even if L1 hasn't committed yet)

**Interfaces:**
- Consumes: `drawShortcutCurve(group, xy, a, b, via, { flip })` — NO
  weightLabel (unlabelled curves, spec §21.4); `createContractor`,
  `orderedShortcutCount`, existing `heuristicOrder`/`degreeDescendingOrder`/
  `seededShuffleOrder` (unchanged).
- Produces (pure, pinned by order.test.ts):
  ```ts
  export interface ReplayStep {
    node: number;
    shortcuts: { a: number; b: number; via: number; w: number }[];
  }
  /** One entry per contraction in `order`, in order; concatenated
   * shortcut counts equal orderedShortcutCount(g, order). */
  export function replayScript(g: Graph, order: number[]): ReplayStep[];
  ```

Behavior (spec §21.2, binding):
- Add ONE shared replay stage between the run buttons and "your turn":
  `.toy-stage.order-replay-stage`, aria-hidden, non-interactive — context +
  roads + drift layers exactly like the your-turn stage, plus a
  `<g class="shortcuts">` group and one `.node-mark` div per node
  (decluttered positions, same as buttons — reuse the same buttonXY run).
- Pressing an order button: cancel any running replay, clear curves and
  `.contracted` marks, then play that order's replayScript at 80 ms per
  step: mark `order[k]`'s node-mark `.contracted`, draw its step's curves
  (unlabelled), set the tile's live count to the running total + bar as
  today (bars scale against the max KNOWN total as today). At the end the
  tile keeps its total — same final numbers as before (replayScript's
  totals ARE orderedShortcutCount's; the test pins it).
- Reduced motion: no interval — final state instantly (all marks
  contracted, all curves drawn, final count).
- "Your turn": each tap ALSO draws that contraction's curves (unlabelled)
  into a `<g class="shortcuts">` group added to the your-turn stage's svg;
  reset clears them. Counter/verdict logic unchanged.
- The three tiles/buttons, seeded random order, and every pinned
  inequality in order.test.ts stay EXACTLY as they are.

Steps: (1) order.test.ts: replayScript totals == orderedShortcutCount for
all three orders + determinism (same order twice → identical script) RED;
(2) implement replayScript GREEN; (3) DOM: replay stage + interval + tile
wiring + your-turn curves; (4) full order suite green; (5) commit.

### L3 — One-story copy (§21.3)

**Files:**
- Modify: `how/index.html` (chapter 4 + 5 body copy and captions ONLY —
  headings, figure/figcaption, and all other chapters untouched)

Replace ch4's body `<p>` (the one beginning "Contraction Hierarchies gets
its speed…") with:

> Chapter 2's ranking is really a demolition schedule: CH removes
> intersections one at a time, quietest first — under one rule, nothing
> is allowed to get slower. Before an intersection goes, every way
> through it gets the same question: is there already a detour just as
> fast without it? If yes, it goes for free — that detour is called a
> witness. If no, CH paves a bypass first: a shortcut that carries
> exactly the travel time the trip through used to take. Click any
> intersection below and watch it ask, pair by pair.

Replace ch4's caption `<p class="caption">` text with:

> What to notice: the same question, asked once per pair of roads — a
> detour just as fast means a free pass; no detour means a dashed
> shortcut, priced at exactly the old travel time.

Replace ch5's body `<p>` (the one beginning "Contracting one intersection
at a time…") with:

> Every shortcut is clutter the map has to carry, so the demolition
> order decides everything. Press the buttons below and watch each order
> play out on the map: knock out a busy hub early and shortcuts bury the
> streets within seconds; save the hubs for last and the map stays
> almost clean. That's the whole trick — contract quiet streets first,
> and the survivors are exactly the big roads. It's the hierarchy you
> saw revealed in chapter 2, and it's why the climb in chapter 3 works.
> Then take "your turn" and see if you can beat the heuristic.

Replace ch5's caption `<p class="caption">` text with:

> What to notice: the smart order isn't luck — run after run it adds the
> fewest shortcuts, and the last streets standing are the ones you'd
> call main roads.

Steps: (1) apply the four replacements verbatim; (2) `npx vitest run spec/`
green (headings/testids untouched — proves no contract broke); (3)
`pnpm build` green; (4) commit.

### L4 — Gate + merge

Roster post-wave; three reviews ∥ gate (fix-wave folding); live proofs
with agent-browser on the built site, both viewports: a narrated click on
a busy intersection (phases visible, narration strings exact, curve lands
at the verdict beat), a dead-end click, mid-script node switch, all three
order replays (worst visibly buries the map early — screenshot mid-run),
your-turn curves, reduced-motion end states for both toys, console clean;
final whole-branch review; ff-merge; evidence shots.

## Self-review notes

- Spec coverage: §21.1→L1, §21.2→L2, §21.3→L3 (exact copy in-plan),
  §21.4→L1's helper move + both tasks' label policy + sensors named in
  L1/L2 steps. §21 item 1 pre-done (commit 9d29beb), not in this plan.
- Seam risk: L2 imports helpers L1 has not yet committed — mitigated by
  the controller's pre-edit in the shared working tree (both tasks build
  against the same files; only `git add` is partitioned).
- styles.css contention — resolved by controller pre-write + read-only
  rule; gaps flow to the gate, never cross-partition edits.

## Gate amendment (L4, from L1 review finding I1)

The pinned shortcut template gains one display case: when the two COMPARED
values round to the same int (raw detour > raw through — reachable in
~0.6% of deep-sequence verdicts on the real graph), both print with one
decimal (`through: 39.6s · best detour: 40.4s > 39.6s → shortcut added
(40s)`) so the page never asserts `40s > 40s`. Deci-second weights make a
real shortcut margin ≥ 0.1 s, so one decimal always separates them. The
trailing shortcut weight stays the rounded int (matches the curve label);
the witness template is unchanged (rounding is monotone — a displayed ≤
cannot read false). Pinned in contraction.test.ts.
