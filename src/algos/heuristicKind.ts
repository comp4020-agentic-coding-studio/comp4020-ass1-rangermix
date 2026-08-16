// Explicit mapping from astar id to HeuristicKind, fail-loud on unknown ids.
export type HeuristicKindId = "astar-straight" | "astar-weighted" | "astar-greedy";

export function getHeuristicKind(id: string): "straight" | "weighted" | "greedy" {
  switch (id) {
    case "astar-straight":
      return "straight";
    case "astar-weighted":
      return "weighted";
    case "astar-greedy":
      return "greedy";
    default:
      throw new Error(`Unknown astar id: ${id}`);
  }
}
