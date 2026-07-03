/**
 * `codemaps check [--base <ref>]` — the PR-loop gate.
 * Exit 1 only when a human-CONFIRMED do-not-touch zone was edited; everything
 * else is advisory output (warn/info). --md emits GitHub-flavored markdown for
 * PR comments / $GITHUB_STEP_SUMMARY.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFile } from "node:fs/promises";
import { buildRiskIndex, checkReportMarkdown, runCheck } from "@codemaps/core";
import { loadGraph } from "./graph-commands.js";

const execFileAsync = promisify(execFile);

export async function runCheckCommand(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const md = args.includes("--md");
  const baseFlag = args.indexOf("--base");
  const base = baseFlag >= 0 ? args[baseFlag + 1] : "main";

  let repoRoot: string;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"]);
    repoRoot = stdout.trim();
  } catch {
    console.error("codemaps check: not inside a git repository.");
    return 2;
  }

  const [graph, riskIndex] = await Promise.all([
    loadGraph(repoRoot),
    buildRiskIndex(repoRoot).catch(() => undefined),
  ]);
  const report = await runCheck(repoRoot, { base, graph, riskIndex });

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (md) {
    const markdown = checkReportMarkdown(report);
    console.log(markdown);
    // In GitHub Actions, also publish to the job summary automatically.
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown + "\n");
    }
  } else {
    printHuman(report);
  }

  return report.verdict === "fail" ? 1 : 0;
}

function printHuman(report: Awaited<ReturnType<typeof runCheck>>): void {
  const icon = { fail: "❌", warn: "⚠️ ", info: "ℹ️ " } as const;
  console.log(
    `\n${report.verdict === "fail" ? "❌" : "✅"} CODEMAPS CHECK — ${report.changedFiles.length} file(s) changed vs ${report.base}`,
  );
  if (report.findings.length === 0) {
    console.log(`   No findings. (Absence of findings is not a guarantee — hotspots/guardrails/security only.)\n`);
    return;
  }
  console.log();
  for (const f of report.findings) {
    console.log(`   ${icon[f.severity]} ${f.file}${f.line ? `:${f.line}` : ""}`);
    console.log(`      ${f.message}`);
  }
  console.log(
    `\n   verdict: ${report.verdict.toUpperCase()} — fail only on confirmed do-not-touch edits;` +
      ` warns are advisory by design (trust loop).\n`,
  );
}
