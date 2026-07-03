/**
 * `codemaps security <path>` — lens 6 (beta). Surfaces the security-relevant
 * context near a change: guards, auth gates, sinks, secrets, weak crypto.
 * Honest labels only — this is "a security reviewer would look here," not SAST.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { scanSecurity, type SecurityFinding } from "@codemaps/core";

const execFileAsync = promisify(execFile);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", ".turbo", "coverage", ".codemaps", "__pycache__", ".venv", "venv"]);

export async function runSecurity(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const target = args.filter((a) => !a.startsWith("--"))[0] ?? ".";

  let repoRoot: string;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"]);
    repoRoot = stdout.trim();
  } catch {
    console.error("codemaps security: not inside a git repository.");
    return 1;
  }

  const files = await collect(repoRoot, target);
  const findings = await scanSecurity(repoRoot, files);

  if (json) {
    console.log(JSON.stringify({ target, findings }, null, 2));
    return 0;
  }

  console.log(`\n🔒 SECURITY SURFACE (beta) — ${target}`);
  if (findings.length === 0) {
    console.log(`\n   No security-surface heuristics matched. (beta: absence of findings is NOT a clean bill.)\n`);
    return 0;
  }

  const byCategory = new Map<string, SecurityFinding[]>();
  for (const f of findings) {
    const list = byCategory.get(f.category) ?? [];
    list.push(f);
    byCategory.set(f.category, list);
  }
  for (const [category, list] of byCategory) {
    console.log(`\n   ${category.toUpperCase()} (${list.length}):`);
    for (const f of list.slice(0, 6)) {
      console.log(`   • ${f.path}:${f.line}  [confidence ${f.confidence}]`);
      console.log(`       ${f.evidence.slice(0, 100)}`);
    }
    if (list.length > 6) console.log(`     … and ${list.length - 6} more`);
    console.log(`     ⚠ ${list[0]!.consequence}`);
  }
  console.log(
    `\n   [provenance: heuristic (beta) — surfaces context for review, not verdicts.` +
      ` Absence of findings is not a clean bill.]\n`,
  );
  return 0;
}

async function collect(repoRoot: string, target: string): Promise<string[]> {
  const abs = path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);
  const base = path.relative(repoRoot, abs).replace(/\\/g, "/") || ".";
  const results: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      results.push(path.relative(repoRoot, dir).replace(/\\/g, "/"));
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
      } else {
        results.push(path.relative(repoRoot, path.join(dir, entry.name)).replace(/\\/g, "/"));
      }
    }
  }
  await walk(base === "." ? repoRoot : path.join(repoRoot, base));
  return results;
}
