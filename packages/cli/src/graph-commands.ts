/**
 * `codemaps index` / `impact <symbol>` / `locate <query>` — Phase 0 step 3.
 * The thin-graph table stakes. Persists to .codemaps/graph.json (JSON per the
 * Phase 0 constraint; SQLite is a Phase 1 swap hidden behind CodeGraph).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  MutableGraph,
  impact,
  indexRepo,
  locate,
  resolveTarget,
  type SerializedGraph,
} from "@codemaps/core";

const execFileAsync = promisify(execFile);

async function repoRoot(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"]);
    return stdout.trim();
  } catch {
    return null;
  }
}

const graphPath = (root: string): string => path.join(root, ".codemaps", "graph.json");

export async function runIndex(): Promise<number> {
  const root = await repoRoot();
  if (!root) {
    console.error("codemaps index: not inside a git repository.");
    return 1;
  }
  const started = Date.now();
  const result = await indexRepo(root);
  await mkdir(path.dirname(graphPath(root)), { recursive: true });
  await writeFile(graphPath(root), JSON.stringify(result.graph.toJSON()));
  console.log(
    `[codemaps] indexed ${result.fileCount} file(s): ${result.symbolCount} symbols, ` +
      `${result.edgeCount} edges in ${((Date.now() - started) / 1000).toFixed(1)}s -> .codemaps/graph.json`,
  );
  return 0;
}

export async function loadGraph(root: string): Promise<MutableGraph | null> {
  try {
    const raw = await readFile(graphPath(root), "utf8");
    return MutableGraph.fromJSON(JSON.parse(raw) as SerializedGraph);
  } catch {
    return null;
  }
}

export async function runImpact(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const target = args.filter((a) => !a.startsWith("--"))[0];
  if (!target) {
    console.error("usage: codemaps impact <symbol> [--json]");
    return 2;
  }
  const root = await repoRoot();
  if (!root) {
    console.error("codemaps impact: not inside a git repository.");
    return 1;
  }
  let graph = await loadGraph(root);
  if (!graph) {
    console.error(`[codemaps] no graph found — building one first (codemaps index)…`);
    await runIndex();
    graph = await loadGraph(root);
    if (!graph) return 1;
  }

  const id = resolveTarget(graph, target);
  const result = id ? impact(graph, id) : null;
  if (!result) {
    console.error(`codemaps impact: symbol "${target}" not found in the graph.`);
    return 1;
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  const loc = result.target.loc ? ` (${result.target.loc.path}:${result.target.loc.startLine})` : "";
  console.log(`\n💥 IMPACT — ${result.target.name}${loc}`);
  console.log(`   direct dependents      ${result.directDependents.length}`);
  for (const d of result.directDependents.slice(0, 10)) {
    console.log(`     • ${d.name}  ${d.loc ? `${d.loc.path}:${d.loc.startLine}` : ""}`);
  }
  if (result.directDependents.length > 10) console.log(`     … and ${result.directDependents.length - 10} more`);
  console.log(`   transitive dependents  ${result.transitiveDependents.length}`);
  console.log(`   affected tests         ${result.affectedTests.length}`);
  for (const t of result.affectedTests.slice(0, 5)) console.log(`     • ${t.loc?.path ?? t.name}`);
  console.log(`\n   [provenance: ${result.provenance} (static call+import edges) · confidence ${result.confidence}]`);
  console.log(`   Note: static analysis misses dynamic dispatch/DI — treat as a floor, not a ceiling.\n`);
  return 0;
}

export async function runLocate(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const query = args.filter((a) => !a.startsWith("--")).join(" ");
  if (!query) {
    console.error("usage: codemaps locate <query> [--json]");
    return 2;
  }
  const root = await repoRoot();
  if (!root) {
    console.error("codemaps locate: not inside a git repository.");
    return 1;
  }
  let graph = await loadGraph(root);
  if (!graph) {
    await runIndex();
    graph = await loadGraph(root);
    if (!graph) return 1;
  }

  const hits = locate(graph, query);
  if (json) {
    console.log(JSON.stringify(hits, null, 2));
    return 0;
  }
  if (hits.length === 0) {
    console.log(`No matches for "${query}".`);
    return 0;
  }
  console.log(`\n🔎 LOCATE — "${query}"`);
  for (const h of hits) {
    const where = h.node.loc ? `${h.node.loc.path}:${h.node.loc.startLine}` : h.node.name;
    console.log(`   ${String(h.score).padStart(3)}  ${h.node.kind.padEnd(9)} ${h.node.name}  ${where}`);
  }
  console.log();
  return 0;
}
