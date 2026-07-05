/**
 * Combined repo indexer — runs every language analyzer and merges into one
 * graph. Adding a language stays additive (VISION principle 8).
 */

import { MutableGraph } from "./store.js";
import { indexTypeScript } from "./ts-indexer.js";
import { indexPython } from "./py-indexer.js";
import { indexGo } from "./go-indexer.js";

export interface RepoIndexResult {
  graph: MutableGraph;
  fileCount: number;
  symbolCount: number;
  edgeCount: number;
  languages: string[];
}

export async function indexRepo(repoRoot: string): Promise<RepoIndexResult> {
  const languages: string[] = [];

  // TypeScript/JavaScript (compiler API).
  const ts = await indexTypeScript(repoRoot);
  const graph = ts.graph;
  let fileCount = ts.fileCount;
  let symbolCount = ts.symbolCount;
  if (ts.fileCount > 0) languages.push("typescript");

  // Python + Go (WASM tree-sitter) — merged into the same graph.
  for (const [name, index] of [
    ["python", indexPython],
    ["go", indexGo],
  ] as const) {
    const result = await index(repoRoot);
    if (result.fileCount === 0) continue;
    languages.push(name);
    fileCount += result.fileCount;
    for (const n of result.nodes) {
      graph.addNode(n);
      if (n.kind !== "file") symbolCount++;
    }
    for (const e of result.edges) graph.addEdge(e);
  }

  return { graph, fileCount, symbolCount, edgeCount: graph.edgeCount, languages };
}
