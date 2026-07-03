/**
 * Query layer over the code graph — `impact` (reverse blast radius) and
 * `locate` (symbol/file search). Table-stakes lenses 2–3, kept thin.
 */

import type { GraphNode, NodeId } from "./graph.js";
import type { MutableGraph } from "./store.js";

const TEST_PATH = /(\.test\.|\.spec\.|__tests__\/|\/tests?\/)/;

export interface ImpactResult {
  target: GraphNode;
  directDependents: GraphNode[];
  transitiveDependents: GraphNode[];
  affectedTests: GraphNode[];
  provenance: "derived";
  confidence: number;
}

/**
 * Reverse blast radius: who depends on `target`, directly and transitively.
 * Traverses incoming call edges, then widens through file-level import edges
 * (a file importing the target's file may depend on it in ways calls miss).
 */
export function impact(graph: MutableGraph, targetId: NodeId): ImpactResult | null {
  const target = graph.nodes.get(targetId);
  if (!target) return null;

  const direct = new Set<NodeId>();
  for (const e of graph.incoming(targetId)) direct.add(e.from);

  // Widen via the target's file: importers of the file are potential dependents.
  const filePath = target.loc?.path ?? (target.kind === "file" ? target.name : undefined);
  if (filePath) {
    for (const e of graph.incoming(`file:${filePath}`)) {
      if (e.kind === "imports") direct.add(e.from);
    }
  }
  direct.delete(targetId);

  // Transitive closure over incoming calls/imports (BFS).
  const seen = new Set<NodeId>(direct);
  seen.add(targetId);
  const queue = [...direct];
  const transitive = new Set<NodeId>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const e of graph.incoming(id)) {
      if (seen.has(e.from)) continue;
      seen.add(e.from);
      transitive.add(e.from);
      queue.push(e.from);
    }
  }

  const resolve = (ids: Iterable<NodeId>): GraphNode[] =>
    [...ids].map((id) => graph.nodes.get(id)).filter((n): n is GraphNode => !!n);

  const directNodes = resolve(direct);
  const transitiveNodes = resolve(transitive);
  const affectedTests = [...directNodes, ...transitiveNodes].filter((n) =>
    TEST_PATH.test(n.loc?.path ?? n.name),
  );

  return {
    target,
    directDependents: directNodes,
    transitiveDependents: transitiveNodes,
    affectedTests,
    provenance: "derived",
    // Static call+import edges are precise but incomplete (dynamic dispatch,
    // string-based access, DI) — honest ceiling below 1.0.
    confidence: 0.8,
  };
}

export interface LocateHit {
  node: GraphNode;
  score: number;
}

/** Find symbols/files by (fuzzy-ish) name or path match, best first. */
export function locate(graph: MutableGraph, query: string, limit = 10): LocateHit[] {
  const q = query.toLowerCase();
  const hits: LocateHit[] = [];
  for (const node of graph.nodes.values()) {
    const name = node.name.toLowerCase();
    const p = (node.loc?.path ?? "").toLowerCase();
    let score = 0;
    if (name === q) score = 100;
    else if (name.startsWith(q)) score = 80;
    else if (name.includes(q)) score = 60;
    else if (p.includes(q)) score = 30;
    if (score > 0) {
      // Prefer symbols over files at equal score; shorter names are better matches.
      if (node.kind !== "file") score += 5;
      score -= Math.min(20, Math.abs(name.length - q.length));
      hits.push({ node, score });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Resolve a user-supplied symbol string ("createSession", "file.ts#fn", full id) to a node id. */
export function resolveTarget(graph: MutableGraph, input: string): NodeId | null {
  if (graph.nodes.has(input)) return input;
  const hits = locate(graph, input.includes("#") ? input.split("#").pop()! : input, 1);
  return hits[0]?.node.id ?? null;
}
