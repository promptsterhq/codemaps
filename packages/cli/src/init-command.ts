/**
 * `codemaps init` — the PLG entry point: index the repo, generate AGENTS.md
 * (leading with Risk + Guardrails), and print MCP registration instructions.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildRiskIndex,
  generateAgentsMd,
  indexRepo,
  loadCodemap,
  mergeFindings,
  mineGuardrails,
  saveCodemap,
  toRiskCache,
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

  // 1. Risk (the moat, from git alone) — also cached for fast hook lookups.
  const riskIndex = await buildRiskIndex(repoRoot);
  await mkdir(path.join(repoRoot, ".codemaps"), { recursive: true });
  await writeFile(
    path.join(repoRoot, ".codemaps", "risk.json"),
    JSON.stringify(toRiskCache(riskIndex)),
  );
  console.log(`  ✓ risk        ${riskIndex.files.size} file(s) from ${riskIndex.totalCommits} commits (+ hook cache)`);

  // 2. Guardrails (materiality-gated by risk), synced into codemap/.
  const guardrails = await mineGuardrails(repoRoot, ".", riskIndex);
  const codemap = await loadCodemap(repoRoot);
  const counts = mergeFindings(codemap, [...guardrails.findings, ...guardrails.suppressed],
    new Date().toISOString().slice(0, 10));
  await saveCodemap(repoRoot, codemap);
  const zones = guardrails.findings.filter((f) => f.kind === "do-not-touch").length;
  const invariants = guardrails.findings.filter((f) => f.kind === "invariant").length;
  console.log(
    `  ✓ guardrails  ${zones} zone(s), ${invariants} material invariant(s) ` +
      `(codemap/guardrails.json: +${counts.added} new, ${counts.kept} human-decided kept)`,
  );

  // 3. Thin graph (table stakes).
  const idx = await indexRepo(repoRoot);
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

  // 5. Claude Code reads CLAUDE.md, not AGENTS.md — write an @import bridge
  //    so the guardrails actually load (see docs/RESEARCH.md §C).
  const claudePath = path.join(repoRoot, "CLAUDE.md");
  const claudeExists = await access(claudePath).then(() => true, () => false);
  if (!claudeExists) {
    await writeFile(claudePath, `@AGENTS.md\n`);
    console.log(`  ✓ CLAUDE.md   bridge created (@AGENTS.md import for Claude Code)`);
  } else {
    const existing = await readFile(claudePath, "utf8");
    if (!existing.includes("AGENTS.md")) {
      console.log(`  ⚠ CLAUDE.md exists but doesn't reference AGENTS.md — add "@AGENTS.md" to load Codemaps context in Claude Code.`);
    }
  }

  // 6. Optional: register enforcement hooks in project .claude/settings.json.
  if (args.includes("--hooks")) {
    await registerHooks(repoRoot);
  }

  console.log(`
[codemaps] done. To give agents live access, register the MCP server:

  Claude Code:   claude mcp add codemaps -- codemaps serve
  Cursor etc.:   add to mcp config: { "command": "codemaps", "args": ["serve"] }
${args.includes("--hooks") ? "" : `
  Optional: codemaps init --hooks registers a PreToolUse guardrail check in
  .claude/settings.json (warns on hotspots/invariants; blocks only human-
  CONFIRMED do-not-touch zones).
`}
Agents get: risk · guardrails · impact · locate (see AGENTS.md).`);
  return 0;
}

/** Merge our hooks into .claude/settings.json without clobbering existing config. */
async function registerHooks(repoRoot: string): Promise<void> {
  const settingsDir = path.join(repoRoot, ".claude");
  const settingsPath = path.join(settingsDir, "settings.json");
  await mkdir(settingsDir, { recursive: true });

  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
  } catch {
    /* fresh file */
  }

  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  const entry = {
    matcher: "Edit|Write",
    hooks: [{ type: "command", command: "codemaps hook", timeout: 10 }],
  };
  const existing = JSON.stringify(hooks.PreToolUse ?? []);
  if (!existing.includes("codemaps hook")) {
    hooks.PreToolUse = [...(hooks.PreToolUse ?? []), entry];
  }
  const sessionEntry = { hooks: [{ type: "command", command: "codemaps hook", timeout: 10 }] };
  if (!JSON.stringify(hooks.SessionStart ?? []).includes("codemaps hook")) {
    hooks.SessionStart = [...(hooks.SessionStart ?? []), sessionEntry];
  }
  settings.hooks = hooks;
  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  console.log(`  ✓ hooks       PreToolUse + SessionStart registered in .claude/settings.json`);
}
