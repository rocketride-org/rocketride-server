# RocketRide verification map

This directory is the maintained source for verifying RocketRide's user-facing behavior. Read [the skill](../SKILL.md) first for shell setup, launch, doctor, and cleanup, then use the matching feature file as the recipe.

## Baseline preconditions

- The checkout is built: `dist/server/engine` exists.
- A run is live: `rr-verify launch --mock` printed a line starting `engine:   http://127.0.0.1:<port>` for your run ID.
- `rr-verify doctor` exits 0 for that run.
- Never drive an engine that this run did not start, such as one from the VS Code extension, `./builder server:run`, or another agent's run.
- For a browser feature, doctor shows no `WARN` line for the UI under test.

## Driving conventions

- Every command below assumes the line starts with `. .claude/skills/verify-rocketride/bin/env.sh <run-id> &&`, run from the repository root. That puts `rr-verify` on `PATH` and sets `$F`, `$ROCKETRIDE_URI`, and `$ROCKETRIDE_APIKEY`.
- Use one run for the whole session. Run `rr-verify doctor` before the first feature, between features, and after any unexpected `FAIL`. Launch a new run with a new ID only when doctor fails or a recipe says so.
- Treat every command as literal. Keep quoted text and flags unchanged. Expected output that says "starts with" is a prefix of the real line; any other quoted output appears as written.
- Pass `--label <feature-id>` so evidence lands in that feature's folder.
- Stop every task a recipe starts. `rr-verify tscli -- list` should end each feature with `No active tasks found`.
- Keep proof artifacts during cleanup.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final output.
- Every recipe command that checks behavior saves its own evidence: `chat` and `send` write `-chat.json` or `-send.json`, `cli`, `tscli`, and `record` write `-cmd.json`, `mcp` writes the request and response, and `browse` writes `-browse.json` with its screenshots and video. Setup commands that only create input files need no evidence.
- Scratch files go under `/tmp` with your run ID in the name, as the recipes show, so two runs never share one.
- Record the sub-feature ID with every result.
- Report an unreachable path with the command you tried and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.
- Mark results from a `--mock` run as "mocked LLM". The evidence JSON has a `mock` field.
- For a browser feature, attach the screenshots that show the behavior and the run's video to the PR.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point, including ones this skill cannot drive yet.
3. `Driving it with rr-verify` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Engine health](./engine-health.md) covers version, build freshness, and API-key auth.
- [Chat pipeline](./chat-pipeline.md) covers the quickstart Chat, LLM, and Return Answers pipeline, with and without Return Answers, mocked and real.
- [Webhook pipeline](./webhook-pipeline.md) covers sending text to a webhook-source pipeline, uploading from the CLI, and termination.
- [CLIs](./cli.md) covers the Python and TypeScript `rocketride` CLIs: validate, start, list, stop, and upload.
- [MCP](./mcp.md) covers the engine's HTTP MCP endpoint: initialize, tool listing, validation, one-shot runs, and task cleanup.
- [Shell and Pipeline Builder](./shell.md) covers the browser shell the engine serves: the home page, sign-in, and adding a node on the Pipeline Builder canvas.
- [Chat page](./chat-ui.md) covers `/chat` for a running chat pipeline: asking a question and reading the conversation.
- [Dropper page](./dropper-ui.md) covers `/dropper` for a running dropper pipeline: uploading and removing files, including the link MCP hands out.
- [Docs site](./docs-site.md) covers the built docs site: the home page, sidebar navigation, search, and the 404 page.
