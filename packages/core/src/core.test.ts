/**
 * Core engine tests — node:test (zero deps, Node 18+).
 * Focus: the trust-loop durability rules, graph traversal correctness, and the
 * security detectors that back the benchmark regression (sendfile-path).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { MutableGraph } from "./store.js";
import { impact, locate, resolveTarget } from "./query.js";
import { guardrailId, mergeFindings, decide, type CodemapFile } from "./codemap-store.js";
import { scanSecurity, securityEnrichment } from "./security.js";
import type { GuardrailFinding } from "./guardrails.js";

// ---------------------------------------------------------------------------
// Graph + query
// ---------------------------------------------------------------------------

function makeGraph(): MutableGraph {
  const g = new MutableGraph();
  g.addNode({ id: "file:src/a.ts", kind: "file", name: "src/a.ts", language: "typescript" });
  g.addNode({ id: "file:src/b.ts", kind: "file", name: "src/b.ts", language: "typescript" });
  g.addNode({ id: "file:tests/a.test.ts", kind: "file", name: "tests/a.test.ts", language: "typescript" });
  g.addNode({ id: "ts:src/a.ts#core", kind: "function", name: "core", language: "typescript", loc: { path: "src/a.ts", startLine: 1, endLine: 5 } });
  g.addNode({ id: "ts:src/b.ts#caller", kind: "function", name: "caller", language: "typescript", loc: { path: "src/b.ts", startLine: 1, endLine: 5 } });
  g.addNode({ id: "ts:tests/a.test.ts#t", kind: "function", name: "t", language: "typescript", loc: { path: "tests/a.test.ts", startLine: 1, endLine: 3 } });
  g.addEdge({ from: "ts:src/b.ts#caller", to: "ts:src/a.ts#core", kind: "calls" });
  g.addEdge({ from: "ts:tests/a.test.ts#t", to: "ts:src/b.ts#caller", kind: "calls" });
  g.addEdge({ from: "file:src/b.ts", to: "file:src/a.ts", kind: "imports" });
  return g;
}

test("impact: reverse blast radius is transitive and finds tests", () => {
  const g = makeGraph();
  const r = impact(g, "ts:src/a.ts#core");
  assert.ok(r);
  assert.ok(r.directDependents.some((n) => n.id === "ts:src/b.ts#caller"));
  assert.ok(r.transitiveDependents.some((n) => n.id === "ts:tests/a.test.ts#t"));
  assert.equal(r.affectedTests.length, 1);
  assert.equal(r.provenance, "derived");
  assert.ok(r.confidence < 1, "static analysis must not claim certainty");
});

test("impact: widens through file-level import edges", () => {
  const g = makeGraph();
  const r = impact(g, "file:src/a.ts");
  assert.ok(r);
  assert.ok(r.directDependents.some((n) => n.id === "file:src/b.ts"));
});

test("graph: edges dedupe; serialization round-trips", () => {
  const g = makeGraph();
  const before = g.edgeCount;
  g.addEdge({ from: "ts:src/b.ts#caller", to: "ts:src/a.ts#core", kind: "calls" }); // dup
  assert.equal(g.edgeCount, before);
  const restored = MutableGraph.fromJSON(g.toJSON("abc123"));
  assert.equal(restored.nodes.size, g.nodes.size);
  assert.equal(restored.edgeCount, g.edgeCount);
  assert.equal(g.toJSON("abc123").head, "abc123");
});

test("locate + resolveTarget: exact beats prefix beats contains", () => {
  const g = makeGraph();
  const hits = locate(g, "core");
  assert.equal(hits[0]!.node.id, "ts:src/a.ts#core");
  assert.equal(resolveTarget(g, "core"), "ts:src/a.ts#core");
  assert.equal(resolveTarget(g, "ts:src/a.ts#core"), "ts:src/a.ts#core");
});

// ---------------------------------------------------------------------------
// Codemap store — trust-loop durability
// ---------------------------------------------------------------------------

const finding = (statement: string, over: Partial<GuardrailFinding> = {}): GuardrailFinding => ({
  kind: "invariant",
  reason: "declared",
  path: "src/a.ts",
  line: 10,
  statement,
  status: "proposed",
  provenance: "mined",
  confidence: 0.6,
  material: true,
  ...over,
});

test("guardrailId: stable across line drift, distinct across statements", () => {
  const a = guardrailId(finding("x must hold", { line: 10 }));
  const b = guardrailId(finding("x must hold", { line: 99 }));
  const c = guardrailId(finding("y must hold"));
  assert.equal(a, b, "line moves must not change identity");
  assert.notEqual(a, c);
});

test("mergeFindings: human decisions survive re-mining (the trust loop)", () => {
  const file: CodemapFile = { version: 1, guardrails: [] };
  mergeFindings(file, [finding("x must hold")], "2026-07-03");
  assert.equal(file.guardrails.length, 1);

  const verdict = decide(file, file.guardrails[0]!.id, "confirmed", "jeff", "2026-07-03");
  assert.notEqual(typeof verdict, "string");

  // Re-mine the same finding at a new line with different confidence.
  const counts = mergeFindings(file, [finding("x must hold", { line: 42, confidence: 0.3 })], "2026-07-04");
  assert.equal(counts.kept, 1, "confirmed record must be kept, not refreshed");
  assert.equal(file.guardrails[0]!.status, "confirmed");
  assert.equal(file.guardrails[0]!.decidedBy, "jeff");
  assert.equal(file.guardrails[0]!.line, 42, "line may refresh; the decision may not");
});

test("mergeFindings: rejected proposals do not resurface as proposed", () => {
  const file: CodemapFile = { version: 1, guardrails: [] };
  mergeFindings(file, [finding("noise")], "2026-07-03");
  decide(file, file.guardrails[0]!.id, "rejected", "jeff", "2026-07-03");
  mergeFindings(file, [finding("noise")], "2026-07-05");
  assert.equal(file.guardrails.length, 1);
  assert.equal(file.guardrails[0]!.status, "rejected");
});

test("decide: ambiguous prefix is an error, not a guess", () => {
  const file: CodemapFile = { version: 1, guardrails: [] };
  mergeFindings(file, [finding("aaa must hold"), finding("bbb must hold")], "2026-07-03");
  const result = decide(file, "", "confirmed", "jeff", "2026-07-03");
  assert.equal(typeof result, "string");
});

// ---------------------------------------------------------------------------
// Security detectors — the sendfile regression, pinned as a unit test
// ---------------------------------------------------------------------------

test("security: detects the express sendFile path-traversal guard", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codemaps-test-"));
  await mkdir(path.join(dir, "lib"), { recursive: true });
  await writeFile(
    path.join(dir, "lib", "response.js"),
    [
      "res.sendFile = function sendFile(path, options, callback) {",
      "  if (!opts.root && !isAbsolute(path)) {",
      "    throw new TypeError('path must be absolute or specify root to res.sendFile');",
      "  }",
      "};",
    ].join("\n"),
  );
  const findings = await scanSecurity(dir, ["lib/response.js"]);
  const guard = findings.find((f) => f.category === "path-traversal-guard");
  assert.ok(guard, "must flag the guard that both benchmark arms deleted");
  assert.match(guard!.consequence, /traversal/);

  // And the enrichment joins it to a mined invariant within 3 lines.
  const enriched = securityEnrichment({ path: "lib/response.js", line: guard!.line + 2 }, findings);
  assert.ok(enriched);
  const far = securityEnrichment({ path: "lib/response.js", line: guard!.line + 50 }, findings);
  assert.equal(far, null);
});

test("security: detects command-injection sink and hardcoded secret", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codemaps-test-"));
  await writeFile(
    path.join(dir, "danger.ts"),
    [
      "import { exec } from 'child_process';",
      "exec(`convert ${userInput}`);",
      'const api_key = "sk_live_abcdefgh12345678";',
    ].join("\n"),
  );
  const findings = await scanSecurity(dir, ["danger.ts"]);
  assert.ok(findings.some((f) => f.category === "injection-sink"));
  assert.ok(findings.some((f) => f.category === "secret"));
});

test("security: quiet on benign code (no false-positive storm)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codemaps-test-"));
  await writeFile(
    path.join(dir, "calm.ts"),
    ["export function add(a: number, b: number) {", "  return a + b;", "}"].join("\n"),
  );
  const findings = await scanSecurity(dir, ["calm.ts"]);
  assert.equal(findings.length, 0);
});

// ---------------------------------------------------------------------------
// Contract surface — extraction + identity normalization (Impact tier b)
// ---------------------------------------------------------------------------

test("contracts: normalizeRoute unifies template styles for cross-repo identity", async () => {
  const { normalizeRoute } = await import("./contracts.js");
  assert.equal(normalizeRoute("/users/:id"), "/users/{param}");
  assert.equal(normalizeRoute("/users/{userId}"), "/users/{param}");
  assert.equal(normalizeRoute("/users/<int:id>"), "/users/{param}");
  assert.equal(normalizeRoute("/users/:id/"), "/users/{param}");
});

test("contracts: extracts express routes, proto rpcs, graphql fields, openapi paths", async () => {
  const { extractContracts } = await import("./contracts.js");
  const dir = await mkdtemp(path.join(tmpdir(), "codemaps-test-"));
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["-C", dir, "init", "-q"]); // listRepoFiles uses git ls-files

  await writeFile(path.join(dir, "server.js"),
    "app.get('/v1/invoices/:id', handler);\napp.post('/v1/invoices', create);\n" +
    "fetch('https://billing.internal/v1/charge');\nproducer.send({ topic: 'invoice.paid', messages: [] });\n");
  await writeFile(path.join(dir, "billing.proto"),
    "syntax = \"proto3\";\npackage billing;\nservice Billing {\n  rpc Finalize (Req) returns (Res);\n}\n");
  await writeFile(path.join(dir, "schema.graphql"),
    "type Query {\n  invoice(id: ID!): Invoice\n}\n");
  await writeFile(path.join(dir, "openapi.yaml"),
    "openapi: 3.0.0\npaths:\n  /v1/refunds:\n    post:\n      summary: refund\n");

  const s = await extractContracts(dir);
  const ids = s.serves.map((c) => c.id);
  assert.ok(ids.includes("http:GET /v1/invoices/{param}"), `express route: ${ids}`);
  assert.ok(ids.includes("grpc:billing.Billing/Finalize"), `proto rpc: ${ids}`);
  assert.ok(ids.includes("graphql:Query.invoice"), `graphql field: ${ids}`);
  assert.ok(ids.includes("http:POST /v1/refunds"), `openapi path: ${ids}`);
  assert.ok(s.calls.some((c) => c.url.includes("billing.internal")), "http client call");
  assert.ok(s.events.some((e) => e.role === "publish" && e.topic === "invoice.paid"), "kafka publish");
  // Typed IDL must outrank heuristic route detection in confidence.
  const proto = s.serves.find((c) => c.kind === "grpc")!;
  const express = s.serves.find((c) => c.via === "express-style")!;
  assert.ok(proto.confidence > express.confidence);
});

test("contracts: Next.js routes — App Router file paths + pages/api", async () => {
  const { extractContracts } = await import("./contracts.js");
  const dir = await mkdtemp(path.join(tmpdir(), "codemaps-test-"));
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["-C", dir, "init", "-q"]);

  // App Router: multi-method handler, both export spellings.
  await mkdir(path.join(dir, "web/app/api/github/webhook"), { recursive: true });
  await writeFile(
    path.join(dir, "web/app/api/github/webhook/route.ts"),
    "export async function POST(request: Request) { return new Response('ok'); }\n" +
      "export const GET = () => new Response('pong');\n",
  );
  // Route group stripped from the URL; dynamic segment normalized.
  await mkdir(path.join(dir, "web/app/(marketing)/pricing/[tier]"), { recursive: true });
  await writeFile(path.join(dir, "web/app/(marketing)/pricing/[tier]/route.ts"), "export function GET() {}\n");
  // Pages Router: method is dispatched at runtime -> ANY.
  await mkdir(path.join(dir, "web/pages/api/users"), { recursive: true });
  await writeFile(path.join(dir, "web/pages/api/users/[id].ts"), "export default function handler(req, res) {}\n");
  // A route.ts OUTSIDE an app/ dir must not match — the path is the contract.
  await mkdir(path.join(dir, "lib"), { recursive: true });
  await writeFile(path.join(dir, "lib/route.ts"), "export function GET() {}\n");

  const s = await extractContracts(dir);
  const ids = s.serves.map((c) => c.id);
  assert.ok(ids.includes("http:POST /api/github/webhook"), `app-router function export: ${ids}`);
  assert.ok(ids.includes("http:GET /api/github/webhook"), `app-router const export: ${ids}`);
  assert.ok(ids.includes("http:GET /pricing/{param}"), `group stripped + param normalized: ${ids}`);
  assert.ok(ids.includes("http:ANY /api/users/{param}"), `pages/api handler: ${ids}`);
  assert.ok(!s.serves.some((c) => c.file === "lib/route.ts"), "route.ts outside app/ must not match");
});

test("contracts: fetch method from options + query strings out of identity", async () => {
  const { extractContracts } = await import("./contracts.js");
  const dir = await mkdtemp(path.join(tmpdir(), "codemaps-test-"));
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["-C", dir, "init", "-q"]);

  await writeFile(
    path.join(dir, "client.ts"),
    'fetch("/api/stitch-org", { method: "POST", headers: { a: "b" } });\n' +
      'fetch("/api/snapshots",\n  { method: "POST" });\n' + // options on the next line
      "fetch(`/api/map-data?org=${orgId}&window=7d`);\n",
  );

  const s = await extractContracts(dir);
  const ids = s.calls.map((c) => c.id);
  assert.ok(ids.includes("http:POST /api/stitch-org"), `same-line method: ${ids}`);
  assert.ok(ids.includes("http:POST /api/snapshots"), `next-line method: ${ids}`);
  assert.ok(ids.includes("http:GET /api/map-data"), `query string stripped: ${ids}`);
});

test("contracts: Go routers/stdlib + Spring annotations and clients", async () => {
  const { extractContracts } = await import("./contracts.js");
  const dir = await mkdtemp(path.join(tmpdir(), "codemaps-test-"));
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["-C", dir, "init", "-q"]);

  await writeFile(
    path.join(dir, "main.go"),
    'r.GET("/v1/users/:id", getUser)\n' + // gin/echo
      'r.Post("/v1/orders", createOrder)\n' + // chi/fiber
      'mux.HandleFunc("GET /healthz", health)\n' + // stdlib 1.22 method-in-pattern
      'http.HandleFunc("/legacy", legacy)\n' + // stdlib classic -> ANY
      'resp, err := http.Get("https://billing.internal/v1/invoices")\n' +
      'req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "https://billing.internal/v1/invoices", body)\n',
  );
  await writeFile(
    path.join(dir, "AccountController.java"),
    '@GetMapping("/v1/accounts/{id}")\n' +
      '@PostMapping(value = "/v1/accounts")\n' +
      '@RequestMapping(path = "/v1/legacy", method = RequestMethod.PUT)\n' +
      '@RequestMapping("/v1/base")\n' + // class-level prefix: must NOT emit
      'restTemplate.getForObject("https://billing.internal/v1/invoices/{id}", Invoice.class);\n' +
      'webClient.post().uri("/v1/charges").retrieve();\n',
  );

  const s = await extractContracts(dir);
  const ids = s.serves.map((c) => c.id);
  assert.ok(ids.includes("http:GET /v1/users/{param}"), `gin route: ${ids}`);
  assert.ok(ids.includes("http:POST /v1/orders"), `chi route: ${ids}`);
  assert.ok(ids.includes("http:GET /healthz"), `go 1.22 method-in-pattern: ${ids}`);
  assert.ok(ids.includes("http:ANY /legacy"), `stdlib HandleFunc: ${ids}`);
  assert.ok(ids.includes("http:GET /v1/accounts/{param}"), `spring @GetMapping: ${ids}`);
  assert.ok(ids.includes("http:POST /v1/accounts"), `spring value=: ${ids}`);
  assert.ok(ids.includes("http:PUT /v1/legacy"), `spring @RequestMapping+method: ${ids}`);
  assert.ok(!ids.some((i) => i.endsWith(" /v1/base")), `class-level prefix must not emit: ${ids}`);

  const callIds = s.calls.map((c) => c.id);
  assert.ok(callIds.includes("http:GET /v1/invoices"), `go http.Get: ${callIds}`);
  assert.ok(callIds.includes("http:POST /v1/invoices"), `go NewRequestWithContext const: ${callIds}`);
  assert.ok(callIds.includes("http:GET /v1/invoices/{param}"), `restTemplate: ${callIds}`);
  assert.ok(callIds.includes("http:POST /v1/charges"), `webClient chain: ${callIds}`);
});

test("go indexer: symbols, receiver methods, imports, conservative calls, impact", async () => {
  const { indexGo } = await import("./go-indexer.js");
  const { impact } = await import("./query.js");
  const { MutableGraph } = await import("./store.js");
  const dir = await mkdtemp(path.join(tmpdir(), "codemaps-test-"));
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["-C", dir, "init", "-q"]);

  await writeFile(path.join(dir, "go.mod"), "module example.com/acme/billing\n\ngo 1.22\n");
  await mkdir(path.join(dir, "internal/store"), { recursive: true });
  await writeFile(
    path.join(dir, "internal/store/store.go"),
    'package store\n\ntype Store struct{}\n\ntype Saver interface{ Save() error }\n\nfunc NewStore() *Store { return &Store{} }\n\nfunc (s *Store) Save() error { return nil }\n',
  );
  await writeFile(
    path.join(dir, "main.go"),
    'package main\n\nimport (\n\t"example.com/acme/billing/internal/store"\n)\n\nfunc main() {\n\ts := store.NewStore()\n\t_ = s.Save()\n}\n',
  );

  const r = await indexGo(dir);
  const ids = r.nodes.map((n) => n.id);
  assert.ok(ids.includes("go:internal/store/store.go#Store"), `struct: ${ids}`);
  assert.ok(ids.includes("go:internal/store/store.go#Saver"), `interface: ${ids}`);
  assert.ok(ids.includes("go:internal/store/store.go#NewStore"), `function: ${ids}`);
  assert.ok(ids.includes("go:internal/store/store.go#Store.Save"), `receiver method: ${ids}`);
  const iface = r.nodes.find((n) => n.id.endsWith("#Saver"));
  assert.equal(iface!.kind, "interface");

  // Import edge: main.go -> the store package's file.
  assert.ok(
    r.edges.some((e) => e.from === "file:main.go" && e.to === "file:internal/store/store.go" && e.kind === "imports"),
    `import edge: ${JSON.stringify(r.edges)}`,
  );
  // Conservative call edges: NewStore and Save are unique names -> edges.
  assert.ok(
    r.edges.some((e) => e.from === "file:main.go" && e.to === "go:internal/store/store.go#NewStore" && e.kind === "calls"),
    `call edge: ${JSON.stringify(r.edges)}`,
  );

  // And impact answers the Go question end-to-end.
  const g = new MutableGraph();
  for (const n of r.nodes) g.addNode(n);
  for (const e of r.edges) g.addEdge(e);
  const blast = impact(g, "go:internal/store/store.go#NewStore");
  assert.ok(blast);
  assert.ok(blast!.directDependents.some((n) => n.id === "file:main.go"), "main.go depends on NewStore");
});

test("jvm indexer: Java + Kotlin symbols, imports, conservative calls", async () => {
  const { indexJava, indexKotlin } = await import("./jvm-indexer.js");
  const dir = await mkdtemp(path.join(tmpdir(), "codemaps-test-"));
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["-C", dir, "init", "-q"]);

  await mkdir(path.join(dir, "src/main/java/com/acme/store"), { recursive: true });
  await writeFile(
    path.join(dir, "src/main/java/com/acme/store/Store.java"),
    "package com.acme.store;\n\npublic class Store {\n  public Store() {}\n  public void save() {}\n}\n\ninterface Saver { void save(); }\n",
  );
  await mkdir(path.join(dir, "src/main/java/com/acme/app"), { recursive: true });
  await writeFile(
    path.join(dir, "src/main/java/com/acme/app/Main.java"),
    "package com.acme.app;\n\nimport com.acme.store.Store;\n\npublic class Main {\n  void run() {\n    Store s = new Store();\n    s.persistAll();\n  }\n}\n",
  );
  await mkdir(path.join(dir, "src/main/kotlin/com/acme/billing"), { recursive: true });
  await writeFile(
    path.join(dir, "src/main/kotlin/com/acme/billing/Invoice.kt"),
    "package com.acme.billing\n\nclass Invoice {\n  fun finalizeTotal() {}\n}\n\nfun newInvoice(): Invoice = Invoice()\n",
  );
  await writeFile(
    path.join(dir, "src/main/kotlin/com/acme/billing/Runner.kt"),
    "package com.acme.billing\n\nimport com.acme.billing.Invoice\n\nfun run() {\n  val inv = newInvoice()\n  inv.finalizeTotal()\n}\n",
  );

  const j = await indexJava(dir);
  const jids = j.nodes.map((n) => n.id);
  const javaPrefix = "java:src/main/java/com/acme/store/Store.java";
  assert.ok(jids.includes(`${javaPrefix}#Store`), `java class: ${jids}`);
  assert.ok(jids.includes(`${javaPrefix}#Store.save`), `java method: ${jids}`);
  assert.ok(jids.includes(`${javaPrefix}#Saver`), `java interface: ${jids}`);
  assert.equal(j.nodes.find((n) => n.id.endsWith("#Saver"))!.kind, "interface");
  assert.ok(
    j.edges.some(
      (e) => e.from === "file:src/main/java/com/acme/app/Main.java" && e.to === "file:src/main/java/com/acme/store/Store.java" && e.kind === "imports",
    ),
    `java import edge across source roots: ${JSON.stringify(j.edges)}`,
  );
  // `new Store()` resolves as a call to the unique Store class.
  assert.ok(
    j.edges.some((e) => e.from === "file:src/main/java/com/acme/app/Main.java" && e.to === `${javaPrefix}#Store` && e.kind === "calls"),
    `constructor call edge: ${JSON.stringify(j.edges)}`,
  );

  const k = await indexKotlin(dir);
  const kids = k.nodes.map((n) => n.id);
  const ktPrefix = "kt:src/main/kotlin/com/acme/billing/Invoice.kt";
  assert.ok(kids.includes(`${ktPrefix}#Invoice`), `kotlin class: ${kids}`);
  assert.ok(kids.includes(`${ktPrefix}#Invoice.finalizeTotal`), `kotlin method: ${kids}`);
  assert.ok(kids.includes(`${ktPrefix}#newInvoice`), `kotlin top-level fn: ${kids}`);
  assert.ok(
    k.edges.some((e) => e.from === "file:src/main/kotlin/com/acme/billing/Runner.kt" && e.to === `${ktPrefix}#newInvoice` && e.kind === "calls"),
    `kotlin call edge: ${JSON.stringify(k.edges)}`,
  );
  assert.ok(
    k.edges.some((e) => e.from === "file:src/main/kotlin/com/acme/billing/Runner.kt" && e.to === `${ktPrefix}#Invoice.finalizeTotal` && e.kind === "calls"),
    `kotlin navigation call edge: ${JSON.stringify(k.edges)}`,
  );
});

test("ruby indexer: nested classes, singleton methods, requires, conservative calls", async () => {
  const { indexRuby } = await import("./ruby-indexer.js");
  const dir = await mkdtemp(path.join(tmpdir(), "codemaps-test-"));
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["-C", dir, "init", "-q"]);

  await mkdir(path.join(dir, "lib/acme"), { recursive: true });
  await writeFile(
    path.join(dir, "lib/acme/store.rb"),
    "module Acme\n  class Store\n    def save\n    end\n\n    def self.build\n    end\n  end\nend\n",
  );
  await writeFile(
    path.join(dir, "app.rb"),
    "require \"acme/store\"\nrequire_relative \"helpers\"\n\nstore = Acme::Store.build()\nstore.save()\n",
  );
  await writeFile(path.join(dir, "helpers.rb"), "def format_money(cents)\nend\n");

  const r = await indexRuby(dir);
  const ids = r.nodes.map((n) => n.id);
  assert.ok(ids.includes("rb:lib/acme/store.rb#Acme"), `module: ${ids}`);
  assert.ok(ids.includes("rb:lib/acme/store.rb#Acme::Store"), `nested class: ${ids}`);
  assert.ok(ids.includes("rb:lib/acme/store.rb#Acme::Store.save"), `method: ${ids}`);
  assert.ok(ids.includes("rb:lib/acme/store.rb#Acme::Store.build"), `singleton method: ${ids}`);
  assert.ok(ids.includes("rb:helpers.rb#format_money"), `top-level def: ${ids}`);

  // require "acme/store" resolves via lib/; require_relative via the file dir.
  assert.ok(
    r.edges.some((e) => e.from === "file:app.rb" && e.to === "file:lib/acme/store.rb" && e.kind === "imports"),
    `lib require: ${JSON.stringify(r.edges)}`,
  );
  assert.ok(
    r.edges.some((e) => e.from === "file:app.rb" && e.to === "file:helpers.rb" && e.kind === "imports"),
    `require_relative: ${JSON.stringify(r.edges)}`,
  );
  // Unique-name calls: build + save resolve; ambiguous/unknown skipped.
  assert.ok(
    r.edges.some((e) => e.from === "file:app.rb" && e.to === "rb:lib/acme/store.rb#Acme::Store.build" && e.kind === "calls"),
    `singleton call: ${JSON.stringify(r.edges)}`,
  );
  assert.ok(
    r.edges.some((e) => e.from === "file:app.rb" && e.to === "rb:lib/acme/store.rb#Acme::Store.save" && e.kind === "calls"),
    `method call: ${JSON.stringify(r.edges)}`,
  );
});

// ---------------------------------------------------------------------------
// Cross-repo stitching — the Phase 3 headline moat, tested with zero cloud
// ---------------------------------------------------------------------------

test("stitch: joins caller repo to provider repo on contract identity", async () => {
  const { stitchServiceGraph, crossRepoImpact } = await import("./stitch.js");
  const surfaces = [
    {
      repo: "acme/storefront",
      surface: {
        serves: [],
        calls: [{ kind: "http" as const, id: "http:POST /v1/invoices", method: "POST", url: "https://billing.internal/v1/invoices", file: "src/checkout.ts", line: 42, via: "axios", confidence: 0.75 }],
        events: [{ role: "subscribe" as const, id: "event:invoice.paid", topic: "invoice.paid", file: "src/consumer.ts", line: 10, via: "kafka", confidence: 0.7 }],
        provenance: "heuristic" as const,
      },
    },
    {
      repo: "acme/billing",
      surface: {
        serves: [
          { kind: "http" as const, id: "http:POST /v1/invoices", method: "POST", route: "/v1/invoices", file: "src/routes.ts", line: 7, via: "express-style", confidence: 0.8 },
          { kind: "http" as const, id: "http:GET /v1/health", method: "GET", route: "/v1/health", file: "src/routes.ts", line: 3, via: "express-style", confidence: 0.8 },
          { kind: "http" as const, id: "http:GET /v1/self", method: "GET", route: "/v1/self", file: "src/routes.ts", line: 9, via: "express-style", confidence: 0.8 },
        ],
        calls: [
          { kind: "http" as const, id: "http:GET /never-indexed", method: "GET", url: "https://stripe.com/never-indexed", file: "src/pay.ts", line: 5, via: "fetch", confidence: 0.7 },
          // Self-call: same-repo consumption must not surface as an unconsumed serve.
          { kind: "http" as const, id: "http:GET /v1/self", method: "GET", url: "/v1/self", file: "src/cron.ts", line: 2, via: "fetch", confidence: 0.7 },
        ],
        events: [{ role: "publish" as const, id: "event:invoice.paid", topic: "invoice.paid", file: "src/emit.ts", line: 20, via: "kafka", confidence: 0.7 }],
        provenance: "heuristic" as const,
      },
    },
  ];

  const graph = stitchServiceGraph(surfaces);

  // HTTP edge: storefront -> billing on POST /v1/invoices.
  const http = graph.edges.find((e) => e.kind === "http");
  assert.ok(http);
  assert.equal(http!.from, "acme/storefront");
  assert.equal(http!.to, "acme/billing");

  // Event edge: billing (producer) -> storefront (consumer), weakest tier.
  const event = graph.edges.find((e) => e.kind === "event");
  assert.ok(event);
  assert.equal(event!.from, "acme/billing");
  assert.ok(event!.confidence < http!.confidence, "topic joins must rank below typed/http joins");

  // Dangling + unconsumed are surfaced, never hidden.
  const dangle = graph.danglingCalls.find((d) => d.contractId.includes("/never-indexed"));
  assert.ok(dangle);
  // The raw url (with host) rides along — contractId strips it, classifiers need it.
  assert.equal(dangle!.url, "https://stripe.com/never-indexed");
  assert.ok(graph.unconsumedServes.some((u) => u.contractId === "http:GET /v1/health"));
  // Self-consumed serve is not a dead surface; self-call is not dangling.
  assert.ok(!graph.unconsumedServes.some((u) => u.contractId === "http:GET /v1/self"));
  assert.ok(!graph.danglingCalls.some((d) => d.contractId === "http:GET /v1/self"));

  // The money question: change POST /v1/invoices in billing -> who breaks?
  const impact = crossRepoImpact(graph, "acme/billing", "http:POST /v1/invoices");
  assert.equal(impact.consumers.length, 1);
  assert.equal(impact.consumers[0]!.repo, "acme/storefront");
  assert.equal(impact.consumers[0]!.file, "src/checkout.ts");
});
