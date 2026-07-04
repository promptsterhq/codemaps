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
