/**
 * Codemaps MCP server — the live query layer.
 *
 * The generated AGENTS.md tells the agent: "for precise, on-demand blast-radius
 * and guardrail queries, call these tools." This file defines that tool surface.
 * Wiring to @modelcontextprotocol/sdk (stdio + HTTP transports) lands in Phase 0
 * once the engine can build a real graph; the descriptors below are the contract.
 */

import type { LensName } from "@codemaps/core";

export interface ToolDescriptor {
  name: LensName;
  title: string;
  description: string;
  /** JSON-schema-ish input contract (finalized when SDK wiring lands). */
  input: Record<string, "string" | "string?">;
}

/** The six lenses, as MCP tools an agent calls before/while making a change. */
export const LENS_TOOLS: readonly ToolDescriptor[] = [
  {
    name: "orient",
    title: "Orient",
    description: "Top-down map: components, entry points, and how parts communicate.",
    input: {},
  },
  {
    name: "locate",
    title: "Locate",
    description: "Where a concept/feature lives: symbols, call paths, and prior related changes.",
    input: { query: "string" },
  },
  {
    name: "impact",
    title: "Impact (blast radius)",
    description: "What breaks if you change a symbol: direct + transitive dependents, affected tests/routes, contract crossings, and git co-change coupling.",
    input: { target: "string" },
  },
  {
    name: "guardrails",
    title: "Guardrails",
    description: "What must stay true here: invariants, do-not-touch zones, and design intent. Surfaces human/tacit knowledge; never fabricated.",
    input: { target: "string" },
  },
  {
    name: "risk",
    title: "Risk",
    description: "Fragility signals: hotspot score, churn, test coverage, flaky tests, owners, and bus factor.",
    input: { target: "string" },
  },
  {
    name: "security",
    title: "Security surface",
    description: "Security-critical context near a change: trust boundaries, taint source→sink paths, auth gates, secrets, and applicable STRIDE categories.",
    input: { target: "string" },
  },
] as const;
