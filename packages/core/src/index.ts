/**
 * @codemaps/core — the context engine.
 *
 * Public surface: the code graph model, the six lenses, and the pluggable
 * language-analysis layer. Concrete graph construction (tree-sitter),
 * git-history mining, and SQLite persistence land next in Phase 0.
 */

export * from "./graph.js";
export * from "./lenses.js";
export * from "./analyzer.js";
export * from "./store.js";
export * from "./risk.js";
export * from "./guardrails.js";
export * from "./ts-indexer.js";
export * from "./py-indexer.js";
export * from "./repo-indexer.js";
export * from "./query.js";
export * from "./agents-md.js";
export * from "./codemap-store.js";
export * from "./security.js";
export * from "./files.js";
export * from "./orient.js";
export * from "./check.js";
export * from "./contracts.js";

export const CODEMAPS_CORE_VERSION = "0.0.0";
