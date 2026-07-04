/**
 * `codemaps stitch <repo=contracts.json ...>` — the cross-repo service graph,
 * runnable locally today. The Phase 3 cloud runs this same function at org
 * scale with durable storage; the algorithm is identical.
 *
 *   codemaps stitch billing=./billing/.codemaps/contracts.json \
 *                   store=./store/.codemaps/contracts.json
 *   codemaps stitch ... --impact billing "http:POST /v1/invoices"
 */

import { readFile } from "node:fs/promises";
import {
  crossRepoImpact,
  stitchServiceGraph,
  type ContractSurface,
  type RepoSurface,
} from "@codemaps/core";

export async function runStitch(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const impactFlag = args.indexOf("--impact");
  const impactArgs = impactFlag >= 0 ? [args[impactFlag + 1], args[impactFlag + 2]] : null;
  const positional = args.filter(
    (a, i) =>
      !a.startsWith("--") &&
      (impactFlag < 0 || (i !== impactFlag + 1 && i !== impactFlag + 2)),
  );

  if (positional.length < 2 && !json) {
    console.error(
      "usage: codemaps stitch <repo=path/to/contracts.json> <repo=...> [--impact <repo> <contractId>] [--json]\n" +
        "       (need at least two surfaces to stitch)",
    );
    return 2;
  }

  const surfaces: RepoSurface[] = [];
  for (const spec of positional) {
    const eq = spec.indexOf("=");
    const repo = eq > 0 ? spec.slice(0, eq) : spec;
    const file = eq > 0 ? spec.slice(eq + 1) : `${spec}/.codemaps/contracts.json`;
    try {
      surfaces.push({ repo, surface: JSON.parse(await readFile(file, "utf8")) as ContractSurface });
    } catch (err) {
      console.error(`codemaps stitch: cannot read surface for "${repo}" from ${file} (${String(err).slice(0, 80)})`);
      console.error(`  hint: run 'codemaps init' in that repo first to produce .codemaps/contracts.json`);
      return 1;
    }
  }

  const graph = stitchServiceGraph(surfaces);

  if (impactArgs && impactArgs[0] && impactArgs[1]) {
    const result = crossRepoImpact(graph, impactArgs[0], impactArgs[1]);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    console.log(`\n💥 CROSS-SERVICE IMPACT — ${result.contractId} (provided by ${result.provider})`);
    if (result.consumers.length === 0) {
      console.log(`   No indexed consumers. (External/unindexed consumers may still exist.)\n`);
      return 0;
    }
    console.log(`   Changing this contract affects ${result.consumers.length} consumer(s):`);
    for (const c of result.consumers) {
      console.log(`   • ${c.repo} — ${c.file}:${c.line}  [confidence ${c.confidence}]`);
    }
    console.log(`\n   Coordinate with those repos' owners before shipping a breaking change.\n`);
    return 0;
  }

  if (json) {
    console.log(JSON.stringify(graph, null, 2));
    return 0;
  }

  console.log(`\n🕸  SERVICE GRAPH — ${graph.services.length} service(s), ${graph.edges.length} cross-repo edge(s)`);
  console.log(`\n   SERVICES:`);
  for (const s of graph.services) {
    console.log(`   • ${s.repo}  (${s.serves} served, ${s.calls} called, ${s.events} events)`);
  }
  if (graph.edges.length > 0) {
    console.log(`\n   EDGES (consumer -> provider):`);
    for (const e of graph.edges.slice(0, 20)) {
      console.log(`   • ${e.from} → ${e.to}  ${e.contractId}  [${e.kind}, ${e.confidence}]`);
      console.log(`       call ${e.callSite.file}:${e.callSite.line} → serve ${e.serveSite.file}:${e.serveSite.line}`);
    }
  }
  if (graph.danglingCalls.length > 0) {
    console.log(`\n   DANGLING CALLS (external SaaS or unindexed repos):`);
    for (const d of graph.danglingCalls.slice(0, 8)) {
      console.log(`   • ${d.repo}: ${d.contractId}  (${d.file}:${d.line})`);
    }
  }
  if (graph.unconsumedServes.length > 0) {
    console.log(`\n   UNCONSUMED (public API or dead surface): ${graph.unconsumedServes.length} contract(s)`);
  }
  console.log(
    `\n   Ask the money question: codemaps stitch ... --impact <provider> "<contractId>"\n`,
  );
  return 0;
}
