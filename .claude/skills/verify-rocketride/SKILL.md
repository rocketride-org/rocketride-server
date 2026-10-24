---
name: verify-rocketride
description: Launch RocketRide from this checkout, use it the way a user does, and save evidence. Covers the engine, pipelines run through the Python SDK, the Python and TypeScript CLIs, and the engine's HTTP MCP endpoint. Use it to prove a change works before opening a PR, to reproduce a bug report, or to collect the transcripts a PR description needs.
---

# Verify RocketRide

This skill starts a RocketRide engine built from this checkout, drives it through the same SDKs, CLIs, and endpoints users call, and saves what happened under `.verify/<run-id>/`. Read this file first, then the feature file for what you are checking.

## Coverage

| Surface | Status | Feature file |
|---|---|---|
| Engine health and auth | covered | [features/engine-health.md](features/engine-health.md) |
| Chat pipelines (Chat, LLM, Return Answers) | covered | [features/chat-pipeline.md](features/chat-pipeline.md) |
| Webhook pipelines | covered | [features/webhook-pipeline.md](features/webhook-pipeline.md) |
| Python and TypeScript CLIs | covered | [features/cli.md](features/cli.md) |
| HTTP MCP endpoint | covered | [features/mcp.md](features/mcp.md) |
| Shell, shell apps, chat-ui, dropper-ui, docs site | not covered yet | |
| VS Code extension | not covered yet | |
| n8n nodes, Docker image, Helm chart | not covered yet | |

If a change touches a surface that is not covered, say so in the PR and describe what you checked by hand. Never report an uncovered surface as verified.

## Prerequisites

- **A built engine.** Run `./builder server:build --autoinstall` once. It downloads a prebuilt engine when the `packages/server` source hash matches a release, and compiles it otherwise, which takes from 10 minutes to a few hours.
- **The C++ nodes need root once.** `parse`, `hash`, `indexer`, `azure`, `msservices`, and `objstore` compile locally and need packages that only `sudo` can install: `sudo ./scripts/compiler-unix.sh --autoinstall`. Without them, `server:build` stops at "Build c++ nodes". Finish the rest of the build with `./builder --sequential nodes:sync ai:sync server:setup-test-deps client-typescript:build shell:build client-init:build client-python:sync-source client-python:wheel-source client-python:copy-readme client-python:wheel-build client-python:sync`. Pipelines that parse documents, hash, index, or use the Azure, Microsoft services, or object storage nodes cannot be verified until the C++ nodes build.
- **`uv`, or a working `python3 -m venv`.** `rr-verify` installs the built Python wheel into `.verify/venv`. On Ubuntu without the `python3-venv` package, `python3 -m venv` fails, and `rr-verify` uses `uv` instead.
- **Rebuild after editing code.** The engine runs copies in `dist/server`, not the source tree. After editing Python in `packages/ai` or `nodes/`, run `./builder ai:sync nodes:sync`. After editing C++ in `packages/server`, run `./builder server:build`. After editing the Python SDK or CLI, rebuild its wheel with `./builder --sequential client-python:sync-source client-python:wheel-source client-python:copy-readme client-python:wheel-build client-python:sync`. After editing the TypeScript SDK or CLI, run `./builder client-typescript:build`. Then launch a new run. `./builder` runs the actions you list in parallel unless you pass `--sequential`, so keep `--sequential` on every multi-step command here. `rr-verify doctor` warns when engine, ai, or node files changed since the build, and when the Python SDK source is newer than its wheel.

## Shell setup

Every shell command line starts with a fresh environment, so begin each one with:

```bash
. .claude/skills/verify-rocketride/bin/env.sh <run-id> && <command>
```

Run it from the repository root. `env.sh` puts `rr-verify` on `PATH`, sets `F` to the fixtures directory, and sets `RR_VERIFY_ID` so every `rr-verify` command uses your run. Once the run is launched, it also loads `ROCKETRIDE_URI` and `ROCKETRIDE_APIKEY`. Pick one run ID, such as your task name, and use it for the whole session. Another agent may be verifying in the same checkout, so never rely on "the latest run".

## Launch

```bash
. .claude/skills/verify-rocketride/bin/env.sh my-run && rr-verify launch --mock
```

It is ready when it prints a line starting `engine:   http://127.0.0.1:<port>`. It waits for the engine's `Application startup complete.` log line and fails with the last log lines if the engine exits first. Launching an ID that already exists fails; pick a new ID.

- `--mock` starts the engine with `ROCKETRIDE_MOCK=nodes/test/mocks`. Pipelines then load stub OpenAI, Anthropic, LangChain, and vector-store libraries, so LLM nodes answer without keys. It also sets `ROCKETRIDE_OPENAI_KEY` to a placeholder when you have not set one. Without `--mock`, LLM nodes call the real providers and need their keys in your environment, such as `ROCKETRIDE_OPENAI_KEY`.
- The engine requires the API key `verify-key` (override with `RR_VERIFY_APIKEY`). Every `rr-verify` command passes it.
- By default the port is a free port passed explicitly. `--port 0` lets the OS pick, the way the VS Code extension's local mode starts the engine; see the MCP gotchas before using it.
- Runs from the same checkout share `dist/data`, the file store in `~/.rocketlib/store`, and `.verify/venv`. Do not run features that write to the store in two runs at once. The engine the VS Code extension installs in `~/.config/RocketRide/engine` is separate and is never touched.

## Doctor

```bash
. .claude/skills/verify-rocketride/bin/env.sh my-run && rr-verify doctor
```

A read-only check that the run's engine is worth driving. It checks that the process is alive, that it owns its port, that `/version` answers, whether engine, ai, or node code changed since the build, and that the API key works both ways (a wrong key gets 401, the run's key gets through). Exit 0 means safe to drive.

Run it before the first recipe, between features, after any unexpected `FAIL`, and whenever output looks wrong. A recipe step that expects a `FAIL` does not count. If it fails, run `rr-verify stop`, launch a new run with a new ID, and do not drive the failed one.

## Drive

Use what a user uses: the SDK, a CLI, MCP, or HTTP. Do not import modules from `packages/ai` or call test-only helpers.

| What the user does | Command |
|---|---|
| Run a chat pipeline (`client.chat`) | `rr-verify chat [--pipe FILE] [--expect answers\|none] "question"` |
| Send text to a webhook pipeline (`client.send`) | `rr-verify send --pipe FILE [--expect-text TEXT] "text"` |
| Use the Python CLI | `rr-verify cli -- <args>` |
| Use the TypeScript CLI | `rr-verify tscli -- <args>` |
| Call an MCP method | `rr-verify mcp <method> ['<params json>']` |
| Call HTTP, or run any other command | `rr-verify record <feature-id> -- <command>`, for example `curl -s "$ROCKETRIDE_URI/version"` |
| Run your own SDK script | `rr-verify py script.py [args]` (not recorded; save your own output) |

`--label <feature-id>` puts the evidence of `chat`, `send`, `cli`, `tscli`, and `mcp` in that feature's folder.

Fixtures in `$F`:

- `quickstart-chat.pipe` is Chat, then OpenAI (`openai-5-2` profile), then Return Answers. It is the pipeline the IDE quickstart builds.
- `quickstart-chat-no-return.pipe` is the same pipeline without Return Answers.
- `echo.pipe` is a webhook source wired to a Return Text node. It returns the text it receives.

To verify a pipeline your change touches, pass the repository's own `.pipe` file with `--pipe`.

Results:

- `chat` and `send` print the result, a `token: ... terminated: ... mock: ...` line, then `PASS:` or `FAIL:` with the reason. Exit code 0 means the expectation held, 1 means it did not, 2 means the run itself failed.
- `mcp` prints the JSON-RPC response, then `MCP: ok` or `MCP: error (see the response above)` on stderr, and exits 1 on any error or `isError` response.
- `cli`, `tscli`, and `record` print the command's output and exit with its exit code.
- Every command that saves evidence also prints `saved: <path>` on stderr. In a combined view of stdout and stderr, that line can come before or after the output, so match the result lines, not the last line.

## Evidence

Everything lands in `.verify/<run-id>/`, which git ignores:

- `engine.log` is the engine's output, and `engine.env` holds the run's PID, port, URI, and API key.
- `<feature>/<time>-chat.json` and `<feature>/<time>-send.json` hold the pipeline, input, result, task token, whether the task was terminated, whether the LLM was mocked, the verdict, and the duration.
- `<feature>/<time>-cmd.json` holds a `cli`, `tscli`, or `record` command with its exit code, stdout, and stderr.
- `<feature>/<time>-<method>[-<tool>].json` holds each MCP request and response, including the `initialize` exchange that precedes it.

Times have millisecond precision, so files never overwrite each other. A command run without `--label` saves to `mcp/` (for `mcp`) or `cli/` (for `cli` and `tscli`).

Proof standards:

- Exercise the path a user takes, not internal setters or test-only endpoints.
- Capture the action and the resulting state, not only the final output.
- Check side effects with a second, read-only view. For example, after stopping a task, run `rr-verify tscli -- list` and confirm it is gone.
- Mock replies prove the wiring, not answer quality. Say "mocked LLM" next to any result that used `--mock`.
- In a PR, show the command, the `PASS:`, `FAIL:`, or `MCP:` line, and the relevant JSON. Never commit `.verify/`.

## Cleanup

```bash
. .claude/skills/verify-rocketride/bin/env.sh my-run && rr-verify stop
```

It ends the engine's process group, which holds the engine and every pipeline process it started. It never kills processes by name. Evidence stays where it is. `rr-verify runs` lists runs and whether each engine is still running. Delete a run's folder with `rm -rf .verify/<run-id>` once you no longer need its evidence.

## Helpers

- `bin/env.sh` sets up a shell for a run. Source it at the start of every command line.
- `bin/rr-verify` is the entry point. `rr-verify help` lists every command and option.
- `bin/drive.py` runs chat and webhook pipelines through the Python SDK and writes evidence. Call it through `rr-verify chat` and `rr-verify send`.
- `bin/record.py` runs a command and saves its output. Call it through `rr-verify record`, `cli`, or `tscli`.

## Feature map

[features/README.md](features/README.md) lists every feature with its preconditions, how a user reaches it, the exact commands that drive it, and the traps that waste a run. Keep it current with the pstack `maintain-verification-skill` pass.
