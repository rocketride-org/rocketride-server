# OpenCode version-bump playbook

RocketRide pins the OpenCode release exactly (`opencode-ai` + `@opencode-ai/sdk`,
matching versions, no `^`). Upstream ships ~3 releases/week; we bump deliberately,
on our schedule, with the eval suite as the regression gate. Never let a bot
(renovate/dependabot) bump these two packages automatically — they are excluded
via a `packageRules` entry in `renovate.json` (`matchPackageNames:
["opencode-ai", "@opencode-ai/sdk"]`, `enabled: false`). Dependabot's `npm`
config (`.github/dependabot.yml`) does not currently scan `apps/rocket-agent`
at all (its `directories` list is `/`, `packages/client-typescript`,
`packages/shared-ui`, `apps/dropper-ui`, `apps/chat-ui`) — if that ever changes,
add the same two packages to dependabot's `ignore` block at that time.

**Current pin (verify before trusting this doc — it drifts):** `1.18.16`,
matching in both places:
- `apps/rocket-agent/package.json` → `"@opencode-ai/sdk": "1.18.16"`
- `apps/rocket-agent/Dockerfile` → `ARG OPENCODE_VERSION=1.18.16` (consumed by
  `npm install -g opencode-ai@${OPENCODE_VERSION}`)

If these two ever disagree, treat it as a bug — fix the drift before bumping
further; don't compound it.

## When to bump
- Security fix in OpenCode or its transitive deps (bump ASAP).
- A feature or fix we need (e.g. provider updates, permission-flow fixes).
- Staleness guard: at minimum every 8 weeks, evaluate the latest release even if
  nothing is burning — drift makes the eventual jump riskier.

## Procedure

1. **Changelog review.** Read every release note between the current pin and
   the target (upstream releases: https://github.com/sst/opencode/releases).
   Flag anything touching: permissions/tool gating, provider auth/config
   (`OPENCODE_CONFIG_CONTENT` semantics, `{env:}` interpolation), the HTTP API
   surface (`/session`, `/event`, `/config`, `/global/health`, permission
   endpoints), config schema, telemetry/phone-home behavior (autoupdate,
   models.dev fetch, default-plugin install, LSP download, Claude Code
   detection — the five `OPENCODE_DISABLE_*` env vars rocket-agent sets in
   `src/opencode.ts` assume these knobs keep existing, keep working, and keep
   their current meaning), and defaults changing from deny→allow anywhere. Any
   RED-flag item gets a written note in the bump PR before proceeding.

2. **Bump in a branch.** Update BOTH the `Dockerfile`'s `ARG OPENCODE_VERSION`
   and `package.json`'s `@opencode-ai/sdk` to the same target version; `pnpm
   install`; commit the lockfile.

3. **Unit + integration tests.** `pnpm --filter rocket-agent test` runs the
   full Jest suite, including the spawn/proxy/lifecycle tests that exercise
   the real binary when `OPENCODE_BIN` is set in the environment (see
   `apps/rocket-agent/tests/opencode.test.ts`, `proxy.test.ts`). Run this with
   `OPENCODE_BIN` pointed at the newly-bumped binary — the CI job
   (`rocket-agent-eval`, see step 5) runs keyless/replay-mode only and does
   NOT exercise the real binary by itself, so this step is the actual
   real-binary gate and must be run by hand (or in a workflow that sets
   `OPENCODE_BIN`).

4. **Verify-ledger re-checks** (empirically-verified behaviors the service
   depends on — re-verify each against the new binary):
   - `OPENCODE_CONFIG_CONTENT` still wins over workspace config, and the
     locked-down deny-wall (`bash`/`external_directory`/`webfetch`/`websearch`
     → `deny`, edit restricted to the allow-listed globs) still validates —
     `buildConfigContent()` in `apps/rocket-agent/src/opencode.ts` asserts
     this at spawn time and throws if the shape regresses; also re-run
     `apps/rocket-agent/scripts/ga-checks/lockdown-probe.mjs` against a real
     session on the new binary.
   - SSE event name + `file.edited` payload envelope
     (`{directory, payload: {type: 'file.edited', properties: {file}}}`) —
     asserted in `apps/rocket-agent/src/session.ts` (`watchFileEdits`) and
     exercised by `apps/rocket-agent/tests/proxy.test.ts`
     ("file.edited events ... trigger a snapshot commit").
   - Permission-response endpoint shape — rocket-agent taps
     `POST /session/:id/permissions/:permissionId`
     (`PERMISSION_REPLY_RE` in `apps/rocket-agent/src/index.ts`) for the
     `agent.permission` audit record; confirm the route and reply body shape
     are unchanged.
   - Basic-auth behavior (default username `opencode`) + `GET
     /global/health` returning `401` unauthenticated / `200` authenticated.
   - `/config` endpoint schema — `permission.bash`, `permission.edit['**/*.pipe']`
     and friends keep the keys `buildConfigContent()` and the redaction path
     in `apps/rocket-agent/src/index.ts` (buffers `/config*` responses and
     runs them through `redactApiKeys` from `apps/rocket-agent/src/log.ts`,
     Task 5.2c) both depend on.
   - Provider `baseURL` override (`providerBaseUrlOverride` hook in
     `buildConfigContent()`, Phase 5 Task 5.1b) — confirm
     `provider.<id>.options.baseURL` is still the documented, honored
     override shape and still wins over the client default.

5. **Eval regression gate.** `pnpm --filter rocket-agent eval:replay` runs the
   18-golden-brief suite against the recorded replay model (keyless,
   deterministic — this is also the `rocket-agent-eval` CI job in
   `.github/workflows/ci.yml`) and diffs against the committed
   `apps/rocket-agent/eval/replay-baseline.json`. *(As of this writing that
   baseline file has not yet been committed — `eval:replay` degrades to an
   infra-only check until it lands; once committed, treat any diff from it as
   a regression signal for this step.)* Then run the LIVE suite —
   `pnpm --filter rocket-agent eval:live`, or trigger the manual,
   key-gated `rocket-agent-eval-live.yml` GitHub Actions workflow
   (`workflow_dispatch`, requires the `RR_EVAL_ANTHROPIC_KEY` org secret) —
   whose GA gate is `passRate >= 0.8` (`apps/rocket-agent/eval/run.ts`). A
   pass-rate drop of more than 5 points versus the current baseline report
   blocks the bump pending prompt/transcript investigation. Re-record
   transcripts (`pnpm --filter rocket-agent eval:record`) only for briefs
   whose request shape legitimately changed with the new release, and say so
   in the PR.

6. **Redaction + pen-test spot check.** The full `pnpm --filter rocket-agent
   test` run in step 3 already covers
   `apps/rocket-agent/tests/redaction.test.ts` — confirm it's green. Then, on
   staging, run the egress (Check 1) and key-grep (Check 4) sections of
   `apps/rocket-agent/scripts/ga-checks/pentest.sh` (STAGING, human-run —
   not part of CI).

7. **Staging soak.** Deploy to staging; run one real session end-to-end
   (build → validate → run → revert). 24h soak with the audit log
   (`agent.permission` / `agent.prompt` / `mcp.tool` records, Task 5.2a)
   watched for error-status spikes.

8. **Ship.** PR titled `chore(rocket-agent): bump opencode 1.x.y -> 1.x.z`
   containing: changelog notes, eval reports (before/after), verify-ledger
   re-check results. Production deploy via the normal ArgoCD flow.

## Rollback

The pin makes rollback trivial: revert the bump commit (Dockerfile ARG +
`package.json` + lockfile together), redeploy. Session data is
version-independent (workspaces are plain files + git); OpenCode's own
session-storage compatibility across a downgrade is NOT guaranteed — treat
in-flight sessions as expendable during a rollback window and say so in the
incident note.
