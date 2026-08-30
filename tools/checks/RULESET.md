# Making `CI OK` the required check

`ci-ok` (`.github/workflows/ci.yml`) aggregates every CI job so that a single
check can be marked *required* without blocking docs-only PRs whose build jobs
are legitimately skipped. Today it is required nowhere: the `main` ruleset
requires only `Build / Ubuntu 22.04`, and `develop` — the PR target — has no
ruleset at all. This document is the runbook for closing that gap. It is
**not** executed by the builder; branch protection is a repository setting,
not a file in the tree.

## Preconditions (do not skip)

1. This branch is merged, so `ci-ok` treats `cancelled` as neutral. Before
   that change, `cancel-in-progress: true` cancelled 33 of the last 100 PR
   runs and each of those would have shown as a red required check.
2. `CI OK` has been green on **10 consecutive `develop` pushes** with the new
   `test-fast` and `ci-lint` jobs included. Check with:

   ```bash
   gh run list -R rocketride-org/rocketride-server --branch develop --workflow CI --limit 10 \
     --json conclusion,headSha,displayTitle
   ```

## Apply (repository admin)

The check name GitHub matches on is the job's `name:` — `CI OK`.

```bash
REPO=rocketride-org/rocketride-server

# develop: create a ruleset that requires CI OK and a PR
gh api -X POST "repos/$REPO/rulesets" --input - <<'JSON'
{
  "name": "develop-required-checks",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/develop"], "exclude": [] } },
  "rules": [
    { "type": "pull_request", "parameters": { "required_approving_review_count": 1, "dismiss_stale_reviews_on_push": true, "require_code_owner_review": false, "require_last_push_approval": false, "required_review_thread_resolution": false } },
    { "type": "required_status_checks", "parameters": { "strict_required_status_checks_policy": false, "required_status_checks": [ { "context": "CI OK" } ] } }
  ]
}
JSON

# main: add CI OK to the existing ruleset (find its id first)
gh api "repos/$REPO/rulesets" --jq '.[] | "\(.id) \(.name)"'
# then edit that ruleset's required_status_checks to [{ "context": "CI OK" }]
# (replacing "Build / Ubuntu 22.04", which CI OK already includes).
```

Windows and macOS builds stay in the matrix with `fail-fast: false` and
**do** fail `CI OK` — that is intended; flaky platforms get fixed, not
un-required.

## Verify

Open a throwaway PR against `develop` that breaks `tests/test_repo_invariants.py`
(e.g. un-pin an action) and confirm the merge button is blocked by `CI OK`.
