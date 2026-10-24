# verify-rocketride evals

These evals measure whether the verification skill helps an agent find real defects. Each case puts a dedicated checkout into a known state, asks a headless agent to verify one area of RocketRide, and scores the agent's verdict against what is actually wrong. The agent is told only the area, never the bug.

## What the cases are

`cases.json` holds every case. There are three kinds.

- **Planted** (`P1` to `P5`): a small, realistic bug applied from `seeds/*.patch`, such as a dropped `else` branch or an off-by-one.
- **Replay** (`R1`, `R3` to `R7`): a real bug that shipped. The case reverts the code of the PR that fixed it on top of the current branch.
- **Clean** (`C-*`): no change, with the same area prompt as a bug case. Any defect reported here is a false alarm, except the case's `known_issues`.

Every bug case was reproduced by hand against the same check on clean code before it was added. `cases.json` records which case was dropped and why.

## Running

Use a checkout that does nothing but evals; `prepare` resets its tracked files.

```bash
git worktree add --detach ../verify-eval <branch>
cd ../verify-eval && ./builder server:build --autoinstall   # plus the steps SKILL.md lists if the C++ nodes cannot build
cd -
E=../verify-eval
.claude/skills/verify-rocketride/evals/run --worktree $E --agent claude P1
.claude/skills/verify-rocketride/evals/run --worktree $E --agent codex P1
.claude/skills/verify-rocketride/evals/run --worktree $E --agent claude --no-skill P1
```

- `run` prepares the case, renders `prompt.md`, runs `claude -p` (default model `sonnet`) or `codex exec` (default `gpt-6.1-sol`, medium effort) with permissions bypassed inside the eval checkout, stops any engine left in that checkout, and writes `.verify/evals/<case>/<variant>-<time>/` in this checkout: `prompt.txt`, the agent's raw output, `final.md`, and `result.json`.
- `--no-skill` deletes this skill from the eval checkout for that run and tells the agent to work out how to verify from the repository. Comparing it with the default shows what the skill adds.
- Runs share one eval checkout and its `dist/`, so run cases one at a time per checkout. Use a second eval checkout to run two at once.
- An agent run takes a few minutes. It uses your Claude or Codex plan's limits, not API billing; `result.json` still records token counts, and for Claude the cost the run would have had if billed.

To run everything once per agent:

```bash
for c in $(python3 -I -c 'import json; print(" ".join(c["id"] for c in json.load(open(".claude/skills/verify-rocketride/evals/cases.json"))["cases"]))'); do
  for a in claude codex; do .claude/skills/verify-rocketride/evals/run --worktree $E --agent $a "$c"; done
done
```

## Scoring

```bash
python3 -I .claude/skills/verify-rocketride/evals/score.py
```

It writes `.verify/evals/report.md`.

- A bug case is **caught** when a reported defect describes the case's ground truth, **wrong-defect** when the agent reported something else, and **missed** when it reported nothing.
- A clean case is **clean** when the agent reported nothing beyond known issues, and a **false alarm** otherwise.
- **no-verdict** means the agent never finished with the JSON block the prompt asks for.

Claude Haiku judges whether a reported defect matches the ground truth, once per run, and caches the verdict in `judge.json` beside `result.json`. Read the judge's reason in the report, and edit `judge.json` to override a verdict you disagree with. `--no-judge` skips the model and leaves those runs unjudged.

## Adding a case

1. For a planted bug, add a patch to `seeds/` that applies to the current branch. For a replay, find the fix's squash commit with `git log --grep='(#<pr>)'` and list its non-test source paths; check that `git show <sha> -- <paths> | git apply -R --check` succeeds.
2. Reproduce the bug by hand: run `prepare`, launch a run, show the defect, then show the same check passing on a clean `prepare`. If you cannot make the difference visible to a user, do not add the case.
3. Add the case and, if the area is new, its clean control to `cases.json`. Keep the area text to what a PR author would ask a reviewer to check, without describing the bug.
