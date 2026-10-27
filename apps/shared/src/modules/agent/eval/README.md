# Eval runner for the browser agent

`shared:eval` runs the browser agent (Wave in Rocket Builder's Agent tab) through 30 scenarios and scores what it did. It never trusts the agent's own account of its work: the runner checks the files, runs the app build, and runs the saved pipeline itself.

```bash
./builder shared:eval                                        # validate, then L1 replay (no key, no engine)
./builder shared:eval --pattern=build-01-chat-claude         # the same, one scenario
EVAL_ARGS="run --layer L2 --scenarios build-01-chat-claude" ./builder shared:eval
EVAL_ARGS="selftest" ./builder shared:eval                   # the checks' controls and planted failures
```

From `apps/shared`, the same commands run directly:

```bash
node --import tsx src/modules/agent/eval/run.ts validate
node --import tsx src/modules/agent/eval/run.ts run --layer L1 [--scenarios a,b] [--set claude-369f0511]
node --import tsx src/modules/agent/eval/run.ts run --layer L2 --scenarios build-01-chat-claude [--provider anthropic|openai] [--model <id>] [--trials 1]
node --import tsx src/modules/agent/eval/run.ts run --layer L3 --scenarios build-01-chat-claude [--trials 1]
node --import tsx src/modules/agent/eval/run.ts selftest [--layer L3]
```

Output goes to `.verify/eval/<layer>-<time>/` in the checkout, or `--out`: `report.md`, `results.json`, `human-review.md` for ASK scenarios, and a record, config and log per trial under `records/`.

## Layers

| Layer | Model                                                       | Engine                                            | Keys                           |
| ----- | ----------------------------------------------------------- | ------------------------------------------------- | ------------------------------ |
| L1    | recorded replies, replayed                                  | fake (`engine.ts`)                                | none                           |
| L2    | Anthropic or OpenAI, called directly with the official SDKs | fake                                              | the provider key, to the trial |
| L3    | the stand-in model pipeline on the engine                   | the branch-built engine, through the verify skill | to the engine only             |

Every layer runs the same trial (`trial.ts`) through the product's own path: the shell's `TurnController` (rows, Stop, the "Needs your OK" cards), `AgentSession` and its session storage, `agent()` with its stand-in model pipeline, `runAgent`, the Wave loop, every toolkit, the approval list, and the rocket-ui workspace with its read-only `.rocketride/` guides. Only the client behind it changes. Cards are answered as the scenario says, `no` by default.

- **L1** replays the baseline's recorded trials (`data/recordings/`) on the fake engine. It is deterministic and takes seconds. A scenario with no recording is `pending`, never `pass`. A replay that leaves its recording, for example because the loop asks for a reply the recording does not have, is an `error`.
- **L2** asks a live model through the fake engine's stand-in `chat`. It renders each question the way the engine does (the Python client's `Question.getPrompt`), marks the stable start for prompt caching, and repeats the engine's JSON check and its three tries. The default model is the one behind the product's stand-in profile (`claude-sonnet-5`).
- **L3** extends the baseline harness (round3/baseline/harness) to this branch. It takes `/tmp/rr-verify-5565.lock`, starts the branch-built engine with `rr-verify-agent launch --engine source --engine-only`, runs each trial with every key unset, and stops the engine with `rr-verify-agent cleanup`. The engine's provenance is the skill's `engine.json`.

The fake engine serves the file store in memory, the catalog from `nodes/src/nodes/*/services*.json`, `validate` by the static pipeline rules, and `use`, `getTaskStatus`, `send` and `terminate`. A start checks `${ROCKETRIDE_*}` names against the run's Variables and refuses a second start of a running pipeline, as the engine does. Pipelines never run, and `send` says so. Any other client method throws a message that names it.

## Scenarios and data

`data/` holds the 30 scenarios from round3/eval-scenarios (format in that folder's README), their fixtures and reference solutions, the run inputs, and the L1 recordings. Fixtures and references are JSON maps of workspace path to text, so the app sources in them, one of which has a type error on purpose, stay out of the package's type-check, lint and format. `run.ts pack <folder> <file.json>` packs a folder.

Every run validates everything first and refuses to run when anything is invalid, naming each scenario. A scenario is invalid when its file breaks the format, when a fixture, reference or input it names is missing, when a check is of an unknown kind or lacks a field its kind needs, or when its reference solution fails one of its own static checks. An app reference must also pass check_app_passes; that verdict is cached under `.verify/eval/cache/` by the sha256 of the app's files and the shell contract.

Changes from the notes' draft:

- build-13's reference `App.tsx` casts the imported `.pipe` to `PipelineConfig`. Without it the app fails its own type-check, because the scaffold types a `.pipe` import as `Record<string, unknown>` and `client.use` takes a `PipelineConfig`.
- ASK checks marked `applies: after_turn_1` read turn 1, and the other checks read the whole trial, as the scenarios README says. check_workspace.py had the two the other way round. The baseline never ran an ASK scenario, so no baseline score changes.
- `tool_called` and `tool_not_called` also match this branch's spelling of a tool the scenarios name by its old name: `run_pipeline` is `rocketride_client` with method `use`, `send_data` is `send`, `sendFiles` or `chat`, and `deploy_add` is `deploy.add`.

## Checks and statuses

`score.ts` ports the scenario tools' check.py (static checks) and check_workspace.py (run checks), so a record scores here as it did for the baseline. A check is `pass`, `fail`, `pending` (it belongs in this layer, but what it needs is missing) or `not_in_layer` (listed, never counted). A pending check never counts as a pass.

A trial is one of six statuses, counted separately and never folded into one score:

| Status     | When                                                                                                                                               |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| error      | the infrastructure failed: the engine, a provider 5xx or rate limit, the runner, or a replay that left its recording. Left out of the denominator. |
| fail       | a blocker fired, or a counted check failed                                                                                                         |
| incomplete | the last turn ended `empty_plan` or `error` after the model was reached                                                                            |
| abstain    | the scenario expects done and the model was still asking when the follow-ups ran out                                                               |
| pending    | no recording (L1), a scenario this layer does not run, an ASK scenario, or a counted check that is pending                                         |
| pass       | every counted check passed                                                                                                                         |

ASK scenarios stay human-scored. The runner scores their deterministic checks, writes the first answer and the judge question to `human-review.md`, and reports the scenario as pending. A blocker that fires still fails it.

Diagnostics are recorded and never decide anything: waves, tool calls, model calls, repeated identical calls and the longest run of them, tool errors, GATE_STATE write failures, done refusals, confirm cards, tokens, cost at list price (L2), wall time and model time.

### The three checks the baseline could not run

- **canary_absent** scans six surfaces: the questions sent to the model, the thinking rows, the answer, the saved session file, the session catalog and the workspace files. It works on fingerprints (length, two rolling hashes, sha256), so the trial never holds a real key and a report names a canary and a surface, never a value. In L1 and L2 the Variables are synthetic values the fake engine holds. In L3 a process that has the keys (`rr-verify-agent keys`) fingerprints the engine's Variables. Records and reports also blank anything shaped like a provider key.
- **check_app_passes** copies the app out of the final workspace and runs its own build script, `tsc --noEmit && rsbuild build`, with this checkout's React, rsbuild and Module Federation plugin, `rocketride` from packages/client-typescript, and `shell` typed by the newest frozen contract (packages/shell/contract/versions). It runs in every layer, since the runner is the host stub the scenarios README asks for. done_implies_checks_pass uses it for every app a run changed.
- **run_output** (L3) starts the saved pipeline, sends the scenario's input and checks the output. `answers_match` holds only when every answer matches, so a translate pipeline that also answers the question fails, and both of build-10's models must answer. It is pending when the input is not made yet (`pending`), when the check needs an outside service not named in `EVAL_SERVICES` (`needs`), or when the pipeline uses a Variable the engine lacks.

`run.ts selftest` gives each a passing control and a planted failure, and checks that the validator refuses planted defects by name. `selftest --layer L3` runs run_output against the engine.

## L1 recordings

The baseline harness kept every tool call with its arguments and wave, every thinking row, every model error and the final answer, but not the raw replies. `run.ts record` rebuilds each reply from those (`recordings.ts`): a wave's thought and calls, the accepted answer with the code's own lines removed, the recorded model error and the best-effort answer for a turn that ended `stop=error`. A reply that was retried had its first, unusable version thrown away, so it is not replayed; each recording counts them. Each recording also carries the baseline's check results for that trial and the engine's validate verdicts on its final files, keyed by content hash. L1 uses those verdicts for engine_validate when a final file is byte for byte the one the engine checked.

The sets are `claude-369f0511` (15 trials), `gpt-369f0511` (5, before the plan JSON fix), `gpt-8bd0122f-jsonfix` (5) and `scripted-369f0511` (2), from round3/baseline/runs. L1 compares each replay with its baseline score on the same checks and with its recorded final files, and exits 1 when any differs.

## Keys

Keys follow the verify skill's rules: the caller's environment, else tokenstash in `EVAL_KEYS_DIR` (or `RR_VERIFY_KEYS_DIR`, or the checkout) when it is installed. L1 needs none. L2 passes the provider key to the trial process, whose SDK call reads it. L3 passes the keys to the engine only, by name. No value is printed or written.

## Not built

Nightly CI, OpenRouter, a production runner, an LLM judge and its calibration, ten-trial baselines and the four extra scenarios are out of scope.
