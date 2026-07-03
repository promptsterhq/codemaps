/**
 * `codemaps init` — the PLG entry point: index the repo, generate AGENTS.md
 * (leading with Risk + Guardrails), and print MCP registration instructions.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildRiskIndex,
  generateAgentsMd,
  indexTypeScript,
  mineGuardrails,
} from "@codemaps/core";

const execFileAsync = promisify(execFile);

export async function runInit(args: string[]): Promise<number> {
  const force = args.includes("--force");

  let repoRoot: string;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"]);
    repoRoot = stdout.trim();
  } catch {
    console.error("codemaps init: not inside a git repository.");
    return 1;
  }

  console.log(`[codemaps] analyzing ${repoRoot} …`);

  // 1. Risk (the moat, from git alone).
  const riskIndex = await buildRiskIndex(repoRoot);
  console.log(`  ✓ risk        ${riskIndex.files.size} file(s) from ${riskIndex.totalCommits} commits`);

  // 2. Guardrails (materiality-gated by risk).
  const guardrails = await mineGuardrails(repoRoot, ".", riskIndex);
  const zones = guardrails.findings.filter((f) => f.kind === "do-not-touch").length;
  const invariants = guardrails.findings.filter((f) => f.kind === "invariant").length;
  console.log(`  ✓ guardrails  ${zones} do-not-touch zone(s), ${invariants} material invariant(s)`);

  // 3. Thin graph (table stakes).
  const idx = await indexTypeScript(repoRoot);
  await mkdir(path.join(repoRoot, ".codemaps"), { recursive: true });
  await writeFile(path.join(repoRoot, ".codemaps", "graph.json"), JSON.stringify(idx.graph.toJSON()));
  console.log(`  ✓ graph       ${idx.symbolCount} symbols, ${idx.edgeCount} edges -> .codemaps/graph.json`);

  // 4. AGENTS.md — refuse to clobber a hand-written one without --force.
  const agentsPath = path.join(repoRoot, "AGENTS.md");
  const exists = await access(agentsPath).then(() => true, () => false);
  if (exists && !force) {
    console.log(
      `  ⚠ AGENTS.md already exists — not overwriting (it may be hand-written). ` +
        `Re-run with --force to regenerate.`,
    );
  } else {
    const md = generateAgentsMd({
      repoName: path.basename(repoRoot),
      riskIndex,
      guardrails,
      graphStats: { files: idx.fileCount, symbols: idx.symbolCount, edges: idx.edgeCount },
    });
    await writeFile(agentsPath, md);
    console.log(`  ✓ AGENTS.md   generated (leads with risk + guardrails)`);
  }

  console.log(`
[codemaps] done. To give agents live access, register the MCP server:

  Claude Code:   claude mcp add codemaps -- codemaps serve
  Cursor etc.:   add to mcp config: { "command": "codemaps", "args": ["serve"] }

Agents get: risk · guardrails · impact · locate (see AGENTS.md).`);
  return 0;
}
