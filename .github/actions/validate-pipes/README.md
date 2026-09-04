# Validate RocketRide Pipelines

Composite GitHub Action that validates `.pipe` pipeline files against a real
RocketRide engine. It:

1. Sets up Python and installs the [`rocketride`](https://pypi.org/project/rocketride/) CLI.
2. Starts the RocketRide engine in Docker and waits for its public `/version`
   endpoint to respond (available on every published engine image).
3. Resolves the files to validate — on pull requests, only the `.pipe` files
   changed relative to the base branch by default.
4. Runs `rocketride validate` against the local engine.
5. Always removes the engine container, even when validation fails.

The job fails when any pipeline is invalid (CLI exit code `1`) or when the
engine cannot be started or reached (exit code `2`).

## Requirements

- A Linux runner with Docker available (e.g. `ubuntu-latest`).
- The repository checked out before this action runs (`actions/checkout`).
  The default `fetch-depth: 1` is fine — the action fetches the PR base
  commit itself when `changed-only` is enabled.
- A `rocketride` CLI release that includes the `validate` command. The
  install step fails fast with a clear error when the installed release does
  not; use the `cli-version` input to pin a release that does.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `files` | `**/*.pipe` | Glob pattern(s) selecting the files to validate. Multiple patterns may be separated by whitespace; `**` recurses into subdirectories. |
| `changed-only` | `true` | On `pull_request` events, validate only the matching files changed vs the PR base (via `git diff`). Ignored on other events. |
| `engine-image` | `ghcr.io/rocketride-org/rocketride-engine:latest` | Docker image of the engine to validate against. |
| `engine-port` | `5565` | Host port mapped to the engine container's internal port `5565`. |
| `api-key` | _(empty)_ | Optional API key, passed to the CLI via the `ROCKETRIDE_APIKEY` environment variable (never on the command line). |
| `python-version` | `3.12` | Python version used to run the CLI. |
| `cli-version` | _(empty)_ | pip version specifier for the `rocketride` CLI (e.g. `==1.2.3` or `>=1.2.3`). Must resolve to a release that includes the `validate` subcommand. Installs the latest release when empty. |
| `fail-on-warnings` | `false` | Fail the job when a pipeline validates with warnings (the CLI itself exits `0` on warnings). |

## Usage

```yaml
name: Validate pipelines

on:
  pull_request:

permissions:
  contents: read

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4
      - uses: ./.github/actions/validate-pipes
        with:
          files: 'examples/**/*.pipe'
          # api-key: ${{ secrets.ROCKETRIDE_APIKEY }}  # if your engine requires auth
```

> [!TIP]
> For reproducible CI results, pin `engine-image` to a released version tag
> (e.g. `ghcr.io/rocketride-org/rocketride-engine:1.3.0`) or an image digest
> instead of `latest`, and bump it deliberately.

## Running the same check locally

```bash
docker run -d --name rocketride-engine -p 5565:5565 \
  ghcr.io/rocketride-org/rocketride-engine:latest
curl -fsS --retry 30 --retry-delay 2 --retry-all-errors http://127.0.0.1:5565/version

pip install rocketride
ROCKETRIDE_URI=http://127.0.0.1:5565 rocketride validate examples/*.pipe

docker rm -f rocketride-engine
```

`rocketride validate` exits `0` when all files are valid, `1` when at least
one file fails validation, and `2` on usage errors, unreadable files, or
connection failures. Add `--json` for a machine-readable report.
