# Security Policy

Codemaps ships a security lens; we hold ourselves to the standard it enforces.

## Reporting a vulnerability

**Please do not open a public issue for security reports.** Use GitHub's
private vulnerability reporting instead:

**[Report a vulnerability →](https://github.com/promptsterhq/codemaps/security/advisories/new)**

You'll get an acknowledgment within 72 hours. We'll work with you on a fix and
coordinate disclosure; credit is yours unless you prefer otherwise.

## Scope

- This repository: the Codemaps engine (`@codemaps/core`), CLI
  (`@codemaps/cli`), and MCP server (`@codemaps/mcp`). Highest-interest areas:
  the PreToolUse hook path (it advises/blocks agent edits — fail-open by
  design, never escalate), anything that reads untrusted repo content, and the
  contract/guardrail miners.
- The Codemaps cloud service is proprietary and out of scope here — report
  cloud issues through the same advisory link and we'll route them.

## Supported versions

Pre-1.0: only the latest published release receives fixes.
