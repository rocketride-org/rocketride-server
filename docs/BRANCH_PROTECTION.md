# Branch Protection Rules

Recommended branch protection configuration for the RocketRide Server repository.

## `develop` Branch (Primary Integration Branch)

### Required Settings

| Setting | Value | Rationale |
|---------|-------|-----------|
| Require pull request reviews | Yes | All changes must be peer-reviewed |
| Required approving reviews | 1 | Minimum one approval before merge |
| Dismiss stale reviews on new pushes | Yes | Force re-review after changes |
| Require review from CODEOWNERS | Yes | Enforces team-based ownership (see `.github/CODEOWNERS`) |
| Require status checks to pass | Yes | Prevents merging broken code |
| Require branches to be up to date | Yes | Ensures CI runs against latest develop |
| Require linear history | Yes | Keeps history clean (squash or rebase merges only) |
| Require signed commits | No | Optional; not all contributors have GPG keys configured |
| Include administrators | Yes | Rules apply to everyone, including admins |
| Restrict who can push | Yes | Only merge via PR; no direct pushes |
| Allow force pushes | No | Never allow force pushes to develop |
| Allow deletions | No | Prevent accidental branch deletion |

### Required Status Checks

These checks must pass before a PR can merge to `develop`:

- `CI OK` (from `ci.yml` — the gatekeeper job that aggregates all CI results)
- `Detect secrets` (from `gitleaks.yml`)
- `Review dependencies` (from `dependency-review.yml`)
- `Validate PR title` (from `pr-checks.yml`)

### Optional but Recommended Status Checks

- `Python coverage` (from `coverage.yml` — advisory, not blocking)

## `main` Branch (Production)

Apply the same settings as `develop`, with these additions:

| Setting | Value | Rationale |
|---------|-------|-----------|
| Required approving reviews | 2 | Higher bar for production releases |
| Restrict pushes to specific teams | DevOps only | Only release managers can merge to main |

## How to Configure in GitHub UI

1. Go to **Settings** > **Branches** > **Add branch protection rule**
2. Enter the branch name pattern (e.g., `develop`)
3. Enable each setting from the tables above
4. Under **Require status checks to pass before merging**:
   - Search for and add each required check by name
   - Enable **Require branches to be up to date before merging**
5. Click **Create** (or **Save changes** if editing)

### Using GitHub CLI

You can also configure branch protection via `gh`:

```bash
gh api repos/{owner}/{repo}/branches/develop/protection \
  --method PUT \
  --field required_status_checks='{"strict":true,"contexts":["CI OK","Detect secrets","Review dependencies","Validate PR title"]}' \
  --field enforce_admins=true \
  --field required_pull_request_reviews='{"required_approving_review_count":1,"dismiss_stale_reviews":true,"require_code_owner_reviews":true}' \
  --field restrictions=null \
  --field required_linear_history=true \
  --field allow_force_pushes=false \
  --field allow_deletions=false
```

## Rulesets (GitHub Rulesets Alternative)

GitHub Rulesets provide a newer, more flexible alternative to branch protection rules.
They support targeting multiple branches, bypass lists, and organization-level policies.

To use rulesets instead, go to **Settings** > **Rules** > **Rulesets** > **New ruleset**.
The same settings from the tables above apply; rulesets simply offer a more granular UI.
