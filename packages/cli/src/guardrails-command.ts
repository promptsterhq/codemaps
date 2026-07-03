/**
 * `codemaps guardrails` — mine, list, and decide guardrails.
 *
 *   codemaps guardrails <path>            mine + sync into codemap/guardrails.json, list
 *   codemaps guardrails confirm <id>      promote proposed -> confirmed (human decision)
 *   codemaps guardrails reject <id>       mark a proposal wrong (won't re-surface)
 *
 * Human decisions are durable — re-mining never overwrites them (trust loop).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  buildRiskIndex,
  decide,
  guardrailId,
  loadCodemap,
  mergeFindings,
  mineGuardrails,
  saveCodemap,
  type StoredGuardrail,
} from "@codemaps/core";

const execFileAsync = promisify(execFile);

export async function runGuardrails(args: string[]): Promise<number> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const sub = positional[0];

  if (sub === "confirm" || sub === "reject") {
    return runDecide(sub === "confirm" ? "confirmed" : "rejected", positional[1]);
  }
  return runMine(args, positional[0] ?? ".");
}

async function repoRoot(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"]);
    return stdout.trim();
  } catch {
    return null;
  }
}

async function gitUser(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["config", "user.name"]);
    return stdout.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

async function runDecide(status: "confirmed" | "rejected", idPrefix?: string): Promise<number> {
  if (!idPrefix) {
    console.error(`usage: codemaps guardrails ${status === "confirmed" ? "confirm" : "reject"} <id>`);
    return 2;
  }
  const root = await repoRoot();
  if (!root) {
    console.error("codemaps guardrails: not inside a git repository.");
    return 1;
  }
  const codemap = await loadCodemap(root);
  const result = decide(codemap, idPrefix, status, await gitUser(), new Date().toISOString().slice(0, 10));
  if (typeof result === "string") {
    console.error(`codemaps guardrails: ${result}`);
    return 1;
  }
  await saveCodemap(root, codemap);
  console.log(
    `${status === "confirmed" ? "✅ confirmed" : "🚫 rejected"} [${result.id}] ${result.path} — "${result.statement}"` +
      `\n   (recorded in codemap/guardrails.json by ${result.decidedBy}; commit it so the team + agents see it)`,
  );
  return 0;
}

async function runMine(args: string[], target: string): Promise<number> {
  const json = args.includes("--json");
  const root = await repoRoot();
  if (!root) {
    console.error("codemaps guardrails: not inside a git repository.");
    return 1;
  }

  // Risk index powers the materiality gate (lens 4 <-> 5 link). If git history
  // is unavailable the mine still works — everything just stays non-material.
  const riskIndex = await buildRiskIndex(root).catch(() => undefined);
  const report = await mineGuardrails(root, target, riskIndex);

  // Sync into the versioned store; human decisions survive re-mining.
  const codemap = await loadCodemap(root);
  const counts = mergeFindings(codemap, [...report.findings, ...report.suppressed],
    new Date().toISOString().slice(0, 10));
  await saveCodemap(root, codemap);

  // Display from the STORE (so confirmed/rejected status shows), scoped to target.
  const scope = report.target === "." ? "" : report.target;
  const inScope = codemap.guardrails.filter(
    (g) => g.status !== "rejected" && (scope === "" || g.path === scope || g.path.startsWith(scope.endsWith("/") ? scope : scope + "/")),
  );

  if (json) {
    console.log(JSON.stringify({ target: report.target, guardrails: inScope, sync: counts }, null, 2));
    return 0;
  }

  printHuman(report.target, inScope, counts);
  return 0;
}

function printHuman(
  target: string,
  guardrails: StoredGuardrail[],
  counts: { added: number; refreshed: number; kept: number },
): void {
  const zones = guardrails.filter((g) => g.kind === "do-not-touch");
  const confirmed = guardrails.filter((g) => g.kind === "invariant" && g.status === "confirmed");
  const material = guardrails.filter((g) => g.kind === "invariant" && g.status === "proposed" && g.material);
  const cold = guardrails.filter((g) => g.kind === "invariant" && g.status === "proposed" && !g.material);

  console.log(`\n🛡️  GUARDRAILS — ${target}`);

  if (confirmed.length > 0) {
    console.log(`\n   CONFIRMED (human-verified — treat as hard constraints):`);
    for (const g of confirmed) {
      console.log(`   ✅ [${g.id}] ${g.path}:${g.line ?? "?"} — "${g.statement}" (by ${g.decidedBy})`);
    }
  }

  if (zones.length > 0) {
    console.log(`\n   DO-NOT-TOUCH ZONES (${zones.length}):`);
    const byReason = new Map<string, StoredGuardrail[]>();
    for (const z of zones) {
      const list = byReason.get(z.reason) ?? [];
      list.push(z);
      byReason.set(z.reason, list);
    }
    for (const [reason, list] of byReason) {
      console.log(`   • [${reason}] ${list[0]!.statement}`);
      for (const z of list.slice(0, 4)) console.log(`       [${z.id}] ${z.path}${z.material ? `  ⚠️ ${z.materialWhy}` : ""}`);
      if (list.length > 4) console.log(`       … and ${list.length - 4} more`);
    }
  }

  if (material.length > 0) {
    console.log(`\n   PROPOSED INVARIANTS — material (${material.length}):`);
    for (const g of material.slice(0, 12)) {
      console.log(`   • [${g.id}] ${g.path}:${g.line ?? "?"}  (${g.materialWhy})`);
      console.log(`       "${g.statement}"  [confidence ${g.confidence}]`);
    }
    if (material.length > 12) console.log(`   … and ${material.length - 12} more`);
  }

  if (guardrails.length === 0) {
    console.log(`\n   No guardrails on file for this path.`);
  }

  if (cold.length > 0) {
    console.log(`\n   (${cold.length} non-material proposal(s) on file — see codemap/guardrails.json)`);
  }

  console.log(
    `\n   sync: +${counts.added} new, ${counts.refreshed} refreshed, ${counts.kept} human-decided kept` +
      `\n   Promote with: codemaps guardrails confirm <id>   (or reject <id>)\n`,
  );
}

// Re-export for other commands that need an id for display.
export { guardrailId };
