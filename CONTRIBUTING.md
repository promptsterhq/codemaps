# Contributing to Codemaps

Thanks for helping map the world's repos for AI agents. A few ground rules keep
contributions healthy for everyone.

## Developer Certificate of Origin (DCO)

Every commit must be signed off:

```bash
git commit -s -m "your message"
```

The `-s` adds a `Signed-off-by:` trailer certifying you wrote the change (or
have the right to submit it) under the project's license — the
[Developer Certificate of Origin](https://developercertificate.org/). PRs with
unsigned commits fail CI. No CLA, no paperwork — just the sign-off.

## License

Code in this repository is licensed under [Apache-2.0](LICENSE). By
contributing, you agree your contributions are licensed under the same terms.
The Codemaps cloud service is a separate, proprietary codebase — contributions
here never end up relicensed into it without the DCO terms above.

## Getting started

```bash
pnpm install && pnpm build && pnpm test   # Node >= 18.17 (see packageManager)
cd packages/cli && npm link               # puts `codemaps` on your PATH
./scripts/e2e-smoke.sh                    # full local smoke
```

This repo dogfoods itself: Codemaps hooks run on every agent edit here, and
`codemap/guardrails.json` is the live guardrail store — treat its warnings as
you'd want your users to.

## Adding a language or framework detector — the ideal first PR

Language support is per-lens; the cheapest, highest-impact additions are
**contract detectors** (a router/framework pattern in
`packages/core/src/contracts.ts`) and **guardrail/manifest conventions**.
The recipe:

1. Find the real-world pattern the lens misses (or open a
   [detector request](https://github.com/promptsterhq/codemaps/issues/new?template=lens_request.yml)
   first to check fit).
2. Add the rule — line-based detectors go in `SERVE_RULES`/`CALL_RULES`/
   `EVENT_RULES`; path-based ones (like Next.js) get a file-level function.
3. Add a fixture test in `packages/core/src/core.test.ts` (see the
   `contracts:` tests for the shape — temp git repo, real snippet, assert ids).
4. Precision over recall: a detector that's quiet on code it doesn't
   understand beats one that guesses. Confidence scores are honest scores.

## What makes a good PR

- Lens correctness > lens breadth. A detector that's precise on one framework
  beats one that's noisy on five (see the doc-comment false-positive lesson in
  the test suite).
- New detectors ship with fixture tests (`packages/core/src/core.test.ts`).
- `pnpm test` green, `codemaps check` clean (it runs as the PR gate).
- Never hand-edit generated artifacts (`pnpm-lock.yaml`, `codemap/*.json`
  content) — the tooling regenerates them.
