# Dependabot Smoke Tests

PR CI currently runs build, lint, secret scanning, and CodeQL, but **not** unit/integration tests. For Python dependency bumps, that means a bumped `litellm` or `spacy-transformers` can pass CI yet break runtime code (the weekly model-sync workflow, pipeline node execution).

These scripts exist to give a reviewer a 30-second answer to "does this dep bump actually run?" before merging a Dependabot PR.

## Scripts

| Script | Use when Dependabot bumps anything in… |
| --- | --- |
| `smoke-litellm.sh` | `tools/sync_models/requirements.txt` (litellm consumer) |
| `smoke-nodes.sh` | `nodes/src/nodes/<node>/*.txt` (Python pipeline node deps) |

## Manual invocation (from a Dependabot PR branch)

```bash
gh pr checkout <PR-number>

# litellm bumps:
bash tools/dependabot-smoke/smoke-litellm.sh

# pipeline-node Python bumps (only the nodes whose .txt files changed):
bash tools/dependabot-smoke/smoke-nodes.sh --changed-only
```

Exit `0` means imports + key APIs work. Non-zero means a real breakage, report on the PR, do not merge.

## Future work: wire into PR CI

These are designed to be cheap and parallelizable. The follow-up to actually gate Dependabot PRs on them is tracked in a separate issue (link in the PR that introduced this directory). Sketch:

- New workflow `.github/workflows/dependabot-smoke.yml`
- Triggers on `pull_request` from `app/dependabot`
- Detects which paths changed; runs the matching script
- Status check name added to `CI OK` aggregator so it gates auto-merge
