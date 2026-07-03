/**
 * Orient lens (thin) — "what is this system and how do its parts talk?"
 * (VISION §3 lens 1 — commodity tier, deliberately manifest-driven and fast.)
 *
 * Components from workspace/package manifests + conventional top-level dirs;
 * entry points from bin/main/index conventions; communication style inferred
 * from dependency names (the same signal a senior engineer reads first).
 * Contract-surface extraction (routes/proto/GraphQL) is Phase 2 groundwork.
 */

import { readFile, readdir, access } from "node:fs/promises";
import path from "node:path";

export interface OrientComponent {
  name: string;
  responsibility?: string;
  paths: string[];
  language?: string;
}

export interface OrientReport {
  repoName: string;
  components: OrientComponent[];
  entryPoints: string[];
  communication: { style: "rest" | "grpc" | "queue" | "db" | "graphql" | "websocket"; via: string }[];
  provenance: "derived";
  confidence: number;
}

const COMMS_SIGNALS: { style: OrientReport["communication"][number]["style"]; deps: RegExp }[] = [
  { style: "rest", deps: /^(express|fastify|koa|hapi|@nestjs\/core|hono|flask|django|fastapi|uvicorn|gin-gonic|actix-web|axios|node-fetch|got|undici|requests|httpx)$/ },
  { style: "grpc", deps: /^(@grpc\/grpc-js|grpc|grpcio|protobufjs|ts-proto)$/ },
  { style: "graphql", deps: /^(graphql|apollo-server|@apollo\/server|@apollo\/client|urql|graphene|strawberry-graphql)$/ },
  { style: "queue", deps: /^(amqplib|kafkajs|bullmq|bull|@aws-sdk\/client-sqs|sqs-consumer|pika|celery|nats|mqtt)$/ },
  { style: "db", deps: /^(pg|mysql2?|mongoose|mongodb|prisma|@prisma\/client|typeorm|drizzle-orm|knex|sequelize|redis|ioredis|sqlalchemy|psycopg2(-binary)?|pymongo|@supabase\/supabase-js|better-sqlite3)$/ },
  { style: "websocket", deps: /^(ws|socket\.io|socket\.io-client|websockets)$/ },
];

export async function orient(repoRoot: string): Promise<OrientReport> {
  const components: OrientComponent[] = [];
  const entryPoints: string[] = [];
  const comms = new Map<string, OrientReport["communication"][number]>();

  const rootPkg = await readJson(path.join(repoRoot, "package.json"));
  const repoName = (rootPkg?.name as string) ?? path.basename(repoRoot);

  // 1. Workspace packages (pnpm workspace globs / npm workspaces).
  const workspaceDirs = await workspacePackageDirs(repoRoot, rootPkg);
  for (const dir of workspaceDirs) {
    const pkg = await readJson(path.join(repoRoot, dir, "package.json"));
    if (!pkg) continue;
    components.push({
      name: (pkg.name as string) ?? dir,
      responsibility: pkg.description as string | undefined,
      paths: [dir],
      language: "typescript",
    });
    collectComms(pkg, comms);
    for (const e of await packageEntryPoints(repoRoot, dir, pkg)) entryPoints.push(e);
  }

  // 2. Single-package repo: the root itself is a component.
  if (components.length === 0 && rootPkg) {
    components.push({
      name: repoName,
      responsibility: rootPkg.description as string | undefined,
      paths: ["."],
      language: "typescript",
    });
    for (const e of await packageEntryPoints(repoRoot, ".", rootPkg)) entryPoints.push(e);
  }
  if (rootPkg) collectComms(rootPkg, comms);

  // 3. Python: pyproject.toml (light parse — no toml dep).
  const pyproject = await readText(path.join(repoRoot, "pyproject.toml"));
  if (pyproject) {
    const name = pyproject.match(/^name\s*=\s*["']([^"']+)["']/m)?.[1];
    const desc = pyproject.match(/^description\s*=\s*["']([^"']+)["']/m)?.[1];
    components.push({ name: name ?? "python-package", responsibility: desc, paths: ["."], language: "python" });
    for (const dep of pyproject.match(/^\s*["']?([A-Za-z0-9_.-]+)\s*[>=<~!]/gm) ?? []) {
      classifyDep(dep.replace(/[\s"'>=<~!]/g, ""), comms);
    }
    for (const candidate of ["main.py", "app.py", "manage.py", "src/main.py"]) {
      if (await exists(path.join(repoRoot, candidate))) entryPoints.push(candidate);
    }
  }

  // 4. Conventional top-level dirs as coarse components when nothing matched.
  if (components.length === 0) {
    for (const dir of ["src", "lib", "app", "server", "cmd", "services"]) {
      if (await exists(path.join(repoRoot, dir))) components.push({ name: dir, paths: [dir] });
    }
  }

  return {
    repoName,
    components,
    entryPoints: [...new Set(entryPoints)],
    communication: [...comms.values()],
    provenance: "derived",
    // Manifest-derived facts are reliable; the *interpretation* (styles) is coarse.
    confidence: 0.7,
  };
}

function collectComms(pkg: Record<string, unknown>, out: Map<string, OrientReport["communication"][number]>): void {
  const deps = {
    ...(pkg.dependencies as Record<string, string> | undefined),
    ...(pkg.devDependencies as Record<string, string> | undefined),
  };
  for (const dep of Object.keys(deps ?? {})) classifyDep(dep, out);
}

function classifyDep(dep: string, out: Map<string, { style: OrientReport["communication"][number]["style"]; via: string }>): void {
  for (const s of COMMS_SIGNALS) {
    if (s.deps.test(dep)) out.set(`${s.style}:${dep}`, { style: s.style, via: dep });
  }
}

async function workspacePackageDirs(repoRoot: string, rootPkg: Record<string, unknown> | null): Promise<string[]> {
  const globs: string[] = [];
  const wsYaml = await readText(path.join(repoRoot, "pnpm-workspace.yaml"));
  if (wsYaml) {
    for (const m of wsYaml.matchAll(/^\s*-\s*["']?([^"'\n#]+?)["']?\s*$/gm)) globs.push(m[1]!.trim());
  }
  if (Array.isArray(rootPkg?.workspaces)) globs.push(...(rootPkg!.workspaces as string[]));

  const dirs: string[] = [];
  for (const glob of globs) {
    // Support the ubiquitous "<dir>/*" form only — thin on purpose.
    const base = glob.replace(/\/\*+$/, "");
    if (base === glob) {
      if (await exists(path.join(repoRoot, base, "package.json"))) dirs.push(base);
      continue;
    }
    try {
      for (const entry of await readdir(path.join(repoRoot, base), { withFileTypes: true })) {
        if (entry.isDirectory() && (await exists(path.join(repoRoot, base, entry.name, "package.json")))) {
          dirs.push(path.join(base, entry.name).replace(/\\/g, "/"));
        }
      }
    } catch {
      /* glob base doesn't exist */
    }
  }
  return dirs;
}

async function packageEntryPoints(repoRoot: string, dir: string, pkg: Record<string, unknown>): Promise<string[]> {
  const results: string[] = [];
  const bin = pkg.bin;
  if (typeof bin === "string") results.push(path.join(dir, bin));
  else if (bin && typeof bin === "object") {
    for (const p of Object.values(bin as Record<string, string>)) results.push(path.join(dir, p));
  }
  if (typeof pkg.main === "string") results.push(path.join(dir, pkg.main));
  for (const candidate of ["src/index.ts", "src/main.ts", "index.ts", "src/index.js"]) {
    if (await exists(path.join(repoRoot, dir, candidate))) results.push(path.join(dir, candidate));
  }
  return results.map((p) => p.replace(/\\/g, "/").replace(/^\.\//, ""));
}

async function readJson(p: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readText(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  return access(p).then(() => true, () => false);
}
