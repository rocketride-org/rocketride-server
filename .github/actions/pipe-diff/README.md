# RocketRide Pipe Diff action

A composite GitHub Action that posts a **semantic** diff of changed `.pipe`
pipeline files as a single, sticky pull-request comment.

Raw JSON diffs of `.pipe` files are dominated by canvas coordinate churn — the
per-node `ui` block and the top-level `viewport` — which buries the changes that
actually matter. This action wraps the local [`rocketride diff`](../../../packages/client-python)
CLI subcommand to surface only what changed: nodes added/removed, provider
changes, config field changes, and edge (wiring) additions/removals.

**The comparison itself runs locally.** Like the `rocketride diff` command it
wraps, it never contacts the RocketRide engine and needs no
`--uri`/`--apikey`/`--token` credentials of any kind — it only reads files and
git objects and compares parsed JSON on the runner. The action *around* that
comparison does use the network: it installs the CLI (from PyPI, or from
`install-from`), fetches the PR base commit, and calls the GitHub comments API
when `comment: true`.

## Usage

Add a workflow that checks out the repo and runs this action on pull requests:

```yaml
name: Pipe diff
on:
  pull_request:

# Reading the repo, and writing the sticky comment.
permissions:
  contents: read
  pull-requests: write

jobs:
  pipe-diff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4
      - uses: ./.github/actions/pipe-diff
```

`actions/checkout` with its default `fetch-depth: 1` is enough — the action
fetches the PR base commit itself before diffing.

### With inputs

```yaml
      - uses: ./.github/actions/pipe-diff
        with:
          files: 'pipelines/**/*.pipe'   # restrict which .pipe files are considered
          python-version: '3.12'
          cli-version: '==1.4.0'          # pin a specific published rocketride release
          comment: 'true'                 # set 'false' to skip commenting
          include-layout: 'false'         # set 'true' to also report ui/viewport churn
```

### Running against an unreleased CLI

`rocketride diff` ships in a release **after** 1.3.0. Until that release is on
PyPI, point `install-from` at a checkout of the client package — this is how this
repository dogfoods the action:

```yaml
      - uses: ./.github/actions/pipe-diff
        with:
          install-from: ./packages/client-python
```

> **`install-from` is an executable package source.** Its value is passed to
> `python -m pip install`, which runs the source's build and install code
> (`setup.py`, PEP 517 backends, install hooks) with the job's privileges and
> token. Point it only at code you trust. In particular, in a
> `pull_request_target` workflow — writable token, base-repository secrets — it
> must **never** resolve to pull-request-controlled code: do not point it at a
> path inside a checkout of the PR head.

## Inputs

| Input            | Default       | Description |
| ---------------- | ------------- | ----------- |
| `files`          | `**/*.pipe`   | Git pathspec glob selecting the `.pipe` files to consider. Git's `:(glob)` magic is applied automatically, so `**` matches across directories. Only files that actually changed versus the PR base are diffed. |
| `python-version` | `3.12`        | Python version passed to `actions/setup-python`. RocketRide requires Python >= 3.10. |
| `cli-version`    | `` (empty)    | pip version specifier appended to the `rocketride` requirement, e.g. `==1.4.0` or `>=1.4,<2`. Empty installs the latest published release. The run **fails fast** with a clear message if the installed CLI lacks the `diff` subcommand. |
| `install-from`   | `` (empty)    | Install the CLI from this local path or pip source (e.g. `./packages/client-python`) instead of PyPI. Takes precedence over `cli-version`. Use it to run the action before a release ships `rocketride diff`. **Executable source:** pip runs its build/install code with the job's privileges, so point it only at trusted code — never at PR-controlled code in a `pull_request_target` workflow. |
| `comment`        | `true`        | When `true`, post or update one sticky PR comment. Set to `false` to compute the diff without commenting; that mode needs no `pull-requests: write` permission. The report is written to the **job summary** either way. |
| `include-layout` | `false`       | When `true`, treat canvas layout churn (per-node `ui` blocks and the top-level `viewport`) as meaningful and enumerate it as `ui.*` / `viewport.*` field changes. When `false` (default) a pure-layout change is reported as `No semantic changes.`. |

## Outputs

| Output                 | Description |
| ---------------------- | ----------- |
| `changed-files`        | Number of changed `.pipe` files considered (added or modified vs the PR base). |
| `has-semantic-changes` | `true` when at least one changed `.pipe` file has semantic changes, else `false`. |
| `comment-body-file`    | Path to the generated Markdown comment body (useful for debugging or reuse). |

## Permissions

The sticky-comment step needs `pull-requests: write` (comments are issue
comments on the PR). `contents: read` is required to check out and diff the
repository. If you set `comment: false`, only `contents: read` is needed.

The action authenticates the GitHub REST calls with the workflow's built-in
`GITHUB_TOKEN`; it never prints the token.

### Fork pull requests

On a `pull_request` event **from a fork**, GitHub hands the job a read-only
`GITHUB_TOKEN` regardless of the workflow's `permissions:` block, so the comment
API returns `403`. The action does not fail on that: it emits a `warning`
annotation and leaves the full report in the **job summary**, which every run
writes. Your options, in order of preference:

1. Do nothing — read the diff in the job summary (works for every PR, no extra
   permissions).
2. Set `comment: false` to skip the API call entirely and drop the
   `pull-requests: write` permission.
3. Use `pull_request_target`, which runs with a writable token. Note its
   trade-off: the workflow runs in the base repository's context, so you must
   **not** check out or execute the PR head's code from it. This action only
   reads `.pipe` data files, but the rest of your job must respect that rule —
   including `install-from`, which pip executes (see the note above).

## Behavior

- **Sticky comment.** The action maintains exactly one comment per PR, found via
  a hidden HTML marker (`<!-- rocketride-pipe-diff -->`) **and** an author check
  for `github-actions[bot]`, so a human comment quoting the marker is never
  overwritten. Re-runs update that comment in place instead of stacking new ones.
- **Job summary.** Every run appends the same report to `$GITHUB_STEP_SUMMARY`,
  so the diff is visible even when commenting is disabled or refused.
- **Layout noise is hidden by default.** A change that only moves nodes on the
  canvas produces exit code 0 from the CLI and is summarized as
  `No semantic changes.`. Pass `include-layout: true` to enumerate the
  `ui.*`/`viewport.*` deltas instead (which then counts as a change).
- **Version changes are always reported** (they are semantic-ish), regardless of
  `include-layout`.
- **New files.** A `.pipe` file added in the PR (absent in the base) is diffed
  against an empty pipeline, so every node and edge shows up as added.
- **Deleted files.** Removed `.pipe` files are noted in the comment and count as
  a semantic change (`has-semantic-changes: true`); there is no working-tree file
  to diff.
- **Untrusted content.** File paths and CLI error text come from the pull
  request, so they are rendered inside code spans / a fenced block and stripped
  of newlines before they reach a workflow-command annotation.
- **Failure semantics.** The action does **not** fail merely because semantic
  changes exist — it is informational. It **does** fail (and emits an `error`
  annotation) when a changed `.pipe` file cannot be parsed or diffed, so a broken
  pipeline in a PR is surfaced as a red check, and when the pull-request base
  commit cannot be fetched (`actions/checkout` did not run first, or ran without
  credentials). Both failure paths still write the job summary, so the reason is
  readable without digging through the step log.

## Local equivalent

Everything the action does per file is one local CLI call — no server, no token:

```bash
# Diff a working-tree .pipe file against the PR base commit, as Markdown:
rocketride diff --git "$(git merge-base origin/main HEAD)" pipelines/my.pipe --markdown

# Or diff two files directly:
rocketride diff old.pipe new.pipe

# Add --include-layout to surface ui/viewport churn; --json for machine output.
```

Exit codes match the action's per-file logic: `0` = no semantic changes,
`1` = semantic changes, `2` = usage error / unreadable / unparseable file.

## Pinned dependencies

Third-party actions are pinned by full commit SHA (with a version comment),
matching the convention in [`.github/workflows`](../../workflows):

- `actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065` (v5)
- `actions/github-script@60a0d83039c74a4aee543508d2ffcb1c3799cdea` (v7)

## License

MIT — see the repository [`LICENSE`](../../../LICENSE).
