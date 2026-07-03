/**
 * Thin Python indexer — Phase 1. WASM tree-sitter (no native compilation):
 * web-tree-sitter 0.24 + prebuilt grammars from tree-sitter-wasms.
 *
 * Same "thin is the goal" rule as the TS indexer: file + symbol nodes,
 * import edges (module-path resolution), call edges by conservative
 * name-matching — a call edge is only added when the name resolves to exactly
 * ONE repo symbol (ambiguity -> skip). Python without type inference is
 * heuristic; we keep precision over recall and stay honest about it.
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { GraphEdge, GraphNode, NodeId } from "./graph.js";
import { listRepoFiles } from "./files.js";

const require = createRequire(import.meta.url);

export interface PyIndexResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  fileCount: number;
}

export async function indexPython(repoRoot: string): Promise<PyIndexResult> {
  const files = await collectPyFiles(repoRoot);
  if (files.length === 0) return { nodes: [], edges: [], fileCount: 0 };

  // Lazy-load the WASM runtime only when a repo actually has Python.
  const Parser = (await import("web-tree-sitter")).default;
  await Parser.init();
  const lang = await Parser.Language.load(require.resolve("tree-sitter-wasms/out/tree-sitter-python.wasm"));
  const parser = new Parser();
  parser.setLanguage(lang);

  const rel = (abs: string): string => path.relative(repoRoot, abs).replace(/\\/g, "/");
  const fileId = (abs: string): NodeId => `file:${rel(abs)}`;
  const symbolId = (abs: string, name: string): NodeId => `py:${rel(abs)}#${name}`;

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  // name -> symbol ids across the repo (for conservative call resolution).
  const byName = new Map<string, NodeId[]>();
  // per-file parse products we need for pass 2.
  const trees: { abs: string; tree: import("web-tree-sitter").Tree; source: string }[] = [];

  // Pass 1: files + symbols.
  for (const abs of files) {
    let source: string;
    try {
      source = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    const tree = parser.parse(source);
    trees.push({ abs, tree, source });
    nodes.push({ id: fileId(abs), kind: "file", name: rel(abs), language: "python" });

    const walk = (node: import("web-tree-sitter").SyntaxNode, className?: string): void => {
      if (node.type === "function_definition" || node.type === "class_definition") {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          const name = nameNode.text;
          const kind =
            node.type === "class_definition" ? "class" : className ? "method" : "function";
          const id = symbolId(abs, className ? `${className}.${name}` : name);
          nodes.push({
            id,
            kind,
            name: className ? `${className}.${name}` : name,
            language: "python",
            loc: { path: rel(abs), startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
            signature: source.slice(node.startIndex, node.startIndex + 120).split("\n", 1)[0],
          });
          // Register both qualified and bare method names for call matching.
          push(byName, name, id);
          if (className) push(byName, `${className}.${name}`, id);
          if (node.type === "class_definition") {
            for (const child of node.namedChildren) walk(child, name);
            return;
          }
        }
      }
      for (const child of node.namedChildren) walk(child, className);
    };
    walk(tree.rootNode);
  }

  // Pass 2: import + call edges.
  for (const { abs, tree } of trees) {
    const fromFile = fileId(abs);

    const walk = (node: import("web-tree-sitter").SyntaxNode): void => {
      // import a.b.c  |  from a.b import c  (incl. relative "from . import x")
      if (node.type === "import_statement" || node.type === "import_from_statement") {
        const moduleNode =
          node.childForFieldName("module_name") ??
          node.namedChildren.find((c) => c.type === "dotted_name" || c.type === "relative_import");
        if (moduleNode) {
          const target = resolveModule(repoRoot, abs, moduleNode.text);
          if (target) edges.push({ from: fromFile, to: `file:${rel(target)}`, kind: "imports" });
        }
      }

      // call: identifier(...) or obj.method(...) — conservative name matching.
      if (node.type === "call") {
        const fn = node.childForFieldName("function");
        if (fn) {
          const name = fn.type === "attribute" ? fn.childForFieldName("attribute")?.text : fn.text;
          if (name) {
            const candidates = byName.get(name) ?? [];
            if (candidates.length === 1 && candidates[0] !== fromFile) {
              edges.push({ from: fromFile, to: candidates[0]!, kind: "calls" });
            }
          }
        }
      }
      for (const child of node.namedChildren) walk(child);
    };
    walk(tree.rootNode);
  }

  return { nodes, edges, fileCount: files.length };
}

function push(map: Map<string, NodeId[]>, key: string, id: NodeId): void {
  const list = map.get(key) ?? [];
  list.push(id);
  map.set(key, list);
}

/** Resolve "a.b.c" / ".sibling" to a repo file (a/b/c.py or a/b/c/__init__.py). */
function resolveModule(repoRoot: string, importerAbs: string, moduleText: string): string | null {
  const dots = moduleText.match(/^\.+/)?.[0].length ?? 0;
  const parts = moduleText.replace(/^\.+/, "").split(".").filter(Boolean);
  const bases: string[] = [];
  if (dots > 0) {
    // Relative: climb (dots - 1) dirs from the importing file's directory.
    let base = path.dirname(importerAbs);
    for (let i = 1; i < dots; i++) base = path.dirname(base);
    bases.push(base);
  } else {
    bases.push(repoRoot);
    // Common src-layout roots.
    bases.push(path.join(repoRoot, "src"));
  }
  for (const base of bases) {
    const stem = path.join(base, ...parts);
    for (const candidate of [`${stem}.py`, path.join(stem, "__init__.py")]) {
      try {
        // readFileSync-free existence check is async elsewhere; keep it simple:
        require("node:fs").accessSync(candidate);
        return candidate;
      } catch {
        /* try next */
      }
    }
  }
  return null;
}

async function collectPyFiles(repoRoot: string): Promise<string[]> {
  // gitignore-respecting enumeration; absolute paths for parsing.
  const files = await listRepoFiles(repoRoot);
  return files.filter((f) => f.endsWith(".py")).map((f) => path.join(repoRoot, f));
}
