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

## What this fork adds beyond upstream

Everything below is ours; none of it exists upstream.

- **`inline_comments`** — findings posted as inline review comments anchored to
  the changed lines, instead of one wall-of-text summary comment.
- **`context_files` / `context_max_bytes`** — the team's own convention files
  (`CLAUDE.md`, `.claude/rules/**`) given to the model, so it reviews against
  our rules rather than generic best practice.
- **`severity_threshold`** — a floor below which a finding is not worth a
  comment. Enforced on the parsed findings, not just asked for in the prompt.
- **`incremental_reviews`** — a re-review reports only findings anchored to
  lines pushed since this action last reviewed the PR. The whole PR diff is
  still sent as context so the model understands the change; the anchor filter
  is what keeps it from re-litigating commits the author already answered.
- **`suppress_duplicates`** — findings this action already posted on the PR are
  dropped, matched by anchor (`path:line`) *and* by normalised title, because
  GitHub re-anchors comment lines as the diff evolves and the model rewords
  titles between runs.
- **`resolve_outdated_threads`** — resolves our own threads that GitHub has
  marked outdated, i.e. the line the finding pointed at has been rewritten.
  Only ever outdated threads, never a human's, and never on a guess that
  something was fixed.
- **Review counting and cooldown actually work in inline mode.** Upstream only
  looks at *issue comments*, but `inline_comments` posts a pull request
  *review* — so `max_pr_reviews` and `cooldown_period` were silently blind and
  never fired. Both now read reviews and comments, and match on our own review
  marker rather than on "any bot" (which used to count Dependabot as us).

See CST-3274 for the reasoning behind the last four.

## Rebuilding after pulling upstream changes

```bash
npm ci
npm run build     # ncc build src/index.js -o dist
git add dist && git commit -m "chore: rebuild dist"
git tag -a vX.Y.Z -m "..." && git push origin main --tags
```

## Consumers

Each of these has a `.github/workflows/ai-pr-review.yml`:

- `Finacte/finacte-cst`
- `Finacte/finacte-epc`
- `Finacte/finacte-seafood`
- `Finacte/finacte-bbl`

Callers pin this action by **commit SHA**, not by tag or branch. Bump the SHA
in **all four** consumers after tagging a new version here — they are meant to
stay on the same version, and the workflows are otherwise identical apart from
the project name and the security paragraph in `custom_prompt`.
