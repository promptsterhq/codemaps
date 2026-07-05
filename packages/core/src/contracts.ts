/**
 * Contract surface — what this repo PUBLISHES and CONSUMES across the network
 * (VISION §3 Impact tier b; DIFFERENTIATION §6).
 *
 * A static graph goes dark at the service boundary: Service A -> Service B is
 * an HTTP/gRPC/queue hop, not an import edge — and that boundary is where
 * change risk is highest. This module extracts, per repo:
 *   serves : routes/RPCs/fields this repo answers (its published API)
 *   calls  : HTTP endpoints it invokes (its consumed APIs)
 *   events : topics/queues it publishes or subscribes to
 *   idl    : typed contracts on disk (proto / GraphQL / OpenAPI)
 *
 * Locally this powers the "you are editing a published contract" flag in
 * `codemaps check`. In the cloud (Phase 3) these surfaces from many repos are
 * stitched by contract identity into the org-wide service graph — only this
 * small artifact leaves the machine, never source.
 *
 * Identity keys (the stitch join): "http:GET /v1/invoices",
 * "grpc:billing.Billing/Finalize", "graphql:Query.invoice", "event:invoice.paid".
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { listRepoFiles } from "./files.js";

export interface ServedContract {
  kind: "http" | "grpc" | "graphql";
  /** Identity key, e.g. "http:GET /v1/invoices". */
  id: string;
  method?: string;
  route: string;
  file: string;
  line: number;
  via: string; // framework/detector
  confidence: number;
}

export interface CalledContract {
  kind: "http";
  id: string;
  method?: string;
  url: string;
  file: string;
  line: number;
  via: string;
  confidence: number;
}

export interface EventContract {
  role: "publish" | "subscribe";
  id: string; // "event:<topic>"
  topic: string;
  file: string;
  line: number;
  via: string;
  confidence: number;
}

export interface ContractSurface {
  serves: ServedContract[];
  calls: CalledContract[];
  events: EventContract[];
  provenance: "heuristic";
}

// ---------------------------------------------------------------------------
// Detectors (line-oriented, thin, precision over recall)
// ---------------------------------------------------------------------------

const HTTP_METHODS = "get|post|put|patch|delete|head|options|all";

interface ServeRule {
  pattern: RegExp;
  via: string;
  confidence: number;
  /** map match -> {method, route} */
  extract: (m: RegExpMatchArray) => { method: string; route: string } | null;
}

const SERVE_RULES: ServeRule[] = [
  {
    // express/koa-router/fastify/hono: app.get('/x'), router.post("/y", ...)
    pattern: new RegExp(`\\b(?:app|router|server|fastify|api)\\.(${HTTP_METHODS})\\s*\\(\\s*['"\`]([/][^'"\`]*)['"\`]`, "i"),
    via: "express-style",
    confidence: 0.8,
    extract: (m) => ({ method: m[1]!.toUpperCase(), route: m[2]! }),
  },
  {
    // NestJS: @Get('/x') @Post() — route may be empty (controller base unknown here)
    pattern: new RegExp(`@(Get|Post|Put|Patch|Delete|Head|Options)\\s*\\(\\s*(?:['"\`]([^'"\`]*)['"\`])?\\s*\\)`),
    via: "nestjs",
    confidence: 0.7,
    extract: (m) => ({ method: m[1]!.toUpperCase(), route: m[2] ?? "" }),
  },
  {
    // FastAPI / Flask-style decorators: @app.get("/x"), @router.post('/y'), @app.route('/z', methods=["POST"])
    pattern: new RegExp(`@\\w+\\.(${HTTP_METHODS}|route)\\s*\\(\\s*['"]([/][^'"]*)['"]`, "i"),
    via: "python-decorator",
    confidence: 0.8,
    extract: (m) => ({ method: m[1]!.toLowerCase() === "route" ? "ANY" : m[1]!.toUpperCase(), route: m[2]! }),
  },
];

const CALL_RULES: { pattern: RegExp; via: string; confidence: number }[] = [
  // fetch/axios/got/requests/httpx with an absolute-or-rooted URL literal
  { pattern: /\bfetch\s*\(\s*[`'"](https?:\/\/[^'"`\s]+|\/[^'"`\s]*)[`'"]/, via: "fetch", confidence: 0.7 },
  { pattern: /\baxios\.(get|post|put|patch|delete)\s*\(\s*[`'"](https?:\/\/[^'"`\s]+|\/[^'"`\s]*)[`'"]/, via: "axios", confidence: 0.75 },
  { pattern: /\b(?:requests|httpx)\.(get|post|put|patch|delete)\s*\(\s*['"](https?:\/\/[^'"\s]+|\/[^'"\s]*)['"]/, via: "python-http", confidence: 0.75 },
];

const EVENT_RULES: { pattern: RegExp; role: "publish" | "subscribe"; via: string; confidence: number }[] = [
  { pattern: /\.send\s*\(\s*\{[^}]*topic\s*:\s*['"`]([^'"`]+)['"`]/, role: "publish", via: "kafka", confidence: 0.7 },
  { pattern: /\.subscribe\s*\(\s*\{[^}]*topics?\s*:\s*\[?\s*['"`]([^'"`]+)['"`]/, role: "subscribe", via: "kafka", confidence: 0.7 },
  { pattern: /\.publish\s*\(\s*['"`]([^'"`]+)['"`]/, role: "publish", via: "amqp/nats", confidence: 0.6 },
  { pattern: /\.(?:consume|process)\s*\(\s*['"`]([^'"`]+)['"`]/, role: "subscribe", via: "amqp/bull", confidence: 0.6 },
  { pattern: /queue\.add\s*\(\s*['"`]([^'"`]+)['"`]/, role: "publish", via: "bullmq", confidence: 0.6 },
];

const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"]);

/** Contracts in test files aren't published/consumed by the running service. */
const TEST_FILE = /(\.test\.|\.spec\.|__tests__\/|(^|\/)tests?\/|(^|\/)test_[^/]+\.py$|_test\.(py|go|ts|js)$)/;

/** Comment lines describe contracts; they don't serve them. */
const COMMENT_LINE = /^\s*(\/\/|\*|#|\/\*)/;

// ---------------------------------------------------------------------------
// Next.js — the route is the FILE PATH, not a line pattern, so these are
// file-level detectors rather than SERVE_RULES entries.
// ---------------------------------------------------------------------------

/** App Router handler: {...}/app/{segments}/route.ts exporting GET/POST/… */
const NEXT_APP_ROUTE_FILE = /(?:^|\/)app\/(?:(.+)\/)?route\.(?:ts|tsx|js|jsx|mjs)$/;
const NEXT_METHOD_EXPORT =
  /^export\s+(?:async\s+)?(?:function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b|const\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*=)/;
/** Pages Router API file: {...}/pages/api/{path}.ts with a default-export handler. */
const NEXT_PAGES_API_FILE = /(?:^|\/)pages\/api\/(.+)\.(?:ts|tsx|js|jsx|mjs)$/;
/** [id], [...slug], [[...slug]] — Next's dynamic-segment spellings. */
const NEXT_DYNAMIC_SEGMENT = /^\[{1,2}\.{0,3}[^\]]+\]{1,2}$/;

/** app-dir segments -> URL path: drop (groups) and @slots, brackets -> {param}. */
function nextRouteFromSegments(middle: string | undefined): string | null {
  if (!middle) return "/";
  const out: string[] = [];
  for (const seg of middle.split("/")) {
    if (!seg || (seg.startsWith("(") && seg.endsWith(")")) || seg.startsWith("@")) continue;
    if (seg.includes("(")) return null; // intercepting routes — skip, precision over recall
    out.push(NEXT_DYNAMIC_SEGMENT.test(seg) ? "{param}" : seg);
  }
  return `/${out.join("/")}`;
}

function nextServes(rel: string, lines: string[]): ServedContract[] {
  const serves: ServedContract[] = [];
  const app = rel.match(NEXT_APP_ROUTE_FILE);
  if (app) {
    const route = nextRouteFromSegments(app[1]);
    if (!route) return serves;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i]!.match(NEXT_METHOD_EXPORT);
      if (!m) continue;
      const method = (m[1] ?? m[2])!;
      serves.push({
        kind: "http",
        id: `http:${method} ${normalizeRoute(route)}`,
        method,
        route,
        file: rel,
        line: i + 1,
        via: "nextjs-route-handler",
        confidence: 0.8, // path-derived route: more reliable than string-matched
      });
    }
    return serves;
  }
  const pages = rel.match(NEXT_PAGES_API_FILE);
  if (pages && lines.some((l) => /^export\s+default\b/.test(l))) {
    const route =
      `/api/${pages[1]!}`
        .replace(/\/index$/, "")
        .split("/")
        .map((seg) => (NEXT_DYNAMIC_SEGMENT.test(seg) ? "{param}" : seg))
        .join("/") || "/api";
    // Pages handlers dispatch on req.method themselves — method is unknowable
    // statically, so ANY (same convention as Flask @app.route).
    serves.push({
      kind: "http",
      id: `http:ANY ${normalizeRoute(route)}`,
      method: "ANY",
      route,
      file: rel,
      line: 1,
      via: "nextjs-pages-api",
      confidence: 0.75,
    });
  }
  return serves;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export async function extractContracts(repoRoot: string): Promise<ContractSurface> {
  const files = await listRepoFiles(repoRoot);
  const serves: ServedContract[] = [];
  const calls: CalledContract[] = [];
  const events: EventContract[] = [];

  for (const rel of files) {
    const ext = path.extname(rel);

    // Typed IDL files — the highest-confidence contracts.
    if (ext === ".proto") {
      serves.push(...(await protoContracts(repoRoot, rel)));
      continue;
    }
    if (ext === ".graphql" || ext === ".gql") {
      serves.push(...(await graphqlContracts(repoRoot, rel)));
      continue;
    }
    if (/(^|\/)(openapi|swagger)[^/]*\.(ya?ml|json)$/i.test(rel)) {
      serves.push(...(await openapiContracts(repoRoot, rel)));
      continue;
    }

    if (!SOURCE_EXT.has(ext) || TEST_FILE.test(rel)) continue;
    let source: string;
    try {
      source = await readFile(path.join(repoRoot, rel), "utf8");
    } catch {
      continue;
    }
    const lines = source.split("\n");
    serves.push(...nextServes(rel, lines));
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.length > 400 || COMMENT_LINE.test(line)) continue;

      for (const rule of SERVE_RULES) {
        const m = line.match(rule.pattern);
        if (!m) continue;
        const extracted = rule.extract(m);
        if (!extracted || extracted.route === "") break; // NestJS empty route: skip, base unknown
        serves.push({
          kind: "http",
          id: `http:${extracted.method} ${normalizeRoute(extracted.route)}`,
          method: extracted.method,
          route: extracted.route,
          file: rel,
          line: i + 1,
          via: rule.via,
          confidence: rule.confidence,
        });
        break;
      }

      for (const rule of CALL_RULES) {
        const m = line.match(rule.pattern);
        if (!m) continue;
        const url = m[2] ?? m[1]!;
        const method = (m[2] ? m[1]! : "GET").toUpperCase();
        calls.push({
          kind: "http",
          id: `http:${method} ${normalizeRoute(pathOf(url))}`,
          method,
          url,
          file: rel,
          line: i + 1,
          via: rule.via,
          confidence: rule.confidence,
        });
        break;
      }

      for (const rule of EVENT_RULES) {
        const m = line.match(rule.pattern);
        if (!m) continue;
        events.push({
          role: rule.role,
          id: `event:${m[1]!}`,
          topic: m[1]!,
          file: rel,
          line: i + 1,
          via: rule.via,
          confidence: rule.confidence,
        });
        break;
      }
    }
  }

  return { serves, calls, events, provenance: "heuristic" };
}

/** Route templates unify for identity: /users/:id ≡ /users/{id} ≡ /users/<id>. */
export function normalizeRoute(route: string): string {
  return route
    .replace(/:\w+/g, "{param}")
    .replace(/\{[^}]+\}/g, "{param}")
    .replace(/<[^>]+>/g, "{param}")
    .replace(/\/+$/, "") || "/";
}

function pathOf(url: string): string {
  try {
    return url.startsWith("/") ? url : new URL(url).pathname;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// IDL parsers (regex-light, deliberately shallow)
// ---------------------------------------------------------------------------

async function protoContracts(repoRoot: string, rel: string): Promise<ServedContract[]> {
  const source = await readFile(path.join(repoRoot, rel), "utf8").catch(() => "");
  const pkg = source.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1];
  const out: ServedContract[] = [];
  const lines = source.split("\n");
  let service: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const svc = lines[i]!.match(/^\s*service\s+(\w+)/);
    if (svc) service = svc[1]!;
    const rpc = lines[i]!.match(/^\s*rpc\s+(\w+)/);
    if (rpc && service) {
      const full = `${pkg ? pkg + "." : ""}${service}/${rpc[1]}`;
      out.push({
        kind: "grpc",
        id: `grpc:${full}`,
        route: full,
        file: rel,
        line: i + 1,
        via: "proto",
        confidence: 0.95, // typed IDL — the stitch-first tier (DIFFERENTIATION §6)
      });
    }
  }
  return out;
}

async function graphqlContracts(repoRoot: string, rel: string): Promise<ServedContract[]> {
  const source = await readFile(path.join(repoRoot, rel), "utf8").catch(() => "");
  const out: ServedContract[] = [];
  const lines = source.split("\n");
  let root: "Query" | "Mutation" | "Subscription" | null = null;
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const typeMatch = line.match(/^\s*(?:extend\s+)?type\s+(Query|Mutation|Subscription)\b/);
    if (typeMatch) {
      root = typeMatch[1] as "Query" | "Mutation" | "Subscription";
      depth = 0;
    }
    if (root) {
      depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
      const field = line.match(/^\s{2,}(\w+)\s*(?:\([^)]*\))?\s*:/);
      if (field && depth > 0) {
        out.push({
          kind: "graphql",
          id: `graphql:${root}.${field[1]}`,
          route: `${root}.${field[1]}`,
          file: rel,
          line: i + 1,
          via: "graphql-sdl",
          confidence: 0.9,
        });
      }
      if (depth <= 0 && i > 0 && line.includes("}")) root = null;
    }
  }
  return out;
}

async function openapiContracts(repoRoot: string, rel: string): Promise<ServedContract[]> {
  const source = await readFile(path.join(repoRoot, rel), "utf8").catch(() => "");
  const out: ServedContract[] = [];
  const lines = source.split("\n");
  let inPaths = false;
  let pathsIndent = 0;
  let currentPath: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const pathsStart = line.match(/^(\s*)paths\s*:/);
    if (pathsStart) {
      inPaths = true;
      pathsIndent = pathsStart[1]!.length;
      continue;
    }
    if (!inPaths) continue;
    const indent = line.length - line.trimStart().length;
    if (line.trim() && indent <= pathsIndent && !line.trim().startsWith("#")) {
      inPaths = false;
      continue;
    }
    const routeLine = line.match(/^\s*(\/[^\s:]*)\s*:/);
    if (routeLine) currentPath = routeLine[1]!;
    const methodLine = line.match(new RegExp(`^\\s*(${HTTP_METHODS})\\s*:`, "i"));
    if (methodLine && currentPath) {
      out.push({
        kind: "http",
        id: `http:${methodLine[1]!.toUpperCase()} ${normalizeRoute(currentPath)}`,
        method: methodLine[1]!.toUpperCase(),
        route: currentPath,
        file: rel,
        line: i + 1,
        via: "openapi",
        confidence: 0.95,
      });
    }
  }
  return out;
}
