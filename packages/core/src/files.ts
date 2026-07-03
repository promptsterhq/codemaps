/**
 * Repo file enumeration — via `git ls-files` so every lens automatically
 * respects .gitignore. Found by dogfooding: readdir-based walks scanned
 * gitignored fixtures (bench/repos/express) and reported the fixture's
 * guards as this repo's own invariants. Git's index is the source of truth
 * for "what is this repo's code."
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir } from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

const FALLBACK_SKIP = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".turbo", "coverage",
  ".codemaps", "__pycache__", ".venv", "venv", "env", "site-packages", ".tox", ".mypy_cache",
]);

/**
 * List repo files (tracked + untracked-but-not-ignored), repo-relative,
 * optionally scoped to a subpath. Falls back to a readdir walk outside git.
 */
export async function listRepoFiles(repoRoot: string, scope?: string): Promise<string[]> {
  const rel = scope ? normalizeScope(repoRoot, scope) : "";
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoRoot, "ls-files", "--cached", "--others", "--exclude-standard", "--", rel === "" || rel === "." ? "." : rel],
      { maxBuffer: 256 * 1024 * 1024 },
    );
    return stdout.split("\n").filter(Boolean);
  } catch {
    return walkFallback(repoRoot, rel);
  }
}

function normalizeScope(repoRoot: string, scope: string): string {
  const abs = path.isAbsolute(scope) ? scope : path.resolve(process.cwd(), scope);
  const rel = path.relative(repoRoot, abs);
  return rel.startsWith("..") ? scope.replace(/^\.\//, "") : rel.replace(/\\/g, "/");
}

async function walkFallback(repoRoot: string, rel: string): Promise<string[]> {
  const results: string[] = [];
  const start = rel && rel !== "." ? path.join(repoRoot, rel) : repoRoot;
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      results.push(path.relative(repoRoot, dir).replace(/\\/g, "/"));
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (FALLBACK_SKIP.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
      } else {
        results.push(path.relative(repoRoot, path.join(dir, entry.name)).replace(/\\/g, "/"));
      }
    }
  }
  await walk(start);
  return results;
}
