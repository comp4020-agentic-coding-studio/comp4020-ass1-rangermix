// Explicit mapping from astar id to HeuristicKind, fail-loud on unknown ids.
// (spec §20.2: astar-weighted removed from the roster — only the two
// remaining astar ids map here now.)
export type HeuristicKindId = "astar-straight" | "astar-greedy";

export function getHeuristicKind(id: string): "straight" | "greedy" {
  switch (id) {
    case "astar-straight":
      return "straight";
    case "astar-greedy":
      return "greedy";
    default:
      throw new Error(`Unknown astar id: ${id}`);
  }
}
