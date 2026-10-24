# MCP

The engine serves an MCP endpoint at `/mcp` (Streamable HTTP) so AI clients can list components, validate and run pipelines, read logs, and manage deployments. `docs/agents/skills/MCP_TOOL_CONTRACT.md` is the tool contract.

## Sub-features

- `mcp-initialize` answers `initialize` with server name `rocketride-mcp`.
- `mcp-tools-list` lists the tools in the contract (33 as of this writing).
- `mcp-validate` validates an inline pipeline with `validate_pipeline`.
- `mcp-run-oneshot` runs an inline pipeline with `run_pipeline` and `inputs`, returning a result in the same call.
- `mcp-terminate` stops a task with `terminate`, after which `list_running_pipelines` no longer shows it.

## How to get to it (user POV)

- Point an MCP client such as Claude Desktop, Cursor, or Claude Code at `http://127.0.0.1:<port>/mcp` with the engine's API key as a bearer token.
- Self-hosting setup is in `docs/public/mcp/http/self-hosting.md`.

## Driving it with rr-verify

Preconditions:

- A run launched with `rr-verify launch --mock` (default port handling, not `--port 0`) is live and passes `rr-verify doctor`.
- `rr-verify tscli -- list` prints `No active tasks found`.

- **Initialize.** Every `rr-verify mcp` call sends `initialize` first and stops with an error if it gets no answer.
- **List tools.** Run `rr-verify mcp tools/list`. The response lists tool names including `validate_pipeline`, `run_pipeline`, `terminate`, and `list_running_pipelines`. Compare the names with the contract file.
- **Validate a pipeline.** Run `rr-verify mcp tools/call "{\"name\":\"validate_pipeline\",\"arguments\":{\"pipeline\":$(tr -d '\n\t' < $F/quickstart-chat.pipe)}}"`. `structuredContent` is `{"ok":true,"errors":[],"warnings":[]}`.
- **Run once.** Run `rr-verify mcp tools/call "{\"name\":\"run_pipeline\",\"arguments\":{\"pipeline\":$(tr -d '\n\t' < $F/echo.pipe),\"inputs\":\"hello over mcp\"}}"`. `structuredContent` has `"ok": true`, a `task_token`, and a `result`.
- **Find the task.** Run `rr-verify mcp tools/call '{"name":"list_running_pipelines","arguments":{}}'`. See the gotcha about one-shot runs: the task from the previous step is still listed.
- **Terminate.** Run `rr-verify mcp tools/call '{"name":"terminate","arguments":{"task_token":"<task_token>"}}'`. It returns `"terminated": "<task_token>"`, and `rr-verify tscli -- list` then prints `No active tasks found`.
- **Proof.** Each call saves `.verify/<run-id>/mcp/<time>-<method>.json` with the request and response.

## Gotchas

- **Engines started with `--port 0` break MCP tools that call the engine.** Without `ROCKETRIDE_URI` in the engine's environment, MCP derives the engine address from the configured port, which is 0. `validate_pipeline`, `run_pipeline`, and similar tools then fail with `Connect call failed ('127.0.0.1', 80)`. The VS Code extension's local mode starts the engine this way. `rr-verify launch` passes an explicit port; use `rr-verify launch --mock --port 0` to reproduce the failure.
- **One-shot runs leave the task running.** After `run_pipeline` with `inputs` returns, MCP drops the token from its own registry but does not terminate the task, although the contract says the token is finished. The task stays in `list_running_pipelines`, and starting the same pipeline again fails with `Pipeline is already running.` Terminate it explicitly.
- The `result` from a one-shot run has no `text` field for the echo fixture, because MCP sends `inputs` without a mimetype. See the webhook feature's gotcha on mimetypes.
- `send_files` is listed only when the engine binds to loopback.
- The bearer token is the engine's API key. A wrong key fails before any MCP method runs.
