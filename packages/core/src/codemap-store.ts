/**
 * The versioned semantic layer — `codemap/guardrails.json`, committed with the
 * code (DIFFERENTIATION §1). This is where mined guardrails get promoted from
 * `proposed` to `confirmed` (or `rejected`) by a human, and where the trust
 * loop's provenance/override rules are enforced:
 *
 *  - A human decision is durable: re-mining NEVER silently overwrites a
 *    confirmed/rejected record (VISION §2.6 "override is remembered").
 *  - Rejected guardrails stay on file so the same proposal isn't re-surfaced.
 *  - JSON (not YAML) for Phase 0: zero deps, diff-reviewable, stable ordering.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { GuardrailFinding, GuardrailStatus } from "./guardrails.js";

export interface StoredGuardrail extends GuardrailFinding {
  /** Stable id: hash of (kind, path, statement-core) — survives line drift. */
  id: string;
  firstSeen: string; // ISO date
  decidedBy?: string; // git user.name at confirm/reject time
  decidedAt?: string;
}

export interface CodemapFile {
  version: 1;
  guardrails: StoredGuardrail[];
}

const CODEMAP_DIR = "codemap";
const GUARDRAILS_FILE = "guardrails.json";

export function guardrailId(f: GuardrailFinding): string {
  // Line numbers drift; statements + path + kind are the identity.
  const core = f.statement.replace(/\s+/g, " ").toLowerCase().slice(0, 120);
  return createHash("sha256").update(`${f.kind}|${f.path}|${core}`).digest("hex").slice(0, 12);
}

export async function loadCodemap(repoRoot: string): Promise<CodemapFile> {
  try {
    const raw = await readFile(path.join(repoRoot, CODEMAP_DIR, GUARDRAILS_FILE), "utf8");
    return JSON.parse(raw) as CodemapFile;
  } catch {
    return { version: 1, guardrails: [] };
  }
}

export async function saveCodemap(repoRoot: string, file: CodemapFile): Promise<void> {
  // Stable sort so diffs stay reviewable.
  file.guardrails.sort((a, b) => a.path.localeCompare(b.path) || a.id.localeCompare(b.id));
  const dir = path.join(repoRoot, CODEMAP_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, GUARDRAILS_FILE), JSON.stringify(file, null, 2) + "\n");
}

/**
 * Merge freshly-mined findings into the store. Human decisions win:
 *  - existing confirmed/rejected records are kept as-is (line refreshed only)
 *  - existing proposed records get refreshed (line/materiality may change)
 *  - new findings are added as proposed
 * Returns counts for reporting.
 */
export function mergeFindings(
  file: CodemapFile,
  mined: GuardrailFinding[],
  today: string,
): { added: number; refreshed: number; kept: number } {
  const byId = new Map(file.guardrails.map((g) => [g.id, g]));
  let added = 0;
  let refreshed = 0;
  let kept = 0;

  for (const f of mined) {
    const id = guardrailId(f);
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, { ...f, id, firstSeen: today });
      added++;
    } else if (existing.status === "proposed") {
      // Refresh location/materiality; keep identity + firstSeen.
      byId.set(id, { ...existing, line: f.line, material: f.material, materialWhy: f.materialWhy, confidence: f.confidence });
      refreshed++;
    } else {
      // confirmed/rejected: human decision is durable — only refresh the line.
      byId.set(id, { ...existing, line: f.line ?? existing.line });
      kept++;
    }
  }

  file.guardrails = [...byId.values()];
  return { added, refreshed, kept };
}

/** Promote/demote by id (or unambiguous id prefix). Returns the record or an error string. */
export function decide(
  file: CodemapFile,
  idPrefix: string,
  status: Exclude<GuardrailStatus, "proposed">,
  decidedBy: string,
  today: string,
): StoredGuardrail | string {
  const matches = file.guardrails.filter((g) => g.id.startsWith(idPrefix));
  if (matches.length === 0) return `no guardrail matches id "${idPrefix}"`;
  if (matches.length > 1) return `ambiguous id "${idPrefix}" (${matches.length} matches)`;
  const g = matches[0]!;
  g.status = status;
  g.decidedBy = decidedBy;
  g.decidedAt = today;
  return g;
}
