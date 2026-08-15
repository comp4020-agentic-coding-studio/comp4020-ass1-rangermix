# Process overview

## What I built

*Highway to Hill* — an interactive explainer of Contraction Hierarchies that
races CH against Dijkstra (and, once you switch them on, A\* and
bidirectional Dijkstra) on Canberra's real OSM road network. Page one makes
you feel the speedup: drop two pins, watch the flood versus the sparks, read
numbers measured in your own browser. Page two explains where the speed
comes from with five toys that run the same algorithm code as the race.
Built design-first: spec and annotated mockup, then a task-by-task plan
executed with fresh implementer subagents and a reviewer gate per task
(ledger of every round in the commit trail).

![The race at 1920 dark: Dijkstra's flood vs CH's sparks](docs/evidence/race-final-1920-dark.png)

## The moments that mattered

1. **The palette I picked by eye failed the machine.** My hand-chosen
   algorithm hues looked fine but failed the dataviz palette validator
   (rose↔violet ΔE 13.1, below the normal-vision floor). Instead of nudging
   hexes until they "looked distinct", I snapped to validated steps,
   re-ordered the roster so no confusable pair sits adjacent, and wrote the
   rule into `CLAUDE.md` ("don't invent hues") so no later session could
   reinvent them — the correction landed in the harness, not in a prompt.
   [`9ad58dc`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-rangermix/commit/9ad58dc)

2. **Real data broke code the fixtures had blessed.** The pipeline's chain
   contraction passed 43 fixture tests, then crashed on the real extract:
   470 unbranched roundabouts produce self-loop edges no fixture modelled —
   and beyond the crash it would have silently mis-weighted routes. The fix
   was red-green verified (guard reverted → identical crash reproduced →
   restored) and the reviewer re-reproduced it independently before the
   task closed.
   [`d82d677...60fae72`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-rangermix/compare/d82d677...60fae72)

3. **The wall-time tile undersold the whole thesis — the fix was proven
   byte-identical.** A cold run showed "3.6 ms vs 2.7 ms" beside "13,249 vs
   238 settled": per-query allocation (~1.3 MB) was drowning CH's real cost
   in GC noise. Persistent scratch buffers fixed it (CH 0.3–0.6 ms vs
   Dijkstra 1.8–2.9 ms across five races, zero inversions) — and the
   regenerated benchmark in `meta.json` came out byte-identical, proving
   the refactor changed nothing semantically. Same commit, same standard:
   the hierarchy slider's "top 2%" label turned out to retain 0.025% of
   roads; it now computes percentiles from the loaded data every mount.
   [`3844dc0`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-rangermix/commit/3844dc0)

4. **Exactness over drama.** The final review measured a 153 km/h
   quantization artifact in the graph, which made A\*'s 100 km/h heuristic
   ceiling inadmissible in principle — the site could have shown a wrong
   route no one would ever notice. The ceiling is now derived from the
   data at load (max observed edge speed × margin), guarded by a test that
   re-scans every edge; A\* settles more nodes than before and the site is
   slightly less dramatic, and correct.
   [`2b41314...07120d9`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-rangermix/compare/2b41314...07120d9)

## Where to look

- `docs/superpowers/specs/2026-08-14-ch-explainer-design.md` — the approved
  spec; its checkable lines live as tests in `spec/highway-to-hill.test.ts`
  (written as todos before the code existed, flipped live task by task).
- `docs/superpowers/plans/2026-08-14-highway-to-hill.md` — the plan the
  subagents executed.
- `docs/evidence/` — verification screenshots (both viewports, both themes,
  the four-racer board, the hierarchy reveal).
- `docs/mockup/` — the pre-implementation annotated mockup, kept deployed.
