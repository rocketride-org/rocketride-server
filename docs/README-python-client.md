<p align="center">
  <img src="https://raw.githubusercontent.com/rocketride-org/rocketride-server/main/images/banner-python.png" alt="RocketRide Python SDK" width="900">
</p>

<p align="center">
  Build, run, and manage AI pipelines from Python.
</p>

<p align="center">
  <a href="https://pypi.org/project/rocketride/"><img src="https://img.shields.io/pypi/v/rocketride?color=222223&label=PyPI" alt="PyPI"></a>
  <a href="https://github.com/rocketride-org/rocketride-server"><img src="https://img.shields.io/github/stars/rocketride-org/rocketride-server?style=flat&color=238636&label=GitHub&logo=github&logoColor=white" alt="GitHub"></a>
  <a href="https://discord.gg/9hr3tdZmEG"><img src="https://img.shields.io/badge/Discord-Join-370b7a?logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://github.com/rocketride-org/rocketride-server/blob/develop/LICENSE"><img src="https://img.shields.io/badge/License-MIT-41b6e6" alt="MIT License"></a>
</p>

## Quick Start

```bash
pip install rocketride
```

```python
import asyncio
from rocketride import RocketRideClient

async def main():
    # Zero-config: no URI needed — the SDK auto-downloads and manages a local engine
    async with RocketRideClient(auth="my-key") as client:
        result = await client.use(filepath="pipeline.pipe")
        token = result["token"]
        out = await client.send(token, "Hello, pipeline!", objinfo={"name": "input.txt"}, mimetype="text/plain")
        print(out)
        await client.terminate(token)

asyncio.run(main())
```

Don't have a pipeline yet? Visit [RocketRide on GitHub](https://github.com/rocketride-org/rocketride-server) or download the extension directly in your IDE.

<p align="center">
  <img src="https://raw.githubusercontent.com/rocketride-org/rocketride-server/main/images/install.png" alt="Install RocketRide extension" width="600">
</p>

## What is RocketRide?

[RocketRide](https://rocketride.org) is an open-source, developer-native AI pipeline platform.
It lets you build, debug, and deploy production AI workflows without leaving your IDE --
using a visual drag-and-drop canvas or code-first with TypeScript and Python SDKs.

- **50+ ready-to-use nodes** - 13 LLM providers, 8 vector databases, OCR, NER, PII anonymization, and more
- **High-performance C++ engine** - production-grade speed and reliability
- **Deploy anywhere** - locally, on-premises, or self-hosted with Docker
- **MIT licensed** - fully open-source, OSI-compliant

You build your `.pipe` - and you run it against the fastest AI runtime available.

<img src="https://raw.githubusercontent.com/rocketride-org/rocketride-server/develop/docs/images/canvas.png" alt="RocketRide visual canvas builder" width="800">

## Features

- **Pipeline execution** - Start with `use()`, send data via `send()`, `send_files()`, or `pipe()`
- **Chat** - Conversational AI via `chat()` and `Question`
- **Event streaming** - Real-time events via `on_event` and `set_events()`
- **File upload** - `send_files()` with progress; streaming with `pipe()`
- **Connection lifecycle** - Optional persist mode, reconnection, and callbacks (`on_connected`, `on_disconnected`, `on_connect_error`)
- **Async context manager** - `async with RocketRideClient(...) as client:` for automatic cleanup
- **Bundled engine** - Zero-config local execution: the SDK auto-downloads, spawns, and manages the engine binary
- **Engine CLI** - `rocketride engine` (or `rocketride e`) commands for engine lifecycle management

---

## CLI Reference

The `rocketride` command-line interface provides two categories of commands: **pipeline/task management** (for running and monitoring pipelines) and **engine management** (for controlling local engine instances).

### Pipeline & Task Commands

#### `rocketride start <pipeline>`

Start a new pipeline execution.

```bash
rocketride start ./pipeline.pipe
rocketride start ./pipeline.pipe --uri http://localhost:5566 --apikey YOUR_KEY
rocketride start ./pipeline.pipe --threads 4 --args key1=value1 key2=value2
```

| Flag        | Description                                           |
| ----------- | ----------------------------------------------------- |
| `--uri`     | Engine URI (default: `$ROCKETRIDE_URI` or auto-spawn) |
| `--apikey`  | API key (default: `$ROCKETRIDE_APIKEY`)               |
| `--token`   | Reuse an existing task token                          |
| `--threads` | Number of threads for the pipeline                    |
| `--args`    | Key-value arguments passed to the pipeline            |

#### `rocketride upload <files> [--pipeline_path <path>]`

Upload files to an existing or new pipeline.

```bash
rocketride upload ./data/*.csv --pipeline_path ./pipeline.pipe
rocketride upload report.pdf --token TASK_TOKEN --uri http://localhost:5566
```

| Flag              | Description                                |
| ----------------- | ------------------------------------------ |
| `--pipeline_path` | Pipeline to start if no `--token` is given |
| `--token`         | Upload to an existing task                 |
| `--uri`           | Engine URI                                 |
| `--apikey`        | API key                                    |
| `--threads`       | Number of threads                          |
| `--args`          | Key-value arguments                        |

#### `rocketride status`

Monitor task execution status continuously.

```bash
rocketride status --token TASK_TOKEN --uri http://localhost:5566
```

#### `rocketride stop`

Terminate a running task.

```bash
rocketride stop --token TASK_TOKEN --uri http://localhost:5566
```

#### `rocketride events [event_types...]`

Monitor task events with optional filtering.

```bash
rocketride events --token TASK_TOKEN
rocketride events apaevt_status_upload apaevt_status_processing --token TASK_TOKEN
rocketride events --log --token TASK_TOKEN
```

#### `rocketride list`

List all active tasks on the engine.

```bash
rocketride list --uri http://localhost:5566
rocketride list --json
```

### Engine Management

The engine commands manage local RocketRide engine instances. The SDK can automatically download, install, and run the engine binary &mdash; no separate install needed.

Use `rocketride engine <command>` (or the shorthand `rocketride e <command>`).

#### `rocketride engine install [version]`

Download and register an engine binary.

```bash
rocketride engine install              # latest compatible version
rocketride engine install 3.0.5        # specific version
rocketride engine install 3.0.5 --force  # skip compatibility check
```

#### `rocketride engine list`

List all tracked engine instances with status, port, PID, memory, and uptime.

```bash
rocketride engine list
```

```
VERSION  ID  PID    PORT  OWNER  STATUS  RESTARTED  UPTIME  MEMORY
3.0.5    0   12340  5566  cli    online  2          4m      86.9 MB
3.0.3    1   -      -     cli    stopped 0          0s      -
```

#### `rocketride engine start [id]`

Start an engine instance.

```bash
rocketride engine start 0                         # by instance ID
rocketride engine start --version 3.0.5            # by version
rocketride engine start --version 3.0.5 --port 7777  # explicit port
```

| Flag        | Description                                                               |
| ----------- | ------------------------------------------------------------------------- |
| `--version` | Engine version to use (looks up the registered instance for that version) |
| `--port`    | Explicit port (default: auto-assigned)                                    |

#### `rocketride engine stop <id>`

Stop a running engine instance.

```bash
rocketride engine stop 0
```

#### `rocketride engine delete <id>`

Deregister an engine instance. The engine binary is kept on disk so `install` can re-register it without re-downloading.

```bash
rocketride engine delete 0            # deregister only
rocketride engine delete 0 --purge    # also remove the binary from disk
```

| Flag      | Description                             |
| --------- | --------------------------------------- |
| `--purge` | Also remove the engine binary from disk |

#### `rocketride engine logs <id>`

Tail the log output of an engine instance.

```bash
rocketride engine logs 0
```

---

## RocketRideClient

### Constructor

```python
RocketRideClient(
    uri: str = "",
    auth: str = "",
    *,
    env: dict = None,
    module: str = None,
    request_timeout: float = None,
    max_retry_time: float = None,
    persist: bool = False,
    on_event = None,
    on_connected = None,
    on_disconnected = None,
    on_connect_error = None,
    on_protocol_message = None,
    on_debug_message = None,
)
```

**Why the options matter:** `uri` and `auth` tell the client _where_ and _how_ to authenticate. `persist` and `max_retry_time` control what happens when the connection fails or the server is not ready yet: with `persist=True` the client retries with exponential backoff and calls `on_connect_error` on each failure, so you can show "Still connecting..." or "Connection failed" without implementing retry logic yourself. Use `on_disconnected` only for "we were connected and then dropped"; use `on_connect_error` for "failed to connect" or "gave up after max retry time."

| Argument              | Type                      | Required | Description                                                                                                                                                        |
| --------------------- | ------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `uri`                 | `str`                     | No       | Server URI. If empty, falls back to `ROCKETRIDE_URI` env var. If neither is set, the SDK auto-spawns a local engine (see [Engine Auto-Spawn](#engine-auto-spawn)). |
| `auth`                | `str`                     | Yes\*    | API key. \*Can be empty if `ROCKETRIDE_APIKEY` is set.                                                                                                             |
| `env`                 | `dict`                    | No       | Override env; if omitted, `.env` is loaded. Use when passing config in code instead of env files.                                                                  |
| `module`              | `str`                     | No       | Client name for logging.                                                                                                                                           |
| `request_timeout`     | `float`                   | No       | Default timeout in ms for requests. Prevents a single DAP call from hanging.                                                                                       |
| `max_retry_time`      | `float`                   | No       | Max time in ms to keep retrying connection. Use (e.g. 300000) so the app can show "gave up" after a bounded time.                                                  |
| `persist`             | `bool`                    | No       | Enable automatic reconnection. Default: `False`. Set `True` for long-lived scripts or UIs.                                                                         |
| `on_event`            | async callable            | No       | Called with each server event dict. Use for progress or status updates.                                                                                            |
| `on_connected`        | async callable            | No       | Called when connection is established.                                                                                                                             |
| `on_disconnected`     | async callable            | No       | Called when connection is lost **only if** connected first; args: `reason`, `has_error`. Do not call `disconnect()` here if you want auto-reconnect.               |
| `on_connect_error`    | callable `(message: str)` | No       | Called on each failed connection attempt. On auth failure the client stops retrying.                                                                               |
| `on_protocol_message` | callable `(message: str)` | No       | Optional; for logging raw DAP messages. Helpful when debugging protocol issues.                                                                                    |
| `on_debug_message`    | callable `(message: str)` | No       | Optional; for debug output.                                                                                                                                        |

If `uri` and `ROCKETRIDE_URI` are both empty, the client activates **engine auto-spawn** mode — it will download (if needed) and start a local engine instance automatically on `connect()`. See [Engine Auto-Spawn](#engine-auto-spawn) for details.

**Example - client with persist and callbacks:**

```python
client = RocketRideClient(
    uri="https://cloud.rocketride.ai",
    auth="my-key",
    persist=True,
    max_retry_time=300000,
    on_connect_error=lambda msg: print("Connect error:", msg),
    on_event=handle_event,
)
```

### Context manager

| Method       | Signature                                              | Returns | Description                          |
| ------------ | ------------------------------------------------------ | ------- | ------------------------------------ |
| `__aenter__` | `async def __aenter__(self)`                           | `self`  | Enters context; calls `connect()`.   |
| `__aexit__`  | `async def __aexit__(self, exc_type, exc_val, exc_tb)` | -       | Exits context; calls `disconnect()`. |

**How to use:** Prefer `async with RocketRideClient(...) as client:` so the connection is always closed when you leave the block, even on exception. No need to call `disconnect()` manually. When using engine auto-spawn, the context manager also handles engine startup and teardown automatically.

**Example:**

```python
async with RocketRideClient(uri="wss://cloud.rocketride.ai", auth=os.environ["ROCKETRIDE_APIKEY"]) as client:
    result = await client.use(filepath="pipeline.json")
    token = result["token"]
    await client.send(token, "Hello, pipeline!")
```

### Connection

| Method                  | Signature                                                                                   | Returns       | Description                                                                                                                                                                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connect`               | `async def connect(self, uri: str = None, auth: str = None, timeout: float = None) -> None` | -             | Opens the WebSocket and performs DAP auth. Optional `uri`/`auth` override the constructor values for this connection attempt. Optional `timeout` (ms) bounds the connect + auth handshake (non-persist only). In **persist** mode, on failure the client calls `on_connect_error` and retries; on **auth** failure it does not retry. |
| `disconnect`            | `async def disconnect(self) -> None`                                                        | -             | Closes the connection and cancels reconnection. Call when the user disconnects or the script is done.                                                                                                                                                                                                                                 |
| `is_connected`          | `def is_connected(self) -> bool`                                                            | `bool`        | Whether the client is connected. Check before calling `use()` or `send()` if needed.                                                                                                                                                                                                                                                  |
| `set_connection_params` | `async def set_connection_params(self, uri: str = None, auth: str = None) -> None`          | -             | Updates server URI and/or auth at runtime. If currently connected, disconnects and reconnects with the new params (in persist mode, reconnection is scheduled; otherwise reconnects once). Use when the user changes server or credentials without creating a new client.                                                             |
| `get_connection_info`   | `def get_connection_info(self) -> dict`                                                     | `dict`        | Current connection state and URI. Returns `{ 'connected': bool, 'transport': str, 'uri': str }`. Useful for debugging or displaying "Connected to ..." in the UI.                                                                                                                                                                     |
| `get_apikey`            | `def get_apikey(self) -> Optional[str]`                                                     | `str \| None` | The API key in use. For debugging only; avoid logging in production.                                                                                                                                                                                                                                                                  |

### Low-level DAP

| Method          | Signature                                                                                                                | Returns | Description                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build_request` | `def build_request(self, command: str, *, token: str = None, arguments: dict = None, data: bytes \| str = None) -> dict` | `dict`  | Builds a DAP request message. Use for custom commands not covered by `use()`, `send()`, etc.                                                      |
| `request`       | `async def request(self, request: dict, timeout: float = None) -> dict`                                                  | `dict`  | Sends the request and returns the response. `timeout` in ms overrides the default for this call. Use `did_fail(response)` before trusting `body`. |
| `dap_request`   | `async def dap_request(self, command: str, arguments: dict = None, token: str = None, timeout: float = None) -> dict`    | `dict`  | Shorthand: builds a request and sends it in one call. Equivalent to `build_request()` + `request()`.                                              |
| `did_fail`      | `def did_fail(self, request: dict) -> bool`                                                                              | `bool`  | Returns `True` when the response indicates failure (`success === False`).                                                                         |

**Example:**

```python
# Two-step (build then request)
req = client.build_request("rrext_monitor", token=token, arguments={"types": ["apaevt_status_upload"]})
res = await client.request(req, timeout=5000)

# One-step with dap_request
res = await client.dap_request("rrext_services", {}, timeout=5000)

if client.did_fail(res):
    raise RuntimeError(res.get("message", "Request failed"))
```

### Pipeline execution

| Method            | Signature                                                                                                                                                                                                | Returns | Description                                                                                                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `use`             | `async def use(self, *, token: str = None, filepath: str = None, pipeline: dict = None, source: str = None, threads: int = None, use_existing: bool = None, args: list = None, ttl: int = None) -> dict` | `dict`  | Starts a pipeline. Requires `filepath` or `pipeline`. The client substitutes `${ROCKETRIDE_*}` from its env. Returns a dict with at least `'token'`; use that token for all data and control operations. |
| `terminate`       | `async def terminate(self, token: str) -> None`                                                                                                                                                          | -       | Stops the pipeline and frees server resources.                                                                                                                                                           |
| `get_task_status` | `async def get_task_status(self, token: str) -> dict`                                                                                                                                                    | `dict`  | Returns current task status (e.g. completed count, total, state). Poll until `completed` or use for progress display.                                                                                    |

**Why a token:** The server runs each pipeline as a separate task. The token identifies that task so `send()`, `send_files()`, `pipe()`, `chat()`, and `get_task_status()` target the correct pipeline.

### Data

| Method       | Signature                                                                                                                      | Returns               | Description                                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------ | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pipe`       | `async def pipe(self, token: str, objinfo: dict = None, mime_type: str = None, provider: str = None) -> DataPipe`              | `DataPipe`            | Creates a **streaming** pipe: open, then one or more write, then close. Use for large or chunked data. Default MIME: `'application/octet-stream'`. |
| `send`       | `async def send(self, token: str, data: str \| bytes, objinfo: dict = None, mimetype: str = None) -> PIPELINE_RESULT`          | `PIPELINE_RESULT`     | Sends data in **one shot** (open pipe, write once, close). Use when you have the full payload in memory.                                           |
| `send_files` | `async def send_files(self, files: List[str \| Tuple[str, dict] \| Tuple[str, dict, str]], token: str) -> List[UPLOAD_RESULT]` | `List[UPLOAD_RESULT]` | Uploads files. Each item: path `str`, or `(path, objinfo)`, or `(path, objinfo, mimetype)`. Progress via `on_event` as `apaevt_status_upload`.     |

**When to use pipe vs send:** Use `send()` for a single string or bytes. Use `pipe()` when you read a file in chunks, or when data arrives incrementally.

**Example - send a string:**

```python
result = await client.send(token, "Hello, pipeline!", objinfo={"name": "greeting.txt"}, mimetype="text/plain")
```

**Example - stream with a pipe:**

```python
pipe = await client.pipe(token, mime_type="application/json")
await pipe.open()
await pipe.write(b'{"key": "value1"}')
await pipe.write(b'{"key": "value2"}')
result = await pipe.close()
```

### Events

| Method       | Signature                                                                | Returns | Description                                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `set_events` | `async def set_events(self, token: str, event_types: List[str]) -> None` | -       | Subscribes this task to the given event types. After this, those events are delivered to `on_event`. Call after `use()` when you need upload or processing progress. |

### Services, validation, and ping

| Method         | Signature                                                                           | Returns        | Description                                                                                                                                                   |
| -------------- | ----------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_services` | `async def get_services(self) -> dict`                                              | `dict`         | Returns all service definitions. Use to discover what the server supports.                                                                                    |
| `get_service`  | `async def get_service(self, service: str) -> Optional[dict]`                       | `dict \| None` | Returns one service by name; `None` if not found or on error.                                                                                                 |
| `validate`     | `async def validate(self, pipeline: PipelineConfig, *, source: str = None) -> dict` | `dict`         | Validates a pipeline configuration without starting it. Returns validation results (e.g. errors, warnings). Use to check pipeline correctness before `use()`. |
| `ping`         | `async def ping(self, token: str = None) -> None`                                   | -              | Liveness check; raises on failure.                                                                                                                            |

### Chat

| Method | Signature                                                                    | Returns           | Description                                                                                                                                                                                       |
| ------ | ---------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat` | `async def chat(self, *, token: str, question: Question) -> PIPELINE_RESULT` | `PIPELINE_RESULT` | Sends the `Question` to the AI for the given token and returns the pipeline result. The answer is in the result body; use the schema's answer helpers if you need to parse JSON from the AI text. |

**How it works:** The client opens a pipe with the question MIME type, writes the serialized `Question`, closes the pipe, and returns the server result. The pipeline must support the chat provider.

---

## DataPipe

Returned by `await client.pipe(...)`. One streaming upload: **open** -> **write** (one or more) -> **close**. You can also use it as an async context manager: entering calls `open()`, exiting calls `close()`.

| Property    | Type          | Description                             |
| ----------- | ------------- | --------------------------------------- |
| `is_opened` | `bool`        | Whether the pipe is open.               |
| `pipe_id`   | `int \| None` | Server-assigned pipe ID after `open()`. |

| Method       | Signature                                              | Returns           | Description                                        |
| ------------ | ------------------------------------------------------ | ----------------- | -------------------------------------------------- |
| `open`       | `async def open(self) -> DataPipe`                     | `self`            | Opens the pipe; required before `write()`.         |
| `write`      | `async def write(self, buffer: bytes) -> None`         | -                 | Writes a chunk. Pipe must be open.                 |
| `close`      | `async def close(self) -> PIPELINE_RESULT`             | `PIPELINE_RESULT` | Closes the pipe and returns the processing result. |
| `__aenter__` | `async def __aenter__(self)`                           | `self`            | Enters context; calls `open()`.                    |
| `__aexit__`  | `async def __aexit__(self, exc_type, exc_val, exc_tb)` | -                 | Exits context; calls `close()`.                    |

---

## Question

From `rocketride.schema`. Build a question for `client.chat(token=..., question=question)`. Add instructions, examples, context, history, and documents to steer the AI.

### Constructor

```python
Question(
    type: QuestionType = QuestionType.QUESTION,
    filter: DocFilter = None,
    expectJson: bool = False,
    role: str = '',
)
```

`QuestionType`: `QUESTION`, `SEMANTIC`, `KEYWORD`, `GET`, `PROMPT`. Default type is `QUESTION`. Default filter and `expectJson=False`, `role=''` if omitted.

### Methods

| Method           | Signature                                                           | Description                                                                |
| ---------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `addInstruction` | `addInstruction(self, title: str, instruction: str)`                | Adds an instruction (e.g. "Use bullet points").                            |
| `addExample`     | `addExample(self, given: str, result: dict \| list \| str)`         | Adds an example input/output; `result` can be dict/list (JSON-serialized). |
| `addContext`     | `addContext(self, context: str \| dict \| List[str] \| List[dict])` | Adds context.                                                              |
| `addHistory`     | `addHistory(self, item: QuestionHistory)`                           | Adds a history item for multi-turn chat.                                   |
| `addQuestion`    | `addQuestion(self, question: str)`                                  | Appends the question text.                                                 |
| `addDocuments`   | `addDocuments(self, documents: Doc \| List[Doc])`                   | Adds documents for the AI to reference.                                    |
| `getPrompt`      | `getPrompt(self, has_previous_json_failed: bool = False) -> str`    | Returns the full prompt (internal).                                        |

---

## Answer

From `rocketride.schema`. Used to parse chat response content. The client does not attach an `Answer` instance to the pipeline result; you read the response body and, if needed, use these helpers to extract JSON or code from AI text (which often includes markdown or code fences).

| Method        | Signature                              | Description                                                      |
| ------------- | -------------------------------------- | ---------------------------------------------------------------- |
| `getText`     | `getText(self) -> str`                 | Get the answer as plain text.                                    |
| `getJson`     | `getJson(self) -> Optional[dict]`      | Get the answer as parsed JSON; returns `None` if not valid JSON. |
| `isJson`      | `isJson(self) -> bool`                 | Whether the answer contains valid JSON.                          |
| `parseJson`   | `parseJson(self, value: str) -> Any`   | Parses JSON from AI text (strips markdown/code blocks).          |
| `parsePython` | `parsePython(self, value: str) -> Any` | Extracts Python code from a code block in the response.          |

---

## Types

- **PIPELINE_RESULT**: TypedDict with `name`, `path`, `objectId`, optional `result_types`, and dynamic fields.
- **UPLOAD_RESULT**: Per-file result with `action`, `filepath`, `error?`, `result?`, `upload_time?`, etc.
- **TASK_STATUS**: Task status with `completedCount`, `totalCount`, `completed`, `state`, `exitCode`, and many more fields.
- **DAPMessage**: Dict with `type`, `seq`, and optional `command`, `arguments`, `body`, `success`, `message`, `event`, `token`, etc.
- **PipelineConfig**: Pipeline definition with `name`, `description`, `version`, `components`, `source`, `project_id`.
- **QuestionHistory**: `{ 'role': str, 'content': str }`.
- **QuestionInstruction**: `{ 'subtitle': str, 'instructions': str }`.
- **QuestionExample**: `{ 'given': str, 'result': str }`.

---

## Engine Auto-Spawn

When no `uri` is provided and `ROCKETRIDE_URI` is not set, the SDK automatically manages a local engine instance. This enables **zero-config** usage — just provide an API key and the SDK handles everything else.

### How it works

1. **Check for a running instance** — The SDK checks `~/.rocketride/instances/state.db` for an already-running engine. If found, it reuses it.
2. **Find an installed binary** — If no running instance exists, the SDK looks for a compatible engine binary under `~/.rocketride/engines/{version}/`.
3. **Download if needed** — If no compatible binary is installed, the SDK downloads the latest compatible version from GitHub releases.
4. **Spawn and connect** — The engine is started on an available port (scanning from 5565), and the client connects to it automatically.
5. **Teardown on exit** — When the client disconnects (via `__aexit__` or `disconnect()`), the engine is stopped — but only if this client started it.

### Compatibility

The SDK declares which engine versions it supports in `pyproject.toml`:

```toml
[tool.rocketride]
engine-compatible = ">=3.0.0,<4.0.0"
```

Only engine versions matching this range will be used or downloaded.

### Supported platforms

| Platform | Architecture          | Asset format |
| -------- | --------------------- | ------------ |
| macOS    | ARM64 (Apple Silicon) | `.tar.gz`    |
| Linux    | x86_64                | `.tar.gz`    |
| Windows  | x64                   | `.zip`       |

### Directory structure

```
~/.rocketride/
├── engines/
│   └── 3.1.0/              # One directory per installed version
│       └── rocketride-server(.exe)
├── instances/
│   └── state.db             # SQLite — tracks running instances
└── logs/
    └── {instance-id}/       # Per-instance log files
        ├── stdout.log
        └── stderr.log
```

### Example — zero-config usage

```python
import asyncio
from rocketride import RocketRideClient

async def main():
    # No URI — the SDK auto-spawns a local engine
    async with RocketRideClient(auth="my-key") as client:
        result = await client.use(filepath="pipeline.pipe")
        token = result["token"]
        out = await client.send(token, "Hello!")
        print(out)
        await client.terminate(token)

asyncio.run(main())
```

---

## Exceptions

The exception hierarchy provides fine-grained error handling:

```text
DAPException                    # Base DAP protocol error (has dap_result dict)
└── RocketRideException         # Base for all RocketRide errors
    ├── ConnectionException     # Connection/network issues
    │   └── AuthenticationException  # Bad API key or credentials
    ├── PipeException           # Data pipe errors (open/write/close)
    ├── ExecutionException      # Pipeline start/run failures
    └── ValidationException     # Invalid input/config

UnsupportedPlatformError        # OS/architecture not supported for engine download
EngineError                     # Base for engine lifecycle errors
└── EngineNotFoundError         # Compatible engine binary could not be found or downloaded
```

DAP exceptions expose a `dap_result` dict with detailed server error context. Engine exceptions are plain `Exception` subclasses (not DAP-related).

`AuthenticationException` is thrown on DAP auth failure. In persist mode the client catches it, calls `on_connect_error`, and does not retry so the app can fix credentials and call `connect()` again.

**Example:**

```python
from rocketride import RocketRideClient, AuthenticationException, EngineError, UnsupportedPlatformError
from rocketride.core.exceptions import PipeException, ExecutionException

try:
    async with RocketRideClient(uri=uri, auth=auth) as client:
        result = await client.use(filepath="pipeline.json")
        await client.send(result["token"], data)
except AuthenticationException:
    print("Bad credentials")
except ExecutionException as e:
    print(f"Pipeline failed: {e}")
except PipeException as e:
    print(f"Data transfer error: {e}")
except EngineError as e:
    print(f"Engine error: {e}")  # Covers EngineNotFoundError too
except UnsupportedPlatformError:
    print("This platform is not supported for local engine execution")
```

---

## Examples (Full API Usage)

### 1. Minimal: connect, run pipeline from file, send one string, disconnect

```python
import asyncio
from rocketride import RocketRideClient

async def main():
    client = RocketRideClient(uri="https://cloud.rocketride.ai", auth="my-key")
    await client.connect()
    result = await client.use(filepath="pipeline.json")
    token = result["token"]
    out = await client.send(token, "Hello, pipeline!", objinfo={"name": "input.txt"}, mimetype="text/plain")
    print(out)
    await client.terminate(token)
    await client.disconnect()

asyncio.run(main())
```

### 2. One-off script with context manager (recommended)

```python
import asyncio
from rocketride import RocketRideClient

async def main():
    async with RocketRideClient(uri="wss://cloud.rocketride.ai", auth="my-key") as client:
        result = await client.use(pipeline={"pipeline": my_pipeline_config})
        token = result["token"]
        await client.send(token, '{"data": 1}')
        status = await client.get_task_status(token)
        print(status)
        await client.terminate(token)

asyncio.run(main())
```

### 3. Long-lived app: persist mode, callbacks, and status handling

```python
import asyncio
from rocketride import RocketRideClient

async def main():
    client = RocketRideClient(
        uri="https://cloud.rocketride.ai",
        auth="my-key",
        persist=True,
        max_retry_time=300000,
        on_connected=lambda info: print("Connected:", info),
        on_disconnected=lambda reason, has_error: print("Disconnected:", reason, has_error),
        on_connect_error=lambda msg: print("Connect error:", msg),
        on_event=lambda e: print(e.get("event"), e.get("body")),
    )
    await client.connect()
    # Later: use(), send_files(), etc. If connection drops, client retries; do not call disconnect() in on_disconnected.

asyncio.run(main())
```

### 4. Upload multiple files and poll until pipeline completes

```python
import asyncio
from pathlib import Path
from rocketride import RocketRideClient

async def main():
    client = RocketRideClient(uri="https://cloud.rocketride.ai", auth="my-key")
    await client.connect()
    result = await client.use(filepath="vectorize.json")
    token = result["token"]
    await client.set_events(token, ["apaevt_status_upload", "apaevt_status_processing"])

    files = ["doc1.md", "doc2.md", ("doc3.json", {"tag": "export"}, "application/json")]
    upload_results = await client.send_files(files, token)
    for r in upload_results:
        if r["action"] == "complete":
            print("OK", r["filepath"])
        else:
            print("Failed", r["filepath"], r.get("error"))

    while True:
        status = await client.get_task_status(token)
        print(f"Progress: {status.get('completedCount', 0)}/{status.get('totalCount', 0)}")
        if status.get("completed"):
            break
        await asyncio.sleep(2)
    await client.terminate(token)
    await client.disconnect()

asyncio.run(main())
```

### 5. Streaming large data with a pipe

```python
import asyncio
from rocketride import RocketRideClient

async def main():
    async with RocketRideClient(uri="https://cloud.rocketride.ai", auth="my-key") as client:
        result = await client.use(filepath="ingest.json")
        token = result["token"]
        pipe = await client.pipe(token, objinfo={"name": "large.csv"}, mime_type="text/csv")
        await pipe.open()
        with open("large.csv", "rb") as f:
            while True:
                chunk = f.read(64 * 1024)
                if not chunk:
                    break
                await pipe.write(chunk)
        result = await pipe.close()
        print(result)
        await client.terminate(token)

asyncio.run(main())
```

### 6. Chat: question with instructions and examples, parse JSON answer

```python
import asyncio
from rocketride import RocketRideClient
from rocketride.schema import Question, Answer

async def main():
    async with RocketRideClient(uri="https://cloud.rocketride.ai", auth="my-key") as client:
        result = await client.use(filepath="chat_pipeline.json")
        token = result["token"]
        question = Question(expectJson=True)
        question.addInstruction("Format", "Return a JSON object with keys: summary, keywords.")
        question.addExample("Summarize X", {"summary": "...", "keywords": ["a", "b"]})
        question.addQuestion("Summarize the main points and list keywords.")
        response = await client.chat(token=token, question=question)
        answer_text = response.get("data", {}).get("answer") or (response.get("answers") or [None])[0]
        structured = Answer().parseJson(answer_text) if answer_text else None
        print(structured)
        await client.terminate(token)

asyncio.run(main())
```

### 7. Discover services and send a custom DAP request

```python
import asyncio
from rocketride import RocketRideClient

async def main():
    client = RocketRideClient(uri="https://cloud.rocketride.ai", auth="my-key")
    await client.connect()
    services = await client.get_services()
    print("Available:", list(services.keys()))
    ocr = await client.get_service("ocr")
    if ocr:
        print("OCR schema:", ocr.get("schema"))
    req = client.build_request("rrext_ping", token=my_token)
    res = await client.request(req, timeout=5000)
    if client.did_fail(res):
        raise RuntimeError(res.get("message", "Ping failed"))
    await client.disconnect()

asyncio.run(main())
```

---

## CLI

The `rocketride` command is installed automatically with the package.

```bash
rocketride start pipeline.json              # Start a pipeline
rocketride upload *.pdf --token <token>      # Upload files to a running pipeline
rocketride status --token <token>            # Monitor task progress
rocketride stop --token <token>              # Terminate a running task
rocketride list                              # List all active tasks
rocketride events ALL --token <token>        # Stream task events
rocketride rrext_store get_all_projects      # List stored projects
```

All commands accept `--uri` and `--apikey` flags, or read from environment variables.

## Configuration

| Variable            | Description                                                            |
| ------------------- | ---------------------------------------------------------------------- |
| `ROCKETRIDE_URI`    | Server URI (e.g. `wss://cloud.rocketride.ai` or `ws://localhost:5565`) |
| `ROCKETRIDE_APIKEY` | API key for authentication                                             |

## Links

- [Documentation](https://docs.rocketride.org/)
- [GitHub](https://github.com/rocketride-org/rocketride-server)
- [Discord](https://discord.gg/9hr3tdZmEG)
- [Contributing](https://github.com/rocketride-org/rocketride-server/blob/develop/CONTRIBUTING.md)

## License

MIT - see [LICENSE](https://github.com/rocketride-org/rocketride-server/blob/develop/LICENSE).
