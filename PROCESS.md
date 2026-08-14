# Process overview

## What I built

*Highway to Hill* (titled *Shortcut City* at design time; renamed at the
design review) — an interactive explainer of Contraction Hierarchies that
races CH against Dijkstra on Canberra's real OSM road network: feel the
speedup on page one, understand where it comes from (contraction, shortcuts,
node ordering, the upward query) on page two. As of this entry the project is
at the **design stage**: a full design spec and an annotated interactive
mockup are committed before any implementation. This overview grows as the
build lands.

## The moments that mattered

1. **Design before code, against the real brief.** The obvious move was to
   start building the map demo immediately. Instead the session pulled the
   published assignment-1 brief and the course deliverable API, and wrote the
   design against their checkable lines — the core-interaction sentence, both
   marking viewports, "one strong idea", and scope tiers sized to the Monday
   cutoff — with a traceability table mapping each brief line to a planned
   check. How I knew it was right: the mockup ships as a real page and
   `pnpm check` stayed green under the template's invariants at both
   viewports, before a line of product code exists.
   [`9ad58dc`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-rangermix/commit/9ad58dc)

2. **The palette I picked by eye failed the machine.** The hand-chosen
   algorithm hues looked fine but failed the dataviz palette validator on the
   dark surface: outside the lightness band, and a rose↔violet adjacent pair
   below the normal-vision floor (ΔE 13.1). Instead of nudging hexes by eye
   until they "looked distinct", the fix was to snap to the validator's
   reference dark steps and re-order the roster so no confusable pair sits
   adjacent (worst adjacent pair now ΔE 15.9 under protanopia, all checks
   pass) — and then to land the resulting tokens in `CLAUDE.md` as a rule
   ("don't invent hues"), so the correction lives in the harness rather than
   in a prompt.
   [`9ad58dc`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-rangermix/commit/9ad58dc)

## Where to look

- `docs/superpowers/specs/2026-08-14-ch-explainer-design.md` — the design:
  page-by-page functionality, user journey at both viewports, assumptions,
  scope tiers, planned sensors, risks.
- `docs/mockup/` — the annotated mockup, shipped as a page so it renders
  where the marker reads.
