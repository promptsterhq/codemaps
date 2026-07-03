#!/usr/bin/env node
/**
 * Benchmark runner v0 — runs each task in a scratch git worktree via
 * `claude -p` (headless), with or without Codemaps context.
 *
 *   node bench/run.mjs --task lockfile-edit --arm codemaps
 *   node bench/run.mjs --all            # full matrix (costs real tokens)
 *
 * Arms:
 *   baseline  — plain agent (its own grep/read/edit tools)
 *   codemaps  — + Codemaps MCP server + generated AGENTS.md in the workdir
 *
 * Each run records: final git diff, transcript (--output-format json),
 * duration. Scoring is done afterwards against tasks.json's judge checklist.
 */

import { execFileSync, execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, cpSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(here);
const { tasks } = JSON.parse(readFileSync(path.join(here, "tasks.json"), "utf8"));

// Where task repos live. "express" must be cloned here beforehand.
const REPOS_DIR = process.env.BENCH_REPOS ?? path.join(here, "repos");
const RESULTS_DIR = path.join(here, "results");

const args = process.argv.slice(2);
const all = args.includes("--all");
const taskId = flag("--task");
const arm = flag("--arm");

function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const runs = all
  ? tasks.flatMap((t) => [{ task: t, arm: "baseline" }, { task: t, arm: "codemaps" }])
  : [{ task: tasks.find((t) => t.id === taskId), arm: arm ?? "baseline" }];

if (runs.some((r) => !r.task)) {
  console.error(`unknown task. known: ${tasks.map((t) => t.id).join(", ")}`);
  process.exit(2);
}

mkdirSync(RESULTS_DIR, { recursive: true });

for (const { task, arm } of runs) {
  await runOne(task, arm);
}

async function runOne(task, arm) {
  const label = `${task.id}-${arm}`;
  console.log(`\n=== ${label} ===`);

  // 1. Fresh working copy.
  const src = task.repo === "self" ? repoRoot : path.join(REPOS_DIR, task.repo);
  if (!existsSync(src)) {
    console.error(`missing repo: ${src} (clone it first, e.g. into bench/repos/)`);
    return;
  }
  // Work dirs live OUTSIDE the repo (copying self into a subdir of self fails).
  const workdir = path.join(os.tmpdir(), "codemaps-bench", label);
  rmSync(workdir, { recursive: true, force: true });
  mkdirSync(path.dirname(workdir), { recursive: true });
  cpSync(src, workdir, {
    recursive: true,
    filter: (p) => !p.includes("node_modules") && !p.includes("bench/results"),
  });
  // 2. Arm setup.
  const baseTools = "Bash,Read,Edit,Write,Grep,Glob";
  // stream-json + verbose: capture per-turn tool calls so scoring can verify
  // whether the agent consulted risk/guardrails/impact before editing.
  const cliArgs = ["-p", task.prompt, "--output-format", "stream-json", "--verbose", "--max-turns", "30"];
  if (arm === "codemaps") {
    // Generate AGENTS.md + graph in the workdir, then attach the MCP server.
    execFileSync("node", [path.join(repoRoot, "packages/cli/dist/index.js"), "init", "--force"],
      { cwd: workdir, stdio: "inherit" });
    const mcpConfig = {
      mcpServers: {
        codemaps: { command: "node", args: [path.join(repoRoot, "packages/cli/dist/index.js"), "serve"] },
      },
    };
    const mcpPath = path.join(workdir, ".bench-mcp.json");
    writeFileSync(mcpPath, JSON.stringify(mcpConfig));
    cliArgs.push("--mcp-config", mcpPath, "--allowedTools",
      `${baseTools},mcp__codemaps__risk,mcp__codemaps__guardrails,mcp__codemaps__impact,mcp__codemaps__locate`);
  } else {
    cliArgs.push("--allowedTools", baseTools);
  }

  // Baseline commit AFTER arm setup so init artifacts (AGENTS.md, .codemaps/)
  // don't pollute the agent's diff.
  execFileSync("git", ["-C", workdir, "add", "-A"], { stdio: "ignore" });
  execFileSync("git", ["-C", workdir, "-c", "user.name=bench", "-c", "user.email=bench@codemaps.dev",
    "commit", "-q", "-m", "bench baseline", "--allow-empty"], { stdio: "ignore" });

  // 3. Run the agent.
  const started = Date.now();
  const transcript = await new Promise((resolve) => {
    execFile("claude", cliArgs, { cwd: workdir, maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60_000 },
      (err, stdout, stderr) => resolve({ err: err?.message, stdout, stderr }));
  });
  const seconds = Math.round((Date.now() - started) / 1000);

  // 4. Record diff + transcript. add -N so newly created files show in the diff.
  execFileSync("git", ["-C", workdir, "add", "-N", "."], { stdio: "ignore" });
  const diff = execFileSync("git", ["-C", workdir, "diff"], { maxBuffer: 64 * 1024 * 1024 }).toString();
  const result = {
    task: task.id, arm, seconds,
    judge: task.judge, trap: task.trap,
    diffStat: execFileSync("git", ["-C", workdir, "diff", "--stat"]).toString().trim(),
    error: transcript.err ?? null,
  };
  writeFileSync(path.join(RESULTS_DIR, `${label}.json`), JSON.stringify(result, null, 2));
  writeFileSync(path.join(RESULTS_DIR, `${label}.diff`), diff);
  writeFileSync(path.join(RESULTS_DIR, `${label}.transcript.jsonl`), transcript.stdout ?? "");
  console.log(`   done in ${seconds}s — diff: ${result.diffStat.split("\n").pop() || "(empty)"}`);
  console.log(`   -> results/${label}.{json,diff,transcript.json}`);
}
