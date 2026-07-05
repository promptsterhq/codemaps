/**
 * Cross-repo contract stitching — the Phase 3 headline moat, as a PURE function
 * (VISION §6.1; DIFFERENTIATION §6). The cloud is just where this runs at org
 * scale; the algorithm itself needs nothing but contract surfaces.
 *
 * Input:  per-repo ContractSurfaces (the small .codemaps/contracts.json
 *         artifacts — never source).
 * Output: the org-wide service graph — which repo's calls resolve to which
 *         repo's served contracts, plus event producer->consumer links — and
 *         cross-service blast radius: "changing this contract breaks N
 *         consumers in M repos."
 *
 * Matching tiers (scope honestly, per the plan):
 *   grpc / graphql ids  — exact identity, highest confidence
 *   http                — method + normalized path template match
 *   events              — topic string equality, labeled lower confidence
 * Unmatched calls/serves are surfaced, not hidden: a dangling call is a
 * dependency on a service Codemaps hasn't indexed yet (or an external SaaS).
 */

import type { ContractSurface, ServedContract } from "./contracts.js";

export interface RepoSurface {
  repo: string; // org-unique name, e.g. "acme/billing"
  surface: ContractSurface;
}

export interface ServiceEdge {
  /** Consumer repo -> provider repo, joined on this contract identity. */
  from: string;
  to: string;
  contractId: string;
  kind: "http" | "grpc" | "graphql" | "event";
  /** Where each side lives, for click-through. */
  callSite: { file: string; line: number };
  serveSite: { file: string; line: number };
  confidence: number;
}

export interface ServiceGraph {
  services: { repo: string; serves: number; calls: number; events: number }[];
  edges: ServiceEdge[];
  /** Calls that matched no indexed provider — external SaaS or unindexed repo.
   *  url = the raw captured URL (contractId strips the host; consumers need it
   *  to classify by hostname). */
  danglingCalls: { repo: string; contractId: string; file: string; line: number; url: string }[];
  /** Served contracts nobody indexed calls — public API or dead surface. */
  unconsumedServes: { repo: string; contractId: string }[];
}

export function stitchServiceGraph(surfaces: RepoSurface[]): ServiceGraph {
  // Index every served contract by identity key.
  const providers = new Map<string, { repo: string; serve: ServedContract }[]>();
  for (const { repo, surface } of surfaces) {
    for (const serve of surface.serves) {
      const list = providers.get(serve.id) ?? [];
      list.push({ repo, serve });
      providers.set(serve.id, list);
    }
  }

  const edges: ServiceEdge[] = [];
  const dangling: ServiceGraph["danglingCalls"] = [];
  const consumed = new Set<string>();

  // 1. HTTP/gRPC/GraphQL: calls join serves on identity.
  for (const { repo, surface } of surfaces) {
    for (const call of surface.calls) {
      const matches = providers.get(call.id) ?? [];
      const external = matches.filter((m) => m.repo !== repo);
      if (external.length === 0) {
        // Same-repo self-calls are in-repo graph territory, not service edges —
        // but a self-consumed serve is NOT a dead surface: mark it consumed.
        if (matches.length === 0) {
          dangling.push({ repo, contractId: call.id, file: call.file, line: call.line, url: call.url });
        } else {
          for (const m of matches) consumed.add(`${m.repo}|${m.serve.id}`);
        }
        continue;
      }
      for (const m of external) {
        consumed.add(`${m.repo}|${m.serve.id}`);
        edges.push({
          from: repo,
          to: m.repo,
          contractId: call.id,
          kind: m.serve.kind,
          callSite: { file: call.file, line: call.line },
          serveSite: { file: m.serve.file, line: m.serve.line },
          // Joint confidence: both sides are heuristic detections.
          confidence: round2(call.confidence * m.serve.confidence),
        });
      }
    }

    // 2. Events: producer -> consumer on topic identity.
    for (const pub of surface.events.filter((e) => e.role === "publish")) {
      for (const other of surfaces) {
        if (other.repo === repo) continue;
        for (const sub of other.surface.events.filter(
          (e) => e.role === "subscribe" && e.id === pub.id,
        )) {
          edges.push({
            from: repo, // producer -> consumer: data flows this way
            to: other.repo,
            contractId: pub.id,
            kind: "event",
            callSite: { file: pub.file, line: pub.line },
            serveSite: { file: sub.file, line: sub.line },
            // Topic-string joins are the weakest tier (VISION §6 async caveat).
            confidence: round2(pub.confidence * sub.confidence * 0.9),
          });
        }
      }
    }
  }

  const unconsumed: ServiceGraph["unconsumedServes"] = [];
  for (const { repo, surface } of surfaces) {
    for (const serve of surface.serves) {
      if (!consumed.has(`${repo}|${serve.id}`)) {
        unconsumed.push({ repo, contractId: serve.id });
      }
    }
  }

  return {
    services: surfaces.map(({ repo, surface }) => ({
      repo,
      serves: surface.serves.length,
      calls: surface.calls.length,
      events: surface.events.length,
    })),
    edges,
    danglingCalls: dangling,
    unconsumedServes: unconsumed,
  };
}

export interface CrossRepoImpact {
  contractId: string;
  provider: string;
  /** Consumers that break if this contract changes, with call sites. */
  consumers: { repo: string; file: string; line: number; confidence: number }[];
}

/**
 * The money question: "if <repo> changes <contract>, whose service breaks?"
 * Pass a contract id (or a served file+line via resolveContract) from the
 * provider repo; get every consuming repo + exact call sites.
 */
export function crossRepoImpact(
  graph: ServiceGraph,
  provider: string,
  contractId: string,
): CrossRepoImpact {
  const consumers = graph.edges
    .filter((e) => e.to === provider && e.contractId === contractId)
    .map((e) => ({ repo: e.from, file: e.callSite.file, line: e.callSite.line, confidence: e.confidence }));
  // Events flow producer->consumer, so "provider" is the publisher (from side).
  for (const e of graph.edges) {
    if (e.kind === "event" && e.from === provider && e.contractId === contractId) {
      consumers.push({ repo: e.to, file: e.serveSite.file, line: e.serveSite.line, confidence: e.confidence });
    }
  }
  return { contractId, provider, consumers };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
