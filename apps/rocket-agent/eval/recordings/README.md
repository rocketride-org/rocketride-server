# eval/recordings

Recorded Anthropic API transcripts, one subdirectory per brief id
(`apps/rocket-agent/eval/src/briefs.ts`), consumed by `--mode replay`
(`eval/src/replay-model.ts`) so the CI regression gate
(`.github/workflows/ci.yml`'s `rocket-agent-eval` job) is keyless and
deterministic.

## Current state (as of Task 5.1c)

Only `webhook-transform/` has recordings (3 files), committed with Task 5.1b
as fixtures for `tests/eval-runner.test.ts`. The other 17 briefs have no
recordings yet, so replay mode cannot exercise them until Step 2 of the
external-gated runbook below runs.

## How this directory gets populated for real (external-gated — needs the org's Anthropic key)

Documented in full in `task-5.1c-report.md`. Summary:

```bash
# 1. Org admin adds the RR_EVAL_ANTHROPIC_KEY secret (Settings > Secrets >
#    Actions), or a maintainer exports the team key locally.
export AGENT_ANTHROPIC_KEY=sk-ant-...   # team eval key, never commit this

# 2. Record all 18 briefs. Rerun with --brief <id> to re-record one brief
#    after a prompt change (Task 5.1d loop) instead of the whole suite.
cd apps/rocket-agent
pnpm eval:record

# 3. Review + commit the new recordings.
git add eval/recordings
git commit -m "test(rocket-agent): record live eval transcripts for replay"

# 4. Commit the resulting eval-report.json as the replay regression baseline
#    (see the note in eval/baseline-report.json.PENDING about the exact path
#    run.ts reads — it is eval/replay-baseline.json, not baseline-report.json).
cp eval-report.json eval/replay-baseline.json
git add eval/replay-baseline.json
git rm eval/baseline-report.json.PENDING
git commit -m "test(rocket-agent): commit first replay regression baseline"
```

Do not fabricate recordings by hand — they must come from a real model run
so replay mode reproduces genuine provider behavior.
