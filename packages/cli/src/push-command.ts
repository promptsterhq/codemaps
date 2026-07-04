/**
 * `codemaps push` — upload this repo's artifacts to Codemaps cloud.
 *
 * Complements the GitHub App: the App auto-indexes contracts+guardrails on
 * push, but can't compute the Risk lens (no git history in its runtime).
 * `codemaps push` runs locally/CI where git lives, and ships all three.
 *
 *   CODEMAPS_API_KEY=cmk_...  codemaps push [--repo owner/name] [--url https://...]
 *
 * The API key is org-scoped (create one on the dashboard); the server derives
 * the org from it — no org id needed here.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  buildRiskIndex,
  extractContracts,
  mineGuardrails,
  toRiskCache,
} from "@codemaps/core";

const execFileAsync = promisify(execFile);
const DEFAULT_URL = "https://codemaps-schinizels-projects.vercel.app";

export async function runPush(args: string[]): Promise<number> {
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const url = flag("--url") ?? process.env.CODEMAPS_URL ?? DEFAULT_URL;
  const key = flag("--key") ?? process.env.CODEMAPS_API_KEY;
  if (!key?.startsWith("cmk_")) {
    console.error("codemaps push: set CODEMAPS_API_KEY (cmk_...) — create one on the dashboard.");
    return 2;
  }

  let repoRoot: string;
  let head: string;
  try {
    repoRoot = (await execFileAsync("git", ["rev-parse", "--show-toplevel"])).stdout.trim();
    head = (await execFileAsync("git", ["rev-parse", "HEAD"])).stdout.trim();
  } catch {
    console.error("codemaps push: not inside a git repository.");
    return 1;
  }

  const repo = flag("--repo") ?? (await detectRepoName(repoRoot));
  if (!repo) {
    console.error("codemaps push: cannot derive repo name (no origin remote) — pass --repo owner/name.");
    return 2;
  }

  console.log(`[codemaps] analyzing ${repo} @ ${head.slice(0, 8)} …`);
  const riskIndex = await buildRiskIndex(repoRoot);
  const risk = toRiskCache(riskIndex);
  const contracts = await extractContracts(repoRoot);
  const guardrails = await mineGuardrails(repoRoot, ".", riskIndex);

  const res = await fetch(`${url}/api/snapshots`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      repo,
      git_head: head,
      contracts,
      risk,
      guardrails: { findings: [...guardrails.findings, ...guardrails.suppressed] },
    }),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    console.error(`codemaps push: ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
    return 1;
  }

  console.log(
    `[codemaps] pushed: ${contracts.serves.length} served, ${contracts.calls.length} called, ` +
      `${Object.keys(risk.files).length} risk file(s), ${guardrails.findings.length} guardrail(s) ` +
      `-> snapshot ${String(data.snapshot_id ?? "").slice(0, 8)}`,
  );
  return 0;
}

/** owner/name from the origin remote (git@ or https forms). */
async function detectRepoName(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoRoot, "remote", "get-url", "origin"]);
    const m = stdout.trim().match(/[:/]([^/:]+\/[^/]+?)(\.git)?$/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}
