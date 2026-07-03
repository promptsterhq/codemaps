/**
 * Language-pluggable analysis. Adding a language must be *additive*, never a
 * rewrite — this is how we escape the "parser treadmill" that killed CodeSee and
 * Sourcetrail. Each analyzer is a thin tree-sitter (later LSP/SCIP) adapter that
 * emits nodes and edges into the shared graph.
 *
 * Phase 0 targets: typescript (dogfood) then python.
 */

import type { GraphEdge, GraphNode } from "./graph.js";

export interface ParsedFile {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface LanguageAnalyzer {
  /** e.g. "typescript". */
  readonly language: string;
  /** File extensions this analyzer claims, e.g. [".ts", ".tsx"]. */
  readonly extensions: readonly string[];
  /** Parse one file's source into graph fragments. Pure & incremental-friendly. */
  parse(path: string, source: string): ParsedFile;
}

/** Registry so the engine can dispatch a file to the right analyzer by extension. */
export class AnalyzerRegistry {
  private byExt = new Map<string, LanguageAnalyzer>();

  register(analyzer: LanguageAnalyzer): void {
    for (const ext of analyzer.extensions) this.byExt.set(ext, analyzer);
  }

  forPath(path: string): LanguageAnalyzer | undefined {
    const dot = path.lastIndexOf(".");
    if (dot < 0) return undefined;
    return this.byExt.get(path.slice(dot));
  }
}
