/**
 * `codemaps risk <path>` — the first runnable moat milestone (Phase 0 step 1).
 * Prints the "slow down here" signal derived from git history alone.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildRiskIndex, riskForPath, type RiskReport } from "@codemaps/core";

const execFileAsync = promisify(execFile);

export async function runRisk(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const positional = args.filter((a) => !a.startsWith("--"));
  const target = positional[0];
  if (!target) {
    console.error("usage: codemaps risk <path> [--json] [--window <months>]");
    return 2;
  }
  const windowFlag = args.indexOf("--window");
  const windowMonths = windowFlag >= 0 ? Number(args[windowFlag + 1]) || 12 : 12;

  let repoRoot: string;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"]);
    repoRoot = stdout.trim();
  } catch {
    console.error("codemaps risk: not inside a git repository.");
    return 1;
  }

  const index = await buildRiskIndex(repoRoot, { windowMonths });
  const report = riskForPath(index, target);
  if (!report) {
    console.error(
      `codemaps risk: no git history for "${target}" in the last ${windowMonths} months ` +
        `(or path not found). Risk is derived from history; a brand-new file has none yet.`,
    );
    return 1;
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  printHuman(report, windowMonths, index.totalCommits);
  return 0;
}

function printHuman(r: RiskReport, windowMonths: number, totalCommits: number): void {
  const s = r.summary;
  const flame = s.hotspotPercentile >= 80 ? "🔥" : s.hotspotPercentile >= 50 ? "🟠" : "🟢";

  console.log(`\n${flame} RISK — ${r.target}${r.kind === "directory" ? "/" : ""}`);
  console.log(`   window     last ${windowMonths}mo (${totalCommits} repo commits)`);
  console.log(`   hotspot    ${s.hotspotPercentile}th percentile in this repo`);
  console.log(`   changes    ${s.commits} commit(s), churn +${s.churn.added}/−${s.churn.deleted}`);
  console.log(
    `   owners     ${s.topOwners.map((o) => `${o.name} ${Math.round(o.share * 100)}%`).join(", ") || "unknown"}`,
  );
  console.log(`   bus-factor ${s.busFactor}${s.busFactor === 1 ? "  ⚠️  single-owner" : ""}`);
  const covered = r.files.filter((f) => f.coverage !== null);
  if (covered.length > 0) {
    const avg = Math.round(covered.reduce((n, f) => n + (f.coverage ?? 0), 0) / covered.length);
    console.log(`   coverage   ${avg}% (lcov)`);
  }

  if (r.kind === "directory" && r.files.length > 1) {
    console.log(`\n   hottest files:`);
    for (const f of r.files.slice(0, 5)) {
      console.log(
        `     ${String(f.hotspotPercentile).padStart(3)}pct  ${f.path}  (${f.commits}x, bus-factor ${f.busFactor})`,
      );
    }
  }

  if (r.warnings.length > 0) {
    console.log(`\n   ⚠️  SLOW DOWN:`);
    for (const w of r.warnings) console.log(`   • ${w}`);
  } else {
    console.log(`\n   No elevated risk signals for this path.`);
  }

  console.log(`\n   [provenance: ${r.provenance} from git history · confidence ${r.confidence}]\n`);
}
