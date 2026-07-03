/**
 * The six lenses — the canonical questions a senior/principal/security engineer
 * must answer to change an unfamiliar repo safely. Each is exposed both as an
 * agent-callable MCP tool and as a human view. See docs/VISION.md §3.
 *
 * Derivability tiers (see docs/RESEARCH.md §B):
 *   🟢 auto-derivable   🟡 heuristic   🔴 human-tacit (surface & route to, never fabricate)
 */

import type { NodeId, SourceLocation } from "./graph.js";

/** A task-scoped context pack: the answer to one lens, sized for an agent (hundreds of tokens). */
export interface LensResult<T> {
  lens: LensName;
  /** Confidence/derivation provenance so agents know how much to trust it. */
  tier: "derived" | "heuristic" | "human";
  data: T;
}

export type LensName =
  | "orient"
  | "locate"
  | "impact"
  | "guardrails"
  | "risk"
  | "security";

// 1. ORIENT 🟢🟡 — "What is this system and how do its parts talk?"
export interface Orientation {
  components: { name: string; responsibility?: string; paths: string[] }[];
  entryPoints: NodeId[];
  communication: { style: "rest" | "grpc" | "queue" | "db" | "graphql"; via: string }[];
}

// 2. LOCATE 🟢🟡 — "Where do I make this change?"
export interface Location {
  nodes: NodeId[];
  callPaths: NodeId[][]; // entry -> ... -> target
  priorChanges: { commit: string; summary: string; paths: string[] }[]; // git changeset history
}

// 3. IMPACT 🟢 — "What breaks if I change this? Who depends on it?" (the killer feature)
export interface BlastRadius {
  target: NodeId;
  directDependents: NodeId[];
  transitiveDependents: NodeId[];
  affectedTests: NodeId[];
  affectedRoutes: NodeId[];
  crossesContract: boolean; // touches a published API/schema/event
  coChanged: { node: NodeId; weight: number }[]; // git hidden coupling
}

// 4. GUARDRAILS 🟡🔴 — "What must stay true? What's load-bearing / do-not-touch?"
export interface Guardrails {
  invariants: { statement: string; source: SourceLocation; kind: "assertion" | "validation" | "type" | "test" | "declared" }[];
  doNotTouch: { path: string; reason: "generated" | "vendored" | "frozen-migration" | "declared" }[];
  intent: { note: string; source: SourceLocation | { adr: string } | { pr: string } }[];
}

// 5. RISK 🟢 — "Where is this fragile?"
export interface Risk {
  hotspot: number; // changeFrequency × complexity, normalized
  churn: number;
  coverage: number | null;
  flakyTests: NodeId[];
  owners: { name: string; kind: "codeowners" | "git-blame"; share: number }[];
  busFactor: number;
}

// 6. SECURITY 🟢🟡 — "What's the security-critical surface here?"
export interface SecuritySurface {
  trustBoundaries: SourceLocation[];
  taintPaths: { source: NodeId; sink: NodeId; sanitized: boolean }[];
  authGates: { node: NodeId; guarded: boolean }[];
  secrets: SourceLocation[];
  stride: ("spoofing" | "tampering" | "repudiation" | "info-disclosure" | "dos" | "elevation")[];
}

/** The context engine exposes all six lenses over a built graph. */
export interface Lenses {
  orient(): Promise<LensResult<Orientation>>;
  locate(query: string): Promise<LensResult<Location>>;
  impact(target: NodeId): Promise<LensResult<BlastRadius>>;
  guardrails(target: NodeId | string): Promise<LensResult<Guardrails>>;
  risk(target: NodeId | string): Promise<LensResult<Risk>>;
  security(target: NodeId | string): Promise<LensResult<SecuritySurface>>;
}
