# RocketRide Client SDK (Python)

A Python SDK for executing RocketRide pipelines using the Debug Adapter Protocol (DAP). This client provides a simplified interface for connecting to RocketRide servers, executing pipelines, managing data transfer operations, and interacting with AI services.

## Features

- **DAP-based communication** for reliable pipeline execution
- **Object-oriented data pipe management** with context manager support
- **Parallel file upload capabilities** with progress events
- **AI chat functionality** with structured JSON responses
- **Event monitoring** for real-time pipeline status
- **Automatic reconnection** with configurable persistence
- **Cloud file store, run-log DVR, deploy/schedule, account, billing, and app publishing APIs**
- **Command-line interface** for pipeline and file-store management

Sections: 1. Install & Configure | 2. Connection & Auth | 3. Pipeline Execution | 4. Sending Data | 5. Chat & Question | 6. Cloud File Store | 7. Templates & Run Logs | 8. Events & Monitoring | 9. Deploy & Schedules | 10. Apps | 11. Account & Billing | 12. Dashboard & Tasks | 13. Database | 14. CLI | 15. Data Types & MIME | 16. Exceptions & Error Handling | 17. Best Practices

## 1. Install & Configure

### Installation

The PyPI `rocketride` can lag the server you work against — when you have
a development server, install its own matching client instead:

```bash
# Install the server-matched client (preferred with a running server).
# The 'latest' filename resolves server-side to the newest wheel.
pip install http://{host}:5565/client/python/rocketride-latest-py3-none-any.whl
```

```bash
# Install from PyPI
pip install rocketride

# Install with development dependencies
pip install rocketride[dev]

# Install with test dependencies
pip install rocketride[test]
```

Requirements: Python 3.10 or higher, a WebSocket connection to a RocketRide DAP server, and a valid API key.

### Uninstalling

```bash
pip uninstall rocketride
```

**Usage:**

```python
from rocketride import RocketRideClient
```

The package includes both the SDK library and a CLI tool.

### Environment Variables

You can configure the client using a `.env` file:

```env
# .env file
ROCKETRIDE_APIKEY=your-api-key-here
ROCKETRIDE_URI=https://api.rocketride.ai
```

The client will automatically parse the `.env` file (in the current working directory) if it exists and use the values as defaults. Values already present in the process environment win over the `.env` file. The priority order is:

1. **Constructor parameters** (highest priority)
2. **Process environment variables**
3. **`.env` file values**
4. **Default values** (lowest priority)

The client automatically reads configuration from the `.env` file, so you typically don't need to pass any parameters:

```python
# Reads ROCKETRIDE_URI and ROCKETRIDE_APIKEY from .env
client = RocketRideClient()
```

You can override `.env` settings by passing parameters directly to the constructor if needed:

```python
# Override for testing or special cases
client = RocketRideClient(uri='https://api.rocketride.ai', auth='your-api-key')
```

### Environment Variable Substitution in Pipelines

Pipeline configurations may contain `${ROCKETRIDE_*}` template variables. Any string containing `${ROCKETRIDE_*}` is replaced with the corresponding value when the pipeline starts: the client sends the `ROCKETRIDE_*` values from your `.env` (plus any `env=` override passed to `use()`) alongside the pipeline, and the server resolves the placeholders at execution time.

**Example `.env` file:**

```env
ROCKETRIDE_APIKEY=your-api-key
ROCKETRIDE_URI=https://api.rocketride.ai
ROCKETRIDE_QDRANT_HOST=localhost
ROCKETRIDE_COLLECTION_NAME=my_documents
ROCKETRIDE_OPENAI_KEY=sk-...
```

**Example pipeline fragment (vector store + LLM configured from the environment):**

```json
{
	"id": "qdrant_1",
	"provider": "qdrant",
	"config": {
		"profile": "local",
		"local": {
			"host": "${ROCKETRIDE_QDRANT_HOST}",
			"port": 6333,
			"collection": "${ROCKETRIDE_COLLECTION_NAME}"
		},
		"parameters": {}
	},
	"input": [{ "lane": "documents", "from": "embedding_transformer_1" }]
}
```

**Using the pipeline:**

```python
# Variables are resolved when the pipeline starts
result = await client.use(filepath='pipeline.pipe')
```

**Key features:**

- Only variables starting with `ROCKETRIDE_` are substituted (for security)
- Unknown variables are left unchanged (e.g., `${ROCKETRIDE_UNKNOWN}` stays as-is)
- Works with nested objects and arrays
- Preserves the original pipeline configuration object
- Supports quoted and unquoted values in `.env` file
- Ignores comments and empty lines in `.env` file
- Per-call overrides: `use(..., env={'ROCKETRIDE_COLLECTION_NAME': 'other'})` merges over the `.env` values
- The stored pipeline keeps its placeholders: `get_task_pipeline()` returns the UNRESOLVED pipeline, so secrets never come back over the wire

**Security Note:** The `.env` file is parsed separately and does not modify your system environment variables.

## 2. Connection & Auth

### Credentials and the two `.env` pairs

The platform maintains the workspace `.env`; you never construct an auth
flow. Two variable pairs may exist, one per editor-managed connection —
build each client from the pair that matches the verb family:

```python
import os

# Development server — run, validate, iterate (use/send/chat/monitors).
# The constructor reads ROCKETRIDE_URI/ROCKETRIDE_APIKEY itself.
dev = RocketRideClient()

# Deployment target — deploy.*, schedules, publish/submit, build logs.
# Its ABSENCE means no deploy target is configured: stop and ask the user;
# never run lifecycle verbs against the development pair as a guess.
deploy_uri = os.environ.get('ROCKETRIDE_DEPLOY_URI')
if not deploy_uri:
    raise RuntimeError('No deployment target configured - pick one in the editor.')
deploy = RocketRideClient(deploy_uri, os.environ.get('ROCKETRIDE_DEPLOY_APIKEY', ''))
```

A cloud connection's credential is the same persistent key the editor
connects with — usage is identical to a self-hosted key. On
`AuthenticationException`: do not retry or invent a flow; the user
reconnects (or signs in) in the editor, which rewrites `.env`. For headless
automation (CI, external schedulers, daemons), mint a key in Account → Keys
and store it in that system's secret store — never copy `.env` values into
anything long-lived.

### Constructor

```python
RocketRideClient(uri: str = '', auth: str = '', **kwargs)
```

**Parameters:**

- `uri` (str): Server URI (default: `ROCKETRIDE_URI` from env/`.env`, else `https://api.rocketride.ai`). Accepts bare `host:port`, `http(s)://`, or `ws(s)://` forms; non-cloud hosts without a port default to port 5565.
- `auth` (str): API key or access token (default: `ROCKETRIDE_APIKEY` from env/`.env`)
- `on_event` (callable, optional): Async handler for server events (see [Events & Monitoring](#8-events--monitoring))
- `on_connected` / `on_disconnected` (callable, optional): Async callbacks `on_connected(info: str)` / `on_disconnected(reason: str, has_error: bool)`
- `on_connect_error` (callable, optional): Async callback `on_connect_error(message: str)` on each failed connection attempt in persist mode
- `persist` (bool, optional): Enable automatic reconnection (default: False)
- `max_retry_time` (float, optional): **Deprecated** — accepted but ignored. Reconnection uses linear backoff and never gives up (see below).
- `env` (dict, optional): Environment dict to use instead of process env + `.env`
- `module` (str, optional): Module name for client identification in logs
- `request_timeout` (float, optional): Default timeout in ms for individual requests (default: no timeout)
- `client_name` / `client_version` (str, optional): Display name/version reported to the server at auth time
- `on_protocol_message` / `on_debug_message` (callable, optional): Sync callbacks receiving raw protocol / debug strings for logging
- `on_trace` (callable, optional): Sync callback `on_trace(trace_type: int, message: dict)` observing every typed request/response (`TRACE_REQUEST` = 0, `TRACE_SUCCESS` = 1, `TRACE_ERROR` = 2)

### `async connect(credential: Optional[str] = None, *, timeout: Optional[float] = None) -> ConnectResult`

Establish a connection to the RocketRide server. Optionally pass a `credential` to authenticate; `timeout` bounds the attempt. Internally this wraps the attach + login lifecycle and returns a `ConnectResult` carrying the resolved auth/identity info (most callers can ignore the return value).

**The identity payload is the discovery call** — org, teams, and developer id all arrive on connect; nothing needs a follow-up request. The fields that drive deploy/publish decisions (attribute access, same names on the wire):

- `userId` / `displayName` / `email` — who authenticated
- `devTeam` — id of the team used by default when an operation names no team; dev-mode runs bill to it
- `organization` — `None` without an org membership, else: `id`, `name`, `permissions` (ORG-level grants, e.g. `'org.admin'`), `developerId` (the org's publisher slug — first segment of every app id; `None` until the org registers as a developer, always absent on OSS), and `teams` — the user's team MEMBERSHIPS as `{id, name, permissions}` with team-scoped permissions (`'team.admin'`, `'task.control'`, `'task.data'`, `'task.monitor'`, `'task.store'`). There is **no top-level teams list** — memberships live here, under the org.
- `capabilities` — `['oss']` or `['saas']`; `apps` — the user's desktop app entries

### `async disconnect() -> None`

Close the connection to the RocketRide server and stop automatic reconnection. Internally wraps `logout()` + `detach()`.

### Auth / Connection Lifecycle

`connect()`/`disconnect()` are convenience wrappers over two independent concerns: the WebSocket transport (attach/detach) and the DAP auth handshake (login/logout). Use the primitives below when you need to manage them separately: e.g. attach once, then log in and out under different credentials without reopening the socket.

#### `async attach(uri: Optional[str] = None, *, timeout: Optional[float] = None) -> None`

Open the WebSocket transport without authenticating. If `uri` is provided and differs from the current URI, detaches first; attaching to the same URI is a no-op. `timeout` (seconds) bounds the connect.

#### `async detach() -> None`

Detach from the server: closes the WebSocket and cancels any pending reconnection.

#### `async login(credential: Optional[str] = None, *, uri: Optional[str] = None, timeout: Optional[float] = None) -> ConnectResult`

Authenticate over an attached transport (auto-attaches if not already attached). If `credential` differs from the current one, logs out first (best-effort) before re-authenticating; if already authenticated with the same credential, this is a no-op. Passing `uri` detaches and re-attaches to the new URI first. Returns a `ConnectResult` with the resolved auth/identity info.

#### `async logout() -> None`

Deauthenticate: sends a `deauth` request to the server and clears client-side auth state. The transport stays attached.

#### `def is_attached() -> bool`

`True` when the WebSocket transport is connected, regardless of auth state.

#### `def is_authenticated() -> bool`

`True` when the auth handshake has succeeded on the current connection.

#### `def is_connected() -> bool`

`True` when the client is connected (transport is up). Check before `use()`/`send()` if needed.

#### `def get_account_info() -> Optional[ConnectResult]`

Return the `ConnectResult` from the last successful `login()`, or `None` if not authenticated. `ConnectResult` includes (all optional): `userToken` (durable `rr_` token the SDK reuses for reconnects), `userId`, `displayName`, `email`, `devTeam`, `organization` (with `id`, `name`, `permissions`, `teams`), `apps`, and `serverVersion`.

#### `def get_apikey() -> Optional[str]`

Return the credential currently in use (after login this may be the durable `rr_` user token the server issued). For debugging only.

#### `def get_connection_info() -> dict`

Return `{'connected': bool, 'transport': 'WebSocket', 'uri': str}` for the current connection.

#### `def set_env(env: Dict[str, str]) -> None`

Replace the client's environment dictionary used for `${ROCKETRIDE_*}` pipeline substitution. (Note: this is distinct from `client.account.set_env()`, which stores server-side environment layers — see [Account & Billing](#11-account--billing).)

**Example: attach once, log in, run, log out:**

```python
client = RocketRideClient()  # config from .env

await client.attach()
await client.login()  # uses ROCKETRIDE_APIKEY

if client.is_authenticated():
    result = await client.use(filepath='pipeline.pipe')
    await client.send(result['token'], 'hello')

await client.logout()
await client.detach()
```

### Context Manager

```python
async with RocketRideClient() as client:  # connects on entry, disconnects on exit
    result = await client.use(filepath='pipeline.pipe')
    response = await client.send(result['token'], 'Process this text')
```

### Persistent Connection with Auto-Reconnect

```python
async def on_connect_error(error: str) -> None:
    print(f'Connection attempt failed: {error}')


client = RocketRideClient(persist=True, on_connect_error=on_connect_error)
await client.connect()
# ...
await client.disconnect()  # stops reconnection
```

With `persist=True`, a dropped connection reconnects automatically using LINEAR backoff: 0.25s after the first failure, +0.25s per subsequent failure, capped at 15s between attempts — and never gives up on transient failures. If the server REJECTS the credential during a reconnect, the client stops retrying auth (it stays attached and reports via `on_connect_error`). Monitor subscriptions (`add_monitor`) are replayed automatically after a successful reconnect.

### Pre-Auth Server Probe

#### `staticmethod async RocketRideClient.get_server_info(uri: str, timeout: float = None) -> ServerInfoResult`

Probe a server for its capabilities without authenticating. Returns a dict with `version`, `capabilities` (e.g. `['oss']` or `['saas']`), `platform`, `apps` (public apps), optionally `stripePublishableKey`, and `endpoints` (`{'api': ..., 'ui': ...}` always resolved to absolute URLs).

```python
info = await RocketRideClient.get_server_info('localhost:5565')
```

## 3. Pipeline Execution

### `async use(**kwargs) -> Dict[str, Any]`

Start a RocketRide pipeline for processing data.

> All `use()` parameters are **keyword-only**: pass them by name (e.g. `use(pipeline=...)`), not positionally.

**Parameters:**

- `pipeline` (dict, optional): Flat pipeline configuration dict (`components`, `source`, `project_id` at top level). A dict wrapped as `{'pipeline': {...}}` is automatically unwrapped.
- `filepath` (str, optional): Path to a `.pipe` or JSON/JSON5 file containing pipeline configuration. Files with a top-level `pipeline` key are automatically unwrapped.
- `token` (str, optional): Custom token for the pipeline (auto-generated if not provided)
- `source` (str, optional): Override the pipeline source (which source component this task runs from)
- `threads` (int, optional): Number of threads for execution (default: None, the server decides)
- `use_existing` (bool, optional): Reuse an existing pipeline instance with the same identity
- `args` (List[str], optional): Extra command-line flags appended to the run's engine process (see the note below); not a data channel
- `ttl` (int, optional): Time-to-live in seconds for idle pipelines (server default if not provided; use 0 for no timeout)
- `pipelineTraceLevel` (str, optional): Trace level: `'none'`, `'metadata'`, `'summary'`, or `'full'`. When set, captures every lane write and invoke call in the response under `_trace`.
- `name` (str, optional): Display name for the task. If omitted and `filepath` is given, the file's base name (minus `.pipe`/`.pipe.json`) is used.
- `env` (Dict[str, str], optional): Extra `ROCKETRIDE_*` values for placeholder substitution, merged over the client's `.env` values for this run.

**Returns:** Dictionary containing the task `token` and other startup metadata.

**Raises:** `ValueError` (no pipeline/filepath given), `FileNotFoundError` (bad filepath), `RuntimeError` (server refused to start or returned no token).

```python
# A document pipeline: webhook source -> parse -> text response
pipeline = {
    'components': [
        {'id': 'webhook_1', 'provider': 'webhook', 'config': {'mode': 'Source', 'type': 'webhook'}},
        {'id': 'parse_1', 'provider': 'parse', 'config': {}, 'input': [{'lane': 'tags', 'from': 'webhook_1'}]},
        {
            'id': 'response_text_1',
            'provider': 'response_text',
            'config': {'laneName': 'text'},
            'input': [{'lane': 'text', 'from': 'parse_1'}],
        },
    ],
    'source': 'webhook_1',
    'project_id': '{guid}',  # Replace with your unique GUID
}

result = await client.use(pipeline=pipeline)
print(f'Pipeline started with token: {result["token"]}')
```

#### Runtime engine arguments (`args`)

`args` rides the start request as a plain list of strings and is appended
to the command line of the engine process that runs the task — each entry
becomes one argument (an entry containing spaces is split shell-style).
The arguments configure the run's ENGINE, not your components:

```python
# Verbose component tracing in the run's output feed:
result = await client.use(pipeline=pipeline, args=['--trace=debugOut'])
```

- Use them for engine runtime flags such as `'--trace=debugOut'`.
- They are **not** a data channel into the pipeline: components never
  receive them as input. Send data with `send()`/`chat()`, configure
  components in the pipeline config itself, and pass substitution values
  through `env` (`${ROCKETRIDE_*}` placeholders).
- They apply at task start only — attaching to an already-running task
  (`use_existing=True`) leaves the running process's arguments unchanged.

### `async terminate(token: str) -> None`

Terminate a running pipeline. Termination is graceful (in-flight items finish) and final — start a new pipeline for further processing.

### `async restart(*, project_id: str, source: str, pipeline: PipelineConfig, token: Optional[str] = None, team_id: str = '') -> None`

Restart a running pipeline with a new configuration. Looks up the existing task by project/source, terminates it, and starts a new execution in one server round-trip. All arguments are keyword-only; `token` is resolved server-side if omitted; pass `team_id` to address the team's DEPLOYED run (omit for your own dev run). Raises `RuntimeError` on failure.

```python
await client.restart(project_id='my-project', source='webhook_1', pipeline=updated_pipeline)
```

### `async get_task_status(token: str) -> TASK_STATUS`

Get the current status of a running pipeline. Returns a dict with `state` (`'starting'`, `'running'`, `'waiting'`, `'completed'`, `'failed'`, `'terminated'`), plus progress, error, timing, and performance fields when available.

### `async get_task_token(project_id: str, source: str, *, team_id: str = '') -> str | None`

Resolve a running task's token from its project ID and source component. The token is required for operations like `terminate()` and `restart()`. Returns `None` if no task is currently running for the given project/source.

The scope IS the kind: pass `team_id` to resolve the team's DEPLOYED run; omit it to resolve your own dev run.

### `async get_task_pipeline(token: str) -> dict | None`

Retrieve the unresolved pipeline for a running task. The pipeline is returned exactly as stored on the task — `${ROCKETRIDE_*}` placeholders are NOT substituted, so no secrets are included in the response. Returns `None` if the task is not found.

### `async validate(pipeline: PipelineConfig, *, source: Optional[str] = None) -> VALIDATION_RESULT`

Validate a pipeline configuration server-side (structure, required fields, component references) without starting it. Source resolution follows the same logic as `use()`: the explicit `source` parameter, else the `source` field in the config, else the single component whose `config.mode` is `'Source'`. Returns a validation result containing errors and warnings; raises `RuntimeError` on a validation failure.

```python
result = await client.validate(pipeline, source='webhook_1')
```

### `async get_services() -> SERVICES_RESPONSE`

Retrieve all service (component/connector) summaries from the server. Returns a dict with `services` (logical type -> summary), `icons` (icon id -> raw SVG, deduplicated; each summary's `icon` field indexes into it), and `version`.

### `async get_service(service: str) -> SERVICE_DEFINITION`

Retrieve one service's FULL definition by name (e.g. `'ocr'`, `'parse'`, `'chat'`) including the configuration schema sections. Raises `ValueError` for an empty name and `RuntimeError` for an unknown service.

```python
services = await client.get_services()
ocr = await client.get_service('ocr')
```

### `async tool(*, token: str, tool: str, node_id: str = '', input: dict = None, timeout: float = None) -> Any`

Invoke a `@tool_function` exposed by a pipeline node, bypassing the chat/question flow. When `node_id` is empty the call broadcasts to all tool-lane nodes and the first node owning the tool handles it. Returns the tool's return value (typically a dict); raises `RuntimeError` when no node handles the tool. (The [Database](#13-database) namespace is built on this.)

```python
rows = await client.tool(token=token, tool='search', input={'query': 'invoices'})
```

### `async ping(token: str = None) -> None`

Test connectivity to the RocketRide server. Raises `RuntimeError` if the server does not respond. Time the call to measure round-trip latency.

## 4. Sending Data

### `async send(token: str, data: Union[str, bytes], objinfo: Dict[str, Any] = None, mimetype: str = None, on_sse=None) -> Dict[str, Any]`

Send data directly to a pipeline. `data` is str or bytes; `objinfo` is optional metadata (e.g. `{'name': 'data.txt'}`); `mimetype` overrides auto-detection; `on_sse` streams SSE events for this call (see [Streaming Callback](#streaming-callback-on_sse)). Returns the processing result dict. Raises `ValueError` (data is not str/bytes) or `PipeException` (the underlying pipe open/write/close failed).

**Important:** Use this method with pipelines that have `webhook` or `dropper` as the source component. For chat/Q&A systems, use `chat()` instead with a `chat` source component.

### `async send_files(files: List, token: str) -> List[Dict[str, Any]]`

Upload multiple files in parallel (all files concurrently; the server handles queuing). Each entry can be a file path `'report.pdf'`, a tuple `(filepath, objinfo)`, or `(filepath, objinfo, mimetype)`. MIME types are auto-detected from the extension when not given; `objinfo` defaults to `{'name': <basename>}`.

Returns a list of upload result dictionaries (one per file, in input order) — see [Upload Result](#upload-result). Raises `ValueError` (empty list, missing file, bad entry shape, missing token) or `RuntimeError` (no API key configured). Per-file failures do NOT raise — they come back as result entries with `action: 'error'`.

```python
files = ['doc1.pdf', 'data.csv', ('report.docx', {'department': 'finance'})]
results = await client.send_files(files, token)

for result in results:
    if result['action'] == 'complete':
        print(f'OK {result["filepath"]}: {result["upload_time"]:.2f}s')
    else:
        print(f'FAILED {result["filepath"]}: {result["error"]}')
```

**Note:** Upload progress events are sent through the event system as `apaevt_status_upload` events (`open`, `write`, `close`, `complete`, `error` actions).

### `async pipe(token: str, objinfo: Dict[str, Any] = None, mime_type: str = None, provider: str = None, on_sse=None) -> DataPipe`

Create a streaming data pipe for sending large datasets in chunks. `mime_type` defaults to `application/octet-stream`; `on_sse` scopes an SSE callback to this pipe. Returns a `DataPipe` instance (not yet opened).

### DataPipe

Created via `client.pipe()`. Properties: `is_opened` (bool), `pipe_id` (server-assigned id after open).

- `async open() -> DataPipe` — open the pipe for data transmission; must be called before any `write()`. Raises `RuntimeError` if already opened, `PipeException` if the server rejects the open (common causes: the pipeline is not running, the source is not `chat`/`webhook`/`dropper`, or the MIME type does not match a source lane).
- `async write(buffer: bytes) -> None` — write a chunk. `buffer` must be `bytes` (`ValueError` otherwise); raises `RuntimeError` if the pipe is not open, `PipeException` on server-side write failure.
- `async close() -> Optional[Dict[str, Any]]` — close the pipe and get the processing results. Raises `PipeException` on a server-side failure while finalizing. Closing a never-opened or already-closed pipe returns `{}`.
- `async tool(*, tool: str, node_id: str = '', input: dict = None) -> Any` — invoke a `@tool_function` on a pipeline node using this pipe's already-borrowed pipeline instance (cheaper than `client.tool()` when you hold an open pipe). Raises `RuntimeError` if the pipe is not open.

**Using the context manager (recommended)** — `async with` opens the pipe on entry and closes it on exit; call `close()` explicitly when you need the results:

```python
import json

async with await client.pipe(token, mime_type='application/json') as pipe:
    for item in data_items:
        await pipe.write(json.dumps(item).encode())
    results = await pipe.close()  # close explicitly to capture the results
```

### Streaming Callback (`on_sse`)

`send()`, `pipe()`, and `chat()` each accept an optional `on_sse` keyword argument: an async callback invoked for every Server-Sent Event emitted by the pipeline node for that specific call. Use it to stream incremental output (e.g. token-by-token LLM responses) before the final result resolves.

**Callback signature:** `async def on_sse(type: str, data: dict) -> None` — `type` is the SSE event type, `data` the event payload.

```python
async def handle_sse(type: str, data: dict) -> None:
    print(f'[{type}] {data}')


response = await client.chat(token=token, question=question, on_sse=handle_sse)
```

## 5. Chat & Question

### `async chat(*, token: str, question: Question, on_sse=None) -> Dict[str, Any]`

Ask a question to RocketRide's AI and get an intelligent response. All arguments are keyword-only: `token` (the chat pipeline's task token), `question` (a Question object), and optional `on_sse` for streamed SSE events (see [Streaming Callback](#streaming-callback-on_sse)).

**Returns:** Response dictionary containing answers (typically `response['answers']`, a list; for `expectJson=True` questions each answer is already parsed into a dict/list).

**Raises:** `RuntimeError` if the question is empty or the chat operation fails; `PipeException` on transfer failure.

**Important:** Use this method with pipelines that have `chat` as the source component. This is for ALL conversational interfaces (web, console, API, mobile), not just web-based UIs. For document processing/uploads, use `send()` or `send_files()` with a `webhook` source instead.

```python
from rocketride.schema import Question

question = Question()
question.addQuestion('What are the key findings?')

response = await client.chat(token='chat-token', question=question)
```

### Question

Question builder for AI chat operations. `Question` is a Pydantic model — you can also set any field via the constructor.

#### Constructor

```python
Question(expectJson: bool = False)

# All fields are constructor-settable, e.g.:
Question(expectJson=True, role='You are a financial analyst', filter=DocFilter(limit=10))
```

Fields: `type` (QuestionType), `filter` (DocFilter), `expectJson` (bool), `role` (str), `instructions`, `history`, `examples`, `context`, `goals`, `documents`, `questions`.

> **Builder methods return `None`, NOT the Question.** They mutate the object in place and CANNOT be chained. Write `q.addQuestion(...)` then `q.addContext(...)` as separate statements — `Question().addQuestion('x')` evaluates to `None` and will break your code.

```python
# WRONG - addQuestion returns None, so chat() receives None:
# question = Question().addQuestion('What changed?')

# CORRECT - build stepwise:
question = Question()
question.addQuestion('What changed?')
question.addContext('Focus on the 2024 filings')
```

- `addQuestion(text: str) -> None` — add the main question text. Most Question objects have exactly one.
- `addInstruction(title: str, instruction: str) -> None` — add a titled instruction to guide the AI's response (format, focus, style).
- `addExample(given: str, result: Union[dict, list, str]) -> None` — provide an example of the desired response format. Dict/list results are JSON-encoded automatically.
- `addContext(context: Union[str, dict, List[str], List[dict]]) -> None` — add contextual information (strings, dicts, or lists of either).
- `addHistory(item: QuestionHistory) -> None` — add one conversation history message for multi-turn context. `QuestionHistory` fields: `role` (`'user'`, `'system'`, or `'assistant'`) and `content` (str).
- `addGoal(goal: str) -> None` — add a high-level objective, rendered as a dedicated Goal section in the prompt, separate from instructions.
- `addDocuments(documents: Union[Doc, List[Doc]]) -> None` — add one or more documents for the AI to reference (instead of searching all content). Accepts `Doc` objects or plain strings (strings are wrapped into `Doc` automatically).

```python
from rocketride.schema import QuestionHistory

question.addHistory(QuestionHistory(role='user', content='Previous question'))
question.addHistory(QuestionHistory(role='assistant', content='Previous answer'))
```

### Structured JSON Responses (`expectJson`)

With `expectJson=True` the SDK injects strict JSON-only response instructions into the prompt and each answer comes back already parsed as a dict/list:

```python
question = Question(expectJson=True)
question.addQuestion('Extract email addresses and phone numbers')
question.addExample('Find contacts', {'emails': ['john@company.com'], 'phones': ['555-1234']})
question.addContext(source_document)

response = await client.chat(token=token, question=question)
structured = response['answers'][0] if response.get('answers') else {}
```

### Document Filters (`DocFilter`)

`DocFilter` controls how documents are searched, grouped, and returned. Attach one via `Question(filter=DocFilter(...))`. Fields (all optional):

- **Pagination**: `offset` (int, 0), `limit` (int, 25).
- **Grouping**: `fullDocuments` (bool, False — combine all chunks of the same document into one result), `fullTables` (bool, False — same for tables).
- **Selection**: `minChunkId`/`maxChunkId` (int — chunk-id range), `nodeId` (str — a specific node), `parent` (str — parent file/folder path), `name` (str — name pattern), `objectIds` (List[str]), `chunkIds` (List[int]), `tableIds` (List[int]), `isTable` (bool — only/exclude tables; None = both), `isDeleted` (bool — include/exclude deleted; None = both), `permissions` (List[int] — respect these permission levels).
- **AI processing**: `useQuickRank` (bool, False — AI rerank for relevance), `useGroupRank` (bool, False — AI rank of document groups), `followUpQuestions` (int, 5 — follow-up questions to generate), `context` (bool, False — include extra context with results).

```python
from rocketride.schema import DocFilter, Question

question = Question(filter=DocFilter(isTable=True, limit=20, useQuickRank=True))
question.addQuestion('What are the sales figures?')
```

### Chat System Pattern

When building a chat system, start the pipeline once as a global part of your application. `client.use()` is time-consuming, so starting it, processing one question, and stopping it is not a good pattern.

```python
# Startup (once): connect and start the chat pipeline
result = await client.use(filepath='chat_pipeline.pipe')
token = result['token']


async def my_chat(my_question: str) -> str:
    question = Question()
    question.addQuestion(my_question)
    response = await client.chat(token=token, question=question)
    answers = response.get('answers') or []
    return answers[0] if answers else 'No answer received'
```

### Importing Schema Types

Schema models can be imported directly from the top-level `rocketride` package, not only from `rocketride.schema` — `from rocketride import Question, Doc, DocGroup, DocFilter` works and is convenient when you also import `RocketRideClient`.

## 6. Cloud File Store

Every account has a private server-side file store. The `fs_*` methods give handle-based streaming I/O plus convenience wrappers. All paths are RELATIVE paths within the account store; `..` traversal and invalid characters are rejected client-side with `ValueError`, and destructive operations additionally reject empty or absolute-like paths. All methods raise `RuntimeError` when the server reports a failure.

### Handle-Based I/O

- `async fs_open(path: str, mode: str = 'r') -> Dict[str, Any]` — open a file handle. `mode` is `'r'` (read) or `'w'` (write). Returns `{'handle': str}`; read mode also includes `'size'` (int).
- `async fs_read(handle: str, offset: int = 0, length: int = 4_194_304) -> bytes` — read up to `length` bytes (default 4 MB) from a read handle at `offset`. Empty bytes means EOF.
- `async fs_write(handle: str, data: bytes) -> int` — write raw bytes to a write handle. Returns the number of bytes written.
- `async fs_close(handle: str, mode: str = 'r') -> None` — close a handle. `mode` must match the mode used in `fs_open`.

### File & Directory Operations

- `async fs_delete(path: str) -> None` — delete a file.
- `async fs_list_dir(path: str = '') -> Dict[str, Any]` — list immediate children of a directory (default: account root). Returns `{'entries': [{'name', 'type', 'size'?, 'modified'?}], 'count'}`; file entries include `size` (bytes) and `modified` (epoch timestamp).
- `async fs_mkdir(path: str) -> None` — create a directory.
- `async fs_rmdir(path: str, *, recursive: bool = False) -> None` — remove a directory. `recursive=True` deletes contents; otherwise a non-empty directory raises `RuntimeError`.
- `async fs_stat(path: str) -> Dict[str, Any]` — metadata: `{'exists', 'type' ('file'|'dir'), 'size' (files), 'modified' (files)}`.
- `async fs_rename(old_path: str, new_path: str) -> None` — rename a file or directory (on object stores implemented as copy + delete; directories move recursively).
- `async fs_get_url(path: str, expires_in: int = 3600, download_name: str = None) -> str` — direct HTTP(S) URL for a file (presigned/SAS on cloud backends, signed server URL locally), usable in browsers for streaming or embedding. Pass `download_name` to force a browser download with that filename; leave `None` for inline serving.
- `async fs_read_many(paths: List[str]) -> List[Dict[str, Any]]` — batch-read many small files in one round trip (max 256 paths per call; 32 MiB total server-side). Missing/unreadable files are per-entry results, never a call failure. Returns one dict per requested path IN ORDER: `{'path': str, 'ok': bool, 'data': bytes | None, 'error': str | None}`.

### Convenience Wrappers

These handle open/read-loop/close internally:

- `async fs_read_string(path: str, encoding: str = 'utf-8') -> str` — read a whole file as a decoded string.
- `async fs_write_string(path: str, text: str, encoding: str = 'utf-8') -> None` — write a string to a file.
- `async fs_read_json(path: str) -> Any` — read and parse a JSON file.
- `async fs_write_json(path: str, obj: Any) -> None` — write an object as pretty-printed JSON.

```python
await client.fs_write_json('configs/settings.json', {'threshold': 0.8})
url = await client.fs_get_url('configs/settings.json', expires_in=600)
```

## 7. Templates & Run Logs

### Pipeline Templates

Domain wrappers that store pipeline JSON under well-known store paths (`.templates/`):

- `async save_template(template_id: str, pipeline: Dict[str, Any]) -> None` — save a template pipeline. `template_id` must be a single path segment; `pipeline` a non-empty dict.
- `async get_template(template_id: str) -> Dict[str, Any]` — get a template by ID.
- `async delete_template(template_id: str) -> None` — delete a template by ID.
- `async get_all_templates() -> Dict[str, Any]` — list all templates with summaries: `{'templates': [{'id', 'name', 'description', 'sources', 'totalComponents'}], 'count'}`.

### Saved Log Files

Simple JSON log documents stored under `.logs/<project_id>/`:

- `async save_log(project_id: str, source: str, contents: Dict[str, Any]) -> str` — save a log file. `contents` must contain `body.startTime` (used in the filename `<source>-<startTime>.log`). Returns the filename.
- `async get_log(project_id: str, name: str) -> Dict[str, Any]` — get a log file by name (as returned by `list_logs` or `save_log`).
- `async delete_log(project_id: str, name: str) -> None` — delete a log file by name.
- `async list_logs(project_id: str, source: Optional[str] = None) -> list[dict]` — list log files for a project, optionally filtered by source. Returns `[{'name', 'modified'}]` sorted by modified time.

### Run-Log Continuum (`client.log`)

Every dev or deploy run of a pipeline source writes into a durable per-source event stream (the "continuum"). The `client.log` namespace reads it. On every method: pass `team_id` to address that TEAM's deploy continuum (deploy runs execute as the team; any teammate with monitor rights can watch/replay); omit it for your OWN stream, where `run_kind` selects the continuum: `''`/`'dev'` = your dev stream, `'deploy'` = your personal (@me) deploy stream. `run_kind` is ignored when `team_id` is set.

- `async log.chapters(project_id: str, source: str, *, team_id: str = '', run_kind: str = '') -> LogChaptersResult` — a stream's chapters (one per run: begin/end times, starting seq, outcome), segment activity spans, the retained window, and the retention horizon: everything a timeline needs in one small read.
- `async log.read(project_id: str, source: str, *, team_id: str = '', run_kind: str = '', from_seq=None, to_seq=None, from_time=None, to_time=None, to_segment=None, cursor=None, max_events=None, max_bytes=None, types=None) -> LogReadResult` — read a seq/time range of events, paged. Range forms: seq bounds, time bounds (omit the upper bound for "to now"), or from-time to to-segment. When the response carries `nextSeq`, pass it back as `cursor` to continue; a `truncatedAtSeq` flag means the request reached below the retention horizon. `types` is a server-side event-type filter (e.g. `['output']`).
- `async log.segment(project_id: str, source: str, segment: int, *, team_id: str = '', run_kind: str = '', offset: int = 0, max_bytes=None) -> LogSegmentResult` — fetch one segment's raw JSONL bytes, chunked by byte offset (whole-line-aligned chunks — each parses standalone). Repeat with the returned `nextOffset` until `final`. The segment table comes from `chapters()`. This is the bulk replay path.
- `async log.delete(project_id: str, source: str, *, team_id: str = '', run_kind: str = '', before_time=None, all: bool = False) -> LogDeleteResult` — delete log data (destructive). `before_time` (epoch seconds) drops segments wholly older than the cutoff; `all=True` removes the entire stream. Returns the number of segments deleted. Team streams require control rights on the team.
- `log.open_event_stream(project_id: str, source: str, *, team_id: str = '', run_kind: str = '') -> LogEventStream` — open a DVR session over one source continuum (synchronous constructor — no await). The session is unpositioned; call `seek()` first. Dispose with `close_event_stream()`.

```python
page = await client.log.read('proj-1', 'chat_1', from_seq=0, max_events=500)
for ev in page['events']:
    print(ev['event'], ev['body'].get('logSeq'))
```

### LogEventStream (the DVR)

The DVR session hides storage (segments, keyframes, deltas) behind positions, chapters, traces, and console. The protocol is **seed-then-stream**: `seek(pos)` positions the session; the `get_*()` calls seed panels from state-at-position; `play(speed, cb)` then delivers reconstructed events strictly AFTER the seed watermark, in order, paced by speed. Playing from a past position AUTO-PINS to live on catching the wall clock — replay flows into live with no seam.

```python
session = client.log.open_event_stream('proj-1', 'chat_1')
await session.seek('live')
status = await session.get_status()
await session.play(None, 0, lambda item: print(item['event']))
# ... later
session.close_event_stream()
```

- `async seek(pos: LogPosition) -> None` — position the session. `pos` is epoch seconds (float) or `'live'` (pin to now). Subsequent `get_*()` calls answer as of this position; `play()` continues from it.
- `position() -> float` — the current position (epoch seconds); rides the wall clock while pinned to live.
- `async get_chapters() -> List[Dict[str, Any]]` — the stream's chapters (runs): begin/end/outcome per run.
- `async get_status() -> Optional[Dict[str, Any]]` — the full task-status snapshot as of the position, or `None` before the first status event.
- `async get_console(n: int) -> List[str]` — the last `n` console lines exactly as the console read at the position (keyframe scrollback + everything printed since).
- `async get_traces(n: int) -> LogTracesResult` — trace state at the position: `{'open': [...], 'closed': [...]}` — ALL in-flight traces plus the `n` most recently completed. `n` must be <= 50 (`ValueError` otherwise).
- `async get_trace(trace_id: int) -> LogTraceDetail` — one trace's complete event set. **Identity contract:** a trace is identified by its BEGIN event's continuum seq (flow events' `body.id` is a reused pipe slot and cannot name a trace). Raises `KeyError` when no trace begins at that seq or it fell below the retention horizon.
- `async play(pos: Optional[LogPosition], speed: float, cb: Callable) -> None` — stream reconstructed events to `cb`, in order, strictly after the seed watermark. `pos` optionally seeks first (`None` = play from the current position). `speed`: 0 = as fast as possible; 0.25/1/10 = time-scaled (1 = real time). `cb` receives `{'event': <event dict>}` items. Auto-pins to live on catching up; while pinned, delivery follows arrival.
- `pause() -> None` — freeze the position (unpins live; a later `play()` resumes here).
- `ingest_live(msg) -> None` — feed one live event from your own monitor subscription into the session (the session also registers its own monitors on `seek()`; use this when your host owns the event routing). Non-stamped events are ignored.
- `close_event_stream() -> None` — dispose the session (stops playback, clears caches). The session is unusable afterwards.

## 8. Events & Monitoring

### Receiving Events

Provide an `on_event` async callback at construction. Every server event arrives as a dict: `{'event': <type>, 'body': <event data>, 'seq': <int>, 'type': 'event'}`. Common event types include `apaevt_status_upload` (file upload progress), `apaevt_status_update` (task status), `output` (console output), `apaevt_flow` (trace/flow begin-end), and `apaevt_sse` (per-pipe SSE, dispatched automatically to `on_sse` callbacks). Errors raised inside your handler are logged and do not break the connection.

```python
async def handle_events(event) -> None:
    if event['event'] == 'apaevt_status_upload':
        body = event['body']
        if body['action'] == 'write':
            print(f'Upload: {body["bytes_sent"] / body["file_size"]:.0%}')


client = RocketRideClient(on_event=handle_events)
```

### Monitor Subscriptions — THE Event API

`add_monitor` / `remove_monitor` / `clear_all_monitors` are the supported way to tell the server which event classes you want. Subscriptions are reference-counted per key (multiple consumers can add the same types independently) and are **automatically replayed after a reconnect**.

#### `async add_monitor(key: Dict[str, Any], types: List[str]) -> None`

Add a monitor subscription. If the key already exists, the new types are merged via reference counting and the merged set is sent to the server.

**MonitorKey semantics** — `key` is one of:

- `{'token': '...'}` — monitor a specific running task by token.
- `{'project_id': '...', 'source': '...'}` — monitor a source continuum by identity, optionally with:
  - `'pipe_id'` (int): scope to one data pipe;
  - `'team_id'` (str): address the team's DEPLOYED run (team scope is always the deploy continuum);
  - `'run_kind'` (str): teamless-scope selector — `'dev'` (or omitted) = your own dev run; `'deploy'` = your PERSONAL (@me) deploy run (deploy-kind but user-owned, the one case team-presence cannot express). Any other value raises `ValueError`. Ignored when `'team_id'` is set.

`types` are event classes such as `['summary', 'flow']`, `['output']`, or `['all']`.

```python
await client.add_monitor({'project_id': 'proj-1', 'source': 'chat_1'}, ['summary', 'flow'])  # dev run
await client.add_monitor({'project_id': 'proj-1', 'source': 'webhook_1', 'team_id': 'team-prod'}, ['all'])
await client.add_monitor({'token': token}, ['summary'])  # a running task by token
```

#### `async remove_monitor(key: Dict[str, Any], types: List[str]) -> None`

Remove a monitor subscription. Decrements reference counts for the given types; a type is only unsubscribed from the server when its count reaches 0. `key` must match the key used in `add_monitor`.

#### `async clear_all_monitors() -> None`

Remove all monitor subscriptions from this client (best-effort server unsubscribe, then clears the local registry).

#### `async identify(client_name: str) -> None`

Update this connection's display name on the server — useful so server-side monitoring shows a descriptive name (e.g. your app's name) instead of the generic client name sent at auth time.

#### `async set_events(token: str, event_types: List[str], pipe_id: int = None) -> None`

> **Deprecated.** Use `add_monitor()` / `remove_monitor()` instead. `set_events` still works (it issues the same underlying subscription for a task token) but is not reference-counted and is not the supported API going forward.

### Monitoring Pipeline Status

Prefer events over polling — no polling overhead, and updates arrive as they happen:

```python
async def event_notification(event) -> None:
    print(event['event'], event['body'])


client = RocketRideClient(on_event=event_notification)
await client.connect()

result = await client.use(filepath='pipeline.pipe')
await client.add_monitor({'token': result['token']}, ['summary'])
```

Polling with `get_task_status()` in an `asyncio.sleep` loop also works when events are impractical.

## 9. Deploy & Schedules

`client.deploy` manages **teams-as-environments** deployments. Vocabulary: **deploy** = copy a version to the server registry (`add`); **publish/point** = bind a team (environment) to a version (`deploy`). Every registry version is IMMUTABLE and sha256-locked — what was deployed is provably what runs. Teams ARE the environments (Staging, Production, ...): promotion and rollback are the same pointer move aimed at a different version or team. Every deploy and pointer change lands in an immutable audit history.

List-shaped reads (`list`, `versions`, `history`) return the standard envelope `{'rows', 'total', 'page', 'pageSize'}` and accept `page`, `page_size`, `search`, `filters`, `sort` (`[{'field': ..., 'dir': 'asc'|'desc'}]`) keyword arguments; only supplied values are sent.

#### `async deploy.add(pipeline=None, *, kind='pipe', data=None, metadata=None, comment=None, deploy_to=None) -> PublishResult`

Deploy an object to the server as the next immutable registry version — the ONE generic rail door for every kind. `kind='pipe'` (default): pass `pipeline`, the full definition dict; its `name` is REQUIRED (server-enforced — artifacts are immutable and the name renders on every deploy surface forever). `kind='app'`: pass `data`, one zip of the app's SOURCE (see [Apps](#10-apps)). `metadata` is an optional blob (e.g. provenance, `appRoot` for app zips); `comment` is a "what changed" note kept in the registry; `deploy_to` optionally points a team at the new version immediately (one-step add+deploy; pipes only). Returns `{'artifact': ...}` plus `'deployment'` when `deploy_to` was given.

#### `async deploy.deploy(project_id: str, version: int, team_id: str) -> Deployment`

Point a team at a published version. Promotion (Staging to Production) and rollback (v3 to v2) are both this call — the team's pointer moves, nothing else changes. The team is always explicit (no default-team fallback); requires `task.control` on it.

#### Reads

- `async deploy.list(*, team_id=None, page=None, page_size=None, search=None, filters=None, sort=None) -> DeployListResult` — deployments visible to the caller. `team_id` restricts to one team; omitted = every team the caller can monitor. Search covers projectId/pipelineName/teamId; filters e.g. `{'state': 'enabled'}`.
- `async deploy.get(project_id: str, team_id: str) -> Deployment` — one team's deployment of a project, registry-joined (version, state, schedules, actors).
- `async deploy.versions(project_id: str, *, page=None, page_size=None, search=None, filters=None, sort=None) -> DeployVersionsResult` — the org-registry versions of a project (the version strip), newest first.
- `async deploy.artifact(project_id: str, version: int) -> PipelineConfig` — one immutable artifact's pipeline JSON from the registry (sha256-verified server-side on load). The source of truth for rendering a deployed version — never a local file, never a running task.
- `async deploy.history(project_id: str, *, team_id=None, page=None, page_size=None, search=None, filters=None, sort=None) -> DeployHistoryResult` — the immutable audit trail, newest first (who published what when, who put which version live where). Rows carry `seq` (stable append-order key) as identity; `filters` supports `at__gte`/`at__lte` in epoch seconds.

#### State & Runs

- `async deploy.run(project_id: str, source_id: str, team_id: str) -> dict` — start one deployed source NOW (manual trigger). The run executes as the team and carries no human identity; billing attributes to the org and team, and who fired it is recorded in the audit history. The deployment must be enabled. Returns `{'token', 'version'}`.
- `async deploy.disable(project_id: str, team_id: str) -> Deployment` — the kill switch: NOTHING runs (schedules stop firing, manual runs are refused) until enabled again.
- `async deploy.enable(project_id: str, team_id: str) -> Deployment` — enable a disabled deployment.
- `async deploy.remove(project_id: str, team_id: str) -> Deployment` — soft-remove one team's deployment. Listings hide it; the audit history and every registry artifact survive. Re-deploying any version revives it.

#### Schedules

- `async deploy.set_schedule(project_id: str, source_id: str, schedule: str | None, team_id: str, *, ttl: int | None = None) -> Deployment` — set (or clear) one source's schedule on a team deployment. `schedule` is a 5-field cron expression; `None` or `'manual'` clears it. `ttl` is **the run-window bound** in seconds — how long each scheduled run may execute before the server ends it; `None` = run each task until the pipeline finishes on its own. Editing cron/ttl preserves the paused flag (a new schedule starts unpaused).
- `async deploy.pause_schedule(project_id: str, source_id: str, team_id: str) -> Deployment` — pause ONE source's schedule; cron/ttl stay configured, it just stops firing until resumed.
- `async deploy.resume_schedule(project_id: str, source_id: str, team_id: str) -> Deployment` — resume a paused source schedule.
- `async deploy.set_source_config(project_id: str, source_id: str, team_id: str, *, trace_level: str | None = None, debug_out: bool = False) -> Deployment` — set one source's execution settings for deploy runs (scheduled and manual alike). `trace_level`: `'none'`|`'metadata'`|`'summary'`|`'full'` (`None` = the deploy default, full); `debug_out`: full task debug output. Editing the schedule never touches these.
- `async deploy.preview(schedule: str, count: int | None = None) -> SchedulePreview` — validate a cron expression and return its next occurrences: `{'valid', 'next'}` plus `'error'` when invalid. This is THE single cron evaluator — use it instead of parsing cron client-side, so previews can never disagree with what the scheduler fires.

**Write crons in the shapes the schedule editor understands.** The platform's
schedule UI offers named schedule types — On demand, Repeating interval, Daily,
Weekly, Advanced cron — and it maps a stored cron back into the friendly picker
only when the expression matches one of these exact shapes:

| Requirement | Cron to write |
|---|---|
| every N minutes | `*/N * * * *` |
| every N hours | `0 */N * * *` |
| daily at HH:MM | `M H * * *` |
| chosen weekdays at HH:MM | `M H * * 1,3,5` — a **comma list** of days, `0`=Sunday…`6`=Saturday |

Any other expression — day *ranges* like `1-5`, day-of-month or month fields,
steps outside the interval shapes — is valid cron and fires correctly, but the
UI can only show it as raw "Advanced cron", which users find confusing. Prefer
the shapes above whenever they express the requirement: for weekdays at 09:00
write `0 9 * * 1,2,3,4,5`, **not** `0 9 * * 1-5`.

### Worked Example: Schedule a Deployed Pipe for Mon/Wed/Fri, 08:00-15:00

**The cron says when a run STARTS; the ttl bounds how long it may RUN.** A "runs Monday, Wednesday, and Friday from 08:00 to 15:00" requirement is therefore two settings: a cron that fires at 08:00 on those days, and a ttl equal to the window length — 7 hours = 25200 seconds — so the run is ended by 15:00 even if the pipeline would keep going.

```python
# 1. Deploy the pipeline as a new immutable registry version
result = await client.deploy.add(pipeline, comment='nightly export v2')
version = result['artifact']['version']

# 2. Point the production team at that version
await client.deploy.deploy('my-project-guid', version, 'team-prod')

# 3. Sanity-check the cron (optional): next occurrences = Mon/Wed/Fri 08:00
preview = await client.deploy.preview('0 8 * * 1,3,5', count=3)

# 4. Schedule: fire 08:00 Mon(1)/Wed(3)/Fri(5); bound each run to 7h (ends by 15:00)
await client.deploy.set_schedule(
    'my-project-guid',
    'webhook_1',            # the source the schedule fires
    '0 8 * * 1,3,5',
    'team-prod',
    ttl=25200,              # 7 hours * 3600 s = the 08:00-15:00 run window
)
```

If you omit `ttl`, each scheduled run executes until the pipeline finishes on its own — correct for batch jobs that end naturally, wrong for always-on sources that must only occupy a window.

## 10. Apps

The app methods are the **automation layer under the App Builder UI** — everything the UI does to move an app from source to store, scriptable. The flow: pack and upload source (`deploy.add_app`), watch the build (`list_deployments`, `build_log`), bind versions to audiences (`publish_app`), and go through store review (`submit_app`, `withdraw_app`, `reply_app`).

**Scaffolding:** creating a new app is currently a TypeScript/CLI surface —
use `rocketride app create <slug>` (or the App Builder wizard); a Python
`create_app` mirror is planned. Everything below (pack, deploy, publish,
review) has full Python parity.

**Packing and uploading:** `deploy.add_app` packs an app folder exactly as
the App Builder does — workspace-rooted zip layout, `appManifest.include`
honored, hierarchical gitignore filtering with the hard baseline
(node_modules/, dist/, .git/), symlink containment, and the 50MB zipped /
512MB uncompressed caps — then ships it through the registry rail. Every
step can narrate through `on_progress`, and `deploy.verify_app` runs the
same checks as a purely local dry run first (no server call): manifest
shape, id grammar, declared assets, include entries, pack size.

```python
# Run from the workspace root (or pass workspace_root=...); use the
# DEPLOY pair when the deploy target is a different server.
report = await client.deploy.verify_app('apps/reports')
if not report.ok:
    for check in report.checks:
        print(f'{"OK " if check.ok else "FAIL"} {check.id}: {check.note}')
    raise SystemExit(1)
result = await client.deploy.add_app('apps/reports', comment='v3: new settings panel')
```

The raw rail door remains for a zip you packed yourself:

```python
with open('my-app-source.zip', 'rb') as f:
    result = await client.deploy.add(kind='app', data=f.read(), comment='v3: new settings panel')
```

The zip contains the app's SOURCE (the server owns the build and never trusts client-produced binaries): either `package.json` + `src` at the zip root, or workspace-relative with `metadata={'appRoot': '<app folder>'}`. A new app deployment is born state `'private'` — an `@me`/`@team` binding may serve it immediately; reaching the public store requires review. Audience targets are `'@me'`, `'@team/<name-or-id>'`, or `'@public'` (`'@user'` is a legacy alias for `'@me'`).

- `async list_deployments(app_id: str) -> List[Dict[str, Any]]` — the app's deployed versions, newest first (the rail). Answered by role: the developer org sees its FULL rail (published or not); other callers see only versions serving on rows visible to them. Each entry carries its deployment `state`, its `buildStatus` (`'ok'` = servable bytes exist), and a `rungs` list naming the audiences currently serving that version.
- `async build_log(app_id: str, registry_version: int) -> Dict[str, Any]` — one version's durable server build log: the full phase-by-phase output of the build worker (error detail never rides the rail rows). Long logs serve their tail; an empty `log` means no log exists for the version. Developer-org gated. Returns `{'appId', 'version', 'log'}`.
- `async publish_app(app_id: str, registry_version: int, target: str) -> Dict[str, Any]` — bind a deployment to an audience; one verb covers first publish, promote, and rollback (the binding is a pure pointer). `'@public'` requires the deployment be `'ready'` (approved); `'@me'`/`'@team'` accept any non-`'failed'` deployment. Returns the `publish` binding row.
- `async remove_app_publish(app_id: str, target: str) -> Dict[str, Any]` — remove an audience binding; the app stops serving to that audience. SOFT: registry versions and audit history survive; publishing again revives it.
- `async where_app(app_id: str) -> List[Dict[str, Any]]` — the reverse index: which audiences serve which version. Returns pin rows (`{'rung', 'handle', 'version', 'appVersion', 'state', 'deployedAt'}`).
- `async submit_app(app_id: str, registry_version: int) -> Dict[str, Any]` — submit a deployed version for store review: flips the deployment `'private'` to `'submit'` (it enters the review queue). Developer-org and developer-namespace gated. Returns the refreshed `artifact` rail entry.
- `async withdraw_app(app_id: str, registry_version: int) -> Dict[str, Any]` — withdraw a pending review (the developer's own cancel): flips `'submit'` back to `'private'`; history records the withdrawal. Only a version in `'submit'` withdraws.
- `async reply_app(app_id: str, message: str, registry_version: Optional[int] = None) -> Dict[str, Any]` — append a developer message to the app's review thread (the same history stream `deploy.history()` reads). Returns `{'replied': True, 'appId': app_id}`.

```python
rail = await client.list_deployments('acme.reports')
latest = rail[0]
if latest['buildStatus'] != 'ok':
    print((await client.build_log('acme.reports', latest['version']))['log'])
else:
    await client.publish_app('acme.reports', latest['version'], '@team/qa')
    await client.submit_app('acme.reports', latest['version'])
```

## 11. Account & Billing

### `client.account`

Account management: profile, API keys, organization, members, teams, and server-side environment layers.

**Profile:**

- `async get_profile() -> AccountProfile` — fetch the current user's profile.
- `async update_profile(**fields: str) -> None` — persist profile fields (`displayName`, `givenName`, etc.; all values strings, empty string = no change).
- `async set_dev_team(team_id: str) -> None` — set the user's DEV team: dev-mode runs bill to it and its environment layer applies.
- `async delete_account() -> None` — permanently delete the current user's account.

**Organization:**

- `async get_org(org_id: str) -> OrgDetail` — org detail (id, name, plan, memberCount, teamCount).
- `async update_org_name(org_id: str, name: str) -> None`

**API keys:**

- `async list_keys() -> list[ApiKeyRecord]`
- `async create_key(*, name: str, permissions: list[str] | None = None, expires_at: str | None = None, team_id: str | None = None) -> CreateKeyResult` — create a personal access token; returns `{'key': '<raw key>'}` (shown once — store it). With `team_id=None` the key inherits the user's teams and permissions; with `team_id` set, `permissions` must be provided and the key is scoped to that team. Effective permissions are always intersected with the user's at auth time.
- `async revoke_key(key_id: str) -> None`

**Members:**

- `async list_members(org_id: str) -> list[MemberRecord]`
- `async invite_member(org_id: str, *, email: str, given_name: str, family_name: str, role: str) -> None`
- `async update_member_role(org_id: str, user_id: str, role: str) -> None`
- `async remove_member(org_id: str, user_id: str) -> None`

**Teams:**

- `async list_teams(org_id: str) -> list[TeamRecord]`
- `async get_team_detail(org_id: str, team_id: str) -> TeamDetail` — full detail including member list.
- `async create_team(org_id: str, name: str) -> None` / `async delete_team(org_id: str, team_id: str) -> None`
- `async add_team_member(org_id: str, *, team_id: str, user_id: str, permissions: list[str]) -> None`
- `async update_team_member_perms(org_id: str, *, team_id: str, user_id: str, permissions: list[str]) -> None`
- `async remove_team_member(org_id: str, *, team_id: str, user_id: str) -> None`

**Server-side environment layers** (`ROCKETRIDE_*` secrets stored per scope and merged org -> team -> user for pipeline resolution):

- `async get_environment_keys() -> list[str]` — merged list of key NAMES across all scopes (no values).
- `async get_env(scope: str, scope_id: str | None = None) -> dict[str, str]` — read one scope's env dict. `scope` is `'org'`, `'team'`, or `'user'`; `scope_id` is the orgId/teamId (omit for user).
- `async set_env(scope: str, env: dict[str, str], scope_id: str | None = None) -> None` — write one scope's FULL env dict (replaces the entire set of keys at that scope level).

```python
new_key = await client.account.create_key(name='ci-runner')
await client.account.set_env('team', {'ROCKETRIDE_OPENAI_KEY': 'sk-...'}, scope_id=team_id)
```

#### What members can do vs admins

Every operation above is role-checked server-side; an unauthorized call is refused with an explicit error (`'Admin role required ...'`) — nothing fails silently. The split for the documented operations:

- **Any org member**: their own profile (`get_profile`, `update_profile`, `set_dev_team`, `set_default_org`); their OWN API keys (`list_keys`, `create_key`, revoking their own); reading the org (`get_org`); listing members and teams and reading a team's detail; USER-scope environment (`get_env('user')` / `set_env('user')`) and the merged key names (`get_environment_keys`); billing reads (`get_details`, `get_credit_balance`, `get_product_prices`) and promo codes (`validate_promo_code`, `redeem_promo_code`).
- **Org admin only**: renaming the org (`update_org_name`); member management (`invite_member`, `update_member_role`, `remove_member`); revoking ANOTHER member's key (own-org keys only); creating teams (`create_team`); ORG-scope environment — both `get_env('org', ...)` and `set_env('org', ...)` (reads too: the org layer holds shared secrets); and every billing operation that moves money or reads the org's ledger — checkout/subscribe, portal, cancel, upgrade, credit purchases and top-ups, `get_usage_by_user`/`get_usage_by_team`, `get_transactions`, `get_transaction_distinct`.
- **Team admin** (the `team.admin` permission on that team; org admins pass implicitly): `delete_team`, `add_team_member`, `update_team_member_perms`, `remove_team_member`, and TEAM-scope `get_env`/`set_env` — both read and write.

### `client.billing`

Billing and subscription operations: plans, checkout, portal, and compute credit wallets.

**Subscriptions:**

- `async get_details(org_id: str) -> list[BillingDetail]` — per-app subscription rows for the org.
- `async get_product_prices(app_id: str) -> list[AppPrice]` — active plans for an app, month-first, formatted for a plan picker.
- `async create_checkout_session(org_id: str, app_id: str, price_id: str, promotion_code: str | None = None) -> dict` — create a Stripe subscription; returns `{'clientSecret', 'subscriptionId', 'status'}`. `clientSecret` is `None` when the first invoice is $0 — the subscription is already active.
- `async validate_promo_code(org_id: str, code: str, price_id: str | None = None) -> PromoValidation` — resolve a promo code without side effects; unknown/expired codes return `{'valid': False, 'reason': ...}` and never raise. Pass `price_id` to also get the discounted first-invoice amount.
- `async redeem_promo_code(org_id: str, code: str) -> PromoRedemption` — redeem a credit-grant code ($0 subscription + immediate credits; `mode: 'credits_only'` when already subscribed). Discount-only codes are rejected — apply those at checkout.
- `async create_portal_session(org_id: str, return_url: str) -> dict` — Stripe Billing Portal session; returns `{'url'}`.
- `async cancel_subscription(org_id: str, app_id: str) -> dict` — schedule cancellation at period end (access retained until then).
- `async upgrade_subscription(org_id: str, app_id: str, new_price_id: str) -> dict` — swap to a different plan with automatic proration.

**Compute credits:**

- `async get_credit_balance(org_id: str) -> CreditBalance` — the org's credit balance with lifetime stats; cheap and safe to poll (~1 req/s).
- `async list_credit_packs() -> list[CreditPack]` — purchasable credit packs from the catalog.
- `async purchase_topup(org_id: str, price_id: str) -> dict` — charge the card on file for a top-up pack; returns `{'status'}` (`'succeeded'` or `'requires_action'`) plus `clientSecret` for 3DS when needed.
- `async create_credit_checkout(org_id: str, pack_id: str, return_url: str) -> dict` — one-off Stripe Checkout for a credit pack; returns `{'url'}`.

**Transactions and usage:**

- `async get_transactions(org_id, scope='org', scope_id=None, page=1, page_size=50, since=None, sort=None, filters=None, search=None) -> TransactionsResult` — paginated credit-ledger detail. `scope` is `'org'`, `'team'`, or `'user'` (with `scope_id` for the latter two); `since` is an ISO datetime; `sort`/`filters`/`search` follow the platform list convention (`field__gte`/`field__lte` for ranges).
- `async get_transaction_distinct(org_id: str, field: str) -> list` — distinct values of one ledger column (e.g. `'type'`) for checklist filters.
- `async get_usage_by_user(org_id: str)` / `async get_usage_by_team(org_id: str) -> list[UsageRollup]` — per-user / per-team consumption rollups, descending.

## 12. Dashboard & Tasks

Server-state snapshots and paginated task/connection views. These require the `task.monitor` permission (or wildcard `*`); a denied call raises `RuntimeError`.

- `async get_dashboard() -> DASHBOARD_RESPONSE` — a point-in-time server dashboard snapshot: `overview` metrics (e.g. `totalConnections`, `activeTasks`), `connections`, and `tasks`.
- `async list_connections(req: Optional[LIST_PAGE_REQUEST] = None) -> LIST_CONNECTIONS_RESPONSE` — one page of the caller's active connections, in the standard envelope `{'rows', 'total', 'page', 'pageSize'}`. `req` may carry `page`, `page_size`, `search`, `sort`, `filters` (server defaults apply for omitted keys). Default sort: registration order.
- `async list_tasks(req: Optional[LIST_PAGE_REQUEST] = None) -> LIST_TASKS_RESPONSE` — one page of the caller's tasks in the same envelope. Default sort: creation order.

```python
page = await client.list_tasks({'search': 'ocr', 'page_size': 10})
print(f'{page["total"]} tasks, showing {len(page["rows"])}')
```

## 13. Database

`client.database` issues raw SQL or Cypher directly against a database pipeline node (via the node's tool functions), **bypassing the LLM translation layer** the default `chat()` flow uses — and its safety checks: you are responsible for the statements you pass. On every method, `node_id=''` broadcasts to all tool-lane nodes and the first database node handles it. Empty token/sql/session_id raise `ValueError`; server failures raise `RuntimeError`.

- `async database.query(*, token: str, sql: str, node_id: str = '', session_id: str = '', params: list | None = None) -> Dict[str, Any]` — execute a raw SQL/Cypher statement. `params` binds positional placeholders (e.g. `[1, 'foo']` for `$1`, `$2`); pass a `session_id` from `begin_transaction` to run inside that transaction. Returns `{'rows': [...], 'affected_rows': int}`.
- `async database.begin_transaction(*, token: str, node_id: str = '') -> Dict[str, Any]` — begin a transaction; returns a dict containing the `session_id` to thread through subsequent `query`/`commit`/`rollback` calls.
- `async database.commit(*, token: str, session_id: str, node_id: str = '') -> Dict[str, Any]` — commit an open transaction. Returns `{'ok': True}` on success.
- `async database.rollback(*, token: str, session_id: str, node_id: str = '') -> Dict[str, Any]` — roll back an open transaction, discarding its changes.
- `async database.dialect(*, token: str, node_id: str = '') -> DatabaseDialect` — discover the underlying engine: `POSTGRES` (`'postgres'`), `MYSQL` (`'mysql'`), or `NEO4J` (`'neo4j'`). Raises `ValueError` when the node reports no dialect (i.e. it is not a database node).

```python
tx = await client.database.begin_transaction(token=token)
session = tx['session_id']
try:
    await client.database.query(token=token, sql='INSERT INTO t (a) VALUES ($1)', params=[42], session_id=session)
    await client.database.commit(token=token, session_id=session)
except Exception:
    await client.database.rollback(token=token, session_id=session)
    raise
```

## 14. CLI

The package installs a `rocketride` command-line tool. The TypeScript
client installs the IDENTICAL command — same verbs, same flags, same
output — so recipes port between languages unchanged.

```bash
pip install rocketride
rocketride --help
```

**Common flags** (every command): `--uri` (default: `ROCKETRIDE_URI` env
or `http://localhost:5565`), `--apikey` (default: `ROCKETRIDE_APIKEY`
env), and `--json [FILE]` — the command's entire result as one JSON value
on stdout (or written to `FILE`), built for scripts and agents; failures
become an `{"error": {"message", "hint"}}` envelope with a non-zero exit.
The CLI loads the workspace `.env`. Deploy verbs (`deploy *`,
`app deploy`) use the `ROCKETRIDE_DEPLOY_*` pair instead and refuse to
run without it.

### `rocketride init` / `rocketride login`

`init` provisions the workspace end-to-end: signs in (see `login`), syncs
the services catalog + schemas, vendors `shell.tgz` and `rocketride.tgz`
into `.rocketride/`, installs the agent docs bundle and the CLAUDE.md
stub, and ensures `.gitignore` covers `.rocketride/` and `.env`.
Idempotent — re-run any time to refresh against the connected server.

`login [--deploy] [--apikey KEY]` (re)authenticates and saves credentials
to `.env` (and makes `.env` git-ignored in the same step). OSS servers
take an API key; saas servers open the browser to sign in and mint a
durable personal API key. Run it whenever a command reports rejected
credentials. `--deploy` targets the `ROCKETRIDE_DEPLOY_*` pair.

### Task commands

```bash
rocketride list                                            # one-shot list of your active tasks
rocketride start --pipeline ./my-pipeline.pipe             # start; prints the task token and exits
rocketride upload files/*.csv --pipeline ./pipeline.pipe   # start + upload + terminate
rocketride upload files/*.csv --token TASK_TOKEN           # upload into an already-running task
rocketride stop --token TASK_TOKEN                         # terminate a task
```

- `start` options: `--pipeline FILE` (or `ROCKETRIDE_PIPELINE`; required), `--token TOKEN` (or `ROCKETRIDE_TOKEN`), `--threads N` (default 4), `--args ...`
- `upload` options: `--pipeline FILE` or `--token TOKEN` (one required), `--threads N` (default 4), `--max-concurrent N` (default 5), `--args ...`

There is no live-monitor command: continuous monitoring belongs to the
platform's event monitor and server monitor apps — the CLI is one-shot,
line-oriented output by design.

### `rocketride app <create|verify|deploy>`

The app lifecycle verbs, identical to the TypeScript CLI: `app create
<slug>` scaffolds under `./apps/<slug>` with the App Builder wizard's
templates (SDK equivalent: `client.deploy.create_app`); `app verify
<folder>` is the no-connection precheck (exit 0 when ready); `app deploy
<folder>` packs the source and deploys it as the next registry version on
the DEPLOYMENT target. Deploying activates nothing — publish a rung to
serve it.

### `rocketride deploy <verb>`

Deployment-target verbs, following the platform vocabulary — **deploy** =
version to the server's registry, **publish** = bind a rung to a version:

```bash
rocketride deploy add pipelines/ingest.pipe --comment "v2 parse"    # next registry version (--kind pipe|node)
rocketride deploy publish PROJECT_ID 3 --team TEAM_ID               # point the team at version 3
rocketride deploy list|get|versions|history PROJECT_ID              # inspect (all support --json)
rocketride deploy run PROJECT_ID SOURCE_ID --team TEAM_ID           # trigger a run now
rocketride deploy schedule set PROJECT_ID SOURCE_ID "0 9 * * 1-5" --team TEAM_ID --ttl 32400
rocketride deploy schedule pause|resume PROJECT_ID SOURCE_ID --team TEAM_ID
rocketride deploy schedule preview "0 9 * * 1-5"                    # validate a cron + next firings
rocketride deploy log APP_ID VERSION                                # read an app version's build log
rocketride deploy enable|disable|remove PROJECT_ID --team TEAM_ID
```

Every verb fronts a `client.deploy.*` SDK method — prefer the API in
application code; the CLI is the one-shot form for terminals, CI, and
quick lifecycle operations.

### `rocketride store <subcommand>`

File-store operations against your account store:

| Subcommand | Usage | Description |
| ---------- | ----- | ----------- |
| `dir` | `rocketride store dir [path]` | List directory contents (default: root) |
| `type` | `rocketride store type <path>` | Display file contents |
| `write` | `rocketride store write <path> --file LOCAL` or `--content TEXT` | Write a file from a local file or inline text (exactly one of the two) |
| `rm` | `rocketride store rm <path>` | Delete a file |
| `mkdir` | `rocketride store mkdir <path>` | Create a directory |
| `stat` | `rocketride store stat <path>` | File/directory metadata |

```bash
rocketride store write configs/settings.json --content '{"threshold": 0.8}' --apikey YOUR_KEY
rocketride store type configs/settings.json --apikey YOUR_KEY
```

## 15. Data Types & MIME

### Pipeline Configuration

```python
pipeline = {
    'components': [
        {
            'id': str,  # Unique component identifier
            'provider': str,  # Component type (e.g., 'webhook', 'parse', 'response_text')
            'name': str,  # Human-readable name (optional)
            'description': str,  # Component description (optional)
            'config': dict,  # Component-specific configuration
            'ui': dict,  # UI-specific configuration (optional)
            'input': [  # Input connections (optional)
                {
                    'lane': str,  # Data lane/channel name
                    'from': str,  # Source component ID
                }
            ],
        }
    ],
    'source': str,  # Entry point component ID
    'project_id': str,  # Project identifier
}
```

### Upload Result

```python
{
    'action': str,  # 'complete' or 'error' (final); progress events use 'open', 'write', 'close'
    'filepath': str,
    'bytes_sent': int,
    'file_size': int,
    'upload_time': float,  # seconds
    'result': dict,  # processing result (on complete)
    'error': str,  # error message (on error)
}
```

### Pipeline Result

`{'answers': list, 'name': str, 'result_types': dict, ...}` — answer values (chat responses) plus dynamic fields based on `result_types`.

### Task Status

`{'state': str, 'progress': dict, 'error': str, ...}` — `state` is `'starting'`, `'running'`, `'waiting'`, `'completed'`, `'failed'`, or `'terminated'`; plus timing/performance fields.

### List Envelope

All paginated reads (`deploy.list`, `deploy.versions`, `deploy.history`, `list_tasks`, `list_connections`, `billing.get_transactions`) return `{'rows': list, 'total': int, 'page': int, 'pageSize': int}`.

### MIME Types

The SDK auto-detects MIME types for common file extensions when uploading:

- `.json` -> `application/json`
- `.csv` -> `text/csv`
- `.txt` -> `text/plain`
- `.pdf` -> `application/pdf`
- `.jpg/.jpeg` -> `image/jpeg`
- `.png` -> `image/png`
- `.mp4` -> `video/mp4`
- `.mp3` -> `audio/mpeg`
- Default -> `application/octet-stream`

For data pipes, MIME types determine processing lanes:

- `application/rocketride-question` -> AI chat question format (the `questions` lane; used internally by `chat()`)
- `text/*` -> Text lane
- `image/*` -> Image lane
- `video/*` -> Video lane
- `audio/*` -> Audio lane
- Others -> Data lane

## 16. Profiling

Server-side cProfile sessions for finding where pipeline (or server) time
goes. One session at a time per target; `target` is a task token to profile
that pipeline's subprocess, or omitted to profile the server process.

```python
await client.cprofile_start(target=token, session='slow-parse-hunt')
# ... exercise the pipeline ...
await client.cprofile_stop(target=token)
report = await client.cprofile_report(target=token)      # full pstats text
tree = await client.cprofile_report_tree(target=token)   # call tree
```

- `cprofile_start(target=None, session=None)` — begin a session; returns
  status with session info and start time.
- `cprofile_stop(target=None)` — end it; returns session name and runtime.
- `cprofile_status(target=None)` — active/inactive, owner, runtime.
- `cprofile_report(target=None)` — the full pstats text report of the last
  completed session.
- `cprofile_report_tree(target=None, max_depth=50, min_pct=0.1,
  include_system=False)` — the call tree with `total_time` and
  `total_calls`; raise `min_pct` or lower `max_depth` to shrink it. Read the
  tree top-down: the widest cumulative-time branch under the run loop is
  the slow pipeline component.

## 17. Exceptions & Error Handling

### Exception Hierarchy

All SDK exceptions derive from `DAPException`, which wraps the raw DAP error result (exposed via `.dap_result`). Catch from broad to narrow:

```text
DAPException                      (base; wraps DAP error responses)
└── RocketRideException           (catch-all for any RocketRide error)
    ├── ConnectionException       (server unreachable, network, connection lost)
    │   └── AuthenticationException   (bad API key / credentials)
    ├── PipeException             (data-transfer failures; also a RuntimeError)
    ├── ExecutionException        (pipeline execution failures)
    └── ValidationException       (invalid input / pipeline configuration)
```

### What Actually Raises What

- `connect()` / `login()`: `AuthenticationException` on rejected credentials; transport failures surface as connection errors.
- `use()`: `ValueError` (neither `pipeline` nor `filepath` given), `FileNotFoundError` (bad `filepath`), `RuntimeError` (server refused to start or returned no token).
- `send()` / `send_files()` / `chat()` / pipe `open()`/`write()`/`close()`: `PipeException` on transfer failure. `PipeException` also inherits `RuntimeError`, so legacy `except RuntimeError` handlers still catch it.
- Every other typed API — `terminate()`, `restart()`, `validate()`, `get_services()`, all `fs_*` methods, and the `deploy`, `log`, `account`, `billing`, `database`, dashboard, and app methods — raises **`RuntimeError`** carrying the server's error message when the server signals failure; client-side argument problems raise `ValueError`.
- `ConnectionException`, `ExecutionException`, and `ValidationException` complete the importable hierarchy; current SDK code paths predominantly raise the types listed above.

```python
from rocketride import RocketRideException, AuthenticationException

try:
    await client.connect()
    result = await client.use(filepath='pipeline.pipe')
except AuthenticationException as e:
    print(f'Bad credentials: {e}')
except RocketRideException as e:
    print(f'RocketRide error: {e} (raw: {e.dap_result})')
except RuntimeError as e:
    print(f'Server-reported failure: {e}')
```

## 18. Best Practices

1. **Never block the asyncio event loop.** The SDK's transport, pending-request resolution, event delivery, reconnection, and DVR playback ALL run on the event loop your code shares. A blocking call (`time.sleep`, synchronous file/network I/O, CPU-heavy loops) stalls every in-flight request and every incoming event until it returns. Use `await asyncio.sleep(...)`, push blocking work into `await asyncio.to_thread(...)`, and keep `on_event`/`on_sse`/connection callbacks fast — hand heavy work off to a task or queue.
2. **Start pipelines once, reuse the token.** `client.use()` is time-consuming; a start-ask-stop cycle per request is an anti-pattern.
3. **Use context managers** (`async with RocketRideClient() as client`, `async with await client.pipe(...) as pipe`) for automatic cleanup.
4. **Handle exceptions at the right specificity** — `AuthenticationException` for credential UX, `PipeException` for transfer retries, `RuntimeError` for server-reported command failures, `RocketRideException` as the broad net.
5. **Use `add_monitor` for progress feedback** instead of polling `get_task_status()`; subscriptions survive reconnects automatically.
6. **Provide examples in AI questions** (`addExample`) for consistent formatting, and remember Question builder methods do NOT chain — they return `None`.
7. **Use structured responses** (`expectJson=True`) for data extraction; the answers come back already parsed.
8. **Stream large datasets with pipes** instead of one giant `send()` to bound memory usage.
9. **Enable `persist=True`** for long-running applications so the client reconnects without your intervention.
10. **Validate before you deploy**: `client.validate()` for pipeline configs, `client.deploy.preview()` for cron — both use the server's own evaluators, so they can never disagree with execution.
11. **Keep secrets in the environment layers** (`.env` locally, `client.account.set_env` server-side) and reference them as `${ROCKETRIDE_*}` in pipeline configs — deployed artifacts are immutable and auditable, so never hard-code keys.
