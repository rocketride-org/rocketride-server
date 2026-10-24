---
name: verify-rocketride
description: Launch RocketRide from this checkout, use it the way a user does, and save evidence. Covers the engine, pipelines run through the Python SDK, the Python and TypeScript CLIs, and the engine's HTTP MCP endpoint. Use it to prove a change works before opening a PR, to reproduce a bug report, or to collect the transcripts a PR description needs.
---

# Verify RocketRide

This skill starts a RocketRide engine built from this checkout, drives it through the same SDKs, CLIs, and endpoints users call, and saves what happened under `.verify/<run-id>/`. Read this file first, then the feature file for what you are checking.

All commands run from the repository root. `rr-verify` below means `.claude/skills/verify-rocketride/bin/rr-verify`.

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
- **The C++ nodes need root once.** `parse`, `hash`, `indexer`, `azure`, `msservices`, and `objstore` compile locally and need packages that only `sudo` can install: `sudo ./scripts/compiler-unix.sh --autoinstall`. Without them, `server:build` stops at "Build c++ nodes". Finish the rest of the build with `./builder nodes:sync ai:sync client-python:sync-source server:setup-test-deps client-typescript:build shell:build client-init:build client-python:wheel-source`. Pipelines that parse documents, hash, index, or use the Azure, Microsoft services, or object storage nodes cannot be verified until the C++ nodes build.
- **`uv`, or a working `python3 -m venv`.** `rr-verify` installs the built Python wheel into `.verify/venv`. On Ubuntu without the `python3-venv` package, `python3 -m venv` fails, and `rr-verify` uses `uv` instead.
- **Rebuild after editing code.** The engine runs copies in `dist/server`, not the source tree. After editing Python in `packages/ai` or `nodes/`, run `./builder ai:sync nodes:sync`. After editing C++ in `packages/server`, run `./builder server:build`. After editing the Python SDK, run `./builder client-python:wheel-source`. After editing the TypeScript SDK or CLI, run `./builder client-typescript:build`. Then launch a new run. `rr-verify doctor` warns when engine, ai, or node files changed since the build.

## Launch

```bash
rr-verify launch --mock
```

It is ready when it prints `engine: http://127.0.0.1:<port>`. It waits for the engine's `Application startup complete.` log line and fails with the last log lines if the engine exits first.

- `--mock` starts the engine with `ROCKETRIDE_MOCK=nodes/test/mocks`. Pipelines then load stub OpenAI, Anthropic, LangChain, and vector-store libraries, so LLM nodes answer without keys. It also sets `ROCKETRIDE_OPENAI_KEY` to a placeholder when you have not set one. Without `--mock`, LLM nodes call the real providers and need their keys in your environment, such as `ROCKETRIDE_OPENAI_KEY`.
- The engine requires the API key `verify-key` (override with `RR_VERIFY_APIKEY`). Every `rr-verify` command passes it.
- Each launch gets its own port and its own range of task ports. By default the port is a free port passed explicitly. `--port 0` lets the OS pick, the way the VS Code extension's local mode starts the engine; see the MCP gotchas before using it.
- `--id NAME` names the run. Otherwise it is named by date and time. Later commands use `--id`, then `$RR_VERIFY_ID`, then the most recently launched run. If another agent or person may be verifying in this checkout at the same time, pass the same `--id NAME` to every command, because "most recent" may be their run.
- Runs from the same checkout share `dist/data` and the file store in `~/.rocketlib/store`. Do not run features that write to the store in two runs at once. The engine the VS Code extension installs in `~/.config/RocketRide/engine` is separate and is never touched.

## Doctor

```bash
rr-verify doctor
```

A read-only check that the run's engine is worth driving. It checks that the process is alive, that it owns its port, that `/version` answers, whether engine, ai, or node code changed since the build, and that the API key works both ways (a wrong key gets 401, the run's key gets through). Exit 0 means safe to drive.

Run it before the first drive, after any drive that fails, and whenever output looks wrong. On a FAIL, run `rr-verify stop`, launch again, and do not drive the failed instance.

## Drive

Use what a user uses: the SDK, a CLI, MCP, or HTTP. Do not import modules from `packages/ai` or call test-only helpers.

| What the user does | Command |
|---|---|
| Run a chat pipeline (`client.chat`) | `rr-verify chat [--pipe FILE] [--expect answers\|none] "question"` |
| Send text to a webhook pipeline (`client.send`) | `rr-verify send --pipe FILE [--expect-text TEXT] "text"` |
| Run any SDK script | `rr-verify py script.py [args]` (sets `ROCKETRIDE_URI` and `ROCKETRIDE_APIKEY`) |
| Use the Python CLI | `rr-verify cli -- <args>` |
| Use the TypeScript CLI | `rr-verify tscli -- <args>` |
| Call an MCP method | `rr-verify mcp <method> ['<params json>']` |
| Call HTTP directly | `. .verify/<run-id>/engine.env` then `curl "$ROCKETRIDE_URI/version"` |

Fixtures in `fixtures/`:

- `quickstart-chat.pipe` is Chat, then OpenAI (`openai-5-2` profile), then Return Answers. It is the pipeline the IDE quickstart builds.
- `quickstart-chat-no-return.pipe` is the same pipeline without Return Answers.
- `echo.pipe` is a webhook source wired to a response node. It returns the text it receives.

To verify a pipeline your change touches, pass the repository's own `.pipe` file with `--pipe`.

`chat` and `send` print the result, then `PASS:` or `FAIL:` with the reason, then the evidence path. Exit code 0 means the expectation held, 1 means it did not, 2 means the run itself failed.

## Evidence

Everything lands in `.verify/<run-id>/`, which git ignores:

- `engine.log` is the engine's output.
- `engine.env` holds the run's PID, port, URI, and API key.
- `<feature>/<time>-chat.json` and `<feature>/<time>-send.json` hold the pipeline, the input, the result, the verdict, and the duration.
- `mcp/<time>-<method>.json` holds each MCP request and response.

Proof standards:

- Exercise the path a user takes, not internal setters or test-only endpoints.
- Capture the action and the resulting state, not only the final output.
- Check side effects with a second, read-only view. For example, after stopping a task, run `rr-verify tscli -- list` and confirm it is gone.
- Mock replies prove the wiring, not answer quality. Say "mocked LLM" next to any result that used `--mock`.
- In a PR, show the command, the `PASS:` or `FAIL:` line, and the relevant JSON. Never commit `.verify/`.

## Cleanup

```bash
rr-verify stop
```

It ends the engine's process group, which holds the engine and every pipeline process it started. It never kills processes by name. Evidence stays where it is. `rr-verify runs` lists runs and whether each engine is still running. Delete a run's folder with `rm -rf .verify/<run-id>` once you no longer need its evidence.

## Helpers

- `bin/rr-verify` is the entry point. `rr-verify help` lists every command and option.
- `bin/drive.py` runs chat and webhook pipelines through the Python SDK and writes evidence. Call it through `rr-verify chat` and `rr-verify send`, which set its environment.

## Feature map

[features/README.md](features/README.md) lists every feature with its preconditions, how a user reaches it, the exact commands that drive it, and the traps that waste a run. Keep it current with the pstack `maintain-verification-skill` pass.
