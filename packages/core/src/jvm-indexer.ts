/**
 * Thin JVM indexers — Java + Kotlin, one file because they share import
 * semantics (dotted packages) and source-tree conventions. Same architecture
 * and honesty rules as the Python/Go indexers: WASM tree-sitter (both
 * grammars ship in tree-sitter-wasms), file + symbol nodes, import edges,
 * call edges by conservative name-matching (exactly ONE repo symbol or skip).
 *
 * Import resolution is suffix-based: "com.acme.Store" matches any repo file
 * ending com/acme/Store.java|kt regardless of source root (src/main/java,
 * src/, ...). Wildcard imports edge to every file in the package directory.
 * Unresolved imports (JDK, external deps) are skipped, never guessed.
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { GraphEdge, GraphNode, NodeId } from "./graph.js";
import { listRepoFiles } from "./files.js";

const require = createRequire(import.meta.url);

export interface JvmIndexResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  fileCount: number;
}

type TSNode = import("web-tree-sitter").SyntaxNode;

export async function indexJava(repoRoot: string): Promise<JvmIndexResult> {
  return indexJvm(repoRoot, {
    language: "java",
    ext: ".java",
    wasm: "tree-sitter-java.wasm",
    typeDecls: ["class_declaration", "interface_declaration", "enum_declaration", "record_declaration"],
    memberDecls: ["method_declaration", "constructor_declaration"],
    typeName: (n) => n.childForFieldName("name")?.text ?? null,
    memberName: (n) => n.childForFieldName("name")?.text ?? null,
    importPath: (n) => {
      if (n.type !== "import_declaration") return null;
      const dotted = n.namedChildren.find((c) => c.type === "scoped_identifier" || c.type === "identifier")?.text;
      if (!dotted) return null;
      return { dotted, wildcard: n.children.some((c) => c.type === "asterisk") };
    },
    callName: (n) => {
      if (n.type === "method_invocation") return n.childForFieldName("name")?.text ?? null;
      if (n.type === "object_creation_expression") {
        const t = n.childForFieldName("type");
        return t?.type === "type_identifier" ? t.text : null; // new Store() -> Store
      }
      return null;
    },
  });
}

export async function indexKotlin(repoRoot: string): Promise<JvmIndexResult> {
  return indexJvm(repoRoot, {
    language: "kotlin",
    ext: ".kt",
    wasm: "tree-sitter-kotlin.wasm",
    typeDecls: ["class_declaration", "object_declaration"],
    memberDecls: ["function_declaration"],
    // tree-sitter-kotlin has thinner field support — find identifiers positionally.
    typeName: (n) => n.namedChildren.find((c) => c.type === "type_identifier" || c.type === "simple_identifier")?.text ?? null,
    memberName: (n) => n.namedChildren.find((c) => c.type === "simple_identifier")?.text ?? null,
    importPath: (n) => {
      if (n.type !== "import_header") return null;
      const dotted = n.namedChildren.find((c) => c.type === "identifier")?.text;
      if (!dotted) return null;
      return { dotted, wildcard: n.text.includes(".*") };
    },
    callName: (n) => {
      if (n.type !== "call_expression") return null;
      const callee = n.namedChildren[0];
      if (!callee) return null;
      if (callee.type === "simple_identifier") return callee.text;
      if (callee.type === "navigation_expression") {
        // last .segment before the arguments: obj.save() -> save
        const ids = callee.descendantsOfType("simple_identifier");
        return ids[ids.length - 1]?.text ?? null;
      }
      return null;
    },
  });
}

interface JvmLang {
  language: string;
  ext: string;
  wasm: string;
  typeDecls: string[];
  memberDecls: string[];
  typeName: (n: TSNode) => string | null;
  memberName: (n: TSNode) => string | null;
  importPath: (n: TSNode) => { dotted: string; wildcard: boolean } | null;
  callName: (n: TSNode) => string | null;
}

async function indexJvm(repoRoot: string, lang: JvmLang): Promise<JvmIndexResult> {
  const allFiles = await listRepoFiles(repoRoot);
  const relFiles = allFiles.filter((f) => f.endsWith(lang.ext));
  if (relFiles.length === 0) return { nodes: [], edges: [], fileCount: 0 };

  const Parser = (await import("web-tree-sitter")).default;
  await Parser.init();
  const grammar = await Parser.Language.load(require.resolve(`tree-sitter-wasms/out/${lang.wasm}`));
  const parser = new Parser();
  parser.setLanguage(grammar);

  const fileId = (rel: string): NodeId => `file:${rel}`;
  const symbolId = (rel: string, name: string): NodeId => `${lang.language === "java" ? "java" : "kt"}:${rel}#${name}`;

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
    nodes.push({ id: fileId(rel), kind: "file", name: rel, language: lang.language });

    const addSymbol = (name: string, kind: GraphNode["kind"], node: TSNode, alias?: string): void => {
      const id = symbolId(rel, name);
      nodes.push({
        id,
        kind,
        name,
        language: lang.language,
        loc: { path: rel, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
        signature: source.slice(node.startIndex, node.startIndex + 120).split("\n", 1)[0],
      });
      push(byName, name, id);
      if (alias) push(byName, alias, id);
    };

    const walk = (node: TSNode, className?: string): void => {
      if (lang.typeDecls.includes(node.type)) {
        const name = lang.typeName(node);
        if (name) {
          addSymbol(name, node.type === "interface_declaration" ? "interface" : "class", node);
          for (const child of node.namedChildren) walk(child, name);
          return;
        }
      }
      if (lang.memberDecls.includes(node.type)) {
        const name = lang.memberName(node);
        if (name) {
          const qualified = className ? `${className}.${name}` : name;
          // Constructors (name === class) must not alias the bare name — it
          // would collide with the class symbol and ambiguity-skip `new X()`.
          const alias = className && name !== className ? name : undefined;
          addSymbol(qualified, className ? "method" : "function", node, alias);
        }
      }
      for (const child of node.namedChildren) walk(child, className);
    };
    walk(tree.rootNode);
  }

  // Suffix index for import resolution: "com/acme/Store.java" endings.
  const jvmFiles = allFiles.filter((f) => f.endsWith(".java") || f.endsWith(".kt"));

  // Pass 2: import + call edges.
  for (const { rel, tree } of trees) {
    const fromFile = fileId(rel);

    const walk = (node: TSNode): void => {
      const imp = lang.importPath(node);
      if (imp) {
        const slashed = imp.dotted.replace(/\./g, "/");
        if (imp.wildcard) {
          for (const target of jvmFiles) {
            if (target !== rel && path.posix.dirname(target).endsWith(slashed)) {
              edges.push({ from: fromFile, to: fileId(target), kind: "imports" });
            }
          }
        } else {
          const target = jvmFiles.find(
            (f) => f !== rel && (f.endsWith(`${slashed}.java`) || f.endsWith(`${slashed}.kt`)),
          );
          if (target) edges.push({ from: fromFile, to: fileId(target), kind: "imports" });
        }
      }

      const callee = lang.callName(node);
      if (callee) {
        const candidates = byName.get(callee) ?? [];
        if (candidates.length === 1 && candidates[0] !== fromFile) {
          edges.push({ from: fromFile, to: candidates[0]!, kind: "calls" });
        }
      }
      for (const child of node.namedChildren) walk(child);
    };
    walk(tree.rootNode);
  }

  return { nodes, edges, fileCount: relFiles.length };
}

function push(map: Map<string, NodeId[]>, key: string, id: NodeId): void {
  const list = map.get(key) ?? [];
  list.push(id);
  map.set(key, list);
}
