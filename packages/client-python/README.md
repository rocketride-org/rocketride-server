# Python Client API (`rocketride-client-python`)

Complete API reference for the Python client. Both clients use DAP over WebSocket; the client accepts `http`/`https` or `ws`/`wss` and converts to WebSocket when needed.

---

## Building (from source)

From the repository root:

```bash
./builder client-python:build
```

This builds the wheel and syncs it to the server dist. The builder resolves dependencies (nodes, ai) automatically.

---

## Installation

```bash
pip install rocketride-client-python
```

Import from the package (e.g. `from rocketride import RocketRideClient`).

---

## RocketRideClient (Python) – constructor

```py
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
)
```

**Why the options matter:** `uri` and `auth` tell the client *where* and *how* to authenticate. `persist` and `max_retry_time` control what happens when the connection fails or the server is not ready yet: with `persist=True` the client retries with exponential backoff and calls `on_connect_error` on each failure, so you can show "Still connecting…" or "Connection failed" without implementing retry logic yourself. Use `on_disconnected` only for "we were connected and then dropped"; use `on_connect_error` for "failed to connect" or "gave up after max retry time."

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `uri` | `str` | Yes* | Server URI. *Can be empty if `ROCKETRIDE_URI` is set in env/`.env`. |
| `auth` | `str` | Yes* | API key. *Can be empty if `ROCKETRIDE_APIKEY` is set. |
| `env` | `dict` | No | Override env; if omitted, `.env` is loaded. Use when passing config in code instead of env files. |
| `module` | `str` | No | Client name for logging. |
| `request_timeout` | `float` | No | Default timeout in ms for requests. Prevents a single DAP call from hanging. |
| `max_retry_time` | `float` | No | Max time in ms to keep retrying connection. Use (e.g. 300000) so the app can show "gave up" after a bounded time. |
| `persist` | `bool` | No | Enable automatic reconnection. Default: `False`. Set `True` for long-lived scripts or UIs. |
| `on_event` | async callable | No | Called with each server event dict. Use for progress or status updates. |
| `on_connected` | async callable | No | Called when connection is established. |
| `on_disconnected` | async callable | No | Called when connection is lost **only if** connected first; args: `reason`, `has_error`. Do not call `disconnect()` here if you want auto-reconnect. |
| `on_connect_error` | callable `(message: str)` | No | Called on each failed connection attempt. On auth failure the client stops retrying. |

Raises `ValueError` if both `uri` and `ROCKETRIDE_URI` are empty or if `auth` is missing and not in env.

**Example — client with persist and callbacks:**

```py
client = RocketRideClient(
    uri="https://eaas.example.com",
    auth="my-key",
    persist=True,
    max_retry_time=300000,
    on_connect_error=lambda msg: print("Connect error:", msg),
    on_event=handle_event,
)
```

---

## RocketRideClient (Python) – context manager

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `__aenter__` | `async def __aenter__(self)` | `self` | Enters context; calls `connect()`. |
| `__aexit__` | `async def __aexit__(self, exc_type, exc_val, exc_tb)` | — | Exits context; calls `disconnect()`. |

**How to use:** Prefer `async with RocketRideClient(...) as client:` so the connection is always closed when you leave the block, even on exception. No need to call `disconnect()` manually.

**Example:**

```py
async with RocketRideClient(uri="wss://eaas.example.com", auth=os.environ["ROCKETRIDE_APIKEY"]) as client:
    result = await client.use(filepath="pipeline.json")
    token = result["token"]
    await client.send(token, "Hello, pipeline!")
```

---

## RocketRideClient (Python) – connection

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `connect` | `async def connect(self) -> None` | — | Opens the WebSocket and performs DAP auth. In **persist** mode, on failure the client calls `on_connect_error` and retries; on **auth** failure it does not retry. |
| `disconnect` | `async def disconnect(self) -> None` | — | Closes the connection and cancels reconnection. Call when the user disconnects or the script is done. |
| `is_connected` | `def is_connected(self) -> bool` | `bool` | Whether the client is connected. Check before calling `use()` or `send()` if needed. |
| `get_connection_info` | `def get_connection_info(self) -> Optional[str]` | `str \| None` | Current connection info from the transport (e.g. URI). Returns `None` if not connected. Useful for debugging or UI. |
| `get_apikey` | `def get_apikey(self) -> Optional[str]` | `str \| None` | The API key in use. For debugging only; avoid logging in production. |

---

## RocketRideClient (Python) – low-level DAP

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `build_request` | `def build_request(self, command: str, *, token: str = None, arguments: dict = None, data: bytes \| str = None) -> dict` | `dict` | Builds a DAP request message. Use for custom commands not covered by `use()`, `send()`, etc. |
| `request` | `async def request(self, request: dict, timeout: float = None) -> dict` | `dict` | Sends the request and returns the response. `timeout` in ms overrides the default for this call. Use `did_fail(response)` before trusting `body`. |
| `did_fail` | `def did_fail(self, request: dict) -> bool` | `bool` | Returns `True` when the response indicates failure (`success === False`). |

**Example:**

```py
req = client.build_request("apaext_monitor", token=token, arguments={"types": ["apaevt_status_upload"]})
res = await client.request(req, timeout=5000)
if client.did_fail(res):
    raise RuntimeError(res.get("message", "Request failed"))
```

---

## RocketRideClient (Python) – pipeline execution

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `use` | `async def use(self, *, token: str = None, filepath: str = None, pipeline: dict = None, source: str = None, threads: int = None, use_existing: bool = None, args: list = None, ttl: int = None) -> dict` | `dict` | Starts a pipeline. Requires `filepath` or `pipeline`. The client substitutes `${ROCKETRIDE_*}` from its env. Returns a dict with at least `'token'`; use that token for all data and control operations. |
| `terminate` | `async def terminate(self, token: str) -> None` | — | Stops the pipeline and frees server resources. |
| `get_task_status` | `async def get_task_status(self, token: str) -> dict` | `dict` | Returns current task status (e.g. completed count, total, state). Poll until `completed` or use for progress display. |

**Why a token:** The server runs each pipeline as a separate task. The token identifies that task so `send()`, `send_files()`, `pipe()`, `chat()`, and `get_task_status()` target the correct pipeline.

---

## RocketRideClient (Python) – data

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `pipe` | `async def pipe(self, token: str, objinfo: dict = None, mime_type: str = None, provider: str = None) -> DataPipe` | `DataPipe` | Creates a **streaming** pipe: open, then one or more write, then close. Use for large or chunked data. Default MIME: `'application/octet-stream'`. |
| `send` | `async def send(self, token: str, data: str \| bytes, objinfo: dict = None, mimetype: str = None) -> PIPELINE_RESULT` | `PIPELINE_RESULT` | Sends data in **one shot** (open pipe, write once, close). Use when you have the full payload in memory. |
| `send_files` | `async def send_files(self, files: List[str \| Tuple[str, dict] \| Tuple[str, dict, str]], token: str) -> List[UPLOAD_RESULT]` | `List[UPLOAD_RESULT]` | Uploads files. Each item: path `str`, or `(path, objinfo)`, or `(path, objinfo, mimetype)`. Progress via `on_event` as `apaevt_status_upload`. |

**When to use pipe vs send:** Use `send()` for a single string or bytes. Use `pipe()` when you read a file in chunks, or when data arrives incrementally.

**Example — send a string:**

```py
result = await client.send(token, "Hello, pipeline!", objinfo={"name": "greeting.txt"}, mimetype="text/plain")
```

**Example — stream with a pipe (context manager):**

```py
pipe = await client.pipe(token, mime_type="application/json")
async with pipe:
    await pipe.write(b'{"key": "value1"}')
    await pipe.write(b'{"key": "value2"}')
result = await pipe.close()  # result available after context
```

---

## RocketRideClient (Python) – events

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `set_events` | `async def set_events(self, token: str, event_types: List[str]) -> None` | — | Subscribes this task to the given event types. After this, those events are delivered to `on_event`. Call after `use()` when you need upload or processing progress. |

---

## RocketRideClient (Python) – services and ping

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `get_services` | `async def get_services(self) -> dict` | `dict` | Returns all service definitions. Use to discover what the server supports. |
| `get_service` | `async def get_service(self, service: str) -> Optional[dict]` | `dict \| None` | Returns one service by name; `None` if not found or on error. |
| `ping` | `async def ping(self, token: str = None) -> None` | — | Liveness check; raises on failure. |

---

## RocketRideClient (Python) – chat

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `chat` | `async def chat(self, *, token: str, question: Question) -> PIPELINE_RESULT` | `PIPELINE_RESULT` | Sends the `Question` to the AI for the given token and returns the pipeline result. The answer is in the result body; use the schema's answer helpers if you need to parse JSON from the AI text. |

**How it works:** The client opens a pipe with the question MIME type, writes the serialized `Question`, closes the pipe, and returns the server result. The pipeline must support the chat provider.

---

## DataPipe (Python)

Returned by `await client.pipe(...)`. One streaming upload: **open** → **write** (one or more) → **close**. You can also use it as an async context manager: entering calls `open()`, exiting calls `close()`.

| Property | Type | Description |
|----------|------|-------------|
| `is_opened` | `bool` | Whether the pipe is open. |
| `pipe_id` | `int \| None` | Server-assigned pipe ID after `open()`. |

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `open` | `async def open(self) -> DataPipe` | `self` | Opens the pipe; required before `write()`. |
| `write` | `async def write(self, buffer: bytes) -> None` | — | Writes a chunk. Pipe must be open. |
| `close` | `async def close(self) -> PIPELINE_RESULT` | `PIPELINE_RESULT` | Closes the pipe and returns the processing result. |
| `__aenter__` | `async def __aenter__(self)` | `self` | Enters context; calls `open()`. |
| `__aexit__` | `async def __aexit__(self, exc_type, exc_val, exc_tb)` | — | Exits context; calls `close()`. |

---

## Question (Python)

From `rocketride.schema`. Build a question for `client.chat(token=..., question=question)`. Add instructions, examples, context, history, and documents to steer the AI.

### Constructor

```py
Question(
    type: QuestionType = QuestionType.SEMANTIC,
    filter: DocFilter = None,
    expectJson: bool = False,
    role: str = '',
)
```

### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `addInstruction` | `addInstruction(self, title: str, instruction: str)` | Adds an instruction (e.g. "Use bullet points"). |
| `addExample` | `addExample(self, given: str, result: dict \| list \| str)` | Adds an example input/output; `result` can be dict/list (JSON-serialized). |
| `addContext` | `addContext(self, context: str \| dict \| List[str] \| List[dict])` | Adds context. |
| `addHistory` | `addHistory(self, item: QuestionHistory)` | Adds a history item for multi-turn chat. |
| `addQuestion` | `addQuestion(self, question: str)` | Appends the question text. |
| `addDocuments` | `addDocuments(self, documents: Doc \| List[Doc])` | Adds documents for the AI to reference. |
| `getPrompt` | `getPrompt(self, has_previous_json_failed: bool = False) -> str` | Returns the full prompt (internal). |

---

## Types (Python)

- **PIPELINE_RESULT**: TypedDict with `name`, `path`, `objectId`, optional `result_types`, and dynamic fields.
- **UPLOAD_RESULT**: Per-file result with `action`, `filepath`, `error?`, `result?`, `upload_time?`, etc.
- **DAPMessage**: Dict with `type`, `seq`, and optional `command`, `arguments`, `body`, `success`, `message`, `event`, `token`, etc.
- **QuestionHistory**: `{ 'role': str, 'content': str }`.
- **QuestionInstruction**: `{ 'subtitle': str, 'instructions': str }`.
- **QuestionExample**: `{ 'given': str, 'result': str }`.

---

## Exceptions (Python)

`AuthenticationException` (from `rocketride.core.exceptions`); thrown on DAP auth failure. In persist mode the client catches it, calls `on_connect_error`, and does not retry so the app can fix credentials and call `connect()` again.

---

## Examples (full API usage)

### 1. Minimal: connect, run pipeline from file, send one string, disconnect

```py
import asyncio
from rocketride import RocketRideClient

async def main():
    client = RocketRideClient(uri="https://eaas.example.com", auth="my-key")
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

```py
import asyncio
from rocketride import RocketRideClient

async def main():
    async with RocketRideClient(uri="wss://eaas.example.com", auth="my-key") as client:
        result = await client.use(pipeline={"pipeline": my_pipeline_config})
        token = result["token"]
        await client.send(token, '{"data": 1}')
        status = await client.get_task_status(token)
        print(status)
        await client.terminate(token)

asyncio.run(main())
```

### 3. Long-lived client with persist and callbacks

```py
import asyncio
from rocketride import RocketRideClient

async def on_evt(event):
    if event.get("event") == "apaevt_status_upload":
        body = event.get("body", {})
        print("Upload:", body.get("filepath"), body.get("bytes_sent"), body.get("file_size"))

async def main():
    client = RocketRideClient(
        uri="https://eaas.example.com",
        auth="my-key",
        persist=True,
        max_retry_time=300000,
        on_connect_error=lambda msg: print("Connect error:", msg),
        on_event=on_evt,
    )
    await client.connect()
    # Use client; if connection drops, it will retry. Do not call disconnect() in on_disconnected.
    result = await client.use(filepath="pipeline.json")
    token = result["token"]
    # ... send data, chat, etc. ...
    await client.terminate(token)
    await client.disconnect()

asyncio.run(main())
```

### 4. Upload multiple files and poll until pipeline completes

```py
import asyncio
from pathlib import Path
from rocketride import RocketRideClient

async def main():
    client = RocketRideClient(uri="https://eaas.example.com", auth="my-key")
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

### 5. Streaming large data with a pipe (context manager)

```py
import asyncio
from rocketride import RocketRideClient

async def main():
    async with RocketRideClient(uri="https://eaas.example.com", auth="my-key") as client:
        result = await client.use(filepath="ingest.json")
        token = result["token"]
        pipe = await client.pipe(token, objinfo={"name": "large.csv"}, mime_type="text/csv")
        async with pipe:
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

### 6. Chat: Question with instructions and examples, structured answer

```py
import asyncio
from rocketride import RocketRideClient
from rocketride.schema import Question

async def main():
    async with RocketRideClient(uri="https://eaas.example.com", auth="my-key") as client:
        result = await client.use(filepath="chat_pipeline.json")
        token = result["token"]
        question = Question(expectJson=True)
        question.addInstruction("Format", "Return a JSON object with keys: summary, keywords.")
        question.addExample("Summarize X", {"summary": "...", "keywords": ["a", "b"]})
        question.addQuestion("Summarize the main points and list keywords.")
        response = await client.chat(token=token, question=question)
        # Extract answer from response body; parse JSON if needed
        data = response.get("data", {})
        answer = data.get("answer") or (response.get("answers") or [None])[0]
        if answer and isinstance(answer, str):
            import json
            structured = json.loads(answer)
            print(structured)
        await client.terminate(token)

asyncio.run(main())
```

### 7. Discover services and send a custom DAP request

```py
import asyncio
from rocketride import RocketRideClient

async def main():
    client = RocketRideClient(uri="https://eaas.example.com", auth="my-key")
    await client.connect()
    services = await client.get_services()
    print("Available:", list(services.keys()))
    ocr = await client.get_service("ocr")
    if ocr:
        print("OCR schema:", ocr.get("schema"))
    req = client.build_request("apaext_ping", token=my_token)
    res = await client.request(req, timeout=5000)
    if client.did_fail(res):
        raise RuntimeError(res.get("message", "Ping failed"))
    await client.disconnect()

asyncio.run(main())
```
