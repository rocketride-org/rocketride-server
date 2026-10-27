---
name: verify-rocketride
description: Launch RocketRide from this checkout, use it the way a user does, and save evidence. Covers the engine, pipelines run through the Python SDK, the Python and TypeScript CLIs, the engine's HTTP MCP endpoint, and the browser UIs the engine serves (the shell and Pipeline Builder, the chat page, the dropper page) plus the docs site. Use it to prove a change works before opening a PR, to reproduce a bug report, or to collect the transcripts, screenshots, and recordings a PR description needs.
---

# Verify RocketRide

This skill starts a RocketRide engine built from this checkout, drives it through the same SDKs, CLIs, endpoints, and browser pages users reach, and saves what happened under `.verify/<run-id>/`. Read this file first, then the feature file for what you are checking.

## Coverage

| Surface | Status | Feature file |
|---|---|---|
| Engine health and auth | covered | [features/engine-health.md](features/engine-health.md) |
| Chat pipelines (Chat, LLM, Return Answers) | covered | [features/chat-pipeline.md](features/chat-pipeline.md) |
| Webhook pipelines | covered | [features/webhook-pipeline.md](features/webhook-pipeline.md) |
| Python and TypeScript CLIs | covered | [features/cli.md](features/cli.md) |
| HTTP MCP endpoint | covered | [features/mcp.md](features/mcp.md) |
| Shell: home page, sign-in, Pipeline Builder canvas | covered | [features/shell.md](features/shell.md) |
| Chat page (`/chat`, `apps/chat-ui`) | covered | [features/chat-ui.md](features/chat-ui.md) |
| Dropper page (`/dropper`, `apps/dropper-ui`) | covered | [features/dropper-ui.md](features/dropper-ui.md) |
| Docs site (`docs/docusaurus`, built to `dist/docs`) | covered | [features/docs-site.md](features/docs-site.md) |
| Other shell apps (Hello World, Event Monitor, File Explorer, Profiler, Server Monitor, SQL Explorer, Test UI, Aparavi AQL) | not covered yet. `rr-verify browse` can drive them, but no recipes exist | |
| App Builder preview | not covered yet. It runs only inside VS Code | |
| VS Code extension | not covered yet | |
| n8n nodes, Docker image, Helm chart | not covered yet | |

If a change touches a surface that is not covered, say so in the PR and describe what you checked by hand. Never report an uncovered surface as verified.

## Prerequisites

- **A built engine.** Run `./builder server:build --autoinstall` once. It downloads a prebuilt engine when the `packages/server` source hash matches a release, and compiles it otherwise, which takes from 10 minutes to a few hours.
- **The C++ nodes need root once.** `parse`, `hash`, `indexer`, `azure`, `msservices`, and `objstore` compile locally and need packages that only `sudo` can install: `sudo ./scripts/compiler-unix.sh --autoinstall`. Without them, `server:build` stops at "Build c++ nodes". Finish the rest of the build with `./builder --sequential nodes:sync ai:sync server:setup-test-deps client-typescript:build shell:build client-init:build client-python:sync-source client-python:wheel-source client-python:copy-readme client-python:wheel-build client-python:sync`. Pipelines that parse documents, hash, index, or use the Azure, Microsoft services, or object storage nodes cannot be verified until the C++ nodes build. A downloaded engine is the exception, because the release ships its own build of these nodes, such as `dist/server/nodes/parse/libparse.so`.
- **The browser UIs.** `server:build` builds the shell, but not the chat page, the dropper page, or the shell apps. After a download, `dist/server/static` holds the release's copies of those, not this checkout's. Run `./builder ui:build` once; it builds every `apps/*-ui` and copies each into `dist/server/static`. For the docs site, run `./builder docs:build`, which writes `dist/docs`. Doctor's UI lines tell you when one of these is missing or older than its source.
- **Playwright and Chromium.** `pnpm install --frozen-lockfile` installs the `playwright` package at the repository root. If `rr-verify browse` reports that Chromium is missing, run `pnpm exec playwright install chromium`.
- **`uv`, or a working `python3 -m venv`.** `rr-verify` installs the built Python wheel into `.verify/venv`. On Ubuntu without the `python3-venv` package, `python3 -m venv` fails, and `rr-verify` uses `uv` instead.
- **Rebuild after editing code.** The engine runs copies in `dist/server`, not the source tree. After editing Python in `packages/ai` or `nodes/`, run `./builder ai:sync nodes:sync`. After editing C++ in `packages/server`, run `./builder server:build`. After editing the Python SDK or CLI, rebuild its wheel with `./builder --sequential client-python:sync-source client-python:wheel-source client-python:copy-readme client-python:wheel-build client-python:sync`. After editing the TypeScript SDK or CLI, run `./builder client-typescript:build`. After editing the shell in `packages/shell`, run `./builder shell:build`. After editing the chat page or the dropper page, run `./builder chat-ui:build` or `./builder dropper-ui:build`. After editing a shell app in `apps/<name>`, run `./builder <name>:build`, such as `./builder rocket-ui:build` for Pipeline Builder. After editing `apps/shared`, which every shell app bundles, run `./builder ui:build`. After editing the docs, run `./builder docs:build`. If a UI build prints `No changes detected` while doctor still warns, add `--force`. Then launch a new run. `./builder` runs the actions you list in parallel unless you pass `--sequential`, so keep `--sequential` on every multi-step command here. `rr-verify doctor` warns when engine C++ changed since the build, when an ai or node file differs from its copy in `dist/server`, when the Python SDK source is newer than its wheel, and when a UI's source is newer than the build the run serves.

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
- Each run has its own file store in `.verify/<run-id>/store`, and the engine seeds the shell apps from `dist/server/static/apps` into it when it starts. Runs from the same checkout share `dist/data` and `.verify/venv`. The engine the VS Code extension installs in `~/.config/RocketRide/engine` and its store in `~/.rocketlib/store` are separate and are never touched.

## Doctor

```bash
. .claude/skills/verify-rocketride/bin/env.sh my-run && rr-verify doctor
```

A read-only check that the run's engine is worth driving. It checks that the process is alive, that it owns its port, that `/version` answers, whether `dist/server` and the wheel match this checkout's code, and that the API key works both ways (a wrong key gets 401, the run's key gets through). Exit 0 means safe to drive.

It also checks the browser UIs. For the shell, the chat page, the dropper page, and each shell app, it prints a `WARN` line with the build command to run when a source file is newer than the last build, when `dist/server/static` differs from the build, or when the bundle seeded into the run's store differs from `dist/server/static/apps`. The rest share one line starting `ok   this run serves UIs built from this checkout's current source`. A last line covers the docs site in `dist/docs`. These lines are warnings and do not change the exit code, so read them before you drive a UI.

Run it before the first recipe, between features, after any unexpected `FAIL`, and whenever output looks wrong. A recipe step that expects a `FAIL` does not count. If it fails, run `rr-verify stop`, launch a new run with a new ID, and do not drive the failed one.

## Drive

Use what a user uses: the SDK, a CLI, MCP, HTTP, or a browser page the engine serves. Do not import modules from `packages/ai` or call test-only helpers.

| What the user does | Command |
|---|---|
| Run a chat pipeline (`client.chat`) | `rr-verify chat [--pipe FILE] [--expect answers\|none] "question"` |
| Send text to a webhook pipeline (`client.send`) | `rr-verify send --pipe FILE [--expect-text TEXT] "text"` |
| Use the Python CLI | `rr-verify cli -- <args>` |
| Use the TypeScript CLI | `rr-verify tscli -- <args>` |
| Call an MCP method | `rr-verify mcp <method> ['<params json>']` |
| Call HTTP, or run any other command | `rr-verify record <feature-id> -- <command>`, for example `curl -s "$ROCKETRIDE_URI/version"` |
| Run your own SDK script | `rr-verify py script.py [args]` (not recorded; save your own output) |
| Use a page in a browser | `rr-verify browse [--site engine\|docs] [--strict] [--ignore REGEX] SCRIPT.mjs [args]` |
| Serve the docs site | `rr-verify docs` |

`--label <feature-id>` puts the evidence of `chat`, `send`, `cli`, `tscli`, `mcp`, and `browse` in that feature's folder.

Fixtures in `$F`:

- `quickstart-chat.pipe` is Chat, then OpenAI (`openai-5-2` profile), then Return Answers. It is the pipeline the IDE quickstart builds.
- `quickstart-chat-no-return.pipe` is the same pipeline without Return Answers.
- `echo.pipe` is a webhook source wired to a Return Text node. It returns the text it receives.
- `dropper-text.pipe` is Dropper, then Parse, then Return Text. It returns the text of each uploaded file.
- `browser/*.mjs` are the browser scripts the feature files run, one per page.

To verify a pipeline your change touches, pass the repository's own `.pipe` file with `--pipe`.

Results:

- `chat` and `send` print the result, a `token: ... terminated: ... mock: ...` line, then `PASS:` or `FAIL:` with the reason. Exit code 0 means the expectation held, 1 means it did not, 2 means the run itself failed.
- `mcp` prints the JSON-RPC response, then `MCP: ok` or `MCP: error (see the response above)` on stderr, and exits 1 on any error or `isError` response.
- `cli`, `tscli`, and `record` print the command's output and exit with its exit code.
- `browse` prints one `ok` or `FAIL` line per step, the counts of console errors and failed requests with the first few of each, the screenshot and video paths, and then `PASS:` or `FAIL:` with the reason. Exit code 0 means every step passed, 1 means a step failed, and 2 means the run itself failed, such as a missing script or browser.
- Every command that saves evidence also prints `saved: <path>` on stderr. In a combined view of stdout and stderr, that line can come before or after the output, so match the result lines, not the last line.

### Browser scripts

`rr-verify browse` starts Chromium, runs a short script, records a video, and closes the browser. Nothing stays open between commands, so put the whole flow in one script. The script is an ES module ending in `.mjs` that exports one async function. That function receives helpers, and each helper call is one recorded step:

```js
export default async ({ open, signIn, click, waitText, shot, expectNoErrors }) => {
	await open('/');
	await signIn();
	await click('role=button[name="Open Pipeline Builder"]');
	await waitText('New pipeline');
	await shot('builder');
	await expectNoErrors();
};
```

- `open(path)` loads a page from the run's engine, or from the docs server with `--site docs`. It fails on HTTP 400 or above unless you pass the status you expect, such as `open('/missing', { status: 404 })`.
- Targets are Playwright selectors such as `role=button[name="Sign In"]`, `text=Connected`, or CSS, or a Locator built from `page`.
- `waitText`, `waitFor`, `check`, `count`, `text`, and `attr` read the page. `shot(name)` saves a PNG, and `snapshot(name)` prints the page's accessibility tree, which is the quickest way to find the role and name to click.
- `signIn()` signs in to the shell with the run's API key. `pipeline(file)` starts a `.pipe` through the TypeScript SDK and returns its `token` and `publicToken`; the task is terminated when the script ends.
- `expectNoErrors()` fails the run if any console error, uncaught page error, or failed request (a network error or HTTP 400 or above) has happened so far. `--strict` adds that check at the end of every run. `--ignore REGEX` leaves matching URLs and messages out, and the evidence lists what was ignored.
- `page`, `context`, `args` (the arguments after the script), `fixtures` (`$F`), and `env` are there for anything else. `rr-verify browse --help` lists every helper and option, including `--timeout`, `--max-seconds`, `--viewport`, and `--trace`.

Write your scripts to `/tmp/rr-verify-<run-id>-<name>.mjs`. Every run saves a final screenshot and a video even when the script takes no screenshots, and a failed step saves `<time>-failure.png`.

## Evidence

Everything lands in `.verify/<run-id>/`, which git ignores:

- `engine.log` is the engine's output, and `engine.env` holds the run's PID, port, URI, and API key.
- `<feature>/<time>-chat.json` and `<feature>/<time>-send.json` hold the pipeline, input, result, task token, whether the task was terminated, whether the LLM was mocked, the verdict, and the duration.
- `<feature>/<time>-cmd.json` holds a `cli`, `tscli`, or `record` command with its exit code, stdout, and stderr.
- `<feature>/<time>-<method>[-<tool>].json` holds each MCP request and response, including the `initialize` exchange that precedes it.
- `<feature>/<time>-browse.json` holds a browser run: the script and its arguments, each step with its result and duration, the console errors, the failed requests, what `--ignore` left out, the screenshot and video paths, `ok`, the verdict, and the duration. Beside it are `<time>-<name>.png`, `<time>-video.webm`, any `<time>-<name>.aria.yml` from `snapshot`, and `<time>-trace.zip` with `--trace`.
- `store/` is the run's file store, `docs.env` and `docs.log` belong to the docs server, and `browsers/` lists browser sessions that are still running.

Times have millisecond precision, so files never overwrite each other. A command run without `--label` saves to `mcp/` (for `mcp`) or `cli/` (for `cli` and `tscli`).

Proof standards:

- Exercise the path a user takes, not internal setters or test-only endpoints.
- Capture the action and the resulting state, not only the final output.
- Check side effects with a second, read-only view. For example, after stopping a task, run `rr-verify tscli -- list` and confirm it is gone.
- Mock replies prove the wiring, not answer quality. Say "mocked LLM" next to any result that used `--mock`.
- For a UI change, show it. Attach the screenshots that show the change and the run's `.webm` video to the PR by dropping the files into the description or a comment on GitHub, and quote the `PASS:` or `FAIL:` line with the console error and failed request counts. Describe what each screenshot shows; a reviewer should not have to guess.
- In a PR, show the command, the `PASS:`, `FAIL:`, or `MCP:` line, and the relevant JSON. Never commit `.verify/`.

## Cleanup

```bash
. .claude/skills/verify-rocketride/bin/env.sh my-run && rr-verify stop
```

It first ends every browser session and docs server the run started, then the engine's process group, which holds the engine and every pipeline process it started. It never kills processes by name. Evidence stays where it is. `rr-verify runs` lists runs and whether each engine is still running. Delete a run's folder with `rm -rf .verify/<run-id>` once you no longer need its evidence.

## Helpers

- `bin/env.sh` sets up a shell for a run. Source it at the start of every command line.
- `bin/rr-verify` is the entry point. `rr-verify help` lists every command and option.
- `bin/drive.py` runs chat and webhook pipelines through the Python SDK and writes evidence. Call it through `rr-verify chat` and `rr-verify send`.
- `bin/record.py` runs a command and saves its output. Call it through `rr-verify record`, `cli`, or `tscli`.
- `bin/browse.mjs` runs a browser script with Playwright and writes its evidence. Call it through `rr-verify browse`.
- `bin/browser.sh` holds the `browse` and `docs` commands and the browser parts of `stop` and `doctor`. `rr-verify` sources it.
- `bin/ui_doctor.py` compares each UI's source, build, and served copy for `rr-verify doctor`.

## Feature map

[features/README.md](features/README.md) lists every feature with its preconditions, how a user reaches it, the exact commands that drive it, and the traps that waste a run. Keep it current with the pstack `maintain-verification-skill` pass.
