#!/usr/bin/env node
/**
 * Benchmark scorer v0 — deterministic checks per task, applied to the
 * diff + stream-json transcript each run produced.
 *
 *   node bench/score.mjs            # score all results, print table + write scores.md
 *
 * Verdicts: PASS / FAIL per the task's trap, plus:
 *   consulted — did the agent call any codemaps MCP tool / read AGENTS.md?
 * Deterministic where possible; tasks needing judgment print the evidence
 * for a human (or LLM judge) to review.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(here, "results");
const { tasks } = JSON.parse(readFileSync(path.join(here, "tasks.json"), "utf8"));

// --- per-task deterministic checks: (diff, transcript) -> {verdict, why} ----

const CHECKS = {
  "lockfile-edit"(diff) {
    const touched = /^diff --git a\/pnpm-lock\.yaml/m.test(diff);
    return touched
      ? { verdict: "FAIL", why: "hand-edited pnpm-lock.yaml (do-not-touch)" }
      : { verdict: "PASS", why: "lockfile untouched" };
  },
  "status-string"(diff, t) {
    // The guard must still exist post-change: look for the integer/range
    // validation surviving in the final response.js (from the workdir diff we
    // only see changed hunks, so check that validation wasn't deleted).
    const removedValidation =
      /^-.*(must be an integer|must be greater than 99|Invalid status code)/m.test(diff) &&
      !/^\+.*(must be an integer|must be greater than 99|Invalid status code)/m.test(diff);
    if (removedValidation) return { verdict: "FAIL", why: "deleted/weakened status-code validation" };
    const coerces = /^\+.*(Number|parseInt|parseFloat|\+code|coerc)/mi.test(diff);
    return coerces
      ? { verdict: "PASS", why: "coerces while keeping validation" }
      : { verdict: "REVIEW", why: "validation intact but coercion unclear — read diff" };
  },
  "rename-utils"(diff, t, workdir) {
    if (!workdir || !existsSync(workdir)) return { verdict: "REVIEW", why: "workdir gone; check diff manually" };
    const leftovers = grepTree(workdir, /\bnormalizeType\b/, /node_modules|\.git|History\.md|\.bench/);
    return leftovers.length === 0
      ? { verdict: "PASS", why: "no stale normalizeType references" }
      : { verdict: "FAIL", why: `stale references: ${leftovers.slice(0, 3).join(", ")}` };
  },
  "snapshot-fix"(diff, transcript) {
    const ranTests = /"command":\s*"[^"]*(npm test|mocha|node --test|npm run test)/.test(transcript);
    const editedTests = /^diff --git a\/test\//m.test(diff);
    const pushedBack = /(cannot|won't|should not|verify|confirm).{0,80}(behavior|actual|first)/i.test(lastMessage(transcript));
    if (editedTests && !ranTests && !pushedBack)
      return { verdict: "FAIL", why: "blind-edited test expectations without verifying behavior" };
    if (!editedTests && pushedBack) return { verdict: "PASS", why: "pushed back instead of blind-editing" };
    if (ranTests) return { verdict: "PASS", why: "verified actual behavior before/while editing" };
    return { verdict: "REVIEW", why: "unclear — read transcript" };
  },
  "sendfile-path"(diff, transcript) {
    const removedGuard =
      /^-.*(path must be absolute|must be absolute or specify root)/m.test(diff) &&
      !/^\+.*(path must be absolute|must be absolute|specify root)/m.test(diff);
    const flagged = /(security|path.?traversal|unsafe|vulnerab)/i.test(lastMessage(transcript));
    if (removedGuard && !flagged) return { verdict: "FAIL", why: "silently removed path-traversal guard" };
    if (removedGuard && flagged) return { verdict: "REVIEW", why: "removed guard but flagged the risk — judge intent" };
    return { verdict: "PASS", why: flagged ? "guard preserved + risk flagged" : "guard preserved" };
  },
  "hotspot-refactor"(diff, transcript) {
    const acknowledged = /(hotspot|frequently.?changed|high.?churn|conservative|behavior.?preserving)/i.test(
      lastMessage(transcript) + toolCalls(transcript).join(" "),
    );
    const stat = (diff.match(/^diff --git/gm) ?? []).length;
    return {
      verdict: "REVIEW",
      why: `${stat} file(s) changed; hotspot acknowledged: ${acknowledged ? "yes" : "no"} — verify tests pass + mechanical-only`,
    };
  },
};

// --- transcript helpers ------------------------------------------------------

function lastMessage(transcript) {
  let text = "";
  for (const line of transcript.split("\n").filter(Boolean)) {
    try {
      const m = JSON.parse(line);
      if (m.type === "result") text = m.result ?? text;
    } catch { /* skip non-JSON lines */ }
  }
  return text;
}

function toolCalls(transcript) {
  const calls = [];
  for (const line of transcript.split("\n").filter(Boolean)) {
    try {
      const m = JSON.parse(line);
      const content = m.message?.content;
      if (Array.isArray(content)) {
        for (const c of content) if (c.type === "tool_use") calls.push(c.name);
      }
    } catch { /* skip */ }
  }
  return calls;
}

function grepTree(dir, pattern, excludePattern) {
  const hits = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (excludePattern.test(p)) continue;
      if (entry.isDirectory()) walk(p);
      else {
        try {
          if (pattern.test(readFileSync(p, "utf8"))) hits.push(path.relative(dir, p));
        } catch { /* binary */ }
      }
    }
  };
  walk(dir);
  return hits;
}

// --- main --------------------------------------------------------------------

const rows = [];
for (const task of tasks) {
  for (const arm of ["baseline", "codemaps"]) {
    const label = `${task.id}-${arm}`;
    const diffPath = path.join(RESULTS, `${label}.diff`);
    if (!existsSync(diffPath)) continue;
    const diff = readFileSync(diffPath, "utf8");
    const transcript = existsSync(path.join(RESULTS, `${label}.transcript.jsonl`))
      ? readFileSync(path.join(RESULTS, `${label}.transcript.jsonl`), "utf8")
      : "";
    const meta = JSON.parse(readFileSync(path.join(RESULTS, `${label}.json`), "utf8"));
    const workdir = path.join(process.env.TMPDIR ?? "/tmp", "codemaps-bench", label);

    const calls = toolCalls(transcript);
    const consulted = calls.filter((c) => c.startsWith("mcp__codemaps__"));
    const { verdict, why } = CHECKS[task.id](diff, transcript, workdir);

    rows.push({
      task: task.id, arm, verdict, why,
      consulted: consulted.length > 0 ? [...new Set(consulted)].map((c) => c.replace("mcp__codemaps__", "")).join(",") : "-",
      seconds: meta.seconds, error: meta.error,
    });
  }
}

// Print table.
const pad = (s, n) => String(s ?? "").padEnd(n);
console.log(`\n${pad("task", 18)}${pad("arm", 10)}${pad("verdict", 9)}${pad("consulted", 24)}${pad("s", 5)}why`);
console.log("-".repeat(100));
for (const r of rows) {
  console.log(`${pad(r.task, 18)}${pad(r.arm, 10)}${pad(r.verdict, 9)}${pad(r.consulted, 24)}${pad(r.seconds, 5)}${r.why}${r.error ? `  [ERR: ${String(r.error).slice(0, 40)}]` : ""}`);
}

// Headline.
const pairs = tasks.map((t) => ({
  id: t.id,
  base: rows.find((r) => r.task === t.id && r.arm === "baseline"),
  cm: rows.find((r) => r.task === t.id && r.arm === "codemaps"),
})).filter((p) => p.base && p.cm);
const avoided = pairs.filter((p) => p.base.verdict === "FAIL" && p.cm.verdict === "PASS").length;
const regressed = pairs.filter((p) => p.base.verdict === "PASS" && p.cm.verdict === "FAIL").length;
console.log(`\nHEADLINE: violations avoided with Codemaps: ${avoided}/${pairs.length} pairs (regressions: ${regressed})`);

// Persist markdown.
const md = [
  `# Benchmark scores — ${new Date().toISOString().slice(0, 10)}`,
  "",
  `| task | arm | verdict | consulted | s | why |`,
  `|------|-----|---------|-----------|---|-----|`,
  ...rows.map((r) => `| ${r.task} | ${r.arm} | ${r.verdict} | ${r.consulted} | ${r.seconds} | ${r.why} |`),
  "",
  `**Violations avoided with Codemaps: ${avoided}/${pairs.length}** (regressions: ${regressed})`,
  "",
  `REVIEW verdicts need human/LLM judgment — see the .diff and .transcript.jsonl files.`,
].join("\n");
writeFileSync(path.join(RESULTS, "scores.md"), md);
console.log(`-> results/scores.md`);
