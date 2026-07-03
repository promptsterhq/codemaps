/**
 * Thin TypeScript indexer — Phase 0 step 3 (VISION §7: built LAST, kept thin).
 *
 * Uses the TS compiler API (zero native deps) for precise symbol resolution:
 * file + symbol nodes, import + call edges, into MutableGraph. This is
 * adoption table-stakes (`impact`/`locate`), NOT the moat — deliberately
 * minimal. tree-sitter/Python and deeper semantics are Phase 1.
 */

import ts from "typescript";
import path from "node:path";
import type { GraphNode, NodeId } from "./graph.js";
import { MutableGraph } from "./store.js";
import { listRepoFiles } from "./files.js";

export interface IndexResult {
  graph: MutableGraph;
  fileCount: number;
  symbolCount: number;
  edgeCount: number;
}

export async function indexTypeScript(repoRoot: string): Promise<IndexResult> {
  const files = await collectTsFiles(repoRoot);
  const program = ts.createProgram(files, {
    allowJs: true,
    checkJs: false,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const graph = new MutableGraph();

  const rel = (abs: string): string => path.relative(repoRoot, abs).replace(/\\/g, "/");
  const inRepo = (abs: string): boolean => !abs.includes("node_modules") && !path.relative(repoRoot, abs).startsWith("..");

  const fileId = (absPath: string): NodeId => `file:${rel(absPath)}`;
  const symbolId = (absPath: string, name: string): NodeId => `ts:${rel(absPath)}#${name}`;

  let symbolCount = 0;

  // Pass 1: file nodes + declared symbols.
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !inRepo(sf.fileName)) continue;
    graph.addNode({ id: fileId(sf.fileName), kind: "file", name: rel(sf.fileName), language: "typescript" });

    const visit = (node: ts.Node): void => {
      const decl = declarationInfo(node, sf);
      if (decl) {
        graph.addNode({
          id: symbolId(sf.fileName, decl.name),
          kind: decl.kind,
          name: decl.name,
          language: "typescript",
          loc: { path: rel(sf.fileName), startLine: decl.startLine, endLine: decl.endLine },
          signature: decl.signature,
        });
        symbolCount++;
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }

  // Pass 2: import edges + call/reference edges.
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !inRepo(sf.fileName)) continue;
    const fromFile = fileId(sf.fileName);

    const visit = (node: ts.Node): void => {
      // import ... from "spec"
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const spec = node.moduleSpecifier;
        if (spec && ts.isStringLiteral(spec)) {
          const resolved = ts.resolveModuleName(spec.text, sf.fileName, program.getCompilerOptions(), ts.sys);
          const target = resolved.resolvedModule?.resolvedFileName;
          if (target && inRepo(target)) {
            graph.addEdge({ from: fromFile, to: fileId(target), kind: "imports" });
          }
        }
      }

      // call expressions -> resolve callee declaration
      if (ts.isCallExpression(node)) {
        const calleeSym = resolveSymbol(checker, node.expression);
        const decl = calleeSym?.declarations?.[0];
        const declFile = decl?.getSourceFile();
        if (decl && declFile && inRepo(declFile.fileName) && !declFile.isDeclarationFile) {
          const calleeName = calleeSym!.getName();
          const to = symbolId(declFile.fileName, calleeName);
          if (graph.nodes.has(to)) {
            const from = enclosingSymbolId(node, sf, symbolId) ?? fromFile;
            if (from !== to) graph.addEdge({ from, to, kind: "calls" });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }

  return { graph, fileCount: files.length, symbolCount, edgeCount: graph.edgeCount };
}

function resolveSymbol(checker: ts.TypeChecker, expr: ts.Expression): ts.Symbol | undefined {
  let sym = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expr) ? expr.name : expr);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  return sym;
}

interface DeclInfo {
  name: string;
  kind: GraphNode["kind"];
  startLine: number;
  endLine: number;
  signature: string;
}

function declarationInfo(node: ts.Node, sf: ts.SourceFile): DeclInfo | null {
  let name: string | undefined;
  let kind: GraphNode["kind"] | undefined;

  if (ts.isFunctionDeclaration(node) && node.name) {
    name = node.name.text;
    kind = "function";
  } else if (ts.isClassDeclaration(node) && node.name) {
    name = node.name.text;
    kind = "class";
  } else if (ts.isInterfaceDeclaration(node)) {
    name = node.name.text;
    kind = "interface";
  } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
    name = node.name.text;
    kind = "method";
  } else if (
    ts.isVariableStatement(node) &&
    node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  ) {
    // Only exported top-level consts (incl. arrow functions) — keep the graph thin.
    const decl = node.declarationList.declarations[0];
    if (decl && ts.isIdentifier(decl.name)) {
      name = decl.name.text;
      kind = decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
        ? "function"
        : "variable";
    }
  }

  if (!name || !kind) return null;
  const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  const firstLine = node.getText(sf).split("\n", 1)[0]!.slice(0, 120);
  return { name, kind, startLine: start, endLine: end, signature: firstLine };
}

/** Nearest enclosing named declaration's symbol id, else null (file-level). */
function enclosingSymbolId(
  node: ts.Node,
  sf: ts.SourceFile,
  symbolId: (absPath: string, name: string) => NodeId,
): NodeId | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    const info = declarationInfo(current, sf);
    if (info) return symbolId(sf.fileName, info.name);
    current = current.parent;
  }
  return null;
}

async function collectTsFiles(repoRoot: string): Promise<string[]> {
  // gitignore-respecting enumeration; absolute paths for the compiler host.
  const files = await listRepoFiles(repoRoot);
  return files
    .filter((f) => /\.(ts|tsx|mts|cts)$/.test(f) && !f.endsWith(".d.ts"))
    .map((f) => path.join(repoRoot, f));
}
