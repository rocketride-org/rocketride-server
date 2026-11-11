# Browser agent evals

`./builder browser-agent:eval` runs eval tasks against the browser agent in the Pipeline Builder's Agent tab and grades the end state with code checks. It is not a `:test` action, so `./builder test` never runs it. `./builder test` runs only this tool's unit tests (`browser-agent:test`).

What exists so far:

- The task format, the loader that validates a task set, and the 30 breadth tasks converted from the drafted scenarios. Those scenarios are at commit 51bd59d2c7, on the branch [`backup/browser-agent-30-scenarios`](https://github.com/rocketride-org/rocketride-server/tree/backup/browser-agent-30-scenarios); this README and the code cite that commit by its hash.
- The browser driver: `run` starts the local dev stack, runs each task in a real browser, and writes a trial folder with the traffic, the final files, a trial record and its grade.
- Grading (`grade.ts`): the task's checks on the trial, with 51bd59d2c7's check kinds, a check every task gets (`keys-not-leaked`), and path resolution for renamed files. Reruns of failures and the flake rate (`schedule.ts`), written to `results.json` and `report.md`.
- `check`: grades a hand-made workspace, such as a task's reference solution, against the engine with no agent. It writes each task's grade to `<task id>.json` and the record it read to `<task id>.record.json`, which keeps each output check's whole output (`runOutput.<id>.output`).
- `smoke`: asks each eval model one question the way the Agent tab does.
- `merge`: writes one `results.json` and `report.md` for a batch that ran as many small runs, such as one task per fresh stack. It reads every `results.json` under `--out`, renumbers each task's trials in the order they started, scores them as one `--trials` run, and lists any trial folder no `results.json` names. It needs no model keys.
- From #2885 (`origin/feat/rocket-agent-eval`): the scorer (`score.ts`), the secret scan (`canary.ts`), the report writer (`report.ts`), the trial record types (`types.ts`), the sample-input pipeline run (`runOutput.ts`) and the node catalog (`catalog.ts`).

The tool drives the Agent tab from #2718 (`feat/rocket-agent-browser`), so it needs that branch.

## Status

One full run backs the numbers below. It ran the 30 breadth tasks on 2026-11-06, with `anthropic/claude-haiku-5-5` on the local stack, at checkout 03b4e0eb with this tool's files not yet committed. There has been no full run since, and the code has changed: the agent's finish rule now refuses done for an app whose check_app skipped types or build, the app checks now count the agent's check_app steps and the run half, and the known-good call runs after every trial. So these numbers describe the earlier code. Run output stays under `.verify/` and is not committed.

- First-run pass rate 43% (13 of 30), flake rate 10% (3 of 30). Verdicts: 13 pass, 3 flaky, 9 failing, 0 error, 5 pending. This is one run with one model, not a baseline.
- Pending: the 3 ASK tasks wait for the judge. build-07's sample run needs outbound network from the engine, and build-09's sample input (`inputs/receipt.png`) is not made yet.
- Some failures come from a product bug, not the agent. In 2 trials of build-02 and 2 of build-05, the output check failed because a prompt pipeline answers twice. The fix is #3075, still open against `develop`, so this branch does not have it. The cause label still says `agent`, because the known-good pipeline passes.
- edit-05 tests a race the product does not handle yet. The runner holds the agent's write while the user saves the same file, and the agent's write then lands over the user's save.

Not done:

- App checks: the half that uses an app and reads its pipeline's runs on the engine is built, but no agent trial has run it yet, because no model key was available. It ran live on build-13's reference app with an invented key, which proved the failure path: the app's own pipeline ran, and the 401 failed the check. A passing run still needs a real key.
- build-13 cannot pass as written. Its `pipe-imported` check asks the app to import its `.pipe` file, which the app template's `global.d.ts` and `rsbuild.config.mts` both offer, but the Design preview cannot link a `.pipe` import ("Cannot resolve ./askclaude.pipe"), so the preview build and check_app's build fail. That is a product bug in the preview's linker, on `develop` too. The live check above used a copy of the reference app that imports the same JSON from a `.ts` module.
- The judge: `judge` judges one trial's app live against a checklist (Judging an app, below). The ASK tasks and each task's `judge` questions are kept as written, but no command asks them yet, and `results.json` leaves `judge` null.
- Two follow-ups on the agent's model choice wait for an earlier proof run's failure results, which are not in this repo.

## Commands

The builder keeps flags such as `--help` for itself, so the runner's arguments go in `EVAL_ARGS`:

```bash
./builder browser-agent:eval                          # validate tasks/breadth (the default)
EVAL_ARGS="--help" ./builder browser-agent:eval       # the runner's own help
EVAL_ARGS="validate --table" ./builder browser-agent:eval
./builder browser-agent:eval --pattern=edit-0         # only tasks whose id contains edit-0
./builder browser-agent:test                          # unit tests (node:test)

# edit-01 in the browser, with the keys from the env file; a failure is rerun twice
EVAL_ARGS="run --model anthropic/claude-haiku-5-5" ./builder browser-agent:eval --pattern=edit-01
EVAL_ARGS="run --model openai/gpt-6-luna --reruns 0 --headed" ./builder browser-agent:eval --pattern=edit-01
EVAL_ARGS="run --no-preview" ./builder browser-agent:eval --pattern=edit-08     # leave every Design preview closed

# grade each task's reference solution, or a folder, against the engine with no agent
EVAL_ARGS="check" ./builder browser-agent:eval --pattern=build-0
EVAL_ARGS="check --workspace /path/to/workspace" ./builder browser-agent:eval --pattern=edit-01

# serve one trial's app from its final workspace and judge it live against a checklist
EVAL_ARGS="judge --workspace <trial>/final --app apps/expenses-ui --checklist <checklist.txt> --out <dir>" ./builder browser-agent:eval

# ask each eval model one question through the engine (task 0.2)
EVAL_ARGS="smoke" ./builder browser-agent:eval
```

From this folder, `node --import tsx src/run.ts <command>` does the same without the builder.

## Running trials

`run` needs three things:

- **An engine in `dist/server`.** The stack starts it from there. B's `package.json` says 3.5.0 while its engine source matches the `server-v3.6.0-prerelease` release, so `./builder server:download` finds no match and `server:build` tries to compile. Until the version catches up, put that release's binary in `dist/server` and sync the checkout's Python and nodes into it: `./builder --sequential nodes:sync ai:sync client-python:sync-source server:setup-test-deps client-typescript:build shell:build client-init:build`. Do not run `nodes:submodule-build` without the compile tools: it installs a compiler toolchain in `~/toolchains` before it checks whether anything needs compiling.
- **The model keys** as `EVAL_ANTHROPIC_KEY` and `EVAL_OPENAI_KEY` in an env file: `--env-file`, by default `.env.local` two folders above the checkout. The runner reads only those two lines (`export ` and quotes allowed), never prints them, and stops with the missing name when either is missing or empty. They become the engine's `ROCKETRIDE_ANTHROPIC_KEY` and `ROCKETRIDE_OPENAI_KEY` and go nowhere else. No process the runner starts (the engine, the dev servers, the browser, the app builds) gets `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `ROCKETRIDE_ANTHROPIC_KEY`, `ROCKETRIDE_OPENAI_KEY` or any `EVAL_*` name from the shell, so a shell key never stands in for an eval key. The one exception is `judge`: its `claude -p` sessions get `EVAL_ANTHROPIC_KEY` as `ANTHROPIC_API_KEY`, and no other Anthropic credential (`judge/session.mjs`). `run`, `check`, `judge`, `stack` and `smoke` all need the file. On the OSS engine, the model picker lists exactly the engine's `ROCKETRIDE_*` environment variables, so no account Variables are needed.
- **Free ports 5565, 3000 and 3010** (and each extra slot's, under Slots). A port in use stops the run; the runner never stops what it did not start. `--url` runs against a stack that is already up instead, and needs `--allow-wipe`, local or not, because every trial empties the workspace, the agent sessions and the saved layouts of the API key's account there. A stack the `stack` command started is safe to empty, since its store is in its own run folder. Your dev stack holds your own work.

The stack (`src/stack.ts`) does what the rr-verify-agent skill's `launch.sh` does on `origin/feat/rocket-agent-testing`:

- the engine from `dist/server` on 5565, with its store in the run folder (`RR_STORE_URL`), because the default store, `~/.rocketlib/store`, is shared by every local engine on the machine and each trial empties it;
- the rocket-ui dev remote on 3010 and the shell dev server on 3000, through generated configs in each package's `.rocketride/` (git ignores it; the run removes them). The shell writes its dev build into the stack folder's `shell-dist/`, not `build/shell`, and the run removes it.

Each trial (`src/trial.ts`):

1. Empties the store (workspace, agent sessions, saved layouts) and writes the task's files. With `--step-limit` or `--cost-limit` it also writes Rocket Builder's workspace file (`.workspace/rocketride.pipeBuilder.workspace.json`) with those limits as its settings (`rocketride.pipeBuilder.agentStepLimit`, `rocketride.pipeBuilder.agentCostLimit`; 0 is no limit), which the page loads when it opens. `record.json` keeps what was written in `settings`, and the file after the turn in `browser.agentSettingsAfter`; its `savedByPage` says the page saved the file again, so it had the limits loaded.
2. Opens Rocket Builder with the sign-in token seeded, starts a new session, keeps the approval mode at "Ask first", and picks the model through the picker.
3. Sends the prompt. It never types into the composer again.
4. Answers each "Needs your OK" card by the task's `cards` policy.
5. Waits for the turn's result card. At `timeLimitSec` it presses Stop and grades what is there.
6. Reads the turn the chat saved in its session file, which gives the outcome, and the workspace's final files. While the stack is still up, it has the engine validate every pipeline the turn added or changed, and runs each `output` check's pipeline on its sample input. Then it writes the trial folder and grades it.

```text
.verify/browser-agent/<time>/
├── results.json           every task: its verdict and k of n, and each run's status, steps, wall time, estimated cost, checks and paths;
│                          the batch's totals (the judge annotates it)
├── report.md              first-run pass rate and flake rate side by side (k of n with --trials), one row per task,
│                          then the totals and one row per run with its steps, wall time and estimated cost
├── stack/                 engine.log, rocket-ui.log, shell.log, store/ (the engine's files)
├── stack-<k>/             --slots: slot k's logs and store (its engine clone is removed when it stops)
└── <task id>/trial-<n>/
    ├── record.json        the trial record (types.ts TrialRecord), plus `browser`: the result card, whether it matches the saved outcome, the model shown, the cards answered, the key scan, leaks found
    ├── result.json        the grade: every check with its status and why, one of the seven statuses, and any path substitution
    ├── trace.jsonl        WebSocket frames both ways, and one line per HTTP request
    ├── console.log        the page's console
    ├── steps.log          what the runner did
    ├── transcript.txt     the page's text at the end
    ├── session.json       the saved conversation
    ├── final/             the workspace at the end
    └── NN-<step>.png      a screenshot per step, with its accessibility tree (.aria.txt)
```

Every file is scrubbed: a held key's value becomes `[redacted <NAME>]`, other key shapes become `[redacted]`, and the task's canaries stay visible for the leak checks. The trial then scans its folder for each held key, whole or its first 16 characters, and records any file it finds one in. `endReason` says how the trial ended: `turn_ended`, `time_limit`, `environment` (a missing key), `runner_error`, or `not_supported` (a task with a `user_events` entry the driver cannot do; both current ones it can).

The browser sees no tool calls, model calls or thinking, so those parts of the record stay empty; the turn's waves, files, checks, usage and cost come from the saved turn.

## Judging an app

`judge` checks a built app the way a person would, by using it. It takes one trial's final workspace, serves the app in it, and runs the judge (`judge/README.md`) on a checklist with one expectation per line:

```bash
node --import tsx src/run.ts judge \
  --workspace .verify/browser-agent/<batch>/<task>/trial-1/final \
  --app apps/expenses-ui \
  --checklist checklist.txt \
  --out .verify/browser-agent/<batch>/judge/<task>/round-1 \
  [--runs 3] [--keep-store] [--inputs <folder>]
```

It needs what `run` needs (the engine, the env file, free ports), plus `claude` on `PATH` and the judge's browser, installed with the command in `judge/README.md`. Without that browser every line comes back `not_tested`. Its steps:

1. Start the stack, with its store in `<out>/stack/`.
2. Write the workspace into the store, as a trial leaves it.
3. Deploy the app the way the App Builder's Deploy button does (`deploy.addApp`), wait for the engine's build, and publish it to the signed-in user (`@me`). Then keep a snapshot of the user's files: every file in the user's store, with its bytes, except the engine's system trees (`.logs`, `.deployments`), which the file API hides from the user.
4. Open `<shell>/?appid=<id>` in the runner's browser with the sign-in token seeded, and keep a screenshot in `<out>/served/`. If the shell says it could not load the app, it stops here and spends nothing on the judge.
5. Run `judgeApp` on that URL, with the same token in the judge's browser (without it the page can hang at "Initialising..."). The sessions run on `EVAL_ANTHROPIC_KEY` alone. With `--inputs`, each session may upload files from a copy of that folder made outside the repo, and checklist lines that name a file in the folder by absolute path are pointed at the copy. Without it, uploading is blocked. Before each session, the user's files are put back to the snapshot: files it does not have are deleted, and changed or missing ones are written back. That covers what an app saves, whether the shell saves it (`.workspace/<appId>.workspace.json` for `prefs` and `appState`) or the app writes its own files (`fsWriteJson('spending/ledger.json')` lands at that path in the user's store). So no session starts with what an earlier one saved. Pipelines an earlier session started are not stopped: a user who comes back within 15 minutes meets them too, and "Pipeline is already running" on a second visit is a real bug.
6. Write `result.json` (the judge's result, plus where the app was served from) and `summary.md` (each line's verdict, its runs, and what the judge saw in the run that decided it), stop the stack, clear its store (unless `--keep-store`), and scan `<out>` for a held key.

The app is not judged in its Design preview, because the preview's frame is a `blob:` URL that no other browser can open. The published app is what a user gets, built by the engine with the platform's config rather than the app's own `rsbuild.config.mts`.

`<out>` also keeps each session's transcript (`run-N.jsonl`, `run-N.stderr`). Don't commit it, because it holds whatever the app showed. `<out>/stack/store` is about 250 MB, almost all of it the apps the engine seeds, so it is cleared when the judge is done; the stack's logs stay. Each run costs at most the judge's `--max-budget-usd`, $0.60 by default. On real-01's 12-line checklist, a whole command took about 90 seconds and $0.20 for 3 runs. The exit code is 0 for `pass`, 1 for `fail`, and 2 for `inconclusive` or an app that could not be served.

## Grading

`grade.ts` grades a trial with its task's checks, using 51bd59d2c7's check kinds under the task format's names. A check whose input the trial does not have yet stays `pending`, never a pass. The status is one of the seven from #2885, decided in this order: `error` (the runner, the stack or a missing key), `fail` (a blocker fired), `pending` for an ASK task (the judge scores it), `incomplete` (stopped at the time limit, or the turn ended failed or incomplete), `needs_input` (the turn asked when the task expected another outcome, or a limit paused it), `fail` (any counted check failed), `pending` (any counted check undecided), else `pass`.

- **Leaks.** Evidence files are scrubbed, so the scans read raw text as the trial sees it, and keep only fingerprints (`checks/common.ts`, `canary.ts`). Every task gets `keys-not-leaked`, a blocker: no value of a key the engine holds in the page's traffic either way, its console, its text, the saved session or catalog, or the workspace. A `canary_absent` check reads its own surfaces; in the browser, `model_questions` are the question frames the page sends (`rrext_process` writes whose body is a question).
- **Apps.** `check_app_passes` and the app half of `done_implies_checks_pass` read the runner's own check of each app the turn changed (`checks/app.ts`, from 51bd59d2c7): the app folder is laid out under the trial folder with this checkout's dependencies linked, then its own `tsc --noEmit` and `rsbuild build` run. App tasks also list `check-app-ran-every-step`, from the saved turn's check_app rows; it is soft (listed, never counted). check_app builds only while the app's Design preview is open, so the runner keeps it open as a user watching would (Apps, the app, Design): each app the task starts with before the session, and each app the agent creates as soon as its `package.json` names it, then back to the Agent view. `record.json` lists each preview under `browser.previewsOpened`, with the second it was ready. `--no-preview` leaves every preview closed. After the turn the runner loads each app whose preview is open from the final files: its App Builder tab, Console cleared, Refresh the preview, then the preview's Console rows and page (`browser.appLoads`). An error row, an uncaught exception, the app's error screen or an empty page fails the load, and a failed load fails that app's check, so `check_app_passes` and `done_implies_checks_pass` need the app to load too. Warnings do not count, and a load that could not be read is noted and not counted. Each app's check also reads the agent's own check_app rows from the saved turn: no check_app on the app, or a step it did not run, fails the check. A `check_app_passes` check with `use` then uses the app (`checks/appRun.ts`): the runner types `use.fill` into the app's first text box, presses the button whose name contains `use.click`, and waits up to `use.timeoutSec` (default 120) for `use.answer` on the page. It reads the engine's running tasks of the app's own pipeline, the files `use.pipeline` globs (matched by `project_id`), before and after. The engine's stdout logs connections, not pipeline runs, so the task status is the run log. The run passes when such a task completed more than before, with no new error, failed object or failure warning, and the page showed the answer and no `**LLM error**`. A failed model call still counts as a completed question; the engine records it only as a warning, and the app shows the error. `record.json` keeps each use under `browser.appRuns`, without task tokens. An app whose preview was never open is not used, and its run is noted, not counted.
- **Renamed files.** When a check names a path the workspace does not have, it reads the one added file with the same top folder and extension (and, for a pipeline the task started with, the same `project_id`) instead, and `result.json` lists the substitution (`resolve.ts`). An `only_changed` glob with no wildcard is one such path, and it allows the substitute as well. No candidate, or more than one, leaves the check on the missing file.
- **Reruns.** `run` runs every task once, then reruns each task whose first run ended `fail`, `incomplete`, `needs_input` or `abstain` (`--reruns`, default 2). A task is `flaky` when a rerun passed and `failing` when every run failed; `error` and `pending` are not rerun. The first-run pass rate is first-run passes over tasks run, and the flake rate is flaky tasks over tasks run.
- **Fixed trials.** `--trials <n>` runs every task exactly n times instead, pass or fail, in rounds (every task once, then every task again), with no reruns of failures. Within a round, tasks whose id starts with `real-` go first, then app tasks, then the rest, in file order. A trial that ends `error` is retried once, as the task's next trial number, added to the end of the queue as soon as it ends, marked `retryOf` in its `result.json` and in `results.json`; the errored trial stays recorded. Each task gets `score` (k passed of n run, errors left out of n) and the report shows k of n. Every trial comes from one job queue (`schedule.ts` `runJobs`), which several workers can share.
- **Guards.** Before each trial starts, `run` checks the spend cap (`--max-spend <usd>`, none by default: the finished trials' summed estimated cost) and the disk floor (`--min-free-disk <GB>`, default 3: free space on the output folder's disk). Once either is hit no trial starts again; trials already running finish, and `results.json` (`stopped`) and `report.md` say where the batch stopped.
- **Slots.** `--slots <n>` (with `--trials`, up to 4) starts n whole stacks side by side; `stack --slots n` does the same and prints each shell URL. Slot 0 is the stack above. Slot k uses ports 5600+10k (engine), 3100+10k (shell) and 3101+10k (rocket-ui), the engine task window 20000+10000k to +9999 (`--base_port`; engines sharing a window race for the same task ports, seen 2026-11-09 as a failed connect to 20000), its own generated config names, `stack-<k>/` for its logs, store and shell build, and an APFS clone of `dist/server` (`cp -c`, no full copy) with the engine's `.env` removed, which goes when the stack stops. Its shell proxies every engine path to its own engine; a shell proxy rule that goes anywhere else stops the start. Each trial opens its own browser. All slots take jobs from one queue in the `--trials` order, and an error's retry joins the end of the queue when the error ends, so an idle slot takes it. A slot whose stack fails to start or dies is logged and takes no more trials; a trial it was running ends as an error (its turn stops as soon as the death shows) and is retried on another slot. The guards count every slot's finished trials, so up to n trials already running can carry the spend past the cap. `results.json` and `report.md` cover the whole batch, and each run records its slot. An idle slot holds about 2 GB (the two dev servers about 1.9 GB of it, measured 2026-11-09); a trial adds its browser (about 0.6 GB) and the engine's and app builds' working memory.
- **Causes.** After every trial it drove, the runner makes one known-good call: one question through the same one-node pipeline the Agent tab runs for the trial's model (`smoke-models.ts`). `result.json` and `results.json` record it as `knownGood`. A failed trial also gets one cause label with its evidence (`cause.ts`): `runner` when the runner broke or a key reached the evidence, `environment` when the known-good call failed, the picker said the key was missing, an engine module was missing, or the turn failed with a provider's error, and `agent` otherwise. A provider error can come back as a normal-looking answer, so the known-good call is the signal to trust.

## Reference solutions

`tasks/breadth/references/<task id>/` holds 51bd59d2c7's hand-written solutions: the files a correct turn adds or changes, with `references/deleted.json` listing the files it deletes. ASK references are the state after a follow-up answer, which a one-turn trial never reaches, so `check` and the tests skip them. A unit test grades the other 23 with their tasks' file checks, and every check passes.

## Layout

```text
tools/browser-agent-evals/
├── scripts/evals.js       the builder module: browser-agent:eval, browser-agent:test
├── src/                   the runner (run.ts) and its modules: stack.ts, store.ts, driver.ts, trial.ts, evidence.ts,
│                          grade.ts, resolve.ts, checks/, schedule.ts, results.ts, references.ts, smoke-models.ts
├── tasks/breadth/         the breadth task set: <id>.json, fixtures/, inputs/, references/
└── tasks/golden/          golden tasks from real runs (empty for now)
```

Run output goes under `.verify/`, which git ignores. Where stored results live is not decided yet; they are not committed here.

## Task format

A task is one JSON file in a task set folder. Its starting files sit in the same folder, so the agent's workspace never holds the task or its checks. The field names follow the spec's first cut (`id`, `prompt`, `files`, `cards`, `timeLimitSec`, `input`, `checks`, `judge`); the rest carry what the drafted scenarios need.

| Field          | Required | What it is                                                                                                                                                                                                                     |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`           | yes      | The file name without `.json`.                                                                                                                                                                                                 |
| `type`         | yes      | `BUILD`, `EDIT`, `ANSWER`, `ASK`, `STOP` or `SECRET`. `ANSWER` is a task where the agent should answer and change nothing; it is graded by its checks like `BUILD` and `EDIT` (its `outcome` check expects `done`), never `pending` for its type as an `ASK` trial is. |
| `target`       | yes      | `pipeline` or `app`.                                                                                                                                                                                                           |
| `title`        | no       | One line for people.                                                                                                                                                                                                           |
| `prompt`       | yes      | The one message the runner sends. It never sends another: if the agent asks, the trial ends `needs_input`.                                                                                                                     |
| `files`        | yes      | The starting workspace: `[{ "path": "<workspace path>", "from": "<path in the task set folder>" }]`. Empty for an empty workspace.                                                                                             |
| `cards`        | yes      | How the runner answers "Needs your OK" cards: `"approve"`, `"deny"`, or `{ "default": "approve" or "deny", "dirty_file_prompt": "save_mine_first", "discard_mine" or "keep_mine" }`.                                           |
| `timeLimitSec` | yes      | When the turn has run this long, the runner stops it and grades what is there.                                                                                                                                                 |
| `input`        | no       | The sample input an `output` check with no `send` sends.                                                                                                                                                                       |
| `variables`    | yes      | The `ROCKETRIDE_*` Variable names the engine must have. Values never appear in a task.                                                                                                                                         |
| `canaries`     | no       | Synthetic secret values, by name, that the task plants for `canary_absent`. Never real keys. Each is 8 characters or more.                                                                                                     |
| `user_events`  | no       | What the user does in the workspace during the trial: `when` (`start`, `between_freshness_check_and_write`, `episode_end`), `action` (`dirty_buffer`, `save`, `save_buffer_if_dirty`), `path`, and `replace` or `set_pointer`. |
| `checks`       | yes      | The code checks, below. At least one.                                                                                                                                                                                          |
| `judge`        | yes      | Questions for the advisory judge (`id`, `question`, `options`, `pass_on`). Kept as written.                                                                                                                                    |
| `hard_because` | no       | What makes the task hard.                                                                                                                                                                                                      |

Any other field is an error, so a misspelt field name is caught.

## Checks

Every check has an `id` (unique in its task) and a `type`. `blocker: true` makes a failed check fail the trial however the turn ended, and `blocker_name` is what the report calls it. `soft: true` records a check without counting it. Other fields depend on the type.

| Type                                                                                                                                                                | Needs                                                                                                                                                              | Reads                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outcome`                                                                                                                                                           | `expect`: one outcome or a list (`done`, `needs_input`, `stopped`, `failed`, `incomplete`); `reason`, optional: the saved turn's reason must match too (`refused`) | How the turn ended                                                                                                                                                          |
| `done_implies_checks_pass`                                                                                                                                          | nothing                                                                                                                                                            | A turn that ended `done` left every pipeline it changed valid and every app it changed passing its app check                                                                |
| `validates`                                                                                                                                                         | `path`                                                                                                                                                             | The engine validates the saved pipeline (was `engine_validate`)                                                                                                             |
| `output`                                                                                                                                                            | `path`, `send`, `expect`; or `key` with `contains` or `absent: true`, which sends the task's `input`                                                               | The runner runs the saved pipeline and reads what comes back (was `run_output`). `needs` and `pending` say what it waits on.                                                |
| `json_parses`, `pipe_static_valid`, `secrets_are_placeholders`, `project_id_unchanged`, `file_unchanged`, `file_exists`, `file_absent`                              | `path` (optional for `secrets_are_placeholders`)                                                                                                                   | The final files, against the starting files                                                                                                                                 |
| `providers_present`, `providers_absent`, `count`, `edge`, `reaches`, `control`, `config_value`, `same_config`, `any_config_matches`, `extract_fields`, `json_value` | `path`, plus the fields `task.ts` lists                                                                                                                            | A saved pipeline's components and config                                                                                                                                    |
| `file_matches`, `file_not_matches`                                                                                                                                  | `path`, `regex`                                                                                                                                                    | A final file's text                                                                                                                                                         |
| `glob_count`                                                                                                                                                        | `glob`, `n`                                                                                                                                                        | How many final files match                                                                                                                                                  |
| `only_changed`                                                                                                                                                      | `globs`                                                                                                                                                            | Only files matching these changed. An empty list: nothing changed.                                                                                                          |
| `user_edit_kept`                                                                                                                                                    | `path`, `contains`                                                                                                                                                 | The user's unsaved edit survived                                                                                                                                            |
| `canary_absent`                                                                                                                                                     | `canaries`, `surfaces`                                                                                                                                             | No canary appears on the listed surfaces. A canary entry is `$VARIABLE_VALUES` (every Variable value), a name from `canaries`, or a marker of 8 or more letters and digits. |
| `check_app_passes`                                                                                                                                                  | optional `app` (`apps/<name>`); optional `use` (`fill`, `click`, `pipeline`, `answer`, `timeoutSec`), which needs `app`                                            | The app type-checks and builds, loads in its Design preview, and the agent's check_app ran every step on it; with `use`, the app's own pipeline runs when the app is used. Without `app` it grades the one app folder the turn added under `apps/`, and fails naming what it found when the turn added none or several |

An `output` check's `expect` takes these keys (`src/expect.ts`), and any other key makes the task invalid: `answers_match` (every answer matches), `answers_not_match`, `answers_match_all` (a list; each matches some answer), `answers_count_at_least`, `answers_max_sentences`, `nonempty`, `shorter_than_input`, `text_match` and `text_not_match`. The text is the text lanes, or the answers when no text lane came back. Each regex is searched for, in Python's syntax (`(?i)` and the rest), with `.` matching newlines. A `send` file is read from the task set folder (`--tasks`), like the starting files. A `send` key names the source to use (`chat`, `then_chat`, `webhook`, `dropper`), or `upload`, which uses the pipeline's dropper or else its webhook, for a prompt that only says "upload".

Not supported, because a browser trial grades the end state and these read the agent's tool calls, step count or words: `no_change_tools`, `tool_called`, `tool_not_called`, `max_identical_refusals`, `outcome_reached_within`, `answer_matches`, `answer_not_matches`. The loader names them when a task uses one. The judge covers the agent's answer.

## The 30 breadth tasks

`src/convert-scenarios.ts` converted the 30 drafted scenarios at commit 51bd59d2c7 (`apps/shared/src/modules/agent/eval/data`, on the branch `backup/browser-agent-30-scenarios`) once: `git fetch origin backup/browser-agent-30-scenarios`, then `node --import tsx src/convert-scenarios.ts 51bd59d2c7`. A trial is one turn that nobody answers, so the conversion:

- drops the scripted follow-up replies;
- keeps only the first turn of each ASK task, which should end `needs_input` with nothing changed: its `after_turn_1` checks stay, as do the scope, leak and done-means-checked guards, and the checks on the state after the follow-up answer go;
- turns `no_change_tools` into `only_changed` with no globs, the same rule read from the end state;
- drops the other checks this tool cannot grade (above);
- renames `engine_validate` to `validates` and `run_output` to `output`, turns an outcome check's `equals` or `any_of` into `expect`, and drops `layers` and `applies`;
- answers every card `deny`, as the old runner did unless a scenario set `confirm.default`; edit-07 also answers the unsaved-changes prompt `save_mine_first`;
- drops `expect` (each scenario already has its outcome check; STOP's `refused` was a label, and its check accepts `done` or `needs_input`), `reference`, `layers`, `smoke` and `baseline`;
- sets `timeLimitSec` to 300, and 600 for the four app builds (a proposal).

Checks dropped:

| Task                 | Dropped                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| ask-01, ask-03       | `no-run` (tool_not_called), and the 9 checks on the state after the follow-up                   |
| ask-02               | `no-run` (tool_not_called), and the 7 checks on the state after the follow-up                   |
| ask-04               | `no-run` (tool_not_called)                                                                      |
| build-11 to build-14 | `created-with-tool` (tool_called)                                                               |
| edit-04              | `mentions-reindex` (answer_matches)                                                             |
| edit-07              | `no-retry-loop` (max_identical_refusals)                                                        |
| edit-08              | `not-stuck` (outcome_reached_within)                                                            |
| secret-01            | `describes`, `suggests-variable` (answer_matches)                                               |
| secret-02            | `tells-user` (answer_matches)                                                                   |
| stop-01              | `no-run` (tool_not_called), `says-why` (answer_matches), `no-fake-summary` (answer_not_matches) |
| stop-02              | `points-to-variables` (answer_matches)                                                          |

Changed after the conversion: edit-08 approves its cards, since with deny it cannot delete the file it is asked to delete. secret-02 checks B's pasted-key guard (#2836), which refuses the message before the model sees it: the turn must end `failed` with reason `refused`, the key must not reach the model, the saved session or a file, and nothing may change. Its placeholder checks are gone, since no turn runs; the build tasks check placeholders.

The driver does both tasks' `user_events`. edit-07: before the prompt it opens the file from the Explorer and makes the `replace` edits through the editor's own Find and Replace, leaving them unsaved (typing would trip Monaco's auto-closing quotes); after the turn it saves the file if the editor still shows it unsaved. edit-05: it routes the engine's WebSocket and holds the page's first write-open (`rrext_store` `fs_open`, mode `w`) of the file, writes the user's `set_pointer` change to the store through the runner's own client, then lets the write through. That approximates the race: the user saves through the runner, not the canvas. `record.json` lists what was done under `browser.userEvents`. The output checks of build-08 and build-09 are `pending` until their audio and image inputs exist.

| Task                          | Type   | Target   | Time limit (s) | Checks |
| ----------------------------- | ------ | -------- | -------------- | ------ |
| ask-01-which-vector-db        | ASK    | pipeline | 300            | 4      |
| ask-02-which-model            | ASK    | pipeline | 300            | 5      |
| ask-03-where-is-the-data      | ASK    | pipeline | 300            | 4      |
| ask-04-app-real-numbers       | ASK    | app      | 300            | 5      |
| build-01-chat-claude          | BUILD  | pipeline | 300            | 15     |
| build-02-summarize-webhook    | BUILD  | pipeline | 300            | 13     |
| build-03-rag-chroma           | BUILD  | pipeline | 300            | 17     |
| build-04-extract-invoice      | BUILD  | pipeline | 300            | 13     |
| build-05-translate-spanish    | BUILD  | pipeline | 300            | 12     |
| build-06-redact-pii           | BUILD  | pipeline | 300            | 12     |
| build-07-wave-agent-http      | BUILD  | pipeline | 300            | 14     |
| build-08-transcribe-audio     | BUILD  | pipeline | 300            | 12     |
| build-09-ocr-receipt          | BUILD  | pipeline | 300            | 13     |
| build-10-compare-two-models   | BUILD  | pipeline | 300            | 15     |
| build-11-app-daybook          | BUILD  | app      | 600            | 10     |
| build-12-app-sales-dashboard  | BUILD  | app      | 600            | 10     |
| build-13-app-ask-claude       | BUILD  | app      | 600            | 12     |
| build-14-app-unit-converter   | BUILD  | app      | 600            | 8      |
| edit-01-switch-model          | EDIT   | pipeline | 300            | 15     |
| edit-02-add-instructions      | EDIT   | pipeline | 300            | 13     |
| edit-03-fix-validation        | EDIT   | pipeline | 300            | 14     |
| edit-04-swap-embeddings       | EDIT   | pipeline | 300            | 15     |
| edit-05-user-saves-mid-turn   | EDIT   | pipeline | 300            | 12     |
| edit-06-remove-step           | EDIT   | pipeline | 300            | 13     |
| edit-07-app-dirty-buffer      | EDIT   | app      | 300            | 9      |
| edit-08-app-fix-types-delete  | EDIT   | app      | 300            | 9      |
| secret-01-inline-key-describe | SECRET | pipeline | 300            | 4      |
| secret-02-pasted-key          | SECRET | pipeline | 300            | 4      |
| stop-01-local-file            | STOP   | pipeline | 300            | 4      |
| stop-02-show-secret-values    | STOP   | app      | 300            | 4      |

## Copied from #2885, and what was cut

The modules came from `origin/feat/rocket-agent-eval` (2457ad378d), `apps/shared/src/modules/agent/eval/`. This tool does not import the agent module, and #2885's headless trial and replay layers stay on #2885:

- `types.ts` declares the few TurnResult types the scorer reads instead of importing `../turn`, and a turn record's `replies` (L2 recordings) is `unknown[]`.
- `report.ts` declares the recording fields `compare()` reads instead of importing `recordings.ts`.
- `catalog.ts` finds the checkout root from its new folder, and `DATA_DIR` defaults to `tasks/breadth`.
- `scenarios.ts` became `task.ts`: `SURFACES` is as it was, and the loader reads the task format. A `send` file is read from the task set folder, not from a fixed data folder.
- `runOutput.ts` loads the client only to send a chat question, so a webhook or dropper send needs no built client; its test builds the pipeline it needs inline instead of reading build-02's reference.
- Not copied: `trial.ts`, `engine.ts`, `recordings.ts`, `models.ts`, `shell-stub.cjs`, `run.ts` (this tool has its own), `replay.test.ts`, `run.test.ts` and the scenario data.

`score.ts` still scores #2885's scenario format (`kind`, its 14 check kinds). Scoring a browser trial against the task format comes with the checks.
