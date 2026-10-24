# MCP

The engine serves an MCP endpoint at `/mcp` (Streamable HTTP) so AI clients can list components, validate and run pipelines, read logs, and manage deployments. `docs/agents/skills/MCP_TOOL_CONTRACT.md` is the tool contract.

## Sub-features

- `mcp-initialize` answers `initialize` with server name `rocketride-mcp`.
- `mcp-tools-list` lists exactly the tools in the contract.
- `mcp-validate` reports a valid pipeline as `ok` and a broken one with the error.
- `mcp-run-oneshot` runs an inline pipeline with `run_pipeline` and `inputs`, returning a result in the same call.
- `mcp-terminate` stops a task with `terminate`, after which `list_running_pipelines` no longer shows it.

## How to get to it (user POV)

- Point an MCP client such as Claude Desktop, Cursor, or Claude Code at `http://127.0.0.1:<port>/mcp` with the engine's API key as a bearer token.
- Self-hosting setup is in `docs/public/mcp/http/self-hosting.md`.

## Driving it with rr-verify

Preconditions:

- Your run was launched without `--port 0` and `rr-verify doctor` exits 0.
- `rr-verify tscli -- list` prints `No active tasks found`.

- **Initialize.** Run `rr-verify mcp --label mcp-initialize initialize`. The response has `"serverInfo":{"name":"rocketride-mcp",...}`, and stderr ends `MCP: ok`.
- **List tools.** Run `rr-verify mcp --label mcp-tools-list tools/list`. Stderr ends `MCP: ok`.
- **Compare with the contract.** Run `diff <(grep -oE '"name":"[a-z_]+"' "$(ls -t .verify/$RR_VERIFY_ID/mcp-tools-list/*-tools_list.json | head -n 1)" | cut -d'"' -f4 | sort -u) <(grep -oE '^\| `[a-z_]+` \|' docs/agents/skills/MCP_TOOL_CONTRACT.md | tr -d '|` ' | sort -u)`. It prints nothing and exits 0 when the engine and the contract list the same tools. Any line it prints is a tool missing from one side.
- **Validate a good pipeline.** Run `rr-verify mcp --label mcp-validate tools/call "{\"name\":\"validate_pipeline\",\"arguments\":{\"pipeline\":$(tr -d '\n\t' < $F/quickstart-chat.pipe)}}"`. `structuredContent` is `{"ok":true,"errors":[],"warnings":[]}`.
- **Validate a broken pipeline.** Create `/tmp/rr-verify-broken.pipe` as in the CLI feature's "Reject a broken pipeline" step. Run `rr-verify mcp --label mcp-validate tools/call "{\"name\":\"validate_pipeline\",\"arguments\":{\"pipeline\":$(cat /tmp/rr-verify-broken.pipe)}}"`. `structuredContent.ok` is `false`, `errors` includes `Component response_text_1 input references unknown component id: missing_1`, stderr ends `MCP: error`, and the exit code is 1. This is the expected result.
- **Run once.** Run `rr-verify mcp --label mcp-run-oneshot tools/call "{\"name\":\"run_pipeline\",\"arguments\":{\"pipeline\":$(tr -d '\n\t' < $F/echo.pipe),\"inputs\":\"hello over mcp\"}}"`. `structuredContent` has `"ok": true`, a `task_token`, and a `result`. Keep the token.
- **Find the task.** Run `rr-verify mcp --label mcp-terminate tools/call '{"name":"list_running_pipelines","arguments":{}}'`. Because of the one-shot gotcha below, `structuredContent` has `"count": 1` and a task with the same `token`.
- **Terminate.** Run `rr-verify mcp --label mcp-terminate tools/call '{"name":"terminate","arguments":{"task_token":"<task_token>"}}'`. `structuredContent` has `"terminated": "<task_token>"`.
- **Confirm it stopped.** Run the "Find the task" command again. `structuredContent` has `"count": 0`. `rr-verify tscli -- list` prints `No active tasks found`.

## Gotchas

- **Engines started with `--port 0` break MCP tools that call the engine.** Without `ROCKETRIDE_URI` in the engine's environment, MCP derives the engine address from the configured port, which is 0. `validate_pipeline`, `run_pipeline`, and similar tools then fail with `Connect call failed ('127.0.0.1', 80)`. The VS Code extension's local mode starts the engine this way. `rr-verify launch` passes an explicit port; use `rr-verify launch --mock --port 0` to reproduce the failure.
- **One-shot runs leave the task running.** After `run_pipeline` with `inputs` returns, MCP drops the token from its own registry but does not terminate the task, although the contract says the token is finished. The task stays in `list_running_pipelines`, and starting the same pipeline again fails with `Pipeline is already running.` Terminate it explicitly.
- **`validate_pipeline` calls internal providers unknown.** It checks providers against the engine's public catalog, so a pipeline using an internal node such as `response` (HTTP Results) fails with `unknown provider 'response'`, although the engine runs it and `rocketride validate` passes it. The fixtures use public nodes.
- The `result` from a one-shot run has no `text` field for the echo fixture, because MCP sends `inputs` without a mimetype. See the webhook feature's gotcha on mimetypes.
- `send_files` is listed only when the engine binds to loopback.
- The bearer token is the engine's API key. A wrong key fails before any MCP method runs.
