/**
 * Thin Go indexer — Tier-2 language expansion. Same architecture and honesty
 * rules as the Python indexer: WASM tree-sitter (grammar already ships in
 * tree-sitter-wasms), file + symbol nodes, import edges, call edges by
 * conservative name-matching (a call edge is added only when the name
 * resolves to exactly ONE repo symbol — ambiguity means skip).
 *
 * Go-specific shapes:
 *  - methods carry receivers: `func (s *Store) Save()` -> symbol "Store.Save"
 *  - imports are module paths — resolved against go.mod's module line to a
 *    repo directory, then edged to every .go file in that package dir
 *    (a Go import imports the package, not a file)
 *  - vendor/ is skipped (committed dependencies, not the repo's own surface)
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { GraphEdge, GraphNode, NodeId } from "./graph.js";
import { listRepoFiles } from "./files.js";

const require = createRequire(import.meta.url);

export interface GoIndexResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  fileCount: number;
}

export async function indexGo(repoRoot: string): Promise<GoIndexResult> {
  const relFiles = (await listRepoFiles(repoRoot)).filter(
    (f) => f.endsWith(".go") && !f.startsWith("vendor/") && !f.includes("/vendor/"),
  );
  if (relFiles.length === 0) return { nodes: [], edges: [], fileCount: 0 };

  // Lazy-load the WASM runtime only when a repo actually has Go.
  const Parser = (await import("web-tree-sitter")).default;
  await Parser.init();
  const lang = await Parser.Language.load(require.resolve("tree-sitter-wasms/out/tree-sitter-go.wasm"));
  const parser = new Parser();
  parser.setLanguage(lang);

  const moduleName = await readModuleName(repoRoot);
  // package dir -> files in it (for import -> package edges).
  const filesByDir = new Map<string, string[]>();
  for (const f of relFiles) {
    const dir = path.posix.dirname(f);
    const list = filesByDir.get(dir) ?? [];
    list.push(f);
    filesByDir.set(dir, list);
  }

  const fileId = (rel: string): NodeId => `file:${rel}`;
  const symbolId = (rel: string, name: string): NodeId => `go:${rel}#${name}`;

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
    nodes.push({ id: fileId(rel), kind: "file", name: rel, language: "go" });

    const addSymbol = (name: string, kind: GraphNode["kind"], node: import("web-tree-sitter").SyntaxNode, alias?: string): void => {
      const id = symbolId(rel, name);
      nodes.push({
        id,
        kind,
        name,
        language: "go",
        loc: { path: rel, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
        signature: source.slice(node.startIndex, node.startIndex + 120).split("\n", 1)[0],
      });
      push(byName, name, id);
      if (alias) push(byName, alias, id);
    };

    for (const node of tree.rootNode.namedChildren) {
      if (node.type === "function_declaration") {
        const name = node.childForFieldName("name")?.text;
        if (name) addSymbol(name, "function", node);
      } else if (node.type === "method_declaration") {
        const name = node.childForFieldName("name")?.text;
        const recv = receiverTypeName(node);
        if (name) {
          if (recv) addSymbol(`${recv}.${name}`, "method", node, name);
          else addSymbol(name, "method", node);
        }
      } else if (node.type === "type_declaration") {
        for (const spec of node.namedChildren.filter((c) => c.type === "type_spec")) {
          const name = spec.childForFieldName("name")?.text;
          const t = spec.childForFieldName("type")?.type;
          if (name) addSymbol(name, t === "interface_type" ? "interface" : "class", spec);
        }
      }
    }
  }

  // Pass 2: import + call edges.
  for (const { rel, tree } of trees) {
    const fromFile = fileId(rel);

    const walk = (node: import("web-tree-sitter").SyntaxNode): void => {
      if (node.type === "import_spec") {
        const raw = node.childForFieldName("path")?.text ?? node.namedChildren.find((c) => c.type === "interpreted_string_literal")?.text;
        const importPath = raw?.replace(/^"|"$/g, "");
        if (importPath && moduleName) {
          const dir = resolvePackageDir(moduleName, importPath);
          if (dir !== null) {
            for (const target of filesByDir.get(dir) ?? []) {
              if (target !== rel) edges.push({ from: fromFile, to: fileId(target), kind: "imports" });
            }
          }
        }
      }

      // call: name(...) or pkg.Fn(...) / recv.Method(...) — conservative.
      if (node.type === "call_expression") {
        const fn = node.childForFieldName("function");
        if (fn) {
          const name = fn.type === "selector_expression" ? fn.childForFieldName("field")?.text : fn.text;
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

  return { nodes, edges, fileCount: relFiles.length };
}

/** `func (s *Store) Save()` -> "Store" (pointer or value receiver). */
function receiverTypeName(method: import("web-tree-sitter").SyntaxNode): string | null {
  const recv = method.childForFieldName("receiver");
  if (!recv) return null;
  const param = recv.namedChildren.find((c) => c.type === "parameter_declaration");
  const t = param?.childForFieldName("type");
  if (!t) return null;
  if (t.type === "pointer_type") return t.namedChildren[0]?.text ?? null;
  return t.text || null;
}

/** "mod/x/y" -> "x/y" when it's inside this module; null for external deps. */
function resolvePackageDir(moduleName: string, importPath: string): string | null {
  if (importPath === moduleName) return ".";
  if (importPath.startsWith(`${moduleName}/`)) return importPath.slice(moduleName.length + 1);
  return null;
}

async function readModuleName(repoRoot: string): Promise<string | null> {
  try {
    const gomod = await readFile(path.join(repoRoot, "go.mod"), "utf8");
    return gomod.match(/^module\s+(\S+)/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

function push(map: Map<string, NodeId[]>, key: string, id: NodeId): void {
  const list = map.get(key) ?? [];
  list.push(id);
  map.set(key, list);
}
