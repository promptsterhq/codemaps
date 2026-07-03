# Agent roster — `.claude/agents/`

A starter set of Claude Code subagents for a security-first engineering-intelligence
data platform. Drop these `.md` files into `.claude/agents/` at your project root and
commit them so the whole team shares the same specialists. Restart the session (or use
`/agents`) for Claude Code to pick up new/edited files on disk.

## The roster (15)

**Core stack + differentiator**
- `security-compliance` — threat modeling, tenant isolation, secrets/KMS, SOC 2 / ISO /
  GDPR, security review gate *(read-only guardrail)*
- `data-platform-architect` — ingestion → storage → query pipeline, canonical schema,
  data-explorer semantics
- `integrations-connectors` — git host / AI-provider / CI-CD connectors, normalization,
  API drift
- `infra-sre` — IaC, deployment models (SaaS / single-tenant / VPC / self-hosted / BYOK),
  reliability
- `eng-metrics-domain` — DORA / SPACE / DX Core 4 / AI-impact, done correctly

**Build-out**
- `platform-backend` — APIs, ingestion framework, query backend, authz
- `data-governance-privacy` — minimization, retention/deletion, PII, residency,
  sub-processors
- `data-explorer-ux` — the one real frontend; query UX, large-tenant performance
- `qa-test` — data-correctness, connector resilience, adversarial isolation tests
- `docs-data-dictionary` — the semantic catalog (a product surface) + API docs / runbooks

**Commercial (advisory)**
- `product-strategy` — positioning, roadmap, competitive, JTBD
- `gtm-marketing` — security-first developer marketing and messaging
- `pricing-packaging` — usage/data-volume pricing, isolation tiers
- `legal-trust` — DPAs, security questionnaires, sub-processors, trust center

**Meta**
- `staff-engineer-reviewer` — cross-cutting coherence + final review gate *(read-only)*

## Conventions baked into the set

- **`description` is the delegation trigger.** Written as when-to-use conditions with
  "Use PROACTIVELY…" nudges so Claude Code auto-routes to them.
- **Tools are scoped per agent.** Review/guardrail agents (`security-compliance`,
  `staff-engineer-reviewer`) are read-only — no `Write`/`Edit` — so they advise and gate
  rather than ship. Build and authoring agents get write access.
- **Each agent carries a short embedded product brief** so it works in its own context
  window. Keep the canonical version in `CLAUDE.md`; trim the embedded briefs once that
  exists to avoid drift.
- **Model tiering:** run your main session on Opus (it's the orchestrator). Agents use
  `model: inherit` by default; comments flag where pinning to `opus` is worth it
  (`security-compliance`, `staff-engineer-reviewer`, architecture work).
- **No coordinator agent.** Your main session routes between these; use a `PLAN.md` /
  queue pattern or Agent Teams for multi-step handoffs.

## Two-pass plan (intentional)

These are v1 skeletons, kept stack-agnostic on purpose — your real anchoring decisions
(language, storage engine, cloud, deployment model) aren't made yet, and hard-coding them
now would bake in guesses.

**Pass 2, once the architecture is real:** for the Tier-1 technical agents, add (1) the
actual stack/conventions, (2) a worked output example (few-shot tightens consistency far
more than a described format), and (3) explicit handoff rules ("when Y, recommend invoking
X"). Then tune empirically against real diffs and tasks — system prompts only get good by
running them. The advisory agents can stay at this depth permanently.
