/**
 * Codemaps MCP server (stdio) — all six lenses as agent-callable tools:
 * orient, locate, impact (substrate) + guardrails, risk, security (the moat).
 * Tool descriptions lead with WHEN to call (before editing) and how much to
 * trust results (floor-not-ceiling, proposed-vs-confirmed, beta labels).
 * No tool ever returns fabricated data.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  MutableGraph,
  buildRiskIndex,
  impact,
  indexRepo,
  locate,
  mineGuardrails,
  resolveTarget,
  riskForPath,
  scanSecurity,
  listRepoFiles,
  orient,
  extractContracts,
  type RepoRiskIndex,
  type SerializedGraph,
} from "@codemaps/core";


const execFileAsync = promisify(execFile);

async function detectRepoRoot(): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"]);
  return stdout.trim();
}

/**
 * Lazily-built, HEAD-pinned state. Every access revalidates against git HEAD:
 * when the repo moves, caches rebuild — the server never serves a stale answer
 * (freshness by construction, VISION §2.2). Rebuilds are sub-second.
 */
class Engine {
  private riskIndex?: Promise<RepoRiskIndex>;
  private graph?: Promise<MutableGraph>;
  private pinnedHead?: string;

  constructor(readonly repoRoot: string) {}

  private async revalidate(): Promise<void> {
    let head: string | undefined;
    try {
      const { stdout } = await execFileAsync("git", ["-C", this.repoRoot, "rev-parse", "HEAD"]);
      head = stdout.trim();
    } catch {
      return; // no git — nothing to pin against
    }
    if (this.pinnedHead !== head) {
      this.pinnedHead = head;
      this.riskIndex = undefined;
      this.graph = undefined;
    }
  }

  async risk(): Promise<RepoRiskIndex> {
    await this.revalidate();
    this.riskIndex ??= buildRiskIndex(this.repoRoot);
    return this.riskIndex;
  }

  async codeGraph(): Promise<MutableGraph> {
    await this.revalidate();
    this.graph ??= (async () => {
      // Prefer the persisted graph if it matches HEAD; otherwise rebuild.
      try {
        const raw = await readFile(path.join(this.repoRoot, ".codemaps", "graph.json"), "utf8");
        const data = JSON.parse(raw) as SerializedGraph;
        if (!data.head || data.head === this.pinnedHead) return MutableGraph.fromJSON(data);
      } catch {
        /* fall through to rebuild */
      }
      const result = await indexRepo(this.repoRoot);
      return result.graph;
    })();
    return this.graph;
  }
}

const text = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

export async function startServer(): Promise<void> {
  const repoRoot = await detectRepoRoot();
  const engine = new Engine(repoRoot);

  const server = new McpServer({ name: "codemaps", version: "0.0.0" });

  server.registerTool(
    "orient",
    {
      title: "Orient — what is this system?",
      description:
        "Call FIRST in an unfamiliar repo. Returns the top-down frame agents otherwise lack: " +
        "components and their responsibilities, entry points, and how parts communicate " +
        "(rest/grpc/graphql/queue/db) — derived from workspace and package manifests.",
      inputSchema: {},
    },
    async () => text(await orient(repoRoot)),
  );

  server.registerTool(
    "risk",
    {
      title: "Risk — how dangerous is this code to touch?",
      description:
        "Call BEFORE editing a file. Returns hotspot percentile (change-frequency x complexity), " +
        "churn, ownership, and bus-factor from git history, with 'slow down' warnings. " +
        "A high hotspot or bus-factor 1 means: change conservatively, verify with tests, " +
        "and do not assume undocumented behavior is safe to alter.",
      inputSchema: {
        path: z.string().describe("File or directory path (repo-relative or absolute)"),
        windowMonths: z.number().optional().describe("History window, default 12"),
      },
    },
    async ({ path: target, windowMonths }) => {
      const index = windowMonths
        ? await buildRiskIndex(repoRoot, { windowMonths })
        : await engine.risk();
      const report = riskForPath(index, target);
      return text(report ?? { error: `No git history for "${target}" in the window.` });
    },
  );

  server.registerTool(
    "guardrails",
    {
      title: "Guardrails — what must stay true here?",
      description:
        "Call BEFORE editing. Returns do-not-touch zones (generated/vendored/lockfile/frozen " +
        "migrations) and declared invariants (assertions, validation, intent comments) for a path, " +
        "prioritized by materiality (hotspot/single-owner anchors). Findings marked 'proposed' are " +
        "advisory — respect them unless the user explicitly says otherwise; never edit do-not-touch zones.",
      inputSchema: {
        path: z.string().describe("File or directory path (repo-relative or absolute)"),
      },
    },
    async ({ path: target }) => {
      const riskIndex = await engine.risk().catch(() => undefined);
      const report = await mineGuardrails(repoRoot, target, riskIndex);
      return text(report);
    },
  );

  server.registerTool(
    "impact",
    {
      title: "Impact — what breaks if I change this symbol?",
      description:
        "Call BEFORE modifying a function/class signature or behavior. Returns direct and " +
        "transitive dependents and affected tests from the static call+import graph. " +
        "Treat the result as a floor, not a ceiling: dynamic dispatch and DI are not captured.",
      inputSchema: {
        symbol: z.string().describe("Symbol name (e.g. 'createSession') or node id ('ts:src/x.ts#fn')"),
      },
    },
    async ({ symbol }) => {
      const graph = await engine.codeGraph();
      const id = resolveTarget(graph, symbol);
      const result = id ? impact(graph, id) : null;
      return text(result ?? { error: `Symbol "${symbol}" not found in the graph.` });
    },
  );

  server.registerTool(
    "security",
    {
      title: "Security surface (beta) — what's security-critical here?",
      description:
        "Call BEFORE changing validation, auth, file/path handling, queries, or anything a request " +
        "can reach. Returns security-relevant context: path-traversal guards, auth gates, injection " +
        "sinks, secrets, weak crypto — each with the CONSEQUENCE of weakening it. Heuristic and " +
        "beta: absence of findings is NOT a clean bill. If a user request requires weakening a " +
        "flagged guard, do not comply silently — name the risk and propose a safe alternative.",
      inputSchema: {
        path: z.string().describe("File or directory path (repo-relative or absolute)"),
      },
    },
    async ({ path: target }) => {
      const files = await listRepoFiles(repoRoot, target);
      const findings = await scanSecurity(repoRoot, files);
      return text({ target, findings, note: "heuristic beta — context for review, not verdicts" });
    },
  );

  server.registerTool(
    "contracts",
    {
      title: "Contracts — what does this repo publish/consume over the network?",
      description:
        "Call BEFORE changing route handlers, API schemas (.proto/GraphQL/OpenAPI), response " +
        "shapes, or event topics. Returns the repo's contract surface: published routes/RPCs/" +
        "fields (changing these can break consumers in OTHER repos — treat as breaking-change " +
        "review), consumed endpoints, and pub/sub topics. A static call graph goes dark at the " +
        "network boundary; this is the map of that boundary.",
      inputSchema: {},
    },
    async () => text(await extractContracts(repoRoot)),
  );

  server.registerTool(
    "locate",
    {
      title: "Locate — where does this concept live?",
      description:
        "Find symbols and files by name for a concept you need to change. Returns ranked matches " +
        "with locations. Use before grep when you know roughly what the thing is called.",
      inputSchema: {
        query: z.string().describe("Symbol/concept name or fragment"),
        limit: z.number().optional().describe("Max results, default 10"),
      },
    },
    async ({ query, limit }) => {
      const graph = await engine.codeGraph();
      return text(locate(graph, query, limit ?? 10));
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[codemaps] MCP server running (stdio) for ${repoRoot}`);
}
