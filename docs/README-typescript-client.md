<p align="center">
  <img src="https://raw.githubusercontent.com/rocketride-org/rocketride-server/main/images/banner-typescript.png" alt="RocketRide TypeScript SDK" width="900">
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
	uri: 'https://api.rocketride.ai',
});
await client.connect();
const { token } = await client.use({ filepath: './pipeline.pipe' });
const result = await client.send(token, 'Hello, pipeline!', { name: 'input.txt' }, 'text/plain');
console.log(result);
await client.terminate(token);
await client.disconnect();
```

Don't have a pipeline yet? Visit [RocketRide on GitHub](https://github.com/rocketride-org/rocketride-server) or download the extension directly in your IDE.

<p align="center">
  <img src="https://raw.githubusercontent.com/rocketride-org/rocketride-server/main/images/install.png" alt="Install RocketRide extension" width="600">
</p>

## What is RocketRide?

[RocketRide](https://rocketride.org) is an open source, developer-native AI pipeline platform.
It lets you build, debug, and deploy production AI workflows without leaving your IDE -
using a visual drag-and-drop canvas or code-first with TypeScript and Python SDKs.

- **100+ ready-to-use nodes** - 15+ LLM providers, 9 vector databases, OCR, NER, PII anonymization, and more
- **High-performance C++ engine** - production-grade speed and reliability
- **Deploy anywhere** - locally, on-premises, or self-hosted with Docker
- **MIT licensed** - fully open source, OSI-compliant

You build your `.pipe` - and you run it against the fastest AI runtime available.

<img src="https://raw.githubusercontent.com/rocketride-org/rocketride-server/develop/docs/images/canvas.png" alt="RocketRide visual canvas builder" width="800">

## Features

- **Pipeline execution** - Start with `use()`, send data via `send()`, `sendFiles()`, or `pipe()`
- **Chat** - Conversational AI via `chat()` and `Question`
- **Event streaming** - Real-time events via `onEvent` and `setEvents()`
- **File upload** - `sendFiles()` with progress; streaming with `pipe()`
- **Connection lifecycle** - Optional persist mode, reconnection, and callbacks (`onConnected`, `onDisconnected`, `onConnectError`)
- **Full TypeScript support** - Complete type definitions

---

## RocketRideClientConfig

Configuration object passed to `new RocketRideClient(config)`.

**Why it matters:** The config controls not only where you connect and how you authenticate, but also how the client behaves when the connection drops or when the server is slow to start. Getting `persist` and the callbacks right avoids confusing "connection lost" vs "never connected" UX.

| Property            | Type                                                     | Required | Description                                                                                                                                                                                                                                                                       |
| ------------------- | -------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth`              | `string`                                                 | No       | Initial API key. Optional: omit and use `env.ROCKETRIDE_APIKEY` or pass a credential directly to `login()` or `connect()`.                                                                                                                                                      |
| `uri`               | `string`                                                 | No       | Initial server URI (e.g. `https://api.rocketride.ai` or `ws://localhost:8080`). Optional: omit and use `env.ROCKETRIDE_URI` or the built-in default; `attach()`, `login()`, and `connect()` accept URI overrides.                                                               |
| `env`               | `Record<string, string>`                                 | No       | Environment override used for `${ROCKETRIDE_*}` substitution and credential/URI defaults. If omitted in Node, the SDK copies string values from `process.env`; it does not load `.env` files.                                                                                  |
| `persist`           | `boolean`                                                | No       | Enable automatic reconnection with capped linear backoff. Default: `false`. Retries start at 250ms, increase by 250ms after each failure, and are capped at 15 seconds. An explicit foreground connection action, `logout()`, or `detach()` cancels stale scheduled work.         |
| `maxRetryTime`      | `number`                                                 | No       | Accepted for backward compatibility but currently ignored. Persistent reconnection has no time limit; stop it explicitly with `logout()`, `detach()`, or `disconnect()`.                                                                                                        |
| `requestTimeout`    | `number`                                                 | No       | Default timeout in ms for each request; overridable per `request()` call. Prevents a single slow DAP call from hanging indefinitely.                                                                                                                                              |
| `onConnected`       | `(info?: string) => Promise<void>`                       | No       | Called exactly once for an accepted authenticated connection generation, after authentication and best-effort monitor restoration completes.                                                                                                                                      |
| `onDisconnected`    | `(reason?: string, hasError?: boolean) => Promise<void>` | No       | Called at most once for a generation, and only if that generation previously published `onConnected`. A failed or cancelled pre-authentication attempt does not call it. Do not call `disconnect()` here if you want persistent reconnection.                                  |
| `onConnectError`    | `(error: ConnectionException) => void \| Promise<void>`  | No       | Called for automatic reconnect failures; the next retry waits for this callback. Foreground `login()` and `connect()` failures reject their returned promises directly. Authentication failure stops automatic authentication retries.                                      |
| `onEvent`           | `(event: DAPMessage) => Promise<void>`                   | No       | Called for each server event (e.g. upload progress, task status). **Use** to drive progress bars or status text; event type is `event.event`, payload in `event.body`.                                                                                                            |
| `onProtocolMessage` | `(message: string) => void`                              | No       | Optional; receives credential-redacted DAP messages for protocol debugging.                                                                                                                                                                                                         |
| `onTrace`           | `(type: TraceType, message: DAPMessage) => void`         | No       | Called around high-level SDK requests with a credential-redacted message copy for logging or telemetry.                                                                                                                                                                             |
| `onDebugMessage`    | `(message: string) => void`                              | No       | Optional; for debug output.                                                                                                                                                                                                                                                       |
| `module`            | `string`                                                 | No       | Client name for logging. Default: `CLIENT-0`, `CLIENT-1`, ...                                                                                                                                                                                                                     |

**Example - long-lived app with persist and status:**

```typescript
const client = new RocketRideClient({
	auth: process.env.ROCKETRIDE_APIKEY!,
	uri: 'wss://api.rocketride.ai',
	persist: true,
	requestTimeout: 30000,
	onConnected: async () => setStatus('connected'),
	onDisconnected: async () => setStatus('disconnected'),
	onConnectError: (error) => setStatus('error', error.message),
	onEvent: async (e) => handleServerEvent(e),
});
```

## RocketRideClient

### Constructor

```typescript
constructor(config: RocketRideClientConfig = {})
```

Creates a client instance; it does **not** open a connection until you call `attach()`, `login()`, or `connect()`. `auth` and `uri` are optional at construction; pass per-call overrides to `login()` or `connect()`, or a URI override to `attach()`.

**Example:**

```typescript
const client = new RocketRideClient({ auth: 'my-key', uri: 'https://api.rocketride.ai' });
await client.connect();
```

### Connection

| Method            | Signature                                                                                                                                                       | Returns                  | Description                                                                                                                                                                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `attach`          | `attach(uri?: string, options?: { timeout?: number }): Promise<void>`                                                                                            | `Promise<void>`          | Opens an anonymous WebSocket attachment without authenticating. Public `rrext_public_*` requests are available. A URI override becomes the current endpoint.                                                                                                       |
| `detach`          | `detach(): Promise<void>`                                                                                                                                        | `Promise<void>`          | Cancels pending login and reconnect work, closes a CONNECTING or OPEN transport, and leaves the client detached. An in-flight login rejects with cancellation reason `detached`.                                                                                   |
| `isAttached`      | `isAttached(): boolean`                                                                                                                                          | `boolean`                | Whether the WebSocket transport is open, regardless of authentication.                                                                                                                                                                                            |
| `login`           | `login(credential?: string \| { code: string; verifier: string; redirectUri: string }, options?: { uri?: string; timeout?: number }): Promise<ConnectResult>`     | `Promise<ConnectResult>` | Attaches if needed, authenticates, restores monitor subscriptions, and returns account data. The credential and URI may override construction-time values.                                                                                                        |
| `logout`          | `logout(): Promise<void>`                                                                                                                                        | `Promise<void>`          | Clears authentication while retaining an anonymous attachment. During an in-flight login it cancels all joined waiters with reason `logout`, discards the login transport, and establishes a fresh anonymous attachment instead of depending on deauthentication ordering. |
| `isAuthenticated` | `isAuthenticated(): boolean`                                                                                                                                     | `boolean`                | Whether authentication succeeded for the current attachment.                                                                                                                                                                                                     |
| `connect`         | `connect(credential?: string \| { code: string; verifier: string; redirectUri: string }, options?: { uri?: string; timeout?: number }): Promise<ConnectResult>`   | `Promise<ConnectResult>` | Compatibility method that performs attach and login as one foreground operation.                                                                                                                                                                                  |
| `disconnect`      | `disconnect(): Promise<void>`                                                                                                                                    | `Promise<void>`          | Compatibility method that performs best-effort logout/deauthentication, then cancels pending work and detaches. Call it when the user explicitly disconnects or the app is shutting down.                                                                         |
| `isConnected`     | `isConnected(): boolean`                                                                                                                                         | `boolean`                | Compatibility alias for `isAttached()`; it does not imply authentication.                                                                                                                                                                                         |
| `setEnv`          | `setEnv(env: Record<string, string>): void`                                                                                                                     | `void`                   | Replaces the client's environment map. `use()`/`validate()` use it for `ROCKETRIDE_*` substitution; `login()` consults `ROCKETRIDE_APIKEY` when no explicit credential is supplied.                                                                                |

Concurrent foreground `login()` or `connect()` calls for the same final WebSocket endpoint and resolved credential join one operation: they share one attachment, one authentication request, and one result. A different foreground login supersedes the earlier operation. A foreground login also supersedes an automatic background reconnect, while background work never supersedes foreground work. Superseded waiters reject with `LoginAttemptCancelledError('superseded')`.

`LoginAttemptCancelledError.reason` is exactly `'superseded'`, `'logout'`, or `'detached'`. It is intentionally a plain `Error`, not a `RocketRideException`. An unsolicited transport loss during login rejects with `ConnectionException` instead of a cancellation error. The first terminal cause wins for every caller joined to an operation.

With `persist: true`, an unexpected loss schedules a generation-owned background reconnect using linear backoff: 250ms, 500ms, 750ms, and so on to a 15-second cap. A successful foreground login resets the delay. Foreground `attach()`, `login()`, or `connect()`, URI changes, `logout()`, `detach()`, and `disconnect()` invalidate stale timers before waiting, so stale callbacks cannot publish state. Authentication failures are not retried automatically. `maxRetryTime` is accepted for compatibility but ignored.

**How to use:** For one-off scripts, call `connect()` once, do your work, then `disconnect()`. For UIs that need anonymous public calls before sign-in, call `attach()`, then `login()`, and use `logout()` to return to a fresh anonymous attachment. With `persist: true`, rely on the client to reconnect after unexpected loss; only call `detach()` or `disconnect()` when reconnection should stop. The client supports `await using` (`Symbol.asyncDispose`) for automatic disconnect when exiting scope.

### Low-level DAP

| Method         | Signature                                                                                                                                   | Returns               | Description                                                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `buildRequest` | `buildRequest(command: string, options?: { token?: string; arguments?: Record<string, unknown>; data?: Uint8Array \| string }): DAPMessage` | `DAPMessage`          | Builds a DAP request message with the next sequence number. Use when you need a custom command not wrapped by `use()`, `send()`, etc.                                                       |
| `request`      | `request(request: DAPMessage, timeout?: number): Promise<DAPMessage>`                                                                       | `Promise<DAPMessage>` | Sends the request and returns the response. Pass `timeout` (ms) to override the config default for this call. Check `didFail(response)` or `response.success` before using `response.body`. |
| `didFail`      | `didFail(response: DAPMessage): boolean`                                                                                                    | `boolean`             | Returns `true` when the server indicated failure (`success === false`). Use after `request()` to decide whether to use `body` or surface `message` as an error.                             |

**Example - custom DAP command:**

```typescript
const req = client.buildRequest('rrext_monitor', { token, arguments: { types: ['apaevt_status_upload'] } });
const res = await client.request(req, 5000);
if (client.didFail(res)) throw new Error(res.message);
```

### Pipeline execution

| Method          | Signature                                                                                                                                                                                                                    | Returns                            | Description                                                                                                                                                                                                                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `use`           | `use(options?: { token?: string; filepath?: string; pipeline?: PipelineConfig; source?: string; threads?: number; useExisting?: boolean; args?: string[]; ttl?: number }): Promise<Record<string, any> & { token: string }>` | `Promise<{ token: string, ... }>`  | Starts a pipeline. You must pass either `pipeline` (object) or `filepath` (path to a JSON file; Node only). The client substitutes `${ROCKETRIDE_*}` in the config from its configured environment map. Returns at least `token`; use that token for `send()`, `sendFiles()`, `pipe()`, `chat()`, `getTaskStatus()`, and `terminate()`. |
| `validate`      | `validate(options: { pipeline: PipelineConfig \| Record<string, unknown>; source?: string }): Promise<Record<string, unknown>>`                                                                                              | `Promise<Record<string, unknown>>` | Validates a pipeline configuration without starting it. Returns validation results (e.g. errors, warnings). Use to check pipeline correctness before `use()`.                                                                                                                                                                  |
| `terminate`     | `terminate(token: string): Promise<void>`                                                                                                                                                                                    | -                                  | Stops the pipeline for that token and frees server resources. Call when the user cancels or when you are done sending data.                                                                                                                                                                                                    |
| `getTaskStatus` | `getTaskStatus(token: string, options?: { timeout?: number \| false }): Promise<TASK_STATUS>`                                                                                                                                | `Promise<TASK_STATUS>`             | Returns current task status: e.g. `completedCount`, `totalCount`, `completed`, `state`, `exitCode`. Use to poll until `completed` is true or to show progress.                                                                                                                                                                 |

**Why `use()` returns a token:** The server runs each pipeline as a separate task. The token identifies that task so all subsequent operations (sending data, chat, status, terminate) target the right pipeline.

**Example - start from file and poll until done:**

```typescript
const { token } = await client.use({ filepath: './pipeline.json', ttl: 3600 });
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

| Method      | Signature                                                                                                                                  | Returns                                 | Description                                                                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pipe`      | `pipe(token: string, objinfo?: Record<string, any>, mimeType?: string, provider?: string): Promise<DataPipe>`                              | `Promise<DataPipe>`                     | Creates a **streaming** data pipe. Use when you have large payloads or chunks arriving over time; you call `open()`, then one or more `write()`, then `close()`. Default MIME: `application/octet-stream`.          |
| `send`      | `send(token: string, data: string \| Uint8Array, objinfo?: Record<string, any>, mimetype?: string): Promise<PIPELINE_RESULT \| undefined>` | `Promise<PIPELINE_RESULT \| undefined>` | Sends data in **one shot** (internally: open pipe, write once, close). Use for small payloads when you have the full buffer in memory.                                                                              |
| `sendFiles` | `sendFiles(files: Array<{ file: File; objinfo?: Record<string, any>; mimetype?: string }>, token: string, maxConcurrent?: number): Promise<UPLOAD_RESULT[]>` | `Promise<UPLOAD_RESULT[]>` | Uploads multiple browser `File` objects with a positive integer concurrency limit. Results are in the same order as `files`. Progress is reported via `onEvent` as `apaevt_status_upload` events (e.g. `body.filepath`, `body.bytes_sent`, `body.file_size`). |

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

| Method      | Signature                                                       | Returns | Description                                                                                                                                                                                                                      |
| ----------- | --------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setEvents` | `setEvents(token: string, eventTypes: string[], pipeId?: number): Promise<void>` | -       | Subscribes this task (or optional pipe) to the given event types (e.g. `apaevt_status_upload`, `apaevt_status_processing`). After this, those events are delivered to your `onEvent` callback. Call after `use()` and before or while sending data. |

### Services, validation, and ping

| Method        | Signature                                                                | Returns                                     | Description                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `getServices` | `getServices(): Promise<Record<string, any>>`                            | `Promise<Record<string, any>>`              | Returns all service/connector definitions from the server (schemas, UI schemas). Use to discover what pipelines or features the server supports. |
| `getService`  | `getService(service: string): Promise<Record<string, any> \| undefined>` | `Promise<Record<string, any> \| undefined>` | Returns the definition for one service by name. Throws if the request fails.                                                                     |
| `ping`        | `ping(token?: string): Promise<void>`                                    | -                                           | Lightweight liveness check. Throws if the server responds with an error. Optional `token` for task-scoped ping.                                  |

### Chat

| Method | Signature                                                                        | Returns                    | Description                                                                                                                                                                                                                                            |
| ------ | -------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `chat` | `chat(options: { token: string; question: Question }): Promise<PIPELINE_RESULT>` | `Promise<PIPELINE_RESULT>` | Sends the `Question` to the AI for the given pipeline token and returns the pipeline result. The answer content is in the result body (e.g. fields described by `result_types`); you can use `Answer.parseJson()` on raw text if the AI returned JSON. |

**How it works:** The client opens a pipe with MIME type `application/rocketride-question`, writes the serialized `Question`, closes the pipe, and returns the server's result. The pipeline must support the chat provider for that token.

### Convenience

| Method              | Signature                                                                     | Returns               | Description                                                                                        |
| ------------------- | ----------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------- |
| `getConnectionInfo` | `getConnectionInfo(): { connected: boolean; transport: string; uri: string }` | object                | Current connection state and URI. Useful for debugging or displaying "Connected to ..." in the UI. |
| `getApiKey`         | `getApiKey(): string \| undefined`                                            | `string \| undefined` | The API key in use (for debugging only; avoid logging in production).                              |

### Static

| Method           | Signature                                                                                                                            | Returns      | Description                                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `withConnection` | `RocketRideClient.withConnection<T>(config: RocketRideClientConfig, callback: (client: RocketRideClient) => Promise<T>): Promise<T>` | `Promise<T>` | Creates a client, calls `connect()`, runs `callback(client)`, then `disconnect()` in a `finally` block. Returns the callback result. **Use** for one-off scripts so you never forget to disconnect. |

---

## DataPipe

Returned by `client.pipe()`. Represents one streaming upload: **open** -> one or more **write** -> **close**. The server assigns a `pipeId` when you open; each `write()` sends a chunk for that pipe, and `close()` finalizes the stream and returns the pipeline result.

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
| `addExample`     | `addExample(given: string, result: string \| object \| any[]): void`  | Adds an example input/output so the AI can match format.         |
| `addContext`     | `addContext(context: string \| object \| string[] \| object[]): void` | Adds context (e.g. "Q4 2024 data").                              |
| `addHistory`     | `addHistory(item: QuestionHistory): void`                             | Adds a history item (`{ role, content }`) for multi-turn chat.   |
| `addQuestion`    | `addQuestion(question: string): void`                                 | Appends the main question text.                                  |
| `addDocuments`   | `addDocuments(documents: Doc \| Doc[]): void`                         | Adds documents for the AI to reference.                          |
| `getPrompt`      | `getPrompt(hasPreviousJsonFailed?: boolean): string`                  | Returns the full prompt (internal use).                          |

---

## Answer

Used to parse chat response content. The client does not attach an `Answer` instance to the pipeline result; you read the response body and, if needed, use these static helpers to extract JSON or code from AI text (which often includes markdown or code fences).

| Method               | Signature                            | Description                                             |
| -------------------- | ------------------------------------ | ------------------------------------------------------- |
| `Answer.parsePython` | `parsePython(value: string): string` | Extracts Python code from a code block in the response. |

---

## Types

- **DAPMessage**: `{ type, seq, command?, arguments?, body?, success?, message?, request_seq?, event?, token?, data?, trace? }`.
- **TASK_STATUS**: Task status with `completedCount`, `totalCount`, `completed`, `state`, `exitCode`, and many more fields.
- **PIPELINE_RESULT**: `{ name, path, objectId, result_types?, [key: string]: any }`.
- **PipelineConfig**: Pipeline definition with `name`, `description`, `version`, `components`, `source`, `project_id`.
- **UPLOAD_RESULT**: Per-file result with e.g. `action` (`'complete'` \| `'error'`), `filepath`, `error?`, `result?`, `upload_time?`.
- **QuestionHistory**: `{ role: string, content: string }`.
- **QuestionInstruction**: `{ subtitle: string, instructions: string }`.
- **QuestionExample**: `{ given: string, result: string }`.

---

## Exceptions

`AuthenticationException` extends `ConnectionException`; thrown on DAP auth failure. In persist mode the client calls `onConnectError` and does not retry authentication so the app can fix credentials and call `login()` or `connect()` again.

`LoginAttemptCancelledError` extends `Error` directly. Its `reason` is the `LoginAttemptCancellationReason` union `'superseded' | 'logout' | 'detached'`. Catch it when overlapping lifecycle actions are expected; transport loss and other connection failures remain `ConnectionException` instances.

---

## Examples (Full API Usage)

### 1. Minimal: connect, run pipeline from file, send one string, disconnect

```typescript
import { RocketRideClient } from 'rocketride';

const client = new RocketRideClient({
	auth: process.env.ROCKETRIDE_APIKEY!,
	uri: 'https://api.rocketride.ai',
});
await client.connect();
const { token } = await client.use({ filepath: './pipeline.json' });
const result = await client.send(token, 'Hello, pipeline!', { name: 'input.txt' }, 'text/plain');
console.log(result);
await client.terminate(token);
await client.disconnect();
```

### 2. One-off script with automatic disconnect (withConnection)

```typescript
import { RocketRideClient } from 'rocketride';

const status = await RocketRideClient.withConnection({ auth: 'my-key', uri: 'wss://api.rocketride.ai' }, async (client) => {
	const { token } = await client.use({ pipeline: { pipeline: myPipelineConfig } });
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
	onConnectError: (error) => updateUI({ state: 'error', message: error.message }),
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
const { token } = await client.use({ filepath: './vectorize.json' });
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
const { token } = await client.use({ pipeline: { pipeline: config } });

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

### 6. Chat: question with instructions and examples, parse JSON answer

```typescript
import { RocketRideClient, Question, Answer } from 'rocketride';

const client = new RocketRideClient({ auth, uri });
await client.connect();
const { token } = await client.use({ pipeline: { pipeline: chatPipelineConfig } });

const question = new Question({ expectJson: true });
question.addInstruction('Format', 'Return a JSON object with keys: summary, keywords.');
question.addExample('Summarize X', { summary: '...', keywords: ['a', 'b'] });
question.addQuestion('Summarize the main points and list keywords.');

const response = await client.chat({ token, question });
const answerText = response?.data?.answer ?? response?.answers?.[0];
const answer = new Answer();
answer.setAnswer(answerText ?? '');
const structured = answer.isJson() ? answer.getJson() : answer.getText();
console.log(structured);

await client.terminate(token);
await client.disconnect();
```

### 7. Discover services and send a custom DAP request

```typescript
import { RocketRideClient } from 'rocketride';

const client = new RocketRideClient({ auth, uri });
await client.connect();

const services = await client.getServices();
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

## License

MIT - see [LICENSE](https://github.com/rocketride-org/rocketride-server/blob/develop/LICENSE).
