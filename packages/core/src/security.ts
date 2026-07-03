/**
 * Security lens (beta) — "what's the security-critical surface here?"
 * (VISION §3 lens 6; DIFFERENTIATION §3)
 *
 * Heuristic, honestly-labeled detectors for the security-relevant context an
 * agent needs BEFORE changing code: guards that prevent path traversal, auth
 * gates, injection sinks, secrets, weak crypto. NOT a SAST replacement — this
 * surfaces "a security reviewer would look here," never a verdict.
 *
 * Born directly from benchmark failure sendfile-path (bench/ANALYSIS.md): both
 * arms removed a path-traversal guard because the mined invariant carried no
 * WHY. This lens attaches category + consequence — the "why" that gives an
 * advisory teeth ("removing this enables res.sendFile('../../etc/passwd')").
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

export type SecurityCategory =
  | "path-traversal-guard"
  | "auth-gate"
  | "injection-sink"
  | "secret"
  | "weak-crypto"
  | "unsafe-deserialization";

export interface SecurityFinding {
  category: SecurityCategory;
  path: string;
  line: number;
  /** The matched code (trimmed, truncated). */
  evidence: string;
  /** What a change here risks — the WHY. */
  consequence: string;
  provenance: "heuristic";
  confidence: number;
}

interface Detector {
  category: SecurityCategory;
  pattern: RegExp;
  consequence: string;
  confidence: number;
  /** Optional secondary condition on the surrounding window of lines. */
  near?: RegExp;
}

const DETECTORS: Detector[] = [
  {
    category: "path-traversal-guard",
    pattern: /(throw|raise|abort|reject).{0,120}(absolute|\.\.|traversal|outside|root)/i,
    near: /(sendFile|sendfile|readFile|createReadStream|writeFile|open\(|download|static|unlink|copyFile|os\.path|pathlib)/,
    consequence:
      "This guard constrains filesystem paths. Removing or loosening it can enable path traversal — e.g. serving '../../etc/passwd' or writing outside the intended directory.",
    confidence: 0.7,
  },
  {
    category: "path-traversal-guard",
    pattern: /(isAbsolute|path\.resolve|os\.path\.realpath|startsWith\(root|normalize)\s*\(.{0,80}(\?|if|&&|\|\||throw|raise|return)/i,
    near: /(sendFile|readFile|createReadStream|writeFile|download|static|open\()/,
    consequence:
      "Path normalization/containment check near filesystem access. Weakening it risks path traversal outside the intended root.",
    confidence: 0.6,
  },
  {
    category: "auth-gate",
    pattern: /(requireAuth|isAuthenticated|ensureLoggedIn|authorize|checkPermission|hasRole|verifyToken|jwt\.verify|login_required|permission_required|@auth|passport\.authenticate)/,
    consequence:
      "Authentication/authorization gate. Changes that skip, reorder, or weaken it can expose the route/action to unauthenticated or unprivileged callers (privilege escalation).",
    confidence: 0.65,
  },
  {
    category: "injection-sink",
    pattern: /(child_process\.(exec|execSync)\(|\bexec(Sync)?\(\s*[`'"].*\$\{|eval\(|new Function\(|subprocess\.(call|run|Popen)\(.{0,40}shell\s*=\s*True|os\.system\()/,
    consequence:
      "Command-execution sink. If attacker-influenced input can reach this call, it's command injection. Changes here need input provenance review.",
    confidence: 0.7,
  },
  {
    category: "injection-sink",
    pattern: /\.(query|execute)\s*\(\s*(`[^`]*\$\{|['"][^'"]*['"]\s*\+|f['"])/,
    consequence:
      "SQL built by string interpolation/concatenation — an injection sink. Prefer parameterized queries; changes here need input provenance review.",
    confidence: 0.65,
  },
  {
    category: "secret",
    pattern: /(api[_-]?key|secret|token|password|passwd)\s*[:=]\s*['"][A-Za-z0-9+/_-]{16,}['"]|-----BEGIN (RSA |EC )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}/i,
    consequence:
      "Possible hardcoded secret. If real, it's exposed to anyone with repo access and to every model/tool that reads this file — rotate and move to env/secret storage.",
    confidence: 0.6,
  },
  {
    category: "weak-crypto",
    pattern: /\b(md5|sha1)\s*\(|createHash\(\s*['"](md5|sha1)['"]|Math\.random\(\).{0,60}(token|secret|password|session|key)/i,
    consequence:
      "Weak primitive in a security context (MD5/SHA1 are broken for integrity/passwords; Math.random is predictable). Don't extend its use; flag for migration.",
    confidence: 0.55,
  },
  {
    category: "unsafe-deserialization",
    pattern: /pickle\.loads?\(|yaml\.load\((?![^)]*SafeLoader)|unserialize\(|Marshal\.load/,
    consequence:
      "Unsafe deserialization of potentially untrusted data can lead to remote code execution. Changes routing new input here need trust review.",
    confidence: 0.65,
  },
];

const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".java", ".php", ".cs", ".yaml", ".yml", ".env"]);
const NEAR_WINDOW = 10; // lines around a match to satisfy `near`

export async function scanSecurity(repoRoot: string, files: string[]): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = [];
  for (const rel of files) {
    if (!SCAN_EXTENSIONS.has(path.extname(rel)) && !rel.endsWith(".env")) continue;
    let source: string;
    try {
      source = await readFile(path.join(repoRoot, rel), "utf8");
    } catch {
      continue;
    }
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.length > 500) continue; // minified/vendored noise
      for (const d of DETECTORS) {
        if (!d.pattern.test(line)) continue;
        if (d.near) {
          const lo = Math.max(0, i - NEAR_WINDOW);
          const hi = Math.min(lines.length, i + NEAR_WINDOW);
          const window = lines.slice(lo, hi).join("\n");
          if (!d.near.test(window)) continue;
        }
        findings.push({
          category: d.category,
          path: rel,
          line: i + 1,
          evidence: line.trim().slice(0, 140),
          consequence: d.consequence,
          provenance: "heuristic",
          confidence: d.confidence,
        });
        break; // one finding per line
      }
    }
  }
  return findings;
}

/**
 * The sendfile fix: enrich a mined invariant statement with security context
 * when a security finding sits on/near the same lines. Returns the enriched
 * statement + boosted confidence, or null if no security relevance.
 */
export function securityEnrichment(
  finding: { path: string; line?: number },
  security: SecurityFinding[],
): { category: SecurityCategory; consequence: string } | null {
  if (finding.line === undefined) return null;
  const hit = security.find(
    (s) => s.path === finding.path && Math.abs(s.line - finding.line!) <= 3,
  );
  return hit ? { category: hit.category, consequence: hit.consequence } : null;
}
