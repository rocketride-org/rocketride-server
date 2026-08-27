---
title: API Reference
sidebar_position: 10
---

# API Reference

The core public surface of the Python SDK. Constructor options and
environment variables are on [Configuration](/clients/python/configuration);
exceptions on [Error Handling](/clients/python/errors).

## RocketRideClient

### Connection

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `attach` | `async def attach(self, uri: Optional[str] = None, *, timeout: Optional[float] = None) -> None` | - | Opens the WebSocket without authenticating. If `uri` is provided and differs from the current URI, detaches first; if already attached to the same URI, this is a no-op. |
| `detach` | `async def detach(self) -> None` | - | Closes the transport and leaves the client detached. |
| `is_attached` | `def is_attached(self) -> bool` | `bool` | Whether the WebSocket transport is open, regardless of authentication. |
| `login` | `async def login(self, credential: Optional[str] = None, *, uri: Optional[str] = None, timeout: Optional[float] = None) -> ConnectResult` | `ConnectResult` | Authenticates over an attached transport (attaching first if needed). A differing `uri` detaches and re-attaches; a differing `credential` logs out (best-effort) before logging in; logging in again with the same credential is a no-op. |
| `logout` | `async def logout(self) -> None` | - | Deauthenticates (sends `deauth`) and clears client auth state while keeping the attachment. |
| `is_authenticated` | `def is_authenticated(self) -> bool` | `bool` | Whether the auth handshake has succeeded on the current connection. |
| `connect` | `async def connect(self, credential: Optional[str] = None, *, timeout: Optional[float] = None) -> ConnectResult` | `ConnectResult` | Opens the WebSocket and performs DAP auth. Optional `credential` overrides the constructor `auth` for this connection attempt. Optional `timeout` (ms) bounds the connect + auth handshake (non-persist only). In **persist** mode, on failure the client calls `on_connect_error` and retries; on **auth** failure it does not retry. |
| `disconnect` | `async def disconnect(self) -> None` | - | Closes the connection and cancels reconnection. |
| `is_connected` | `def is_connected(self) -> bool` | `bool` | Backward-compatible alias for `is_attached()` — `True` when the WebSocket is open; does not imply authentication. |
| `get_connection_info` | `def get_connection_info(self) -> dict` | `dict` | Returns `{ 'connected': bool, 'transport': str, 'uri': str }`. |
| `get_apikey` | `def get_apikey(self) -> Optional[str]` | `str \| None` | The API key in use. For debugging only; avoid logging in production. |
| `set_env` | `def set_env(self, env: Dict[str, str]) -> None` | - | Replaces the client's environment map, used for `${ROCKETRIDE_*}` substitution and credential lookup. |

Context manager: `async with RocketRideClient(...) as client:` — entering calls
`connect()`, exiting calls `disconnect()`.

### Pipeline execution

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `use` | `async def use(self, *, token: str = None, filepath: str = None, pipeline: PipelineConfig = None, source: str = None, threads: int = None, use_existing: bool = None, args: List[str] = None, ttl: int = None, pipelineTraceLevel: str = None, name: str = None, env: Dict[str, str] = None) -> dict` | `dict` | Starts a pipeline. Requires `filepath` or `pipeline`. `pipelineTraceLevel` sets run-log trace verbosity, `name` a task display name, `env` per-run variable overrides. Returns a dict with at least `'token'`. |
| `terminate` | `async def terminate(self, token: str) -> None` | - | Stops the pipeline and frees server resources. |
| `get_task_status` | `async def get_task_status(self, token: str) -> dict` | `dict` | Current task status (`completedCount`, `totalCount`, `completed`, `state`, `exitCode`, …). |

### Data

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `pipe` | `async def pipe(self, token: str, objinfo: dict = None, mime_type: str = None, provider: str = None, on_sse=None) -> DataPipe` | `DataPipe` | Creates a **streaming** pipe: open, then one or more writes, then close. Default MIME: `'application/octet-stream'`. `on_sse` receives server-sent events. |
| `send` | `async def send(self, token: str, data: str \| bytes, objinfo: dict = None, mimetype: str = None, on_sse=None) -> PIPELINE_RESULT` | `PIPELINE_RESULT` | Sends data in **one shot** (open, write once, close). No MIME auto-detection — default is `'application/octet-stream'`. |
| `send_files` | `async def send_files(self, files: List[str \| Tuple[str, dict] \| Tuple[str, dict, str]], token: str) -> List[UPLOAD_RESULT]` | `List[UPLOAD_RESULT]` | Uploads files concurrently (unbounded `asyncio.gather`). **Requires an API key** (`RuntimeError` without one); a missing file raises `ValueError`. Progress via `on_event` as `apaevt_status_upload`. |

### Events

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `add_monitor` | `async def add_monitor(self, key: Dict[str, Any], types: List[str]) -> None` | - | Adds a reference-counted monitor subscription; events are delivered to `on_event`. Key: `{'token': ...}` or `{'project_id': ..., 'source': ...}` (+ optional `'pipe_id'`, `'team_id'`). |
| `remove_monitor` | `async def remove_monitor(self, key: Dict[str, Any], types: List[str]) -> None` | - | Removes a monitor subscription; a type unsubscribes from the server only when its reference count reaches zero. |
| `set_events` | `async def set_events(self, token: str, event_types: List[str], pipe_id: int = None) -> None` | - | **Deprecated** — use `add_monitor`/`remove_monitor`. Subscribes the task to the given event types. |

### Services, validation, and ping

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `get_services` | `async def get_services(self) -> dict` | `dict` | Lightweight **summaries** of every service, plus a deduplicated `icons` table and the server `version`. Full definitions come from `get_service`. |
| `get_service` | `async def get_service(self, service: str) -> dict` | `dict` | One service's full definition (config schema included). **Raises** `ValueError` (empty name) or `RuntimeError` (unknown service); never returns `None`. |
| `validate` | `async def validate(self, pipeline: PipelineConfig, *, source: str = None) -> dict` | `dict` | Validates a pipeline configuration without starting it; returns errors and warnings. |
| `ping` | `async def ping(self) -> None` | - | Liveness check; raises on failure. (A legacy `token` argument is accepted but not sent.) |

### Chat

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `chat` | `async def chat(self, *, token: str, question: Question, on_sse=None) -> PIPELINE_RESULT` | `PIPELINE_RESULT` | Sends the `Question` to the pipeline and returns the result. `on_sse` streams server-sent events (e.g. token-by-token output). See [Chat](/clients/python/chat). |

### Store (file access)

Paths are **relative** to the store root; absolute-like paths are rejected. See
[File Storage](/clients/python/storage) for the workflow.

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `fs_open` | `async def fs_open(self, path: str, mode: str = 'r') -> dict` | `dict` | Open a handle. Returns `{'handle': str}`; read mode also includes `'size'` (int). |
| `fs_read` | `async def fs_read(self, handle: str, offset: int = 0, length: int = 4_194_304) -> bytes` | `bytes` | Read up to `length` bytes (default 4 MB) from `offset`. Empty bytes = EOF. |
| `fs_write` | `async def fs_write(self, handle: str, data: bytes) -> int` | `int` | Write raw bytes to a write handle. Returns the number of bytes written. |
| `fs_close` | `async def fs_close(self, handle: str, mode: str = 'r') -> None` | - | Close a handle. `mode` must match the mode passed to `fs_open`. |
| `fs_read_string` | `async def fs_read_string(self, path: str, encoding: str = 'utf-8') -> str` | `str` | Read an entire file as a decoded string. |
| `fs_write_string` | `async def fs_write_string(self, path: str, text: str, encoding: str = 'utf-8') -> None` | - | Write a string to a file (overwrites). |
| `fs_read_json` | `async def fs_read_json(self, path: str) -> Any` | `Any` | Read and parse a JSON file. |
| `fs_write_json` | `async def fs_write_json(self, path: str, obj: Any) -> None` | - | Serialize an object to JSON and write it. |
| `fs_list_dir` | `async def fs_list_dir(self, path: str = '') -> dict` | `dict` | List immediate children: `{entries: [{name, type, size?, modified?}], count}`. |
| `fs_stat` | `async def fs_stat(self, path: str) -> dict` | `dict` | Metadata: `{exists, type, size, modified}` (`size`/`modified` for files only). |
| `fs_mkdir` | `async def fs_mkdir(self, path: str) -> None` | - | Create a directory. |
| `fs_rmdir` | `async def fs_rmdir(self, path: str, *, recursive: bool = False) -> None` | - | Remove a directory. `recursive=True` deletes contents. |
| `fs_rename` | `async def fs_rename(self, old_path: str, new_path: str) -> None` | - | Rename or move a file/directory (copy+delete on object stores; recursive for directories). |
| `fs_delete` | `async def fs_delete(self, path: str) -> None` | - | Delete a file. |
| `fs_get_url` | `async def fs_get_url(self, path: str, expires_in: int = 3600, download_name: str = None) -> str` | `str` | Time-limited HTTP(S) URL for direct browser access; inline by default, `download_name` forces `Content-Disposition: attachment`. |
| `fs_read_many` | `async def fs_read_many(self, paths: List[str]) -> List[Dict[str, Any]]` | `List[Dict]` | Batch-read many small files in one round trip (max 256 paths / 32 MiB total). Per-entry failures (`ok: False` + `error`), request order, `data` as `bytes`. |

### Database

Raw SQL through a pipeline database node (requires `allow_execute: true` on the
node). The TypeScript SDK additionally offers a Sequelize ORM binding over this
surface.

| Method | Signature | Description |
| --- | --- | --- |
| `database.query` | `async def query(*, token, sql, node_id='', session_id='', params=None) -> dict` | Execute raw SQL through the pipeline's `execute` tool function; returns `{rows, affected_rows}`. |
| `database.begin_transaction` | `async def begin_transaction(*, token, node_id='') -> dict` | Open a transaction (`begin` tool function); returns `{session_id}`. |
| `database.commit` | `async def commit(*, token, session_id, node_id='') -> dict` | Commit the open transaction. |
| `database.rollback` | `async def rollback(*, token, session_id, node_id='') -> dict` | Roll back the open transaction. |
| `database.dialect` | `async def dialect(*, token, node_id='') -> DatabaseDialect` | The target node's SQL dialect. |

### Deploy (`client.deploy`)

See [Deployments](/clients/python/deploy) for the model.

| Method | Signature | Returns |
| --- | --- | --- |
| `deploy.publish` | `async def publish(self, pipeline, *, comment=None, deploy_to=None) -> PublishResult` | `PublishResult` |
| `deploy.deploy` | `async def deploy(self, project_id, version, team_id) -> Deployment` | `Deployment` |
| `deploy.list` | `async def list(self, *, team_id=None, page=None, page_size=None, search=None, filters=None, sort=None) -> DeployListResult` | `DeployListResult` |
| `deploy.get` | `async def get(self, project_id, team_id) -> Deployment` | `Deployment` |
| `deploy.versions` | `async def versions(self, project_id, *, page=None, ...) -> DeployVersionsResult` | `DeployVersionsResult` |
| `deploy.history` | `async def history(self, project_id, *, team_id=None, page=None, ...) -> DeployHistoryResult` | `DeployHistoryResult` |
| `deploy.disable` | `async def disable(self, project_id, team_id) -> Deployment` | `Deployment` |
| `deploy.enable` | `async def enable(self, project_id, team_id) -> Deployment` | `Deployment` |
| `deploy.remove` | `async def remove(self, project_id, team_id) -> Deployment` | `Deployment` |
| `deploy.set_schedule` | `async def set_schedule(self, project_id, source_id, schedule, team_id, *, ttl=None) -> Deployment` | `Deployment` |
| `deploy.pause_schedule` | `async def pause_schedule(self, project_id, source_id, team_id) -> Deployment` | `Deployment` |
| `deploy.resume_schedule` | `async def resume_schedule(self, project_id, source_id, team_id) -> Deployment` | `Deployment` |
| `deploy.set_source_config` | `async def set_source_config(self, project_id, source_id, team_id, ...) -> Deployment` | `Deployment` |
| `deploy.run` | `async def run(self, project_id, source_id, team_id) -> dict` | `{token, version}` |
| `deploy.artifact` | `async def artifact(self, project_id, version) -> PipelineConfig` | `PipelineConfig` |
| `deploy.preview` | `async def preview(self, schedule, count=None) -> SchedulePreview` | `SchedulePreview` |

### App publish ladder

| Method | Signature |
| --- | --- |
| `app_publish` | `async def app_publish(self, app_id, version, bundle, message='', module_id=None, name=None) -> dict` |
| `app_versions` | `async def app_versions(self, app_id) -> list[dict]` |
| `app_deploy` | `async def app_deploy(self, app_id, registry_version, target) -> dict` |
| `app_where` | `async def app_where(self, app_id) -> list[dict]` |

### Run logs (`client.log`)

See [Run Logs](/clients/python/logs) for the continuum model and the DVR session.

## DataPipe

Returned by `await client.pipe(...)`. One streaming upload: **open → write (one or
more) → close**. Also an async context manager: entering calls `open()`, exiting
calls `close()`.

| Property | Type | Description |
| --- | --- | --- |
| `is_opened` | `bool` | Whether the pipe is open. |
| `pipe_id` | `int \| None` | Server-assigned pipe ID after `open()`. |

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `open` | `async def open(self) -> DataPipe` | `self` | Opens the pipe; required before `write()`. |
| `write` | `async def write(self, buffer: bytes) -> None` | - | Writes a chunk. Pipe must be open; payload must be `bytes`. |
| `close` | `async def close(self) -> PIPELINE_RESULT` | `PIPELINE_RESULT` | Closes the pipe and returns the processing result. |
| `tool` | `async def tool(self, *, tool: str, node_id: str = '', input: dict = None) -> Any` | `Any` | Invokes a pipeline tool function through the pipe. |

## Question

From `rocketride.schema`. Build a question for
`client.chat(token=..., question=question)`.

```python
Question(
    type: QuestionType = QuestionType.QUESTION,
    filter: DocFilter = None,
    expectJson: bool = False,
    role: str = '',
)
```

`QuestionType`: `QUESTION`, `SEMANTIC`, `KEYWORD`, `GET`, `PROMPT`.

| Method | Signature | Description |
| --- | --- | --- |
| `addInstruction` | `addInstruction(self, title: str, instruction: str)` | Adds an instruction (e.g. "Use bullet points"). |
| `addExample` | `addExample(self, given: str, result: dict \| list \| str)` | Adds an example input/output; `result` can be dict/list (JSON-serialized). |
| `addContext` | `addContext(self, context: str \| dict \| List[str] \| List[dict])` | Adds context. |
| `addHistory` | `addHistory(self, item: QuestionHistory)` | Adds a history item for multi-turn chat. |
| `addQuestion` | `addQuestion(self, question: str)` | Appends the question text. |
| `addDocuments` | `addDocuments(self, documents: Doc \| List[Doc])` | Adds documents for the AI to reference. |
| `addGoal` | `addGoal(self, goal: str)` | Adds a goal statement for the AI. |
| `getPrompt` | `getPrompt(self, has_previous_json_failed: bool = False) -> str` | Returns the full prompt (internal). |

## Answer

From `rocketride.schema`. Parses chat response content — see
[Chat](/clients/python/chat#parse-the-response-with-answer) for semantics.

| Member | Signature | Description |
| --- | --- | --- |
| `setAnswer` | `setAnswer(self, value: str \| dict \| list)` | Stores the response value, validating/parsing it as JSON when `expectJson` is `True`. |
| `getText` | `getText(self) -> str` | The answer as plain text. |
| `getJson` | `getJson(self) -> Optional[dict]` | The parsed JSON. Returns `None` only when no answer has been set; **raises `ValueError`** on invalid JSON. |
| `isJson` | `isJson(self) -> bool` | Returns the `expectJson` flag (does not inspect content). |
| `parsePython` | `parsePython(self, value: str) -> Any` | Extracts Python code from a code block in the response. |
| `tokens` | field | Turn-total LLM token usage reported by the server. The TypeScript `Answer` carries no usage field. <!-- language-specific --> |

## Types

- **PIPELINE_RESULT**: TypedDict with `name`, `path`, `objectId`, optional `result_types`, and dynamic fields.
- **UPLOAD_RESULT**: Per-file result with `action`, `filepath`, `error?`, `result?`, `upload_time?`, etc.
- **TASK_STATUS**: Task status with `completedCount`, `totalCount`, `completed`, `state`, `exitCode`, and many more fields.
- **ConnectResult**: Identity payload returned by `connect()`/`login()` — `userToken`, `userId`, `displayName`, organizations, apps, teams (all optional).
- **DAPMessage**: Dict with `type`, `seq`, and optional `command`, `arguments`, `body`, `success`, `message`, `event`, `token`, etc.
- **PipelineConfig**: Pipeline definition with `name`, `description`, `version`, `components`, `source`, `project_id`.
- **QuestionHistory**: `{ 'role': str, 'content': str }`.
- **QuestionExample**: `{ 'given': str, 'result': str }`.
- **QuestionType** / **QuestionText**: question kind enum and text wrapper from `rocketride.schema`.
- **Deploy types**: `DeployArtifact`, `Deployment`, `DeploymentSchedule`, `DeployActor`, `DeployHistoryEntry`, `PublishResult`, `DeployListResult`, `DeployVersionsResult`, `DeployHistoryResult`, `SchedulePreview` (from `rocketride.types`).

### Additional client surface

Further public methods, present in both SDKs, in brief:

| Area | Methods |
| --- | --- |
| Generic invoke | `call(command, ...)` — any DAP command; `tool(...)` — invoke a pipeline tool function <!-- language-specific --> |
| Task helpers | `get_task_token`, `get_task_pipeline`, `restart` |
| Identity | `get_account_info`; static `get_server_info`, `normalize_uri` |
| Monitors | `clear_all_monitors`, `identify` (plus `add_monitor`/`remove_monitor` above) |
| Template storage | `save_template`, `get_template`, `delete_template`, `get_all_templates` |
| Log storage | `save_log`, `get_log`, `delete_log`, `list_logs` |
| Dashboard | `get_dashboard`, `list_connections`, `list_tasks` |
| Profiling | `cprofile_start`, `cprofile_stop`, `cprofile_status`, `cprofile_report`, `cprofile_report_tree` |
| Namespaces | `client.account`, `client.billing` (account and billing APIs) |

## Advanced: low-level DAP

For commands not covered by the typed surface.

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `build_request` | `def build_request(self, command: str, *, token: str = None, arguments: dict = None, data: bytes \| str = None) -> dict` | `dict` | Builds a DAP request message. |
| `request` | `async def request(self, request: dict, timeout: float = None) -> dict` | `dict` | Sends the request and returns the response. `timeout` in ms overrides the default for this call. Use `did_fail(response)` before trusting `body`. |
| `dap_request` | `async def dap_request(self, command: str, arguments: dict = None, token: str = None, timeout: float = None) -> dict` | `dict` | Shorthand: builds and sends in one call. Python-only — in TypeScript, compose `buildRequest()` + `request()`. <!-- language-specific --> |
| `did_fail` | `def did_fail(self, request: dict) -> bool` | `bool` | `True` when the response indicates failure (`success === False`). |

```python
# Two-step (build then request)
req = client.build_request('rrext_monitor', token=token, arguments={'types': ['apaevt_status_upload']})
res = await client.request(req, timeout=5000)

# One-step with dap_request
res = await client.dap_request('rrext_services', {}, timeout=5000)

if client.did_fail(res):
    raise RuntimeError(res.get('message', 'Request failed'))
```
