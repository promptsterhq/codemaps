# Agent roster — `.claude/agents/`

A set of Claude Code subagents specialized for building **Codemaps**: a
local-first context engine that maps a repository (tree-sitter → code graph
→ SQLite) and serves it to AI coding agents through the six lenses (Orient,
Locate, Impact, Guardrails, Risk, Security) via an MCP server, a generated
`AGENTS.md`/`CLAUDE.md`, and Claude Code hook enforcement — plus a thin
cloud tier for cross-repo contract stitching. Drop these `.md` files into
`.claude/agents/` at your project root and commit them so the whole team
shares the same specialists. Restart the session (or use `/agents`) for
Claude Code to pick up new/edited files on disk.

## The roster (14)

**Core engine + protocol**
- `core-engine-architect` — tree-sitter → code graph, git-history Risk
  mining, Guardrails mining + the materiality gate, contract-surface
  extraction — the six lenses' actual implementation
- `agent-integrations` — the MCP tool surface, hook (PreToolUse/SessionStart)
  contracts, and cross-runtime compatibility (Claude Code, Cursor, Copilot,
  Cline, Codex)
- `cli-platform-eng` — the CLI, the `init` pipeline, `hook-command.ts`'s
  fail-open/confirmed-only-deny logic, local `.codemaps/*` persistence
- `cloud-platform-eng` — the (deliberately thin) Next.js/Supabase cloud
  tier: stitch/snapshot APIs, RLS, org data model

**Trust + evidence**
- `security-compliance` — local-first boundary integrity, hook/MCP trust
  boundary, cloud RLS, supply chain *(folds in the trust/legal-drafting
  scope: security questionnaires, DPA, sub-processors, trust center)*
  *(read-only guardrail for app code; drafts trust artifacts)*
- `privacy-boundary` — what's allowed to leave the machine for cloud
  stitching (contracts only, never source), git-mined identity data,
  snapshot retention/deletion
- `benchmark-evals` — the `bench/` harness: trap-task design, baseline-vs-
  codemaps scoring, guarding every public benchmark claim against being
  gameable

**Build-out**
- `web-dashboard-ux` — the one real frontend: the hosted service-map/
  cross-repo-impact dashboard
- `qa-test` — Risk/Guardrails correctness fixtures, hook-safety adversarial
  tests, MCP contract tests, cloud RLS isolation
- `docs-agents-md` — the generated `AGENTS.md`/`CLAUDE.md`/
  `guardrails.json` as a product surface, plus API/CLI reference

**Commercial (advisory)**
- `product-strategy` — the "judgment layer above a commodity code-graph-
  over-MCP category" wedge, roadmap, competitive framing
- `gtm-marketing` — developer marketing to AI-agent users, benchmark-backed
  claims only
- `pricing-packaging` — free local CLI vs. paid cross-repo cloud tier

**Meta**
- `staff-engineer-reviewer` — cross-cutting coherence + final review gate
  across core/mcp/cli/web *(read-only)*

## Conventions baked into the set

- **`description` is the delegation trigger.** Written as when-to-use
  conditions with "Use PROACTIVELY…" nudges so Claude Code auto-routes to
  them.
- **Tools are scoped per agent.** Review/guardrail agents
  (`security-compliance`, `staff-engineer-reviewer`) stay read-only for
  application code so they advise and gate rather than ship;
  `security-compliance` gets `Write`/`Edit` narrowly for drafting
  trust-center/DPA artifacts (folded in from the retired `legal-trust`).
- **Each agent carries a short embedded product brief** so it works in its
  own context window. Keep the canonical version in `AGENTS.md`/`CLAUDE.md`;
  trim the embedded briefs if that drifts.
- **Model tiering:** agents use `model: inherit` by default; comments flag
  where pinning to `opus` is worth it (`security-compliance`,
  `staff-engineer-reviewer`, lens/architecture design work).
- **No coordinator agent.** Your main session routes between these; use a
  `PLAN.md` / queue pattern or Agent Teams for multi-step handoffs.

## History

This roster started as a copy of a starter set built for an unrelated
data-platform product and was remapped onto Codemaps' actual domain
(context engine, six lenses, MCP/hooks, cross-repo stitching). `legal-trust`
was folded into `security-compliance` rather than kept separate, since the
local-first model leaves a much thinner legal/trust surface than the
original product had.
