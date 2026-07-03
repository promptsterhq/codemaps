/**
 * `codemaps check` engine — the PR-loop lens (Phase 2 drift detection).
 *
 * Answers, for a diff: did this change touch a do-not-touch zone, a guarded
 * invariant line, a security surface, or a high-risk hotspot — and what's the
 * blast radius? This is the "check in the workflow" survivor pattern
 * (docs/RESEARCH.md §A): the map as a recurring, funded decision.
 *
 * Severity follows the trust loop:
 *   fail  — edits a human-CONFIRMED do-not-touch zone (strictness is earned)
 *   warn  — proposed zones, guarded/security lines touched, hotspot risk
 *   info  — blast radius / review-routing context
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { buildRiskIndex, type RepoRiskIndex } from "./risk.js";
import { loadCodemap, type StoredGuardrail } from "./codemap-store.js";
import { scanSecurity, type SecurityFinding } from "./security.js";
import type { MutableGraph } from "./store.js";
import { impact } from "./query.js";

const execFileAsync = promisify(execFile);

export type CheckSeverity = "fail" | "warn" | "info";

export interface CheckFinding {
  severity: CheckSeverity;
  kind:
    | "confirmed-zone-edit"
    | "proposed-zone-edit"
    | "guarded-line-touched"
    | "security-surface-touched"
    | "hotspot-edit"
    | "weak-safety-net"
    | "blast-radius";
  file: string;
  line?: number;
  message: string;
}

export interface CheckReport {
  base: string;
  changedFiles: string[];
  findings: CheckFinding[]; // fails first, then warns, then info
  verdict: "fail" | "pass";
}

interface ChangedFile {
  path: string;
  /** Line ranges added/modified in the new version. */
  hunks: { start: number; end: number }[];
}

// ---------------------------------------------------------------------------
// Diff parsing
// ---------------------------------------------------------------------------

async function git(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoRoot, ...args], {
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Changed files + touched line ranges vs. `base` (merge-base semantics, like a
 * PR diff), including uncommitted working-tree changes.
 */
export async function collectChanges(repoRoot: string, base: string): Promise<ChangedFile[]> {
  let range = "HEAD";
  try {
    const mergeBase = (await git(repoRoot, ["merge-base", base, "HEAD"])).trim();
    range = mergeBase;
  } catch {
    // base ref missing (shallow clone, new repo) — fall back to comparing HEAD.
  }
  const diff = await git(repoRoot, ["diff", "--unified=0", "--no-color", range]);

  const files = new Map<string, ChangedFile>();
  let current: ChangedFile | null = null;
  for (const line of diff.split("\n")) {
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch) {
      const p = fileMatch[1]!;
      current = files.get(p) ?? { path: p, hunks: [] };
      files.set(p, current);
      continue;
    }
    if (line.startsWith("+++ /dev/null")) {
      current = null; // deletion — nothing in the new version to anchor to
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk && current) {
      const start = Number(hunk[1]);
      const count = hunk[2] !== undefined ? Number(hunk[2]) : 1;
      if (count > 0) current.hunks.push({ start, end: start + count - 1 });
    }
  }
  return [...files.values()];
}

const touches = (hunks: { start: number; end: number }[], line: number, slack = 2): boolean =>
  hunks.some((h) => line >= h.start - slack && line <= h.end + slack);

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

export async function runCheck(
  repoRoot: string,
  options: { base?: string; graph?: MutableGraph | null; riskIndex?: RepoRiskIndex },
): Promise<CheckReport> {
  const base = options.base ?? "main";
  const changes = await collectChanges(repoRoot, base);
  const changedFiles = changes.map((c) => c.path);
  const findings: CheckFinding[] = [];

  if (changes.length === 0) {
    return { base, changedFiles, findings, verdict: "pass" };
  }

  const codemap = await loadCodemap(repoRoot);
  const riskIndex = options.riskIndex ?? (await buildRiskIndex(repoRoot).catch(() => undefined));
  const security: SecurityFinding[] = await scanSecurity(repoRoot, changedFiles).catch(() => []);

  for (const change of changes) {
    const onFile = codemap.guardrails.filter(
      (g): g is StoredGuardrail =>
        g.status !== "rejected" &&
        (g.path === change.path || change.path.startsWith(g.path.endsWith("/") ? g.path : g.path + "/")),
    );

    // 1. Do-not-touch zones.
    const zone = onFile.find((g) => g.kind === "do-not-touch");
    if (zone && zone.status === "confirmed") {
      findings.push({
        severity: "fail",
        kind: "confirmed-zone-edit",
        file: change.path,
        message: `edits a CONFIRMED do-not-touch zone (${zone.reason}): ${zone.statement} [confirmed by ${zone.decidedBy ?? "a maintainer"}]`,
      });
    } else if (zone) {
      findings.push({
        severity: "warn",
        kind: "proposed-zone-edit",
        file: change.path,
        message: `edits a proposed do-not-touch zone (${zone.reason}): ${zone.statement} (confirm: codemaps guardrails confirm ${zone.id})`,
      });
    }

    // 2. Guarded invariant lines inside touched hunks.
    for (const g of onFile) {
      if (g.kind !== "invariant" || g.line === undefined) continue;
      if (!touches(change.hunks, g.line)) continue;
      const sec = g.security ? ` [SECURITY: ${g.security.category}] ${g.security.consequence}` : "";
      findings.push({
        severity: "warn",
        kind: "guarded-line-touched",
        file: change.path,
        line: g.line,
        message: `touches a ${g.status === "confirmed" ? "CONFIRMED" : "mined"} invariant: "${g.statement}"${sec}`,
      });
    }

    // 3. Security surface inside touched hunks (beyond stored guardrails).
    for (const s of security) {
      if (s.path !== change.path || !touches(change.hunks, s.line)) continue;
      findings.push({
        severity: "warn",
        kind: "security-surface-touched",
        file: change.path,
        line: s.line,
        message: `touches ${s.category} (${Math.round(s.confidence * 100)}% conf): ${s.consequence}`,
      });
    }

    // 4. Risk context.
    const risk = riskIndex?.files.get(change.path);
    if (risk) {
      if (risk.hotspotPercentile >= 90) {
        findings.push({
          severity: "warn",
          kind: "hotspot-edit",
          file: change.path,
          message: `is a ${risk.hotspotPercentile}th-percentile hotspot (${risk.commits} recent changes, bus-factor ${risk.busFactor}) — review with extra care`,
        });
      }
      if (risk.hotspotPercentile >= 80 && risk.coverage !== null && risk.coverage < 50) {
        findings.push({
          severity: "warn",
          kind: "weak-safety-net",
          file: change.path,
          message: `hotspot with only ${risk.coverage}% coverage — regressions here are unlikely to be caught by tests`,
        });
      }
    }

    // 5. Blast radius (info): symbols whose declarations overlap the hunks.
    if (options.graph) {
      const symbols = [...options.graph.nodes.values()].filter(
        (n) => n.loc?.path === change.path && n.kind !== "file" &&
          change.hunks.some((h) => n.loc!.startLine <= h.end && n.loc!.endLine >= h.start),
      );
      for (const sym of symbols.slice(0, 5)) {
        const r = impact(options.graph, sym.id);
        if (!r) continue;
        const total = r.directDependents.length + r.transitiveDependents.length;
        if (total === 0) continue;
        findings.push({
          severity: "info",
          kind: "blast-radius",
          file: change.path,
          line: sym.loc!.startLine,
          message: `${sym.name}: ${r.directDependents.length} direct / ${r.transitiveDependents.length} transitive dependents, ${r.affectedTests.length} test file(s) — re-run those tests`,
        });
      }
    }
  }

  const order: Record<CheckSeverity, number> = { fail: 0, warn: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file));

  return {
    base,
    changedFiles,
    findings,
    verdict: findings.some((f) => f.severity === "fail") ? "fail" : "pass",
  };
}

/** GitHub-flavored markdown summary — for PR comments / job summaries. */
export function checkReportMarkdown(report: CheckReport): string {
  const icon = { fail: "❌", warn: "⚠️", info: "ℹ️" } as const;
  const lines = [
    `## Codemaps check — ${report.verdict === "fail" ? "❌ fail" : "✅ pass"}`,
    "",
    `${report.changedFiles.length} file(s) changed vs \`${report.base}\` · ${report.findings.length} finding(s)`,
    "",
  ];
  if (report.findings.length > 0) {
    lines.push(`| | file | finding |`, `|---|------|---------|`);
    for (const f of report.findings) {
      lines.push(`| ${icon[f.severity]} | \`${f.file}${f.line ? `:${f.line}` : ""}\` | ${f.message.replace(/\|/g, "\\|")} |`);
    }
    lines.push("");
  }
  lines.push(
    `<sub>fail = human-confirmed do-not-touch zone edited · warn = advisory (guarded/security/hotspot) · Codemaps never blocks on unconfirmed findings</sub>`,
  );
  return lines.join("\n");
}
