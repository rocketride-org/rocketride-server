---
name: browser-agent-test
description: Run the browser agent eval tasks (tools/browser-agent-evals) in the real Agent tab of Rocket Builder and read what they found. Use it to run one task or a set against the local stack or a running one, grade a hand-made workspace, smoke-test the eval models, and read a run's report, results and trial folders. It wraps ./builder browser-agent:eval; tools/browser-agent-evals/README.md has the details.
---

# Browser agent eval tasks

Everything goes through `./builder browser-agent:eval`, from the repository root. The builder keeps flags such as `--help` for itself, so the runner's arguments go in `EVAL_ARGS`, and `--pattern=<id>` picks tasks by part of their id.

## Before a run

- **An engine in `dist/server`.** Read "Running trials" in `tools/browser-agent-evals/README.md` for how to put one there. Do not run `nodes:submodule-build` without the compile tools.
- **Model keys in the environment, by name only.** `ROCKETRIDE_ANTHROPIC_KEY` and `ROCKETRIDE_OPENAI_KEY` (or `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`). Without the key for the model you pick, each trial ends `error` with cause `environment`, which is a result, not a crash.
- **Ports 5565, 3000 and 3010 free**, unless you pass `--url`. A run refuses a busy port and never stops what it did not start. One run per machine.
- **In a git worktree**, set `npm_config_ignore_scripts=true` for the builder. Its dependency install otherwise reruns lefthook, which rewrites the git hooks that every worktree of the clone shares.

## One command per intent

```bash
./builder browser-agent:eval                                               # validate the task set
EVAL_ARGS="run --model anthropic/claude-haiku-5-5" ./builder browser-agent:eval --pattern=edit-01        # one task
EVAL_ARGS="run --model openai/gpt-6-luna" ./builder browser-agent:eval --pattern=build-0                  # a set
EVAL_ARGS="run --model anthropic/claude-haiku-5-5 --reruns 0 --headed" ./builder browser-agent:eval --pattern=edit-01   # no reruns, watch the browser
EVAL_ARGS="run --no-preview" ./builder browser-agent:eval --pattern=edit-08                              # leave every Design preview closed
EVAL_ARGS="stack" ./builder browser-agent:eval                             # hold a local stack until Ctrl-C ...
EVAL_ARGS="run --url http://127.0.0.1:3000" ./builder browser-agent:eval --pattern=edit-01                # ... and run against it
EVAL_ARGS="check" ./builder browser-agent:eval --pattern=edit-01           # grade the task's reference solution, no agent
EVAL_ARGS="check --workspace <dir>" ./builder browser-agent:eval --pattern=edit-01                       # grade a folder, no agent
EVAL_ARGS="smoke" ./builder browser-agent:eval                             # ask each eval model one question
```

`run` reruns each failure twice (`--reruns`). A run against another machine (`--url https://...`) takes its API key from `RR_EVAL_APIKEY` and needs `--allow-remote-wipe`, because every trial empties that account's workspace and sessions.

## Reading a run

The run prints its folder, under `.verify/browser-agent/` (git ignores it). Read in this order:

1. `report.md`: first-run pass rate and flake rate, then one row per task with its verdict, cause and guide reads.
2. `results.json`: the same, for machines and the judge.
3. `<task>/trial-<n>/result.json`: every check with its status and why, and the cause of a failure (`agent`, `environment` or `runner`).
4. `record.json`, `steps.log`, the numbered screenshots, `session.json`, `final/`, `trace.jsonl` and `console.log` when you need to see what happened.

Report a task as the run graded it: its status, how many counted checks passed, the failing checks by id with their detail, and the cause. For a pass, the status and the check count are enough. A `pending` check was not decided; never count it as a pass.

## Keys

- Refer to keys by name. Never print, echo or write a value, and never put one in a command's arguments: set it in the environment, for example `ROCKETRIDE_ANTHROPIC_KEY="$(cat <file>)" ./builder ...`.
- The runner scrubs every file it writes and scans each trial folder for the keys it holds; `record.json` lists any file it found one in under `browser.leaks`. To check by hand, list files only, and give grep the key's start through a file descriptor so it never sits in grep's arguments: `grep -rlF -f <(head -c 16 <key file>) .verify/browser-agent/<run>`.

## Cleaning up

`run`, `check` and `smoke` stop what they started when they end. `stack` stops on Ctrl-C or SIGTERM. Each run folder keeps the engine's store (about 250 MB), so delete old run folders when you are done with them.
