# RocketRide verification map

This directory is the maintained source for verifying RocketRide's user-facing behavior. Read [the skill](../SKILL.md) first for launch, doctor, and cleanup, then use the matching feature file as the recipe.

## Baseline preconditions

- The checkout is built: `dist/server/engine` exists and `rr-verify launch` starts.
- A run is live: `rr-verify launch --mock` printed `engine: http://127.0.0.1:<port>`.
- `rr-verify doctor` exits 0 for that run.
- Never drive an engine that this run did not start, such as one from the VS Code extension or `./builder server:run`.

## Driving conventions

- Start every recipe from a fresh run unless its preconditions say otherwise.
- Treat every command as literal. Keep quoted text and flags unchanged.
- Run commands from the repository root. `rr-verify` means `.claude/skills/verify-rocketride/bin/rr-verify`, and `F` means `.claude/skills/verify-rocketride/fixtures`.
- Stop every task a recipe starts. `rr-verify tscli -- list` should end with `No active tasks found`.
- Keep proof artifacts during cleanup.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final output.
- SDK proof is the evidence JSON that `rr-verify chat` or `rr-verify send` saves, plus its `PASS:` or `FAIL:` line.
- CLI proof is the command, its stdout and stderr, and its exit code.
- MCP proof is the request and response JSON that `rr-verify mcp` saves.
- Record the feature ID and entry point with every artifact.
- Report an unreachable path with the command you tried and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.
- Mark results from a `--mock` run as "mocked LLM".

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point, including ones this skill cannot drive yet.
3. `Driving it with rr-verify` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Engine health](./engine-health.md) covers version, build freshness, and API-key auth.
- [Chat pipeline](./chat-pipeline.md) covers the quickstart Chat, LLM, and Return Answers pipeline, with and without Return Answers.
- [Webhook pipeline](./webhook-pipeline.md) covers sending text to a webhook-source pipeline and reading the result.
- [CLIs](./cli.md) covers the Python and TypeScript `rocketride` CLIs: validate, upload, and list.
- [MCP](./mcp.md) covers the engine's HTTP MCP endpoint: tool listing, validation, one-shot runs, and task cleanup.
