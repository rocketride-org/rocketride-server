# tool_daytona

A RocketRide tool node that gives an AI agent an isolated cloud sandbox for running code.

## What it does

Gives an agent a remote [Daytona](https://www.daytona.io) sandbox to execute generated code
and shell commands in, the code runs on Daytona's infrastructure, never on the engine host.
The agent can run code in the configured language, run arbitrary shell commands (install
packages, build, then run), and move text files in and out of the sandbox.

One ephemeral sandbox is shared across every tool call in the pipeline: files written and
packages installed by one call are visible to the next. The sandbox is created **lazily** on
the first tool call, a pipeline that never invokes the tool never provisions (or pays for)
one, and is deleted when the pipeline shuts down.

A running sandbox bills by the minute, so the node is built to fail safe on cost: the sandbox
is `ephemeral` with a 1–120 minute inactivity **auto-stop** that deletes it even if the engine
crashes before cleanup. If an idle gap recycles the sandbox mid-pipeline, the next `run_code`,
`run_command`, or `upload_file` call transparently creates a fresh one (state resets: re-upload
and reinstall as needed).

---

## Configuration

| Field | Type | Description |
|---|---|---|
| `apikey` | string | **Required.** Daytona API key (app.daytona.io → Keys). |
| `api_url` | string | Default empty. Daytona API endpoint. Leave empty for the default cloud (`https://app.daytona.io/api`); set it to point at a self-hosted Daytona. |
| `target` | string | Default empty. Sandbox region, e.g. `us` or `eu`. Leave empty for the organization default. |
| `snapshot` | string | Default empty. Daytona snapshot to create the sandbox from. Leave empty for the default snapshot. |
| `language` | string | Default `python`. Language runtime used by `run_code`: `python`, `javascript`, or `typescript`. |
| `auto_stop_minutes` | integer | Default 5 (1–120). Inactivity stop interval. The sandbox is ephemeral, so stopping also deletes it: this is the cost safety net if cleanup is missed. |
| `exec_timeout_secs` | integer | Default 120 (1–1200). Maximum seconds a single `run_code` / `run_command` call may take. |
| `max_output_chars` | integer | Default 50000 (1000–1000000). Output longer than this is truncated before being returned to the agent, protecting its context window. |

---

## Available tools

| Tool | Description |
|---|---|
| `run_code` | Execute source code in the sandbox (language from config) and return its output. |
| `run_command` | Run a shell command in the sandbox: install dependencies, build, then run. |
| `upload_file` | Write a text file into the sandbox (creates or overwrites). |
| `download_file` | Read a text file back from the sandbox. |

### run_code

| Parameter | Required | Description |
|---|---|---|
| `code` | yes | Source code to execute. Use `print()` (or the language equivalent) to produce output. |

Returns `exit_code`, `output` (combined stdout/stderr, truncated at `max_output_chars`), and
`truncated`. On a sandbox failure it returns `error` instead, with `exit_code: -1`.

### run_command

| Parameter | Required | Description |
|---|---|---|
| `command` | yes | Shell command, e.g. `pip install requests && python app.py`. |
| `cwd` | no | Working directory inside the sandbox. |

Returns `exit_code`, `output`, and `truncated` (or `error` on a sandbox failure).

### upload_file

| Parameter | Required | Description |
|---|---|---|
| `path` | yes | Destination path inside the sandbox, e.g. `app/main.py`. |
| `content` | yes | Text content to write (UTF-8). |

Returns `success` and `path`, or `error` on failure.

### download_file

| Parameter | Required | Description |
|---|---|---|
| `path` | yes | Path of the file to read from the sandbox. |

Returns `content` (UTF-8, truncated at `max_output_chars`) and `truncated`, or `error` when the
file is missing or the sandbox call fails.

---

## Cost safety

A sandbox bills while it runs, so the node bounds the exposure three ways:

- **Lazy creation**: the sandbox is provisioned only when a tool is actually called, never at
  pipeline start.
- **Ephemeral + auto-stop**: it stops (and, being ephemeral, deletes itself) after
  `auto_stop_minutes` of inactivity, even if the engine dies before cleanup. The interval is
  floored at 1 minute so an abandoned sandbox always shuts itself down.
- **Explicit teardown**: it is deleted on pipeline shutdown (`endGlobal`).

## Sandbox lifecycle

The sandbox is shared, so installed packages and uploaded files persist between tool calls
within a pipeline run. After it sits idle past the auto-stop interval it is recycled
server-side; the next `run_code`, `run_command`, or `upload_file` call detects the stale handle
and creates a fresh, empty sandbox automatically. `download_file` does **not** auto-recreate: a
404 there is ambiguous between a missing file and an expired sandbox, and a fresh empty sandbox
could not produce the file either way, so it simply reports the miss.

---

## Running the tests

```bash
# Unit tests (mocked Daytona client — no API key or network needed)
pytest nodes/test/test_tool_daytona.py -v
```

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `tool_daytona.api_url` | `string` | **API URL**<br/>Daytona API endpoint. Leave empty for the default cloud (https://app.daytona.io/api); set for self-hosted Daytona. | `""` |
| `tool_daytona.apikey` | `string` | **API Key**<br/>Daytona API key (app.daytona.io → Keys). | `""` |
| `tool_daytona.auto_stop_minutes` | `integer` | **Auto-stop (minutes)**<br/>Sandbox stops (and, being ephemeral, deletes itself) after this many minutes of inactivity: the cost safety net if cleanup is missed. | `5` |
| `tool_daytona.exec_timeout_secs` | `integer` | **Execution Timeout (seconds)**<br/>Max seconds a single run_code/run_command call may take. | `120` |
| `tool_daytona.language` | `string` | **Language**<br/>Language runtime for run_code in the sandbox. | `"python"` |
| `tool_daytona.max_output_chars` | `integer` | **Max Output (characters)**<br/>Output longer than this is truncated before being returned to the agent. | `50000` |
| `tool_daytona.snapshot` | `string` | **Snapshot**<br/>Daytona snapshot to create the sandbox from. Leave empty for the default snapshot. | `""` |
| `tool_daytona.target` | `string` | **Target Region**<br/>Sandbox region, e.g. "us" or "eu". Leave empty for the organization default. | `""` |

## Dependencies

- `daytona` `==0.140.0`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/tool_daytona)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
