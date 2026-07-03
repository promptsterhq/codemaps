/**
 * `codemaps guardrails <path>` — Phase 0 step 2.
 * Do-not-touch zones + declared invariants, materiality-gated by the Risk lens.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildRiskIndex, mineGuardrails, type GuardrailsReport } from "@codemaps/core";

const execFileAsync = promisify(execFile);

export async function runGuardrails(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const positional = args.filter((a) => !a.startsWith("--"));
  const target = positional[0] ?? ".";

  let repoRoot: string;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"]);
    repoRoot = stdout.trim();
  } catch {
    console.error("codemaps guardrails: not inside a git repository.");
    return 1;
  }

  // Risk index powers the materiality gate (lens 4 <-> 5 link). If git history
  // is unavailable the mine still works — everything just stays non-material.
  const riskIndex = await buildRiskIndex(repoRoot).catch(() => undefined);
  const report = await mineGuardrails(repoRoot, target, riskIndex);

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  printHuman(report);
  return 0;
}

function printHuman(r: GuardrailsReport): void {
  const zones = r.findings.filter((f) => f.kind === "do-not-touch");
  const invariants = r.findings.filter((f) => f.kind === "invariant");

  console.log(`\n🛡️  GUARDRAILS — ${r.target}`);

  if (zones.length > 0) {
    console.log(`\n   DO-NOT-TOUCH ZONES (${zones.length}):`);
    // Group identical-reason zones to keep output scannable.
    const byReason = new Map<string, typeof zones>();
    for (const z of zones) {
      const list = byReason.get(z.reason) ?? [];
      list.push(z);
      byReason.set(z.reason, list);
    }
    for (const [reason, list] of byReason) {
      console.log(`   • [${reason}] ${list[0]!.statement}`);
      for (const z of list.slice(0, 4)) console.log(`       ${z.path}${z.material ? `  ⚠️ ${z.materialWhy}` : ""}`);
      if (list.length > 4) console.log(`       … and ${list.length - 4} more`);
    }
  }

  if (invariants.length > 0) {
    console.log(`\n   DECLARED INVARIANTS — material only (${invariants.length}):`);
    for (const inv of invariants.slice(0, 12)) {
      console.log(`   • ${inv.path}:${inv.line}  (${inv.materialWhy})`);
      console.log(`       "${inv.statement}"  [confidence ${inv.confidence}]`);
    }
    if (invariants.length > 12) console.log(`   … and ${invariants.length - 12} more`);
  }

  if (zones.length === 0 && invariants.length === 0) {
    console.log(`\n   No guardrails surfaced for this path.`);
  }

  if (r.suppressed.length > 0) {
    console.log(
      `\n   (${r.suppressed.length} non-material invariant(s) suppressed — anchored to cold,` +
        ` multi-owner code. Use --json to see everything.)`,
    );
  }

  console.log(
    `\n   All findings are PROPOSED (mined, advisory) — none are confirmed by a human yet.` +
      `\n   Proposed guardrails warn; they never block. [provenance: mined]\n`,
  );
}
