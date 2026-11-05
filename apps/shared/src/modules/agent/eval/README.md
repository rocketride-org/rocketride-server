# Eval runner for the browser agent

`shared:eval` runs the browser agent (Wave in Rocket Builder's Agent tab) through the smoke scenarios and scores what it did. It never trusts the agent's own account of its work: the runner reads the files back, validates the pipelines, and on the real engine runs them.

```bash
./builder shared:eval                                        # validate, then L1 replay (no key, no engine)
./builder shared:eval --pattern=build-01-chat-claude         # the same, one scenario
EVAL_ARGS="run --layer L2 --scenarios build-01-chat-claude" ./builder shared:eval
```

From `apps/shared`, the same commands run directly:

```bash
node --import tsx src/modules/agent/eval/run.ts validate
node --import tsx src/modules/agent/eval/run.ts run --layer L1 [--scenarios a,b] [--set <name>] [--limits recorded|default|off]
node --import tsx src/modules/agent/eval/run.ts run --layer L2 --scenarios build-01-chat-claude [--provider anthropic|openai] [--model <id>] [--trials 1] [--limits default|off]
node --import tsx src/modules/agent/eval/run.ts run --layer L3 --scenarios build-01-chat-claude [--trials 1] [--limits default|off]
node --import tsx src/modules/agent/eval/run.ts record --from <an L2 run's output folder> --set <name>
```

Output goes to `.verify/eval/<layer>-<time>/` in the checkout, or `--out`: `report.md`, `results.json`, and a record, config and log per trial under `records/`.

## Layers

| Layer | Model                                                        | Engine                                            | Keys                           |
| ----- | ------------------------------------------------------------ | ------------------------------------------------- | ------------------------------ |
| L1    | recorded replies, replayed                                   | fake (`engine.ts`)                                | none                           |
| L2    | Anthropic's Messages API or OpenAI's Responses API, by fetch | fake                                              | the provider key, to the trial |
| L3    | the stand-in model pipeline on the engine                    | the branch-built engine, through the verify skill | to the engine only             |

Every layer runs the same trial (`trial.ts`) through the product's own path: the shell's `TurnController` (rows, Stop, the "Needs your OK" cards), `AgentSession` and its session storage, `agent()` with its stand-in model pipeline, `runAgent`, the Wave loop, every toolkit, the approval list, and the rocket-ui workspace with its read-only `.rocketride/` guides. Only the client behind it changes. Cards are answered no.

- **L1** replays the recordings in `data/recordings/` on the fake engine. It needs no key and takes a few seconds. A scenario with no recording is `pending`, never `pass`, and L1 exits 1 unless every scenario has a recording that reproduces.
- **L2** asks a live model through the fake engine's stand-in `chat`. It renders each question the way the engine does (the Python client's `Question.getPrompt`), marks the stable start for prompt caching, and repeats the engine's JSON check and its three tries for a question that asks for JSON. The default model is the one behind the product's stand-in profile (`claude-sonnet-5`). Each trial keeps the model's replies, so an L2 run can become recordings.
- **L3** takes `/tmp/rr-verify-5565.lock`, starts the branch-built engine with `rr-verify-agent launch --engine source --engine-only`, runs each trial with every model key unset and the engine's API key in `RR_VERIFY_APIKEY` (never in a file), and stops the engine with `rr-verify-agent cleanup`, also when starting it failed part way. When launch refuses because this checkout's engine already runs, L3 leaves that engine alone. The engine's provenance is the skill's `engine.json`. Neither the skill nor verify-rocketride's launcher (#2870) is on this branch yet, so L3 refuses to start and names the missing skill.

The fake engine serves the file store in memory, the catalog from `nodes/src/nodes/*/services*.json`, `validate` by the static pipeline rules, and `use`, `getTaskStatus`, `send` and `terminate`. A start checks `${ROCKETRIDE_*}` names against the run's Variables and refuses a second start of a running pipeline, as the engine does. Pipelines never run, and `send` says so. Any other client method throws a message that names it.

## L1 in CI

`replay.test.ts` runs L1 inside `./builder shared:test`, which CI's build runs on every pull request to develop or main. It fails unless every scenario has a recording, and every replay reproduces: its status and every check match the live trial it was recorded from, its final files are the same, each turn's TurnResult has the same outcome and reason, every tool call has the same wave, tool, outcome, arguments and result, and it used every recorded reply. Anything else means the agent's loop, its tools, what they read or the scoring changed how the recorded replies play out.

Arguments and results are compared by sha256, after `NONDETERMINISTIC` in `recordings.ts` replaces what differs between a live trial and its replay (UUIDs, the fake engine's run tokens and start times, the synthetic Variable values). A read of the guides under `.rocketride/` (served from `docs/agents/context/`) or of the node catalog (`getServices`, `getService`, from `nodes/src/nodes/*/services*.json`) keeps its outcome and arguments but not its result (`SERVED_READS`), so editing a guide or a services file does not fail the replay. Every other result counts.

When a change is meant to do that, delete the old set from `data/recordings/` (a run refuses to start while any recording is invalid, and a second recording of the same scenario and trial is invalid) and record again:

```bash
EVAL_ARGS="run --layer L2 --out ../../.verify/eval/record" ./builder shared:eval
node --import tsx src/modules/agent/eval/run.ts record --from ../../.verify/eval/record --set claude-<commit>
```

A recording holds each turn's request, the model's replies in order, the turn's TurnResult outcome and reason, each tool call's wave, tool and outcome with the sha256 of its arguments and of its result (empty for a guide or catalog read), the limits the trial ran under, how it scored and the sha256 of its final files.

## Scenarios and data

`data/` holds the five smoke scenarios, their reference solutions and the run inputs. A scenario has an `id`, the `prompt`, the `followup` the simulated user sends when the agent asks (up to `max` times), the `variables` the run has, its `checks`, and `hard_because`, what its checks are built around. Each starts from an empty workspace. Its reference, `references/<id>.json`, is a JSON map of workspace path to text. Every run validates everything first and refuses to run when anything is invalid, naming each scenario: a file that breaks the format, a reference or input that is missing, a check of an unknown kind or without a field its kind needs, or a reference that fails one of its own static checks.

## Checks and statuses

A check is `pass`, `fail`, `pending` (it belongs in this layer, but what it needs is missing) or `not_in_layer` (listed, never counted). A pending check never counts as a pass. `engine_validate` and `run_output` need the real engine, so they count in L3 only. `outcome` reads the last turn's TurnResult, never the log.

A trial is one of seven statuses, counted separately and never folded into one score:

| Status      | When                                                                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| error       | the infrastructure failed: the engine, a provider 5xx or rate limit, the runner, or a replay that left its recording. Left out of the denominator. |
| fail        | a blocker fired, or a counted check failed                                                                                                         |
| incomplete  | the last turn's TurnResult is `failed` or `incomplete`: an error, or replies that stayed unusable                                                  |
| needs_input | the last turn's TurnResult is `needs_input`: ask_user asked, or the step or cost limit paused the turn                                             |
| abstain     | the model was still asking when the follow-ups ran out                                                                                             |
| pending     | no recording (L1), or a counted check that is pending                                                                                              |
| pass        | every counted check passed                                                                                                                         |

Diagnostics are recorded and never decide anything: each turn's TurnResult (outcome/reason), waves, tool calls, model calls, repeated identical calls, tool errors, GATE_STATE write failures, done refusals, confirm cards, tokens, cost at list price (L2), the agent's estimated tokens and cost, wall time and model time.

`--limits` sets the step and cost limits each turn runs under: `default` (L2 and L3) is the product's 60 steps and $2, `off` turns both off, and `recorded` (L1) replays a trial under the limits it was recorded with. A turn a limit paused ends the trial, since Continue is the user's call.

`canary_absent` scans the questions sent to the model, the thinking rows, the answer, the saved session file, the session catalog and the workspace files for the run's Variable values. It works on fingerprints (length, two rolling hashes, sha256), so the trial never holds a real key and a report names a Variable and a surface, never a value. In L1 and L2 the Variables are synthetic values the fake engine holds. In L3 a process that has the keys (`rr-verify-agent keys`) fingerprints the engine's Variables. Records and reports also blank anything shaped like a provider key.

`run_output` (L3) starts the saved pipeline, sends the scenario's input and checks the output. `answers_match` holds only when every answer matches, so a translate pipeline that also answers the question fails. The engine refuses a second start of a running pipeline, so a run of it the trial started (the agent's test run) is ended first. A run someone else started is never ended.

## Keys

Keys follow the verify skill's rules: the caller's environment, else tokenstash in `EVAL_KEYS_DIR` (or `RR_VERIFY_KEYS_DIR`, or the checkout) when it is installed. L1 needs none. L2 passes the provider key to the trial process, which sends it in the request header. L3 passes the keys to the engine only, by name, and the engine's API key to each trial in its environment. No value is printed or written: trial configs, records, logs, reports and recordings hold none.
