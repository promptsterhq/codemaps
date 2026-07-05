# Codemaps

[![CI](https://github.com/promptsterhq/codemaps/actions/workflows/codemaps.yml/badge.svg)](https://github.com/promptsterhq/codemaps/actions/workflows/codemaps.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

> The open-source Codemaps engine, CLI, and MCP server. The hosted cross-repo
> service graph (Codemaps Cloud) is a separate proprietary product:
> https://codemaps-schinizels-projects.vercel.app

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

Working pre-alpha — **all six lenses live, end-to-end locally testable.**

```bash
# one-time setup from a clone:
pnpm install && pnpm build
cd packages/cli && npm link       # puts `codemaps` on your PATH

# then in any git repo:
codemaps init            # risk + guardrails + graph + AGENTS.md (+ CLAUDE.md bridge)
codemaps orient          # what is this system? components, entry points, comms
codemaps risk <path>     # hotspot pct, churn, owners, bus-factor, coverage + warnings
codemaps guardrails <p>  # do-not-touch zones + mined invariants (materiality-gated)
codemaps guardrails confirm <id>   # promote to human-confirmed (durable, versioned in codemap/)
codemaps security <path> # (beta) traversal guards, auth gates, sinks, secrets — with consequences
codemaps impact <symbol> # reverse blast radius + affected tests (TS/JS, Python, Go, Java, Kotlin)
codemaps locate <query>  # ranked symbol/file search
codemaps serve           # MCP server: all six lenses for any MCP agent
codemaps explore         # localhost dashboard: risk table, guardrail confirm/reject, impact search
codemaps init --hooks    # PreToolUse hook: warns on hotspots/invariants,
                         # blocks only human-CONFIRMED do-not-touch zones

# verify everything in one shot:
./scripts/e2e-smoke.sh          # 13 checks: build, tests, lenses, MCP, hook, explorer
```

**Benchmark evidence** (same model, same prompt; [`bench/ANALYSIS.md`](bench/ANALYSIS.md)): on the lockfile trap the baseline agent hand-edited `pnpm-lock.yaml` while the Codemaps arm refused, cited the guardrail, and finished 2× faster. On the security trap both arms initially removed a path-traversal guard — which drove the Security lens (consequence-enriched invariants); on re-run the agent flagged the risk, named the `../../etc/passwd` attack, and proposed a safe alternative. **2/6 violations avoided, 0 regressions, n=1 per cell (early).**


## Language support

Support is **per-lens, not all-or-nothing** — the lens that needs the least
parsing works everywhere, and depth increases from there:

| Lens | Languages | Why |
|------|-----------|-----|
| **Risk** (hotspots, churn, ownership, bus-factor) | **Any git repo, any language** | Mined from git history — never parses code |
| **Guardrails** (do-not-touch zones, invariants) | TS/JS, Python, Go, Ruby, Java, Rust, C# | Comment/assert conventions per language |
| **Contracts** (serves / calls / events) | Express-style routers, NestJS, **Next.js** (App Router + `pages/api`), FastAPI/Flask — plus `.proto`, GraphQL, OpenAPI (language-neutral IDL) | Thin per-framework detectors |
| **Orient** (components, entry points) | JS/TS + Python manifests | Manifest-driven |
| **Impact / Locate** (code graph, blast radius) | TypeScript/JavaScript, Python, **Go**, **Java**, **Kotlin** | Real per-language indexers (TS compiler API / tree-sitter) |
| **Security** (beta) | TS/JS + Python heuristics | Per-language sink/guard patterns |

More languages are grammar work, not architecture — the Python indexer already
runs on web-tree-sitter, which has prebuilt grammars for dozens of languages.
**Framework detectors are the easiest contribution we take**: open a
[detector request](https://github.com/promptsterhq/codemaps/issues/new?template=lens_request.yml)
with a minimal missed-pattern snippet, or send the PR — pattern + fixture test
(see `contracts:` tests in `packages/core/src/core.test.ts` for the shape).

## Repo layout

```
packages/
  core/   @codemaps/core   the context engine (graph, lenses, language analyzers)
  cli/    @codemaps/cli     npx codemaps (init / index / serve / explore)
  mcp/    @codemaps/mcp     MCP server exposing the six lenses
```

## Develop

```bash
pnpm install
pnpm build
```

## License

The Codemaps engine, CLI, and MCP server (`packages/*`) are **Apache-2.0** —
see [LICENSE](LICENSE). Contributions require a DCO sign-off
([CONTRIBUTING.md](CONTRIBUTING.md)). The Codemaps cloud (cross-repo service
graph, hosted at codemaps.dev) is a separate proprietary codebase.
