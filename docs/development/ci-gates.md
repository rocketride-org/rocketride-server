# CI Gates

What has to pass before a PR can merge, and how to reproduce each check on your
machine. Sources of truth: `.github/workflows/ci.yml`, `.github/workflows/_build.yaml`,
and `lefthook.yml`.

## The one required check

**`CI OK`** (job `ci-ok`) is the *only* job marked required in branch protection.
It aggregates the results of `init`, `changes`, `build`, `helm-changes`,
`helm-lint`, `ruff-check`, `docs-build`, `gitleaks`, and `shell-contract`, and
fails if any of them failed or was cancelled. Jobs that were correctly **skipped**
do not fail it — which is the whole point: a docs-only PR skips the 90-minute
three-platform build and still merges.

Two jobs are deliberately **outside** `ci-ok` and cannot block a merge:

- `node-docs` ("Doc schemas (advisory)") — advisory while the node corpus is
  migrated to the README schema.
- `container-scan` — runs on push/schedule only, never on PRs. Adding it to the
  required list would block every merge, since it is always skipped on a PR.

CodeQL is GitHub's "Default setup" (repo Settings → Code security), not a job in
this workflow; findings land in the Security tab.

---

## What decides which jobs run

The `changes` job (`dorny/paths-filter`) classifies each PR into two independent
booleans:

| Filter | Paths |
| --- | --- |
| `code` | `packages/**`, `nodes/**`, `apps/**`, `scripts/**`, `builder`, `builder.cmd`, `.github/workflows/**`, `package.json` |
| `docs` | `docs/**`, `packages/docs/**`, `nodes/src/nodes/**/README.md`, `packages/*/docs/**`, and the three client `README.md` files |

`code == false` skips `build` (a `build-skip` job reports success under the same
check names so branch protection stays satisfied) and skips `shell-contract`.
`docs == false` skips `docs-build`. A PR can trip both filters.

`helm-changes` is a separate filter on `deploy/helm/**` gating `helm-lint`.

---

## The gates, and how to run each locally

### Ruff — `ruff-check` (blocking, always runs)

```bash
ruff check
ruff format --check
```

Runs on every PR with no path gating. It mirrors the local lefthook hook so a
contributor who commits with `--no-verify` is still caught.

### Docs export drift — `./builder docs:check` (blocking, always runs)

```bash
node scripts/build.js docs:check      # or ./builder docs:check
```

Piggybacks on the `ruff-check` job on purpose: that is the only always-on PR job,
so it is the one place that reliably fires on docs-only PRs — exactly the PRs
this gate exists to catch. It fails when a generated copy under `packages/` has
drifted from its source under `docs/`. Fix with `./builder docs:export`; never
hand-edit the destination. See [The Docs Pipeline](docs-pipeline.md).

### Docs site build — `docs-build` (blocking, docs PRs only)

```bash
node scripts/build.js docs:test       # the gather/export helpers themselves
node scripts/build.js docs:build      # stage + compile the site
```

Catches what only a full build can: broken internal links, a file under
`docs/public/` that no mount covers, and a spine id with no backing page (which
would otherwise publish a live "coming soon" URL). Without this gate those
failures surface after merge, in `docs.yml` on `develop`.

### gitleaks (blocking, always runs)

```bash
gitleaks detect --config .gitleaks.toml --verbose --redact --log-opts="<base-sha>..HEAD"
```

CI installs the binary directly rather than using the upstream action, which
requires a paid licence for org-owned repos. Mirrors the local pre-commit hook.

### Build and tests — `build` (blocking, code PRs only)

```bash
./builder build          # add --autoinstall on a fresh machine
./builder test --sequential
```

`_build.yaml` runs a three-platform matrix (Ubuntu 22.04, Windows Server 2022,
macOS ARM64), each doing `./builder build` then `./builder test --verbose --sequential`,
with 90-minute timeouts. The test step boots a local engine on `:5565` and
connects a test client, so both sides need a matching `ROCKETRIDE_APIKEY` — CI
uses the literal `MYAPIKEY`, the same placeholder as `.env.template`. Ubuntu also
starts MinIO, Azurite, and Postgres (pgvector + Apache AGE, on `:55432`/`:55433`)
for the storage and database node tests.

Per-module equivalents when you only touched one area:

```bash
./builder nodes:test            # node tests
./builder nodes:test-contracts  # contract tests only
./builder client-python:test
./builder client-typescript:test
./builder client-mcp:test
./builder ai:test
./builder server:test
```

### Shell API contract — `shell-contract` (blocking, code PRs only)

```bash
node scripts/build.js shell:check
node scripts/build.js shell:regen && git diff --exit-code -- \
  apps/shell-ui/src/contract-check.generated.ts \
  packages/shell-api/index.ts packages/shell-api/latest.ts
```

`shell:check` fails on a removed or broken frozen export (via per-version tsc
floors) and on an added export that was never `shell:freeze`d. The second step
regenerates the floors from the immutable frozen versions and fails on any diff,
so a floor cannot be hand-edited to launder a removed export past tsc.

### Helm — `helm-lint` (blocking, `deploy/helm/**` PRs only)

```bash
helm lint deploy/helm/rocketride
helm template rocketride deploy/helm/rocketride \
  --values deploy/helm/rocketride/tests/values_test.yaml \
  | kubeconform -strict -summary -kubernetes-version 1.29.0
```

### Doc schemas — `node-docs` (**advisory**, always runs)

```bash
python3 scripts/validate-node-readme.py --all nodes/src/nodes
python3 scripts/validate-client-docs.py
```

Two deterministic checkers: node READMEs against
[the node README schema](nodes/readme-schema.md), and client-doc parity against
[the client README schema](clients/readme-schema.md). The job carries
`continue-on-error: true` and is not in the `ci-ok` needs list, so it cannot
block a merge today. Once every node README conforms, drop `continue-on-error`
and add the job to `ci-ok` to make it a hard gate — until then, treat a *new*
failure in a node you touched as something to fix.

Check a single node while you work:

```bash
python3 scripts/validate-node-readme.py nodes/src/nodes/<node>
```

---

## The local pre-commit hook

`lefthook.yml` runs three commands sequentially (sequential on purpose — parallel
ruff invocations fight over the cache):

| Command | Scope |
| --- | --- |
| `gitleaks protect --staged` | every commit |
| `ruff check {staged_files}` | staged `*.py` |
| `ruff format --check {staged_files}` | staged `*.py` |

ESLint and Prettier are commented out — they are staged for a later rollout in
both lefthook and CI, so `npx eslint .` and `npx prettier --check .` are useful
locally but gate nothing yet.

Every hook here has a CI counterpart, so `--no-verify` postpones the failure
rather than avoiding it.

---

## Reproducing a full PR run

```bash
ruff check && ruff format --check
node scripts/build.js docs:check
node scripts/build.js docs:test && node scripts/build.js docs:build   # if you touched docs
./builder build && ./builder test --sequential                        # if you touched code
python3 scripts/validate-node-readme.py --all nodes/src/nodes         # advisory
python3 scripts/validate-client-docs.py
```

---

## After merge

`.github/workflows/docs.yml` rebuilds and deploys the docs site to GitHub Pages on
every push to `develop` that touches a doc source. It runs `docs:build` and
`docs:check` again, and checks out with full history so `docs:gather` can stamp
each page with its source file's real last-commit date.
