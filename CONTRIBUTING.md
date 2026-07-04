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

## What makes a good PR

- Lens correctness > lens breadth. A detector that's precise on one framework
  beats one that's noisy on five (see the doc-comment false-positive lesson in
  the test suite).
- New detectors ship with fixture tests (`packages/core/src/core.test.ts`).
- `pnpm test` green, `codemaps check` clean (it runs as the PR gate).
- Never hand-edit generated artifacts (`pnpm-lock.yaml`, `codemap/*.json`
  content) — the tooling regenerates them.
