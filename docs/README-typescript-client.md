# RocketRide

TypeScript/JavaScript SDK for the RocketRide Engine - build, run, and manage AI pipelines from Node.js or the browser.

> [RocketRide](https://rocketride.org) is an open source, developer-native AI pipeline platform.
> This package lets you connect to a RocketRide engine, start pipelines, send data, stream results,
> and build conversational AI - all with full TypeScript support.

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
  uri: 'https://cloud.rocketride.ai',
});
await client.connect();
const { token } = await client.use({ filepath: './pipeline.json' });
const result = await client.send(token, 'Hello, pipeline!', { name: 'input.txt' }, 'text/plain');
console.log(result);
await client.terminate(token);
await client.disconnect();
```

## Features

- **Pipeline execution** - Start with `use()`, send data via `send()`, `sendFiles()`, or `pipe()`
- **Chat** - Conversational AI via `chat()` and `Question`
- **Event streaming** - Real-time events via `onEvent` and `setEvents()`
- **File upload** - `sendFiles()` with progress; streaming with `pipe()`
- **Connection lifecycle** - Optional persist mode, reconnection, and callbacks (`onConnected`, `onDisconnected`, `onConnectError`)
- **Full TypeScript support** - Complete type definitions

## What is RocketRide?

[RocketRide](https://rocketride.org) is an open source, developer-native AI pipeline platform.
It lets you build, debug, and deploy production AI workflows without leaving your IDE -
using a visual drag-and-drop canvas or code-first with TypeScript and Python SDKs.

- **50+ ready-to-use nodes** - 13 LLM providers, 8 vector databases, OCR, NER, PII anonymization, and more
- **High-performance C++ engine** - production-grade speed and reliability
- **Deploy anywhere** - locally, on-premises, or self-hosted with Docker
- **MIT licensed** - fully open source, OSI-compliant

---

## RocketRideClientConfig

Configuration object passed to `new RocketRideClient(config)`.

**Why it matters:** The config controls not only where you connect and how you authenticate, but also how the client behaves when the connection drops or when the server is slow to start. Getting `persist`, `maxRetryTime`, and the callbacks right avoids confusing "connection lost" vs "never connected" UX.

| Property            | Type                                                    | Required | Description |
| ------------------- | ------------------------------------------------------- | -------- | ----------- |
| `auth`              | `string`                                                | No       | API key. Optional: omit and set via `env.ROCKETRIDE_APIKEY` or `.env` (Node only), or set later with `setConnectionParams({ auth })` before calling `connect()`. |
| `uri`               | `string`                                                | No       | Server URI (e.g. `https://cloud.rocketride.ai` or `ws://localhost:8080`). Optional: omit and use `env.ROCKETRIDE_URI` or built-in default, or set later with `setConnectionParams({ uri })` before calling `connect()`. |
| `env`               | `Record<string, string>`                                | No       | Override env; if omitted, `.env` is loaded in Node (only). Used for `${ROCKETRIDE_*}` substitution in pipeline config and for `ROCKETRIDE_APIKEY`/`ROCKETRIDE_URI` when not passed as `auth`/`uri`. |
| `persist`           | `boolean`                                               | No       | Enable automatic reconnection with exponential backoff. Default: `false`. **Use `true`** for long-lived UIs or when the server may restart; the client will retry (250ms -> 2500ms) and call `onConnectError` on each failure until `maxRetryTime` or success. |
| `maxRetryTime`      | `number`                                                | No       | Max time in ms to keep retrying connection. Default: no limit. **Use** (e.g. 300000 for 5 min) so you can show "gave up" after a bounded time instead of retrying forever. |
| `requestTimeout`    | `number`                                                | No       | Default timeout in ms for each request; overridable per `request()` call. Prevents a single slow DAP call from hanging indefinitely. |
| `onConnected`       | `(info?: string) => Promise<void>`                      | No       | Called when connection is established. **Use** to refresh UI, refetch services, or clear "connecting" state. |
| `onDisconnected`    | `(reason?: string, hasError?: boolean) => Promise<void>` | No      | Called when connection is lost **only if** `onConnected` was already called. So "failed to connect in the first place" does *not* fire this - use `onConnectError` for that. **Do not** call `client.disconnect()` here if you want the client to auto-reconnect in persist mode. |
| `onConnectError`    | `(message: string) => void \| Promise<void>`            | No       | Called on each failed connection attempt (e.g. while retrying in persist mode). **Use** to show "Connection failed: ..." or "Still connecting..."; on auth failure the client stops retrying, so you can prompt the user to fix credentials and call `connect()` again. |
| `onEvent`           | `(event: DAPMessage) => Promise<void>`                  | No       | Called for each server event (e.g. upload progress, task status). **Use** to drive progress bars or status text; event type is `event.event`, payload in `event.body`. |
| `onProtocolMessage` | `(message: string) => void`                             | No       | Optional; for logging raw DAP messages. Helpful when debugging protocol issues. |
| `onDebugMessage`    | `(message: string) => void`                             | No       | Optional; for debug output. |
| `module`            | `string`                                                | No       | Client name for logging. Default: `CLIENT-0`, `CLIENT-1`, ... |

**Example - long-lived app with persist and status:**

```typescript
const client = new RocketRideClient({
  auth: process.env.ROCKETRIDE_APIKEY!,
  uri: 'wss://cloud.rocketride.ai',
  persist: true,
  maxRetryTime: 300000,
  requestTimeout: 30000,
  onConnected: async () => setStatus('connected'),
  onDisconnected: async () => setStatus('disconnected'),
  onConnectError: (msg) => setStatus('error', msg),
  onEvent: async (e) => handleServerEvent(e),
});
```

## RocketRideClient

### Constructor

```typescript
constructor(config: RocketRideClientConfig = {})
```

Creates a client instance; it does **not** connect until you call `connect()`. You can set up callbacks and then open the connection when ready. `auth` and `uri` are optional at construction and can be set later with `setConnectionParams()` before `connect()`.

**Example:**

```typescript
const client = new RocketRideClient({ auth: 'my-key', uri: 'https://cloud.rocketride.ai' });
await client.connect();
```

### Connection

| Method                | Signature | Returns | Description |
| --------------------- | --------- | ------- | ----------- |
| `connect`             | `connect(timeout?: number): Promise<void>` | - | Opens the WebSocket and performs DAP auth. Optional `timeout` (ms) bounds the connect + auth handshake (non-persist only; in persist mode timeout is not applied). In **persist** mode, if this fails the client calls `onConnectError` and schedules retries (exponential backoff); on **auth** failure it does *not* retry so the app can fix credentials and call `connect()` again. |
| `disconnect`          | `disconnect(): Promise<void>` | - | Closes the connection and cancels any pending reconnection. Call when the user explicitly disconnects or the app is shutting down. |
| `isConnected`         | `isConnected(): boolean` | `boolean` | Whether the client is currently connected. Use before calling `use()` or `send()` to avoid confusing errors. |
| `setConnectionParams` | `setConnectionParams(options: { uri?: string; auth?: string }): Promise<void>` | - | Updates server URI and/or auth at runtime. If currently connected, disconnects and reconnects with the new params (in persist mode, reconnection is scheduled; otherwise reconnects once). Use when the user changes server or credentials without creating a new client. |

**How to use:** For one-off scripts, call `connect()` once, do your work, then `disconnect()`. For UIs, use `persist: true` and rely on the client to reconnect; only call `disconnect()` when the user logs out or you are done with the client. The client supports `await using` (Symbol.asyncDispose) for automatic disconnect when exiting scope.

### Low-level DAP

| Method         | Signature | Returns | Description |
| -------------- | --------- | ------- | ----------- |
| `buildRequest` | `buildRequest(command: string, options?: { token?: string; arguments?: Record<string, unknown>; data?: Uint8Array \| string }): DAPMessage` | `DAPMessage` | Builds a DAP request message with the next sequence number. Use when you need a custom command not wrapped by `use()`, `send()`, etc. |
| `request`      | `request(request: DAPMessage, timeout?: number): Promise<DAPMessage>` | `Promise<DAPMessage>` | Sends the request and returns the response. Pass `timeout` (ms) to override the config default for this call. Check `didFail(response)` or `response.success` before using `response.body`. |
| `dapRequest`   | `dapRequest(command: string, args?: Record<string, unknown>, token?: string, timeout?: number): Promise<DAPMessage>` | `Promise<DAPMessage>` | Shorthand: builds a request and sends it in one call. Equivalent to `buildRequest()` + `request()`. |
| `didFail`      | `didFail(response: DAPMessage): boolean` | `boolean` | Returns `true` when the server indicated failure (`success === false`). Use after `request()` to decide whether to use `body` or surface `message` as an error. |

**Example - custom DAP command:**

```typescript
const req = client.buildRequest('rrext_monitor', { token, arguments: { types: ['apaevt_status_upload'] } });
const res = await client.request(req, 5000);
if (client.didFail(res)) throw new Error(res.message);
```

### Pipeline execution

| Method          | Signature | Returns | Description |
| --------------- | --------- | ------- | ----------- |
| `use`           | `use(options?: { token?: string; filepath?: string; pipeline?: PipelineConfig; source?: string; threads?: number; useExisting?: boolean; args?: string[]; ttl?: number }): Promise<Record<string, any> & { token: string }>` | `Promise<{ token: string, ... }>` | Starts a pipeline. You must pass either `pipeline` (object) or `filepath` (path to a JSON file; Node only). The client substitutes `${ROCKETRIDE_*}` in the config from its `env` (or `.env`). Returns at least `token`; use that token for `send()`, `sendFiles()`, `pipe()`, `chat()`, `getTaskStatus()`, and `terminate()`. |
| `validate`      | `validate(options: { pipeline: PipelineConfig \| Record<string, unknown>; source?: string }): Promise<Record<string, unknown>>` | `Promise<Record<string, unknown>>` | Validates a pipeline configuration without starting it. Returns validation results (e.g. errors, warnings). Use to check pipeline correctness before `use()`. |
| `terminate`     | `terminate(token: string): Promise<void>` | - | Stops the pipeline for that token and frees server resources. Call when the user cancels or when you are done sending data. |
| `getTaskStatus` | `getTaskStatus(token: string): Promise<TASK_STATUS>` | `Promise<TASK_STATUS>` | Returns current task status: e.g. `completedCount`, `totalCount`, `completed`, `state`, `exitCode`. Use to poll until `completed` is true or to show progress. |

**Why `use()` returns a token:** The server runs each pipeline as a separate task. The token identifies that task so all subsequent operations (sending data, chat, status, terminate) target the right pipeline.

**Example - start from file and poll until done:**

```typescript
const { token } = await client.use({ filepath: './pipeline.json', ttl: 3600 });
await client.setEvents(token, ['apaevt_status_processing']);
// ... send data ...
while (true) {
  const status = await client.getTaskStatus(token);
  if (status.completed) break;
  await new Promise(r => setTimeout(r, 2000));
}
await client.terminate(token);
```

### Data

| Method      | Signature | Returns | Description |
| ----------- | --------- | ------- | ----------- |
| `pipe`      | `pipe(token: string, objinfo?: Record<string, any>, mimeType?: string, provider?: string): Promise<DataPipe>` | `Promise<DataPipe>` | Creates a **streaming** data pipe. Use when you have large payloads or chunks arriving over time; you call `open()`, then one or more `write()`, then `close()`. Default MIME: `application/octet-stream`. |
| `send`      | `send(token: string, data: string \| Uint8Array, objinfo?: Record<string, any>, mimetype?: string): Promise<PIPELINE_RESULT \| undefined>` | `Promise<PIPELINE_RESULT \| undefined>` | Sends data in **one shot** (internally: open pipe, write once, close). Use for small payloads when you have the full buffer in memory. |
| `sendFiles` | `sendFiles(files: Array<{ file: File; objinfo?: Record<string, any>; mimetype?: string }>, token: string): Promise<UPLOAD_RESULT[]>` | `Promise<UPLOAD_RESULT[]>` | Uploads multiple browser `File` objects. Results are in the same order as `files`. Progress is reported via `onEvent` as `apaevt_status_upload` events (e.g. `body.filepath`, `body.bytes_sent`, `body.file_size`). |

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

| Method      | Signature | Returns | Description |
| ----------- | --------- | ------- | ----------- |
| `setEvents` | `setEvents(token: string, eventTypes: string[]): Promise<void>` | - | Subscribes this task to the given event types (e.g. `apaevt_status_upload`, `apaevt_status_processing`). After this, those events are delivered to your `onEvent` callback. Call after `use()` and before or while sending data. |

### Services, validation, and ping

| Method        | Signature | Returns | Description |
| ------------- | --------- | ------- | ----------- |
| `getServices` | `getServices(): Promise<Record<string, any>>` | `Promise<Record<string, any>>` | Returns all service/connector definitions from the server (schemas, UI schemas). Use to discover what pipelines or features the server supports. |
| `getService`  | `getService(service: string): Promise<Record<string, any> \| undefined>` | `Promise<Record<string, any> \| undefined>` | Returns the definition for one service by name. Throws if the request fails. |
| `ping`        | `ping(token?: string): Promise<void>` | - | Lightweight liveness check. Throws if the server responds with an error. Optional `token` for task-scoped ping. |

### Chat

| Method | Signature | Returns | Description |
| ------ | --------- | ------- | ----------- |
| `chat` | `chat(options: { token: string; question: Question }): Promise<PIPELINE_RESULT>` | `Promise<PIPELINE_RESULT>` | Sends the `Question` to the AI for the given pipeline token and returns the pipeline result. The answer content is in the result body (e.g. fields described by `result_types`); you can use `Answer.parseJson()` on raw text if the AI returned JSON. |

**How it works:** The client opens a pipe with MIME type `application/rocketride-question`, writes the serialized `Question`, closes the pipe, and returns the server's result. The pipeline must support the chat provider for that token.

### Convenience

| Method              | Signature | Returns | Description |
| ------------------- | --------- | ------- | ----------- |
| `getConnectionInfo` | `getConnectionInfo(): { connected: boolean; transport: string; uri: string }` | object | Current connection state and URI. Useful for debugging or displaying "Connected to ..." in the UI. |
| `getApiKey`         | `getApiKey(): string \| undefined` | `string \| undefined` | The API key in use (for debugging only; avoid logging in production). |

### Static

| Method           | Signature | Returns | Description |
| ---------------- | --------- | ------- | ----------- |
| `withConnection` | `RocketRideClient.withConnection<T>(config: RocketRideClientConfig, callback: (client: RocketRideClient) => Promise<T>): Promise<T>` | `Promise<T>` | Creates a client, calls `connect()`, runs `callback(client)`, then `disconnect()` in a `finally` block. Returns the callback result. **Use** for one-off scripts so you never forget to disconnect. |

---

## DataPipe

Returned by `client.pipe()`. Represents one streaming upload: **open** -> one or more **write** -> **close**. The server assigns a `pipeId` when you open; each `write()` sends a chunk for that pipe, and `close()` finalizes the stream and returns the pipeline result.

| Member     | Type                          | Description                                          |
| ---------- | ----------------------------- | ---------------------------------------------------- |
| `isOpened` | `boolean` (getter)            | Whether the pipe has been opened and not yet closed.  |
| `pipeId`   | `number \| undefined` (getter) | Server-assigned pipe ID; set after `open()`.        |

| Method  | Signature | Returns | Description |
| ------- | --------- | ------- | ----------- |
| `open`  | `open(): Promise<DataPipe>` | `Promise<DataPipe>` | Opens the pipe on the server. Must be called before `write()`. |
| `write` | `write(buffer: Uint8Array): Promise<void>` | - | Writes a chunk. Pipe must be open. |
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

| Method           | Signature | Description |
| ---------------- | --------- | ----------- |
| `addInstruction` | `addInstruction(title: string, instruction: string): void` | Adds an instruction for the AI (e.g. "Answer in bullet points"). |
| `addExample`     | `addExample(given: string, result: string \| object \| any[]): void` | Adds an example input/output so the AI can match format. |
| `addContext`     | `addContext(context: string \| object \| string[] \| object[]): void` | Adds context (e.g. "Q4 2024 data"). |
| `addHistory`     | `addHistory(item: QuestionHistory): void` | Adds a history item (`{ role, content }`) for multi-turn chat. |
| `addQuestion`    | `addQuestion(question: string): void` | Appends the main question text. |
| `addDocuments`   | `addDocuments(documents: Doc \| Doc[]): void` | Adds documents for the AI to reference. |
| `getPrompt`      | `getPrompt(hasPreviousJsonFailed?: boolean): string` | Returns the full prompt (internal use). |

---

## Answer

Used to parse chat response content. The client does not attach an `Answer` instance to the pipeline result; you read the response body and, if needed, use these static helpers to extract JSON or code from AI text (which often includes markdown or code fences).

| Method             | Signature | Description |
| ------------------ | --------- | ----------- |
| `Answer.parseJson` | `parseJson(value: string): any` | Parses JSON from AI text (strips markdown/code blocks). |
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

`AuthenticationException` extends `ConnectionException`; thrown on DAP auth failure. In persist mode the client catches it, calls `onConnectError`, and does not retry so the app can fix credentials and call `connect()` again.

---

## Examples (Full API Usage)

### 1. Minimal: connect, run pipeline from file, send one string, disconnect

```typescript
import { RocketRideClient } from 'rocketride';

const client = new RocketRideClient({
  auth: process.env.ROCKETRIDE_APIKEY!,
  uri: 'https://cloud.rocketride.ai',
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

const status = await RocketRideClient.withConnection(
  { auth: 'my-key', uri: 'wss://cloud.rocketride.ai' },
  async (client) => {
    const { token } = await client.use({ pipeline: { pipeline: myPipelineConfig } });
    await client.send(token, JSON.stringify({ data: 1 }));
    return await client.getTaskStatus(token);
  }
);
console.log(status);
```

### 3. Long-lived app: persist mode, callbacks, and status handling

```typescript
import { RocketRideClient } from 'rocketride';

const client = new RocketRideClient({
  auth: apiKey,
  uri: serverUri,
  persist: true,
  maxRetryTime: 300000,
  onConnected: async () => updateUI({ state: 'connected' }),
  onDisconnected: async (reason, hasError) => updateUI({ state: 'disconnected', reason, hasError }),
  onConnectError: (msg) => updateUI({ state: 'error', message: msg }),
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
const uploadResults = await client.sendFiles(files.map(file => ({ file })), token);
console.log('Uploaded:', uploadResults.filter(r => r.action === 'complete').length);

while (true) {
  const status = await client.getTaskStatus(token);
  console.log(`Progress: ${status.completedCount}/${status.totalCount}`);
  if (status.completed) break;
  await new Promise(r => setTimeout(r, 2000));
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
const structured = answerText ? Answer.parseJson(answerText) : null;
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
- [Discord](https://discord.gg/9hr3tdZmEG)
- [Contributing](https://github.com/rocketride-org/rocketride-server/blob/develop/CONTRIBUTING.md)

## License

MIT - see [LICENSE](https://github.com/rocketride-org/rocketride-server/blob/develop/LICENSE).
