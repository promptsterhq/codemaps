/**
 * `codemaps hook` — Claude Code hook endpoint (Phase 1: enforcement moments).
 *
 * Registered as a PreToolUse hook on Edit|Write. Reads the hook event JSON
 * from stdin and applies the trust-loop rules (DIFFERENTIATION §1):
 *
 *   confirmed do-not-touch zone  -> DENY (human-verified; strict is earned)
 *   proposed zone / invariants   -> ADVISORY additionalContext (never blocks —
 *                                   safe for unattended/CI runs by construction)
 *   hotspot / single-owner file  -> ADVISORY "slow down" annotation
 *
 * Also handles SessionStart: injects a compact orientation blurb.
 * Fast path: reads .codemaps/risk.json + codemap/guardrails.json only —
 * no git scan, no graph build. Must stay well under hook timeouts.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadCodemap, type RiskCache, type StoredGuardrail } from "@codemaps/core";

interface HookEvent {
  hook_event_name: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; command?: string };
}

export async function runHook(): Promise<number> {
  const raw = await readStdin();
  let event: HookEvent;
  try {
    event = JSON.parse(raw) as HookEvent;
  } catch {
    // Malformed input: never break the agent's flow over our own bug.
    return 0;
  }

  const repoRoot = event.cwd ?? process.cwd();

  if (event.hook_event_name === "SessionStart") {
    return sessionStart(repoRoot);
  }
  if (event.hook_event_name === "PreToolUse" && (event.tool_name === "Edit" || event.tool_name === "Write")) {
    return preToolUse(repoRoot, event.tool_input?.file_path);
  }
  return 0;
}

async function preToolUse(repoRoot: string, filePath?: string): Promise<number> {
  if (!filePath) return 0;
  const rel = path.isAbsolute(filePath)
    ? path.relative(repoRoot, filePath).replace(/\\/g, "/")
    : filePath.replace(/\\/g, "/");
  if (rel.startsWith("..")) return 0; // outside this repo — not ours to judge

  const codemap = await loadCodemap(repoRoot);
  const onFile = codemap.guardrails.filter(
    (g) => g.status !== "rejected" && (g.path === rel || rel.startsWith(g.path.endsWith("/") ? g.path : g.path + "/")),
  );

  // 1. Confirmed do-not-touch: the only case that blocks. Human-verified.
  const confirmedZone = onFile.find((g) => g.kind === "do-not-touch" && g.status === "confirmed");
  if (confirmedZone) {
    emit({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          `Codemaps: ${rel} is a CONFIRMED do-not-touch zone (${confirmedZone.reason}): ` +
          `${confirmedZone.statement} Confirmed by ${confirmedZone.decidedBy ?? "a maintainer"}. ` +
          `Do not edit it; explain to the user what regenerates it instead.`,
      },
    });
    return 0;
  }

  // 2. Everything else is advisory — context, never a block.
  const notes: string[] = [];

  const proposedZone = onFile.find((g) => g.kind === "do-not-touch");
  if (proposedZone) {
    notes.push(
      `${rel} looks like a do-not-touch zone (${proposedZone.reason}, proposed): ${proposedZone.statement} ` +
        `Strongly prefer editing the source that generates it. ` +
        `[If this zone is correct, a human can lock it: codemaps guardrails confirm ${proposedZone.id}]`,
    );
  }

  const invariants = onFile.filter((g) => g.kind === "invariant" && (g.status === "confirmed" || g.material));
  if (invariants.length > 0) {
    const list = invariants
      .slice(0, 3)
      .map((g) => `- ${g.status === "confirmed" ? "[CONFIRMED] " : ""}${g.statement} (${g.path}:${g.line ?? "?"})`)
      .join("\n");
    notes.push(`Invariants to preserve in ${rel}:\n${list}`);
  }

  const risk = await loadRiskCache(repoRoot);
  const fileRisk = risk?.files[rel];
  if (fileRisk && (fileRisk.hotspotPercentile >= 80 || fileRisk.busFactor === 1)) {
    const parts: string[] = [];
    if (fileRisk.hotspotPercentile >= 80) parts.push(`${fileRisk.hotspotPercentile}th-percentile hotspot (${fileRisk.commits} recent changes)`);
    if (fileRisk.busFactor === 1) parts.push(`single-owner code (${fileRisk.topOwner})`);
    notes.push(
      `Risk: ${rel} is ${parts.join(" and ")}. Slow down: keep the diff minimal, ` +
        `preserve behavior you don't fully understand, and verify with tests.`,
    );
  }

  if (notes.length > 0) {
    emit({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: `[codemaps] Before editing:\n${notes.join("\n\n")}`,
      },
    });
  }
  return 0;
}

async function sessionStart(repoRoot: string): Promise<number> {
  const risk = await loadRiskCache(repoRoot);
  if (!risk) return 0;
  const hot = Object.entries(risk.files)
    .filter(([, f]) => f.hotspotPercentile >= 90)
    .sort((a, b) => b[1].hotspotPercentile - a[1].hotspotPercentile)
    .slice(0, 5);
  if (hot.length === 0) return 0;
  // SessionStart: plain stdout is injected as context.
  console.log(
    `[codemaps] Repo risk snapshot (${risk.windowMonths}mo): hotspots — ` +
      hot.map(([p, f]) => `${p} (${f.hotspotPercentile}pct${f.busFactor === 1 ? ", single-owner" : ""})`).join(", ") +
      `. Call the codemaps risk/guardrails tools before editing these.`,
  );
  return 0;
}

async function loadRiskCache(repoRoot: string): Promise<RiskCache | null> {
  try {
    const raw = await readFile(path.join(repoRoot, ".codemaps", "risk.json"), "utf8");
    return JSON.parse(raw) as RiskCache;
  } catch {
    return null;
  }
}

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj));
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (buf += d));
    process.stdin.on("end", () => resolve(buf));
    // Defensive: if no stdin arrives, don't hang past hook budgets.
    setTimeout(() => resolve(buf), 3000).unref();
  });
}

// Suppress unused-import lint if StoredGuardrail is only used in types above.
export type { StoredGuardrail };
