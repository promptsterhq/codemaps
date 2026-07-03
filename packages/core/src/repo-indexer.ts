/**
 * Combined repo indexer — runs every language analyzer and merges into one
 * graph. Adding a language stays additive (VISION principle 8).
 */

import { MutableGraph } from "./store.js";
import { indexTypeScript } from "./ts-indexer.js";
import { indexPython } from "./py-indexer.js";

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

  // Python (WASM tree-sitter) — merged into the same graph.
  const py = await indexPython(repoRoot);
  if (py.fileCount > 0) {
    languages.push("python");
    fileCount += py.fileCount;
    for (const n of py.nodes) {
      graph.addNode(n);
      if (n.kind !== "file") symbolCount++;
    }
    for (const e of py.edges) graph.addEdge(e);
  }

  return { graph, fileCount, symbolCount, edgeCount: graph.edgeCount, languages };
}
