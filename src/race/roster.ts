// The algorithm roster — single source of truth for the racers and the
// bidirectional family modifier (spec §18, weighted A* removed by §20.2). Pure data: the worker derives its
// algo registry from workerKey/bidiKey, the panel builds its rows from the
// rest. Neither side edits this file during the roster round (contract-first,
// controller-owned); hue/glow values live in styles.css under the listed
// custom-property names, validated with the dataviz palette validator in
// this display order (spec §18's palette block).
export interface RosterEntry {
  id: "dijkstra" | "astar-straight" | "astar-greedy" | "ch";
  /** Display name — contract-exact; spec tests assert these strings. */
  name: string;
  family: "searchers" | "ch";
  /** Core racers are always on and carry no toggle affordance. */
  core: boolean;
  hueVar: string;
  glowVar: string;
  workerKey: string;
  /** Bidirectional form's worker key — searchers only (spec §18.6). */
  bidiKey?: string;
  /**
   * Exactness promise. When false, the racer may return a longer-than-
   * optimal route and its row MUST disclose "+X% longer route" live
   * (spec §18.4's honesty rule).
   */
  exact: boolean;
  /** One-line heuristic description shown while the row is enabled. */
  note?: string;
}

export const ROSTER: readonly RosterEntry[] = [
  {
    id: "dijkstra",
    name: "Dijkstra",
    family: "searchers",
    core: true,
    hueVar: "--c-dijkstra",
    glowVar: "--g-dijkstra",
    workerKey: "dijkstra",
    bidiKey: "bidi:dijkstra",
    exact: true,
  },
  {
    id: "astar-straight",
    name: "A* — straight line",
    family: "searchers",
    core: false,
    hueVar: "--c-astar",
    glowVar: "--g-astar",
    workerKey: "astar-straight",
    bidiKey: "bidi:astar-straight",
    exact: true,
    note: "guided by straight-line travel time (great-circle distance ÷ fastest road)",
  },
  {
    id: "astar-greedy",
    name: "A* — greedy (direction only)",
    family: "searchers",
    core: false,
    hueVar: "--c-astar-g",
    glowVar: "--g-astar-g",
    workerKey: "astar-greedy",
    bidiKey: "bidi:astar-greedy",
    exact: false,
    note: "chases the target's direction and ignores distance already travelled — fast, often wrong",
  },
  {
    id: "ch",
    name: "Contraction Hierarchies",
    family: "ch",
    core: true,
    hueVar: "--c-ch",
    glowVar: "--g-ch",
    workerKey: "ch",
    exact: true,
  },
] as const;
