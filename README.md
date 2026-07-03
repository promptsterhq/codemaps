# Codemaps

**A local-first context engine that maps your repository and serves it to AI coding agents — so they make fewer mistakes, change code faster, and know what *not* to touch.**

AI agents fail most often not because the model is weak, but because they lack context: they hallucinate APIs, edit the wrong layer, break invariants, and don't know what's load-bearing. "Missing context" is the #1 agent failure mode (~60–65% of developers report it). Codemaps is the missing context layer.

Code-graph-over-MCP (callers, imports, blast radius) commoditized in 2026 — several great free tools now ship it. Codemaps stands *on top of* that commodity graph and adds the judgment layer nobody else does: **what must stay true here (Guardrails), where it's fragile (Risk), and the security-critical surface (Security)** — the questions today's models are worst at answering unaided.

Unlike cloud, embedding-based tools, Codemaps is:

- **Precise, not fuzzy** — a deterministic code graph (tree-sitter → SQLite), so agents get *certainty* on callers and blast radius, not "chunks that look similar."
- **Local-first & private** — runs on your machine; your source never leaves it.
- **Always fresh** — incremental re-index on change; a stale map is worse than none.
- **Agent-native** — ships over **MCP** + a generated **`AGENTS.md`**, so it works inside Claude Code, Cursor, Copilot, Cline, and Codex — not a walled-off client.

## The six lenses

Codemaps answers the questions a senior/principal/security engineer needs to change an unfamiliar repo safely — each an agent-callable MCP tool and a human view:

| Lens | Answers |
|------|---------|
| **Orient** | What is this system and how do its parts talk? |
| **Locate** | Where do I make this change? |
| **Impact** | What breaks if I change this? Who depends on it? |
| **Guardrails** | What must stay true? What's load-bearing / do-not-touch? |
| **Risk** | Where is this fragile? (hotspots, churn, coverage, ownership) |
| **Security** | What's the security-critical surface here? |

## Status

Early / pre-alpha. Phase 0 builds a *thin* TS/Python graph (just enough scaffolding for `impact()`/`locate()`) and leads with the differentiated layer: a first Guardrails slice + an evaluation benchmark proving fewer bad edits vs. commodity graph + grep. See [`docs/VISION.md`](docs/VISION.md) for the plan, [`docs/DIFFERENTIATION.md`](docs/DIFFERENTIATION.md) for the defensible layers, and [`docs/RESEARCH.md`](docs/RESEARCH.md) for the market/technical grounding (incl. the 2026 competitive re-scan).

## Repo layout

```
packages/
  core/   @codemaps/core   the context engine (graph, lenses, language analyzers)
  cli/    @codemaps/cli     npx codemaps (init / index / serve / explore)
  mcp/    @codemaps/mcp     MCP server exposing the six lenses
apps/
  web/                      Next.js marketing + hosted explorer (Phase 3)
```

## Develop

```bash
pnpm install
pnpm build
```
