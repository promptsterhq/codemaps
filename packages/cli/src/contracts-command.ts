/**
 * `codemaps contracts` — what this repo publishes and consumes across the
 * network (Impact tier b; the artifact Phase 3 stitches cross-repo).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extractContracts, type ContractSurface } from "@codemaps/core";

const execFileAsync = promisify(execFile);

export async function runContracts(args: string[]): Promise<number> {
  const json = args.includes("--json");
  let repoRoot: string;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"]);
    repoRoot = stdout.trim();
  } catch {
    console.error("codemaps contracts: not inside a git repository.");
    return 1;
  }

  const surface = await extractContracts(repoRoot);
  if (json) {
    console.log(JSON.stringify(surface, null, 2));
    return 0;
  }
  printHuman(surface);
  return 0;
}

function printHuman(s: ContractSurface): void {
  console.log(`\n🔌 CONTRACT SURFACE`);

  if (s.serves.length > 0) {
    console.log(`\n   PUBLISHES (${s.serves.length}) — changing these can break external consumers:`);
    const byKind = new Map<string, typeof s.serves>();
    for (const c of s.serves) {
      const list = byKind.get(c.kind) ?? [];
      list.push(c);
      byKind.set(c.kind, list);
    }
    for (const [kind, list] of byKind) {
      console.log(`   ${kind.toUpperCase()}:`);
      for (const c of list.slice(0, 12)) {
        console.log(`   • ${c.id.replace(/^\w+:/, "")}  (${c.file}:${c.line}, ${c.via}, ${Math.round(c.confidence * 100)}%)`);
      }
      if (list.length > 12) console.log(`     … and ${list.length - 12} more`);
    }
  }

  if (s.calls.length > 0) {
    console.log(`\n   CONSUMES (${s.calls.length}) — this repo depends on these external endpoints:`);
    for (const c of s.calls.slice(0, 10)) {
      console.log(`   • ${c.method} ${c.url}  (${c.file}:${c.line}, ${c.via})`);
    }
    if (s.calls.length > 10) console.log(`     … and ${s.calls.length - 10} more`);
  }

  if (s.events.length > 0) {
    console.log(`\n   EVENTS (${s.events.length}):`);
    for (const e of s.events.slice(0, 10)) {
      console.log(`   • ${e.role} ${e.topic}  (${e.file}:${e.line}, ${e.via})`);
    }
  }

  if (s.serves.length === 0 && s.calls.length === 0 && s.events.length === 0) {
    console.log(`\n   No network contracts detected (heuristic — library/CLI repos often have none).`);
  }

  console.log(
    `\n   [provenance: heuristic. Route templates normalized ({param}) for cross-repo identity.` +
      `\n    codemaps check flags edits to any published contract line.]\n`,
  );
}
