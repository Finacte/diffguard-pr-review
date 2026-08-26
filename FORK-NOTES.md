# Why this fork exists

Upstream: [jonit-dev/openrouter-github-action](https://github.com/jonit-dev/openrouter-github-action) (MIT).

GitHub Actions runs the **committed** `dist/index.js` bundle — it never builds
an action for you. Upstream's `main` branch has the newest features
(`exclude_files`, `minimum_score`, `max_pr_reviews`, `cooldown_period`,
`reasoning_effort`) but the author removed `dist/` from it, so `@main` fails
immediately with a missing-module error. The only refs that still ship a
bundle are the `v1.0.0` / `pr-review` tags from November 2024, which predate
all of those inputs.

This fork is upstream `main` with `dist/` rebuilt and committed, so the
current feature set actually runs.

## Rebuilding after pulling upstream changes

```bash
npm ci
npm run build     # ncc build src/index.js -o dist
git add dist && git commit -m "chore: rebuild dist"
git tag -a vX.Y.Z -m "..." && git push origin main --tags
```

## Consumers

- `Finacte/finacte-cst` → `.github/workflows/ai-pr-review.yml`

Callers pin this action by **commit SHA**, not by tag or branch. Bump the SHA
in each consumer after tagging a new version here.
