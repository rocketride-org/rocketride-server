<p align="center">
  <img src="https://raw.githubusercontent.com/rocketride-org/rocketride-server/develop/images/banner-typescript.png" alt="RocketRide TypeScript SDK" width="900">
</p>

<p align="center">
  Build, run, and manage AI pipelines from Node.js or the browser.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/rocketride"><img src="https://img.shields.io/npm/v/rocketride?color=222223&label=NPM" alt="npm"></a>
  <a href="https://github.com/rocketride-org/rocketride-server"><img src="https://img.shields.io/github/stars/rocketride-org/rocketride-server?style=flat&color=238636&label=GitHub&logo=github&logoColor=white" alt="GitHub"></a>
  <a href="https://discord.gg/PMXrtenMsY"><img src="https://img.shields.io/badge/Discord-Join-370b7a?logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://github.com/rocketride-org/rocketride-server/blob/develop/LICENSE"><img src="https://img.shields.io/badge/License-MIT-41b6e6" alt="MIT License"></a>
</p>

## Quick Start

```bash
# NPM
npm install rocketride
# Yarn
yarn add rocketride
# PNPM
pnpm add rocketride
```

```typescript
import { RocketRideClient } from 'rocketride';

const client = new RocketRideClient({
	auth: process.env.ROCKETRIDE_APIKEY!,
	uri: 'ws://localhost:5565', // your engine (or RocketRide Cloud: https://api.rocketride.ai)
});
await client.connect();
const { token } = await client.use({ filepath: './pipeline.pipe' });
const result = await client.send(token, 'Hello, pipeline!', { name: 'input.txt' }, 'text/plain');
console.log(result);
await client.terminate(token);
await client.disconnect();
```

Where the key comes from: when the VS Code extension connects to a self-hosted engine, it writes `ROCKETRIDE_URI` and `ROCKETRIDE_APIKEY` into your workspace `.env` automatically. For RocketRide Cloud, create a key at [cloud.rocketride.ai](https://cloud.rocketride.ai/).

Don't have a pipeline yet? Save this minimal `pipeline.pipe` next to your script (`project_id` is any identifier you choose; it groups the pipeline's runs and logs):

```json
{
  "components": [
    { "id": "webhook_1", "provider": "webhook", "config": { "hideForm": true, "mode": "Source", "parameters": {}, "type": "webhook" } },
    { "id": "response_text_1", "provider": "response_text", "config": { "laneName": "text" }, "input": [{ "lane": "text", "from": "webhook_1" }] }
  ],
  "project_id": "quickstart",
  "viewport": { "x": 0, "y": 0, "zoom": 1 },
  "version": 1
}
```

Then build real pipelines visually: visit [RocketRide on GitHub](https://github.com/rocketride-org/rocketride-server) or download the extension directly in your IDE.

<p align="center">
  <img src="https://raw.githubusercontent.com/rocketride-org/rocketride-server/develop/images/install-extension.png" alt="Install RocketRide extension" width="600">
</p>

## What is RocketRide?

[RocketRide](https://rocketride.org) is an open-source, developer-native AI pipeline platform.
It lets you build, debug, and deploy production AI workflows without leaving your IDE,
using a visual drag-and-drop canvas or code-first with TypeScript and Python SDKs.

- **115+ pipeline nodes** - 16 LLM providers, 9 vector databases, OCR, NER, PII anonymization, agents, and more
- **High-performance C++ engine** - multithreaded runtime built for AI and data workloads
- **Full TypeScript support** - complete type definitions, works in Node.js and the browser
- **MIT licensed** - fully open source, OSI-compliant

The same portable `.pipe` file runs against either deployment:

- **Self-hosted** (free, MIT): Docker, on-prem, or a local process in your IDE. Point the client at your own engine, e.g. `ws://localhost:5565`.
- **[RocketRide Cloud](https://cloud.rocketride.ai/)**: managed hosting at `https://api.rocketride.ai`, if you would rather not run an engine yourself.

<img src="https://raw.githubusercontent.com/rocketride-org/rocketride-server/develop/images/pipeline-example.png" alt="Build and run AI pipelines inside your IDE" width="800">

## Features

- **Pipeline execution** - Start with `use()`, send data via `send()`, `sendFiles()`, or `pipe()`
- **Chat** - Conversational AI via `chat()` and `Question`, with incremental output via the optional `onSSE` callback
- **Event streaming** - Real-time events via `onEvent` and `setEvents()`
- **File upload** - `sendFiles()` with progress; streaming with `pipe()`
- **Connection lifecycle** - Layered `attach()` / `login()` / `logout()` / `detach()`, persist mode with automatic reconnection, and callbacks (`onConnected`, `onDisconnected`, `onConnectError`)
- **Server filesystem API** - `fsRead()`, `fsWrite()`, `fsListDir()`, and friends for server-side project storage
- **Monitoring** - `getDashboard()`, `listConnections()`, `listTasks()` for live server state
- **Namespaced APIs** - `client.account`, `client.billing`, `client.database`, `client.deploy`, `client.log`
- **CLI included** - installing the package provides a `rocketride` command for running pipelines, uploading files, and monitoring tasks from the terminal

This page covers the core client. The full reference, including the account, billing, database, deploy, and log namespaces, lives at [docs.rocketride.org](https://docs.rocketride.org/).

---

## RocketRideClientConfig

Configuration object passed to `new RocketRideClient(config)`.

**Why it matters:** The config controls not only where you connect and how you authenticate, but also how the client behaves when the connection drops or when the server is slow to start. Getting `persist` and the callbacks right avoids confusing "connection lost" vs "never connected" UX.

| Property            | Type                                                     | Required | Description                                                                                                                                                                                                                                              |
| ------------------- | -------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth`              | `string`                                                 | No       | API key or token. Optional: omit and set via `env.ROCKETRIDE_APIKEY` or `.env` (Node only), or pass a credential directly to `connect()` / `login()`.                                                                                                    |
| `uri`               | `string`                                                 | No       | Server URI (e.g. `ws://localhost:5565` or `https://api.rocketride.ai`). `http(s)://` and `ws(s)://` schemes are both accepted and normalized automatically. Optional: omit and use `env.ROCKETRIDE_URI` or the built-in default, or pass per call via `connect(credential, { uri })` / `attach(uri)`.                                        |
| `env`               | `Record<string, string>`                                 | No       | Override env; if omitted, `.env` is loaded in Node (only), falling back to `process.env`. `ROCKETRIDE_*` values are forwarded with `use()`; the server resolves `${ROCKETRIDE_*}` in pipeline config from its merged environment.                         |
| `persist`           | `boolean`                                                | No       | Enable automatic reconnection. Default: `false`. **Use `true`** for long-lived UIs or when the server may restart; the client retries with linear backoff (250ms increments, 15s cap) until connected or `detach()`, calling `onConnectError` on each failure. Auth failures stop the retry loop. |
| `maxRetryTime`      | `number`                                                 | No       | Accepted for backward compatibility but ignored: reconnection no longer gives up on its own. Call `detach()` or `disconnect()` to stop retrying.                                                                                                         |
| `requestTimeout`    | `number`                                                 | No       | Default timeout in ms for each request; overridable per `request()` call. Prevents a single slow DAP call from hanging indefinitely.                                                                                                                     |
| `public`            | `boolean`                                                | No       | Open a public (unauthenticated) connection. Only `rrext_public_*` commands may be sent, e.g. for catalog browsing.                                                                                                                                        |
| `wsPath`            | `string`                                                 | No       | Custom WebSocket path override (default: `/task/service`).                                                                                                                                                                                               |
| `onConnected`       | `(info?: string) => Promise<void>`                       | No       | Called when connection is established. **Use** to refresh UI, refetch services, or clear "connecting" state.                                                                                                                                             |
| `onDisconnected`    | `(reason?: string, hasError?: boolean) => Promise<void>` | No       | Called when connection is lost **only if** `onConnected` was already called. So "failed to connect in the first place" does _not_ fire this - use `onConnectError` for that. **Do not** call `client.disconnect()` here if you want auto-reconnect in persist mode. |
| `onConnectError`    | `(error: ConnectionException) => void \| Promise<void>`  | No       | Called on each failed connection attempt (e.g. while retrying in persist mode). The `ConnectionException` carries structured details such as status codes. On auth failure the client stops retrying, so you can prompt the user to fix credentials and call `connect()` again. |
| `onEvent`           | `(event: DAPMessage) => Promise<void>`                   | No       | Called for each server event (e.g. upload progress, task status). **Use** to drive progress bars or status text; event type is `event.event`, payload in `event.body`.                                                                                   |
| `onProtocolMessage` | `(message: string) => void`                              | No       | Optional; for logging raw DAP messages. Helpful when debugging protocol issues.                                                                                                                                                                          |
| `onDebugMessage`    | `(message: string) => void`                              | No       | Optional; for debug output.                                                                                                                                                                                                                              |
| `module`            | `string`                                                 | No       | Client name for logging. Default: `CLIENT-0`, `CLIENT-1`, ...                                                                                                                                                                                            |
| `clientName` / `clientVersion` | `string`                                      | No       | Friendly client identification sent during auth (e.g. "VS Code" / "0.9.4"), shown in the server dashboard.                                                                                                                                               |

**Example - long-lived app with persist and status:**

```typescript
const client = new RocketRideClient({
	auth: process.env.ROCKETRIDE_APIKEY!,
	uri: 'ws://localhost:5565',
	persist: true,
	requestTimeout: 30000,
	onConnected: async () => setStatus('connected'),
	onDisconnected: async () => setStatus('disconnected'),
	onConnectError: (err) => setStatus('error', err.message),
	onEvent: async (e) => handleServerEvent(e),
});
```

## RocketRideClient

### Constructor

```typescript
constructor(config: RocketRideClientConfig = {})
```

Creates a client instance; it does **not** connect until you call `connect()` (or `attach()`). You can set up callbacks and then open the connection when ready. `auth` and `uri` are optional at construction: pass a credential to `connect(credential)` or `login(credential)`, and a URI via `connect(credential, { uri })` or `attach(uri)`.

**Example:**

```typescript
const client = new RocketRideClient({ auth: 'my-key', uri: 'ws://localhost:5565' });
await client.connect();
```

### Connection

The connection API is layered: `attach()` opens the WebSocket without authenticating (needed for public operations like catalog browsing), `login()` authenticates over an attached transport, `logout()` reverts to unauthenticated without closing the socket, and `detach()` tears the socket down. `connect()` and `disconnect()` are convenience wrappers around these layers.

| Method            | Signature                                                                                                                                                       | Returns                  | Description                                                                                                                                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `connect`         | `connect(credential?: string \| { code: string; verifier: string; redirectUri: string }, options?: { uri?: string; timeout?: number }): Promise<ConnectResult>` | `Promise<ConnectResult>` | Attach + login in one call. `credential` accepts API keys, access tokens, and `rr_*` user tokens; `options` (`uri`, `timeout`) override config per call. Returns the authenticated identity (`userId`, organizations, apps, teams). In **persist** mode failures trigger `onConnectError` and automatic retries; **auth** failures do _not_ retry so the app can fix credentials and call `connect()` again. |
| `disconnect`      | `disconnect(): Promise<void>`                                                                                                                                    | -                        | Logout + detach. Closes the connection and cancels any pending reconnection. Call when the user explicitly disconnects or the app is shutting down.                                                                                  |
| `attach`          | `attach(uri?: string, options?: { timeout?: number }): Promise<void>`                                                                                            | -                        | Opens the WebSocket **without** authenticating. Required for public/unauthenticated operations.                                                                                                                                      |
| `login`           | `login(credential?, options?): Promise<ConnectResult>`                                                                                                           | `Promise<ConnectResult>` | Authenticates over an attached transport. Supports credential rotation (auto-logout if the credential differs).                                                                                                                      |
| `logout`          | `logout(): Promise<void>`                                                                                                                                        | -                        | Reverts the connection to unauthenticated without closing the socket.                                                                                                                                                                |
| `detach`          | `detach(): Promise<void>`                                                                                                                                        | -                        | Tears down the WebSocket and cancels the reconnect engine.                                                                                                                                                                           |
| `isConnected`     | `isConnected(): boolean`                                                                                                                                         | `boolean`                | Whether the client is currently connected. Use before calling `use()` or `send()` to avoid confusing errors.                                                                                                                         |
| `isAttached`      | `isAttached(): boolean`                                                                                                                                          | `boolean`                | `true` when the WebSocket is open, regardless of auth state.                                                                                                                                                                         |
| `isAuthenticated` | `isAuthenticated(): boolean`                                                                                                                                     | `boolean`                | `true` when the auth handshake has succeeded on the current connection.                                                                                                                                                              |

**How to use:** For one-off scripts, call `connect()` once, do your work, then `disconnect()`. For UIs, use `persist: true` and rely on the client to reconnect; only call `disconnect()` when the user logs out or you are done with the client. The client supports `await using` (Symbol.asyncDispose) for automatic disconnect when exiting scope.

### Low-level DAP

RocketRide clients talk to the engine over DAP (Debug Adapter Protocol) messages on a WebSocket. The methods below let you send commands the higher-level API does not wrap.

| Method         | Signature                                                                                                                                   | Returns               | Description                                                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `buildRequest` | `buildRequest(command: string, options?: { token?: string; arguments?: Record<string, unknown>; data?: Uint8Array \| string }): DAPMessage` | `DAPMessage`          | Builds a DAP request message with the next sequence number. Use when you need a custom command not wrapped by `use()`, `send()`, etc.                                                       |
| `request`      | `request(request: DAPMessage, timeout?: number): Promise<DAPMessage>`                                                                       | `Promise<DAPMessage>` | Sends the request and returns the response. Pass `timeout` (ms) to override the config default for this call. Check `didFail(response)` or `response.success` before using `response.body`. |
| `didFail`      | `didFail(response: DAPMessage): boolean`                                                                                                    | `boolean`             | Returns `true` when the server indicated failure (`success === false`). Use after `request()` to decide whether to use `body` or surface `message` as an error.                             |
| `call`         | `call<T>(command: string, args?: Record<string, unknown>, options?: { token?: string; timeout?: number }): Promise<T>`                      | `Promise<T>`          | One-shot helper: builds the request, sends it, throws on failure, and returns the response body.                                                                                            |

**Example - custom DAP command:**

```typescript
const req = client.buildRequest('rrext_monitor', { token, arguments: { types: ['apaevt_status_upload'] } });
const res = await client.request(req, 5000);
if (client.didFail(res)) throw new Error(res.message);
```

### Pipeline execution

| Method          | Signature                                                                                                                                                                                                                                                                          | Returns                            | Description                                                                                                                                                                                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `use`           | `use(options?: { token?: string; filepath?: string; pipeline?: PipelineConfig; source?: string; threads?: number; useExisting?: boolean; args?: string[]; ttl?: number; pipelineTraceLevel?: 'none' \| 'metadata' \| 'summary' \| 'full'; name?: string; env?: Record<string, string>; teamId?: string }): Promise<Record<string, unknown> & { token: string }>` | `Promise<{ token: string, ... }>`  | Starts a pipeline. You must pass either `pipeline` (object) or `filepath` (path to a `.pipe` or JSON file; Node only, the `.pipe` wrapper is unwrapped automatically). `${ROCKETRIDE_*}` variables are resolved server-side from the merged environment; per-call `env` values override. Returns at least `token`; use that token for `send()`, `sendFiles()`, `pipe()`, `chat()`, `getTaskStatus()`, and `terminate()`. |
| `validate`      | `validate(options: { pipeline: PipelineConfig \| Record<string, unknown>; source?: string }): Promise<ValidationResult>`                                                                                                                                                            | `Promise<ValidationResult>`        | Validates a pipeline configuration without starting it. Returns a typed `ValidationResult` (`valid`, `errors`, `warnings`). Use to check pipeline correctness before `use()`.                                                                                                  |
| `terminate`     | `terminate(token: string): Promise<void>`                                                                                                                                                                                                                                           | -                                  | Stops the pipeline for that token and frees server resources. Call when the user cancels or when you are done sending data.                                                                                                                                                    |
| `getTaskStatus` | `getTaskStatus(token: string, options?: { timeout?: number \| false }): Promise<TASK_STATUS>`                                                                                                                                                                                       | `Promise<TASK_STATUS>`             | Returns current task status: e.g. `completedCount`, `totalCount`, `completed`, `state`, `exitCode`. Use to poll until `completed` is true or to show progress.                                                                                                                  |

Also available: `restart()` to restart a running task with an updated pipeline, and `getTaskToken()` / `getTaskPipeline()` to look up an existing task by project and source.

**Why `use()` returns a token:** The server runs each pipeline as a separate task. The token identifies that task so all subsequent operations (sending data, chat, status, terminate) target the right pipeline.

**Example - start from file and poll until done:**

```typescript
const { token } = await client.use({ filepath: './pipeline.pipe', ttl: 3600 });
await client.setEvents(token, ['apaevt_status_processing']);
// ... send data ...
while (true) {
	const status = await client.getTaskStatus(token);
	if (status.completed) break;
	await new Promise((r) => setTimeout(r, 2000));
}
await client.terminate(token);
```

### Data

| Method      | Signature                                                                                                                                                  | Returns                                 | Description                                                                                                                                                                                                         |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pipe`      | `pipe(token: string, objinfo?: Record<string, unknown>, mimeType?: string, provider?: string, onSSE?: (type: string, data: Record<string, unknown>) => Promise<void>): Promise<DataPipe>`                                  | `Promise<DataPipe>`                     | Creates a **streaming** data pipe. Use when you have large payloads or chunks arriving over time; you call `open()`, then one or more `write()`, then `close()`. Default MIME: `application/octet-stream`.          |
| `send`      | `send(token: string, data: string \| Uint8Array, objinfo?: Record<string, unknown>, mimetype?: string, onSSE?: (type: string, data: Record<string, unknown>) => Promise<void>): Promise<PIPELINE_RESULT \| undefined>`     | `Promise<PIPELINE_RESULT \| undefined>` | Sends data in **one shot** (internally: open pipe, write once, close). Use for small payloads when you have the full buffer in memory.                                                                              |
| `sendFiles` | `sendFiles(files: Array<{ file: File; objinfo?: Record<string, unknown>; mimetype?: string }>, token: string): Promise<UPLOAD_RESULT[]>`                   | `Promise<UPLOAD_RESULT[]>`              | Uploads multiple browser `File` objects. Results are in the same order as `files`. Progress is reported via `onEvent` as `apaevt_status_upload` events (e.g. `body.filepath`, `body.bytes_sent`, `body.file_size`). |

The optional `onSSE` callback (`(type: string, data: Record<string, unknown>) => Promise<void>`) receives incremental server-sent output, e.g. token-by-token LLM text, while the request is in flight.

**When to use `pipe` vs `send`:** Use `send()` when you have a single blob (e.g. a string or one `Uint8Array`) and don't need to stream. Use `pipe()` when you are reading a large file in chunks, or when data arrives incrementally (e.g. from a stream or multiple buffers).

**Example - send a string:**

```typescript
const result = await client.send(token, 'Hello, pipeline!', { name: 'greeting.txt' }, 'text/plain');
```

**Example - stream chunks with a pipe:**

```typescript
const pipe = await client.pipe(token, { name: 'data.json' }, 'application/json');
await pipe.open();
for (const chunk of chunks) await pipe.write(new TextEncoder().encode(chunk));
const result = await pipe.close();
```

### Events

| Method      | Signature                                                                        | Returns | Description                                                                                                                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setEvents` | `setEvents(token: string, eventTypes: string[], pipeId?: number): Promise<void>` | -       | Subscribes this task to the given event types (e.g. `apaevt_status_upload`, `apaevt_status_processing`). After this, those events are delivered to your `onEvent` callback. Call after `use()` and before or while sending data. |

### Services, monitoring, and ping

| Method            | Signature                                                                 | Returns                                      | Description                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `getServices`     | `getServices(): Promise<ServicesResponse>`                                | `Promise<ServicesResponse>`                  | Returns all service/connector definitions from the server as `{ services: Record<string, ServiceDefinition> }`. Use to discover what the server supports. |
| `getService`      | `getService(service: string): Promise<ServiceDefinition \| undefined>`    | `Promise<ServiceDefinition \| undefined>`    | Returns the definition for one service by name. Throws if the request fails.                                                                     |
| `getDashboard`    | `getDashboard(): Promise<DashboardResponse>`                              | `Promise<DashboardResponse>`                 | Live server dashboard: connections, tasks, and aggregate metrics.                                                                                |
| `listConnections` | `listConnections(req?: ListPageRequest): Promise<ListConnectionsResponse>`| `Promise<ListConnectionsResponse>`           | Pages through active server connections.                                                                                                         |
| `listTasks`       | `listTasks(req?: ListPageRequest): Promise<ListTasksResponse>`            | `Promise<ListTasksResponse>`                 | Pages through running and recent tasks.                                                                                                          |
| `ping`            | `ping(token?: string): Promise<void>`                                     | -                                            | Lightweight liveness check. Throws if the server responds with an error. Optional `token` for task-scoped ping.                                  |

### Server filesystem

Server-side project storage, replacing the removed project store methods.

| Method      | Signature                                                                                                                                    | Description                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `fsOpen`    | `fsOpen(path: string, mode: 'r' \| 'w' = 'r'): Promise<{ handle: string; size?: number }>`                                                   | Opens a server file and returns a handle for `fsRead`/`fsWrite`.   |
| `fsRead`    | `fsRead(handle: string, offset?: number, length?: number): Promise<Uint8Array>`                                                              | Reads a chunk (default up to 4 MiB) from an open handle.           |
| `fsWrite`   | `fsWrite(handle: string, data: Uint8Array): Promise<number>`                                                                                 | Appends a chunk to a handle opened with mode `'w'`.                |
| `fsClose`   | `fsClose(handle: string, mode: 'r' \| 'w'): Promise<void>`                                                                                   | Closes the handle; `mode` must match the one used in `fsOpen`.     |
| `fsListDir` | `fsListDir(path?: string): Promise<{ entries: Array<{ name: string; type: 'file' \| 'dir'; size?: number; modified?: number }>; count: number }>` | Lists a server directory.                                     |
| `fsStat`    | `fsStat(path: string): Promise<{ exists: boolean; type?: 'file' \| 'dir'; size?: number; modified?: number }>`                               | Checks existence and metadata without opening the file.            |
| `fsDelete`  | `fsDelete(path: string): Promise<void>`                                                                                                      | Deletes a server file.                                             |

Also available: `fsMkdir()`, `fsRmdir()`, `fsRename()`, `fsGetUrl()`, and the string/JSON conveniences `fsReadString()`, `fsWriteString()`, `fsReadJson()`, `fsWriteJson()` (each wraps open/read-or-write/close for you). See the [full reference](https://docs.rocketride.org/) for those signatures.

### Chat

| Method | Signature                                                                                  | Returns                    | Description                                                                                                                                                                       |
| ------ | ------------------------------------------------------------------------------------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat` | `chat(options: { token: string; question: Question; onSSE?: (type: string, data: Record<string, unknown>) => Promise<void> }): Promise<PIPELINE_RESULT>`   | `Promise<PIPELINE_RESULT>` | Sends the `Question` to the AI for the given pipeline token and returns the pipeline result. Pass `onSSE` to receive the answer incrementally as it is generated.                  |

**How it works:** The client opens a pipe with MIME type `application/rocketride-question`, writes the serialized `Question`, closes the pipe, and returns the server's result. Works with chat, webhook, and dropper sources.

### Convenience

| Method              | Signature                                                                     | Returns               | Description                                                                                        |
| ------------------- | ----------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------- |
| `getConnectionInfo` | `getConnectionInfo(): { connected: boolean; transport: string; uri: string }` | object                | Current connection state and URI. Useful for debugging or displaying "Connected to ..." in the UI. |
| `getApiKey`         | `getApiKey(): string \| undefined`                                            | `string \| undefined` | The API key in use (for debugging only; avoid logging in production).                              |

### Static

| Method           | Signature                                                                                                                            | Returns                    | Description                                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `withConnection` | `RocketRideClient.withConnection<T>(config: RocketRideClientConfig, callback: (client: RocketRideClient) => Promise<T>): Promise<T>` | `Promise<T>`               | Creates a client, calls `connect()`, runs `callback(client)`, then `disconnect()` in a `finally` block. Returns the callback result. **Use** for one-off scripts so you never forget to disconnect. |
| `getServerInfo`  | `RocketRideClient.getServerInfo(uri: string, timeout?: number): Promise<ServerInfoResult>`                                           | `Promise<ServerInfoResult>`| Probes a server without authenticating (version, public apps).                                                                                                                                      |

---

## DataPipe

Returned by `client.pipe()`. Represents one streaming upload: **open** -> one or more **write** -> **close**. The server assigns a `pipeId` when you open; each `write()` sends a chunk for that pipe, and `close()` finalizes the stream and returns the pipeline result. On server failure, `open()`, `write()`, and `close()` throw `PipeException`, which carries the full DAP response body.

| Member     | Type                           | Description                                          |
| ---------- | ------------------------------ | ---------------------------------------------------- |
| `isOpened` | `boolean` (getter)             | Whether the pipe has been opened and not yet closed. |
| `pipeId`   | `number \| undefined` (getter) | Server-assigned pipe ID; set after `open()`.         |

| Method  | Signature                                        | Returns                                 | Description                                                                 |
| ------- | ------------------------------------------------ | --------------------------------------- | --------------------------------------------------------------------------- |
| `open`  | `open(): Promise<DataPipe>`                      | `Promise<DataPipe>`                     | Opens the pipe on the server. Must be called before `write()`.              |
| `write` | `write(buffer: Uint8Array): Promise<void>`       | -                                       | Writes a chunk. Pipe must be open.                                          |
| `close` | `close(): Promise<PIPELINE_RESULT \| undefined>` | `Promise<PIPELINE_RESULT \| undefined>` | Closes the pipe and returns the processing result. No-op if already closed. |

---

## Question

From `rocketride`. Build a question for `client.chat({ token, question })`. You can add instructions (how to answer), examples (example input/output), context (background), history (prior messages), and documents (what to reference).

### Constructor

```typescript
constructor(options?: {
  type?: QuestionType;
  filter?: DocFilter;
  expectJson?: boolean;
  role?: string;
})
```

`QuestionType`: `QUESTION`, `SEMANTIC`, `KEYWORD`, `GET`, `PROMPT`. Default type is `QUESTION`. Default filter and `expectJson: false`, `role: ''` if omitted.

### Methods

| Method           | Signature                                                             | Description                                                      |
| ---------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `addInstruction` | `addInstruction(title: string, instruction: string): void`            | Adds an instruction for the AI (e.g. "Answer in bullet points"). |
| `addExample`     | `addExample(given: string, result: string \| object \| unknown[]): void` | Adds an example input/output so the AI can match format.      |
| `addContext`     | `addContext(context: string \| object \| string[] \| object[]): void` | Adds context (e.g. "Q4 2024 data").                              |
| `addHistory`     | `addHistory(item: QuestionHistory): void`                             | Adds a history item (`{ role, content }`) for multi-turn chat.   |
| `addGoal`        | `addGoal(goal: string): void`                                         | Adds a goal statement describing the desired outcome.            |
| `addQuestion`    | `addQuestion(question: string): void`                                 | Appends the main question text.                                  |
| `addDocuments`   | `addDocuments(documents: Doc \| Doc[]): void`                         | Adds documents for the AI to reference.                          |
| `getPrompt`      | `getPrompt(hasPreviousJsonFailed?: boolean): string`                  | Returns the full prompt (internal use).                          |

---

## Types

- **DAPMessage**: `{ type, seq, command?, arguments?, body?, success?, message?, request_seq?, event?, token?, data?, trace? }`.
- **ConnectResult**: The authenticated identity returned by `connect()` / `login()`: `userToken` (replayable session token), `userId`, `displayName`, organizations, apps, teams, and more.
- **TASK_STATUS**: Task status with `completedCount`, `totalCount`, `completed`, `state`, `exitCode`, and many more fields.
- **PIPELINE_RESULT**: `{ name, path, objectId, result_types?, [key: string]: any }`.
- **PipelineConfig**: Pipeline definition with `components`, `source`, `project_id`, `description`, `version`.
- **ValidationResult**: `{ valid, errors, warnings }` returned by `validate()`.
- **ServicesResponse** / **ServiceDefinition**: typed service catalog returned by `getServices()` / `getService()`.
- **UPLOAD_RESULT**: Per-file result with e.g. `action` (`'complete'` \| `'error'`), `filepath`, `error?`, `result?`, `upload_time?`.
- **QuestionHistory**: `{ role: string, content: string }`.
- **QuestionInstruction**: `{ subtitle: string, instructions: string }`.
- **QuestionExample**: `{ given: string, result: string }`.

---

## Exceptions

All errors derive from `DAPException` -> `RocketRideException`:

- **`ConnectionException`**: transport-level failures; passed to `onConnectError`.
- **`AuthenticationException`** (extends `ConnectionException`): thrown on DAP auth failure. In persist mode the client does not retry after an auth failure, so the app can fix credentials and call `connect()` again.
- **`PipeException`**: thrown by `DataPipe.open()`, `.write()`, `.close()` when the server reports failure; carries the full DAP response.
- **`ExecutionException`**, **`ValidationException`**: pipeline execution and validation failures.

---

## Examples (Full API Usage)

### 1. Minimal: connect, run pipeline from file, send one string, disconnect

```typescript
import { RocketRideClient } from 'rocketride';

const client = new RocketRideClient({
	auth: process.env.ROCKETRIDE_APIKEY!,
	uri: 'ws://localhost:5565',
});
await client.connect();
const { token } = await client.use({ filepath: './pipeline.pipe' });
const result = await client.send(token, 'Hello, pipeline!', { name: 'input.txt' }, 'text/plain');
console.log(result);
await client.terminate(token);
await client.disconnect();
```

### 2. One-off script with automatic disconnect (withConnection)

```typescript
import { RocketRideClient } from 'rocketride';

// The minimal webhook pipeline from the Quick Start above
const myPipelineConfig = {
	components: [
		{ id: 'webhook_1', provider: 'webhook', config: { hideForm: true, mode: 'Source', parameters: {}, type: 'webhook' } },
		{ id: 'response_text_1', provider: 'response_text', config: { laneName: 'text' }, input: [{ lane: 'text', from: 'webhook_1' }] },
	],
	project_id: 'quickstart',
	viewport: { x: 0, y: 0, zoom: 1 },
	version: 1,
};

const status = await RocketRideClient.withConnection({ auth: 'my-key', uri: 'ws://localhost:5565' }, async (client) => {
	const { token } = await client.use({ pipeline: myPipelineConfig });
	await client.send(token, JSON.stringify({ data: 1 }));
	return await client.getTaskStatus(token);
});
console.log(status);
```

### 3. Long-lived app: persist mode, callbacks, and status handling

```typescript
import { RocketRideClient } from 'rocketride';

const client = new RocketRideClient({
	auth: apiKey,
	uri: serverUri,
	persist: true,
	onConnected: async () => updateUI({ state: 'connected' }),
	onDisconnected: async (reason, hasError) => updateUI({ state: 'disconnected', reason, hasError }),
	onConnectError: (err) => updateUI({ state: 'error', message: err.message }),
	onEvent: async (e) => {
		if (e.event === 'apaevt_status_upload') updateProgress(e.body);
	},
});
await client.connect();
// Later: use(), sendFiles(), etc. If connection drops, client retries; do not call disconnect() in onDisconnected.
```

### 4. Upload multiple files and poll until pipeline completes

```typescript
import { RocketRideClient } from 'rocketride';

const client = new RocketRideClient({ auth, uri, onEvent: async (e) => console.log(e.event, e.body) });
await client.connect();
const { token } = await client.use({ filepath: './vectorize.pipe' });
await client.setEvents(token, ['apaevt_status_upload', 'apaevt_status_processing']);

const files = [new File([content1], 'a.md'), new File([content2], 'b.md')];
const uploadResults = await client.sendFiles(
	files.map((file) => ({ file })),
	token
);
console.log('Uploaded:', uploadResults.filter((r) => r.action === 'complete').length);

while (true) {
	const status = await client.getTaskStatus(token);
	console.log(`Progress: ${status.completedCount}/${status.totalCount}`);
	if (status.completed) break;
	await new Promise((r) => setTimeout(r, 2000));
}
await client.terminate(token);
await client.disconnect();
```

### 5. Streaming large data with a pipe

```typescript
import { RocketRideClient } from 'rocketride';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';

const client = new RocketRideClient({ auth, uri });
await client.connect();
const { token } = await client.use({ pipeline: config });

const pipe = await client.pipe(token, { name: 'large.csv' }, 'text/csv');
await pipe.open();
const rl = createInterface({ input: createReadStream('large.csv') });
for await (const line of rl) {
	await pipe.write(new TextEncoder().encode(line + '\n'));
}
const result = await pipe.close();
console.log(result);
await client.terminate(token);
await client.disconnect();
```

### 6. Chat: question with instructions and examples, streamed answer

```typescript
import { RocketRideClient, Question } from 'rocketride';

const client = new RocketRideClient({ auth, uri });
await client.connect();
const { token } = await client.use({ pipeline: chatPipelineConfig });

const question = new Question({ expectJson: true });
question.addInstruction('Format', 'Return a JSON object with keys: summary, keywords.');
question.addExample('Summarize X', { summary: '...', keywords: ['a', 'b'] });
question.addQuestion('Summarize the main points and list keywords.');

const response = await client.chat({
	token,
	question,
	onSSE: async (type, data) => process.stdout.write(String(data.text ?? '')),
});
const answerText = response?.data?.answer ?? response?.answers?.[0] ?? '';
if (answerText) {
	console.log(JSON.parse(String(answerText)));
}

await client.terminate(token);
await client.disconnect();
```

### 7. Discover services and send a custom DAP request

```typescript
import { RocketRideClient } from 'rocketride';

const client = new RocketRideClient({ auth, uri });
await client.connect();

const { services } = await client.getServices();
console.log('Available:', Object.keys(services));
const ocrSchema = await client.getService('ocr');

const req = client.buildRequest('rrext_ping', { token: myToken });
const res = await client.request(req, 5000);
if (client.didFail(res)) throw new Error(res.message);
await client.disconnect();
```

---

## Links

- [Documentation](https://docs.rocketride.org/)
- [GitHub](https://github.com/rocketride-org/rocketride-server)
- [Discord](https://discord.gg/PMXrtenMsY)
- [Contributing](https://github.com/rocketride-org/rocketride-server/blob/develop/CONTRIBUTING.md)
- [RocketRide Cloud](https://cloud.rocketride.ai/)

## License

MIT - see [LICENSE](https://github.com/rocketride-org/rocketride-server/blob/develop/LICENSE).
