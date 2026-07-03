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
  guardrailId,
  pruneStaleProposals,
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

  // 2. Guardrails (materiality-gated by risk), synced into codemap/;
  //    stale proposals pruned repo-wide, human decisions kept.
  const guardrails = await mineGuardrails(repoRoot, ".", riskIndex);
  const codemap = await loadCodemap(repoRoot);
  const mined = [...guardrails.findings, ...guardrails.suppressed];
  const counts = mergeFindings(codemap, mined, new Date().toISOString().slice(0, 10));
  pruneStaleProposals(codemap, ".", new Set(mined.map(guardrailId)));
  await saveCodemap(repoRoot, codemap);
  const zones = guardrails.findings.filter((f) => f.kind === "do-not-touch").length;
  const invariants = guardrails.findings.filter((f) => f.kind === "invariant").length;
  console.log(
    `  ✓ guardrails  ${zones} zone(s), ${invariants} material invariant(s) ` +
      `(codemap/guardrails.json: +${counts.added} new, ${counts.kept} human-decided kept)`,
  );

  // 3. Thin graph (table stakes) — HEAD-stamped for freshness checks.
  const idx = await indexRepo(repoRoot);
  const head = await execFileAsync("git", ["-C", repoRoot, "rev-parse", "HEAD"])
    .then((r) => r.stdout.trim())
    .catch(() => undefined);
  await mkdir(path.join(repoRoot, ".codemaps"), { recursive: true });
  await writeFile(path.join(repoRoot, ".codemaps", "graph.json"), JSON.stringify(idx.graph.toJSON(head)));
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

/**
 * Pick a hook command that will actually resolve when Claude Code runs it.
 * Hooks execute in a NON-interactive shell: PATH additions living in .zshrc
 * (interactive-only) are invisible there, and a hook that can't resolve its
 * binary dies SILENTLY — the one failure a guardrail must never have. So:
 * prefer bare `codemaps` only if a non-interactive shell can see it; otherwise
 * pin the absolute node + CLI entrypoint of this very installation.
 */
async function hookCommand(): Promise<string> {
  try {
    await execFileAsync("/bin/sh", ["-c", "command -v codemaps"]);
    return "codemaps hook";
  } catch {
    const entry = path.resolve(process.argv[1] ?? "");
    return `"${process.execPath}" "${entry}" hook`;
  }
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

  const command = await hookCommand();
  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  // Drop any earlier codemaps registrations (command form may have changed).
  for (const key of ["PreToolUse", "SessionStart"]) {
    hooks[key] = (hooks[key] ?? []).filter((h) => !JSON.stringify(h).includes("codemaps") ||
      JSON.stringify(h).includes(command));
  }
  const entry = {
    matcher: "Edit|Write",
    hooks: [{ type: "command", command, timeout: 10 }],
  };
  if (!JSON.stringify(hooks.PreToolUse ?? []).includes(command)) {
    hooks.PreToolUse = [...(hooks.PreToolUse ?? []), entry];
  }
  const sessionEntry = { hooks: [{ type: "command", command, timeout: 10 }] };
  if (!JSON.stringify(hooks.SessionStart ?? []).includes(command)) {
    hooks.SessionStart = [...(hooks.SessionStart ?? []), sessionEntry];
  }
  settings.hooks = hooks;
  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  console.log(`  ✓ hooks       PreToolUse + SessionStart registered (${command.startsWith('"') ? "pinned absolute path — 'codemaps' not on non-interactive PATH" : "via PATH"})`);
}
