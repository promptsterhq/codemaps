/**
 * Thin Ruby indexer — same architecture and honesty rules as Python/Go/JVM:
 * WASM tree-sitter, file + symbol nodes, import edges, call edges by
 * conservative name-matching (exactly ONE repo symbol or skip).
 *
 * Ruby specifics:
 *  - classes/modules nest; methods register as Class.method + bare alias
 *  - `def self.x` (singleton_method) registers like an ordinary method
 *  - requires: require_relative resolves against the file's dir; require
 *    resolves against lib/ and the repo root (the two conventional load
 *    paths) — anything else (gems, stdlib) is skipped, never guessed
 *  - only explicit `call` nodes are considered; Ruby's paren-less bare
 *    invocations parse as plain identifiers and are too ambiguous to claim
 */

import { readFile } from "node:fs/promises";
import { accessSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { GraphEdge, GraphNode, NodeId } from "./graph.js";
import { listRepoFiles } from "./files.js";

const require = createRequire(import.meta.url);

export interface RubyIndexResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  fileCount: number;
}

type TSNode = import("web-tree-sitter").SyntaxNode;

export async function indexRuby(repoRoot: string): Promise<RubyIndexResult> {
  const relFiles = (await listRepoFiles(repoRoot)).filter((f) => f.endsWith(".rb"));
  if (relFiles.length === 0) return { nodes: [], edges: [], fileCount: 0 };

  const Parser = (await import("web-tree-sitter")).default;
  await Parser.init();
  const lang = await Parser.Language.load(require.resolve("tree-sitter-wasms/out/tree-sitter-ruby.wasm"));
  const parser = new Parser();
  parser.setLanguage(lang);

  const fileId = (rel: string): NodeId => `file:${rel}`;
  const symbolId = (rel: string, name: string): NodeId => `rb:${rel}#${name}`;

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const byName = new Map<string, NodeId[]>();
  const trees: { rel: string; tree: import("web-tree-sitter").Tree; source: string }[] = [];

  // Pass 1: files + symbols.
  for (const rel of relFiles) {
    let source: string;
    try {
      source = await readFile(path.join(repoRoot, rel), "utf8");
    } catch {
      continue;
    }
    const tree = parser.parse(source);
    trees.push({ rel, tree, source });
    nodes.push({ id: fileId(rel), kind: "file", name: rel, language: "ruby" });

    const addSymbol = (name: string, kind: GraphNode["kind"], node: TSNode, alias?: string): void => {
      const id = symbolId(rel, name);
      nodes.push({
        id,
        kind,
        name,
        language: "ruby",
        loc: { path: rel, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
        signature: source.slice(node.startIndex, node.startIndex + 120).split("\n", 1)[0],
      });
      push(byName, name, id);
      if (alias) push(byName, alias, id);
    };

    const walk = (node: TSNode, scope?: string): void => {
      if (node.type === "class" || node.type === "module") {
        const name = node.childForFieldName("name")?.text;
        if (name) {
          const qualified = scope ? `${scope}::${name}` : name;
          addSymbol(qualified, node.type === "module" ? "module" : "class", node, scope ? name : undefined);
          for (const child of node.namedChildren) walk(child, qualified);
          return;
        }
      }
      if (node.type === "method" || node.type === "singleton_method") {
        const name = node.childForFieldName("name")?.text;
        if (name) {
          const qualified = scope ? `${scope}.${name}` : name;
          addSymbol(qualified, scope ? "method" : "function", node, scope ? name : undefined);
        }
      }
      for (const child of node.namedChildren) walk(child, scope);
    };
    walk(tree.rootNode);
  }

  // Pass 2: require + call edges.
  for (const { rel, tree } of trees) {
    const fromFile = fileId(rel);

    const walk = (node: TSNode): void => {
      if (node.type === "call") {
        const methodName = node.childForFieldName("method")?.text;
        const argNode = node.childForFieldName("arguments")?.namedChildren.find((c) => c.type === "string");
        const arg = argNode?.text.replace(/^['"]|['"]$/g, "");

        if ((methodName === "require" || methodName === "require_relative") && arg) {
          const target = resolveRequire(repoRoot, rel, methodName, arg);
          if (target) edges.push({ from: fromFile, to: fileId(target), kind: "imports" });
        } else if (methodName) {
          const candidates = byName.get(methodName) ?? [];
          if (candidates.length === 1 && candidates[0] !== fromFile) {
            edges.push({ from: fromFile, to: candidates[0]!, kind: "calls" });
          }
        }
      }
      for (const child of node.namedChildren) walk(child);
    };
    walk(tree.rootNode);
  }

  return { nodes, edges, fileCount: relFiles.length };
}

/** require_relative "x" -> sibling; require "x/y" -> lib/x/y.rb or x/y.rb. */
function resolveRequire(repoRoot: string, fromRel: string, kind: string, arg: string): string | null {
  const candidates =
    kind === "require_relative"
      ? [path.posix.join(path.posix.dirname(fromRel), `${arg}.rb`)]
      : [`lib/${arg}.rb`, `${arg}.rb`];
  for (const rel of candidates) {
    try {
      accessSync(path.join(repoRoot, rel));
      return rel;
    } catch {
      /* try next */
    }
  }
  return null;
}

function push(map: Map<string, NodeId[]>, key: string, id: NodeId): void {
  const list = map.get(key) ?? [];
  list.push(id);
  map.set(key, list);
}
