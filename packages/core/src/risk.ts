/**
 * Risk lens — "where is this fragile?" (VISION §3 lens 5; DIFFERENTIATION §2)
 *
 * Derived entirely from `git log` + a cheap complexity proxy. Deliberately needs
 * NO code graph: this is the fastest moat signal and the first runnable
 * milestone of Phase 0. A commodity graph tool can say what connects to a file;
 * this says how dangerous it is to touch.
 *
 * Trust loop (VISION §2.6): every result is tagged with provenance and
 * confidence — Risk is "derived" (🟢), the highest tier, because it's computed
 * from history, not inferred.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export interface FileRisk {
  path: string; // repo-relative
  commits: number; // commits touching this file in the window
  churn: { added: number; deleted: number };
  lastTouched: string; // ISO date
  /** Author name -> share of commits touching this file, descending. */
  authors: { name: string; share: number }[];
  /** Smallest number of authors covering >50% of this file's changes. */
  busFactor: number;
  /** Line coverage % from lcov (coverage/lcov.info) — null if unavailable. */
  coverage: number | null;
  /** Lines of code (current) — part of the complexity proxy. */
  loc: number;
  /** Mean leading-indent depth — cheap nesting/complexity proxy, no parser. */
  indentDepth: number;
  /** changeFrequency × complexity, normalized to [0,1] within this repo. */
  hotspotScore: number;
  /** Percentile rank of hotspotScore among all files (0–100). */
  hotspotPercentile: number;
}

export interface RepoRiskIndex {
  repoRoot: string;
  windowMonths: number;
  generatedAt: string;
  totalCommits: number;
  files: Map<string, FileRisk>;
}

export interface RiskReport {
  /** The queried path (file or directory), repo-relative. */
  target: string;
  kind: "file" | "directory";
  files: FileRisk[]; // for a file query: length 1
  /** Directory roll-up (or the single file's numbers). */
  summary: {
    commits: number;
    churn: { added: number; deleted: number };
    hotspotPercentile: number; // max across files — risk doesn't average away
    busFactor: number; // min across files — weakest link
    topOwners: { name: string; share: number }[];
  };
  /** Human/agent-readable "slow down" flags, worst first. */
  warnings: string[];
  provenance: "derived";
  confidence: number;
}

// ---------------------------------------------------------------------------
// Git mining — one `git log --numstat` pass for the whole repo
// ---------------------------------------------------------------------------

interface RawFileStats {
  commits: number;
  added: number;
  deleted: number;
  lastTouched: number; // unix seconds
  authorCommits: Map<string, number>;
}

const COMMIT_PREFIX = "\u0001"; // sentinel byte: commit headers can never collide with numstat paths

async function git(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoRoot, ...args], {
    maxBuffer: 512 * 1024 * 1024,
  });
  return stdout;
}

/** Resolve `old => new` rename notation in numstat paths to the new path. */
function resolveNumstatPath(raw: string): string {
  // Forms: "a/{old => new}/b.ts", "old.ts => new.ts"
  const braced = raw.match(/^(.*)\{(?:[^{}]*) => ([^{}]*)\}(.*)$/);
  if (braced) {
    return (braced[1]! + braced[2]! + braced[3]!).replace(/\/\//g, "/");
  }
  const arrow = raw.indexOf(" => ");
  if (arrow >= 0) return raw.slice(arrow + 4);
  return raw;
}

/**
 * Parse lcov (coverage/lcov.info or lcov.info) into path -> line-coverage %.
 * Best-effort: coverage is CI-produced and may be stale; consumers must treat
 * it as advisory. Returns empty map when absent.
 */
async function parseLcov(repoRoot: string): Promise<Map<string, number>> {
  const coverage = new Map<string, number>();
  let raw: string | null = null;
  for (const candidate of ["coverage/lcov.info", "lcov.info", ".coverage/lcov.info"]) {
    try {
      raw = await readFile(path.join(repoRoot, candidate), "utf8");
      break;
    } catch {
      /* try next */
    }
  }
  if (!raw) return coverage;
  let current: string | null = null;
  let found = 0;
  let hit = 0;
  for (const line of raw.split("\n")) {
    if (line.startsWith("SF:")) {
      const p = line.slice(3).trim();
      current = path.isAbsolute(p) ? path.relative(repoRoot, p).replace(/\\/g, "/") : p.replace(/\\/g, "/");
      found = 0;
      hit = 0;
    } else if (line.startsWith("LF:")) found = Number(line.slice(3));
    else if (line.startsWith("LH:")) hit = Number(line.slice(3));
    else if (line.startsWith("end_of_record") && current) {
      coverage.set(current, found > 0 ? Math.round((hit / found) * 100) : 100);
      current = null;
    }
  }
  return coverage;
}

export async function buildRiskIndex(
  repoRoot: string,
  options: { windowMonths?: number } = {},
): Promise<RepoRiskIndex> {
  const windowMonths = options.windowMonths ?? 12;
  const lcov = await parseLcov(repoRoot);
  const log = await git(repoRoot, [
    "log",
    `--since=${windowMonths} months ago`,
    "--numstat",
    `--format=${COMMIT_PREFIX}%H%x09%an%x09%at`,
    "--no-merges",
  ]);

  const stats = new Map<string, RawFileStats>();
  let totalCommits = 0;
  let currentAuthor = "";
  let currentTime = 0;

  for (const line of log.split("\n")) {
    if (line.startsWith(COMMIT_PREFIX)) {
      const [, author, time] = line.slice(1).split("\t");
      currentAuthor = author ?? "unknown";
      currentTime = Number(time ?? 0);
      totalCommits++;
      continue;
    }
    if (!line.trim()) continue;
    const [addedRaw, deletedRaw, ...pathParts] = line.split("\t");
    if (pathParts.length === 0) continue;
    const filePath = resolveNumstatPath(pathParts.join("\t"));
    // Binary files report "-": count the commit, skip churn.
    const added = addedRaw === "-" ? 0 : Number(addedRaw);
    const deleted = deletedRaw === "-" ? 0 : Number(deletedRaw);

    let s = stats.get(filePath);
    if (!s) {
      s = { commits: 0, added: 0, deleted: 0, lastTouched: 0, authorCommits: new Map() };
      stats.set(filePath, s);
    }
    s.commits++;
    s.added += added;
    s.deleted += deleted;
    if (currentTime > s.lastTouched) s.lastTouched = currentTime;
    s.authorCommits.set(currentAuthor, (s.authorCommits.get(currentAuthor) ?? 0) + 1);
  }

  // Complexity proxy for files that still exist.
  const files = new Map<string, FileRisk>();
  let maxRawScore = 0;
  const rawScores = new Map<string, number>();

  for (const [filePath, s] of stats) {
    const { loc, indentDepth } = await complexityProxy(path.join(repoRoot, filePath));
    if (loc < 0) continue; // deleted or unreadable — history-only, skip ranking

    const authors = [...s.authorCommits.entries()]
      .map(([name, c]) => ({ name, share: c / s.commits }))
      .sort((a, b) => b.share - a.share);

    // Bus factor: fewest authors covering >50% of commits.
    let covered = 0;
    let busFactor = 0;
    for (const a of authors) {
      covered += a.share;
      busFactor++;
      if (covered > 0.5) break;
    }

    // Hotspot: change frequency × complexity (LOC weighted by nesting).
    const complexity = loc * (1 + indentDepth);
    const rawScore = s.commits * Math.log2(1 + complexity);
    rawScores.set(filePath, rawScore);
    if (rawScore > maxRawScore) maxRawScore = rawScore;

    files.set(filePath, {
      path: filePath,
      commits: s.commits,
      churn: { added: s.added, deleted: s.deleted },
      lastTouched: new Date(s.lastTouched * 1000).toISOString().slice(0, 10),
      authors,
      busFactor,
      coverage: lcov.get(filePath) ?? null,
      loc,
      indentDepth,
      hotspotScore: 0, // filled below
      hotspotPercentile: 0,
    });
  }

  // Normalize + percentile-rank.
  const sorted = [...rawScores.values()].sort((a, b) => a - b);
  for (const [filePath, raw] of rawScores) {
    const f = files.get(filePath)!;
    f.hotspotScore = maxRawScore > 0 ? raw / maxRawScore : 0;
    const below = lowerBound(sorted, raw);
    f.hotspotPercentile = sorted.length > 1 ? Math.round((below / (sorted.length - 1)) * 100) : 0;
  }

  return {
    repoRoot,
    windowMonths,
    generatedAt: new Date().toISOString(),
    totalCommits,
    files,
  };
}

function lowerBound(sorted: number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

async function complexityProxy(absPath: string): Promise<{ loc: number; indentDepth: number }> {
  try {
    const source = await readFile(absPath, "utf8");
    const lines = source.split("\n");
    let loc = 0;
    let indentSum = 0;
    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (!trimmed.trim()) continue;
      loc++;
      const leading = trimmed.length - trimmed.trimStart().length;
      indentSum += Math.floor(leading / 2); // 2-space depth unit; tabs count 1
    }
    return { loc, indentDepth: loc > 0 ? indentSum / loc : 0 };
  } catch {
    return { loc: -1, indentDepth: 0 };
  }
}

// ---------------------------------------------------------------------------
// Query — file or directory roll-up
// ---------------------------------------------------------------------------

const HOTSPOT_WARN_PERCENTILE = 80;
const RECENT_CHURN_DAYS = 30;

/** Compact per-file risk snapshot for fast hook lookups (.codemaps/risk.json). */
export interface RiskCache {
  generatedAt: string;
  windowMonths: number;
  files: Record<string, { hotspotPercentile: number; busFactor: number; commits: number; topOwner: string; coverage: number | null }>;
}

export function toRiskCache(index: RepoRiskIndex): RiskCache {
  const files: RiskCache["files"] = {};
  for (const [p, f] of index.files) {
    files[p] = {
      hotspotPercentile: f.hotspotPercentile,
      busFactor: f.busFactor,
      commits: f.commits,
      topOwner: f.authors[0]?.name ?? "unknown",
      coverage: f.coverage,
    };
  }
  return { generatedAt: index.generatedAt, windowMonths: index.windowMonths, files };
}

export function riskForPath(index: RepoRiskIndex, target: string): RiskReport | null {
  const rel = normalizeTarget(index.repoRoot, target);
  const exact = index.files.get(rel);
  const files = exact
    ? [exact]
    : [...index.files.values()].filter((f) => f.path.startsWith(rel.endsWith("/") ? rel : rel + "/"));

  if (files.length === 0) return null;

  const commits = files.reduce((n, f) => n + f.commits, 0);
  const added = files.reduce((n, f) => n + f.churn.added, 0);
  const deleted = files.reduce((n, f) => n + f.churn.deleted, 0);
  const hotspotPercentile = Math.max(...files.map((f) => f.hotspotPercentile));
  const busFactor = Math.min(...files.map((f) => f.busFactor));

  // Aggregate ownership across files, weighted by commits.
  const ownerTotals = new Map<string, number>();
  for (const f of files) {
    for (const a of f.authors) {
      ownerTotals.set(a.name, (ownerTotals.get(a.name) ?? 0) + a.share * f.commits);
    }
  }
  const topOwners = [...ownerTotals.entries()]
    .map(([name, weight]) => ({ name, share: weight / commits }))
    .sort((a, b) => b.share - a.share)
    .slice(0, 3);

  const warnings: string[] = [];
  const hottest = files.reduce((a, b) => (a.hotspotPercentile >= b.hotspotPercentile ? a : b));
  if (hottest.hotspotPercentile >= HOTSPOT_WARN_PERCENTILE) {
    warnings.push(
      `HOTSPOT: ${hottest.path} is in the ${ordinal(hottest.hotspotPercentile)} percentile ` +
        `(changed ${hottest.commits}x in ${index.windowMonths}mo, ~${hottest.loc} LOC). ` +
        `Frequently-changed complex code concentrates defect risk — change conservatively and verify with tests.`,
    );
  }
  if (busFactor === 1) {
    const solo = files.find((f) => f.busFactor === 1)!;
    const owner = solo.authors[0]?.name ?? "unknown";
    warnings.push(
      `BUS-FACTOR 1: ${solo.path} is effectively single-owner (${owner}, ` +
        `${Math.round((solo.authors[0]?.share ?? 0) * 100)}% of changes). ` +
        `Tacit knowledge likely lives with one person — do not assume undocumented behavior is safe to change.`,
    );
  }
  const weakSafetyNet = files.find(
    (f) => f.hotspotPercentile >= HOTSPOT_WARN_PERCENTILE && f.coverage !== null && f.coverage < 50,
  );
  if (weakSafetyNet) {
    warnings.push(
      `WEAK SAFETY NET: ${weakSafetyNet.path} is a hotspot with only ${weakSafetyNet.coverage}% line coverage. ` +
        `The tests will not catch most regressions here — pin current behavior with a characterization test before changing it.`,
    );
  }

  const daysSinceTouch = files
    .map((f) => (Date.now() - Date.parse(f.lastTouched)) / 86_400_000)
    .reduce((a, b) => Math.min(a, b), Infinity);
  if (daysSinceTouch <= RECENT_CHURN_DAYS && commits >= 5) {
    warnings.push(
      `ACTIVE CHURN: touched within the last ${Math.max(1, Math.round(daysSinceTouch))} day(s) ` +
        `with ${commits} commit(s) in the window — coordinate to avoid conflicting with in-flight work.`,
    );
  }

  return {
    target: rel,
    kind: exact ? "file" : "directory",
    files: files.sort((a, b) => b.hotspotPercentile - a.hotspotPercentile),
    summary: { commits, churn: { added, deleted }, hotspotPercentile, busFactor, topOwners },
    warnings,
    provenance: "derived",
    // High confidence: computed from history. Discounted slightly because the
    // complexity proxy (LOC × indent) is a heuristic stand-in for real complexity.
    confidence: 0.85,
  };
}

function normalizeTarget(repoRoot: string, target: string): string {
  const abs = path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);
  const rel = path.relative(repoRoot, abs);
  // If target was already repo-relative (and cwd isn't the repo), fall back to it.
  return rel.startsWith("..") ? target.replace(/^\.\//, "") : rel.replace(/\\/g, "/");
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}
