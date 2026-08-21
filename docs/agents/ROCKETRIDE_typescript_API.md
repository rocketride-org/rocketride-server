# RocketRide Client SDK (TypeScript/JavaScript)

A TypeScript/JavaScript SDK for executing RocketRide pipelines using the Debug Adapter Protocol (DAP). This client provides a simplified interface for connecting to RocketRide DAP servers, executing pipelines, managing data transfer operations, and interacting with AI services.

## Features

- **DAP-based communication** for reliable pipeline execution, with full TypeScript type definitions
- **AI chat functionality** with structured JSON responses
- **Streaming data pipes** and parallel file uploads with progress events
- **Event monitoring** for real-time pipeline status; **automatic reconnection** with configurable persistence
- **Cloud file store** with handle-based and convenience read/write APIs
- **Deploy, schedule, and app-publish automation** via typed sub-clients
- **Run-log DVR** for replaying and live-tailing pipeline event streams
- **Command-line interface** for pipeline management

---

## 1. Install & Configure

### Version note: install the server-matched client

The npm registry's `rocketride` can lag the server you work against. Two
rules keep the client and server matched:

- **In an App Builder workspace, do nothing** — the platform vendors the
  connected server's own client to `.rocketride/client/rocketride.tgz`
  and scaffolded apps already pin it (`"rocketride": "file:../../
  .rocketride/client/rocketride.tgz"`). Never replace that pin with a
  registry version.
- **In a standalone script project**, install straight from your
  development server, which always serves its matching client:
  `pnpm add http://{host}:5565/client/typescript` (npm works the same
  way). Fall back to the registry only when you have no server yet.

### Using npm

```bash
npm install rocketride       # install from npm registry
npm install -D rocketride    # as dev dependency
npm install -g rocketride    # globally (for the CLI)
```

### Using pnpm

```bash
pnpm add rocketride          # install from npm registry
pnpm add -D rocketride       # as dev dependency
pnpm add -g rocketride       # globally (for the CLI)
```

### Uninstalling

```bash
npm uninstall rocketride     # npm (add -g for global)
pnpm remove rocketride       # pnpm (add -g for global)
```

The package includes the SDK library, the `rocketride` CLI tool, and the `rocketride/app-sdk` subpath for shell app development.

### Environment Variables

The client reads its defaults from environment variables:

```env
ROCKETRIDE_APIKEY=your-api-key-here
ROCKETRIDE_URI=https://api.rocketride.ai
```

**Important:** the SDK does **not** load `.env` files itself. Load them into `process.env` before constructing the client — for example start Node with `--env-file=.env`, or use a dotenv loader. In Node.js the client copies string values from `process.env` at construction; in the browser there is no ambient environment, so pass `env` explicitly.

Priority order: **constructor parameters** (`uri`, `auth`) → **`config.env`** (when provided it is copied and used *instead of* `process.env` — the two are never merged) → **`process.env`** (Node.js, when `config.env` is omitted) → the built-in default URI `https://api.rocketride.ai`.

```typescript
// Reads ROCKETRIDE_URI and ROCKETRIDE_APIKEY from process.env
const client = new RocketRideClient();

// Override explicitly
const client2 = new RocketRideClient({ auth: 'your-api-key', uri: 'https://api.rocketride.ai' });

// Fully self-contained environment (no process.env involvement)
const client3 = new RocketRideClient({
	env: { ROCKETRIDE_APIKEY: 'your-api-key', ROCKETRIDE_URI: 'https://api.rocketride.ai', ROCKETRIDE_OPENAI_KEY: 'sk-...' },
});
```

### Environment Variable Substitution in Pipelines

Pipeline configurations may reference `${ROCKETRIDE_*}` placeholders. When you call `use()`, the client sends the pipeline **unresolved** together with its `ROCKETRIDE_*`-filtered environment map (plus any per-call `env` overrides); the **server** performs the substitution. Secrets never need to be baked into the pipeline JSON, and `getTaskPipeline()` returns the stored pipeline with placeholders intact.

**Example environment:**

```env
ROCKETRIDE_QDRANT_HOST=qdrant.internal
ROCKETRIDE_COLLECTION_NAME=my-documents
```

**Example pipeline configuration (real providers):**

```typescript
const pipeline = {
	project_id: '{guid}', // Replace with your unique GUID
	source: 'webhook_1',
	components: [
		{ id: 'webhook_1', provider: 'webhook', config: { hideForm: true, mode: 'Source', type: 'webhook' } },
		{ id: 'parse_1', provider: 'parse', config: {}, input: [{ lane: 'tags', from: 'webhook_1' }] },
		{
			id: 'qdrant_1',
			provider: 'qdrant',
			config: {
				profile: 'local',
				// host and collection are substituted server-side:
				local: { host: '${ROCKETRIDE_QDRANT_HOST}', port: 6333, collection: '${ROCKETRIDE_COLLECTION_NAME}' },
			},
			input: [{ lane: 'documents', from: 'parse_1' }],
		},
	],
};

// The pipeline plus the ROCKETRIDE_* environment map are sent to the server,
// which resolves the placeholders before execution.
const result = await client.use({ pipeline });
```

**Key behaviors:** only `ROCKETRIDE_*` keys from the client environment ride along with the pipeline; per-call overrides via `use({ env: { ... } })` merge over them (unfiltered); substitution happens server-side, so the stored pipeline keeps its placeholders (no secret leakage); `setEnv()` replaces the client's environment map at runtime.

---

## 2. Connection & Auth

### Credentials and the two `.env` pairs

The platform maintains the workspace `.env`; you never construct an auth
flow. Two variable pairs may exist, one per editor-managed connection —
build each client from the pair that matches the verb family:

```typescript
// Development server — run, validate, iterate (use/send/chat/monitors)
const dev = new RocketRideClient({
	uri: process.env.ROCKETRIDE_URI,
	auth: process.env.ROCKETRIDE_APIKEY,
});

// Deployment target — deploy.*, schedules, publishApp/submitApp, build logs.
// Its ABSENCE means no deploy target is configured: stop and ask the user;
// never run lifecycle verbs against the development pair as a guess.
if (!process.env.ROCKETRIDE_DEPLOY_URI) {
	throw new Error('No deployment target configured - pick one in the editor.');
}
const deploy = new RocketRideClient({
	uri: process.env.ROCKETRIDE_DEPLOY_URI,
	auth: process.env.ROCKETRIDE_DEPLOY_APIKEY,
});
```

A cloud connection's credential is the same persistent key the editor
connects with — usage is identical to a self-hosted key. On
`AuthenticationException`: do not retry or invent a flow; the user
reconnects (or signs in) in the editor, which rewrites `.env`. For headless
automation (CI, external schedulers, daemons), mint a key in Account → Keys
and store it in that system's secret store — never copy `.env` values into
anything long-lived.

### Constructor

```typescript
new RocketRideClient(config?: RocketRideClientConfig)
```

**Configuration options (`RocketRideClientConfig`):**

- `auth?: string` — API key/token; fallback credential when `login()` receives none and the environment has no `ROCKETRIDE_APIKEY`
- `uri?: string` — server URI (default: `https://api.rocketride.ai`; also `ROCKETRIDE_URI`)
- `env?: Record<string, string>` — environment dictionary; when provided it is copied and used instead of `process.env`
- `onEvent?: (event: DAPMessage) => Promise<void>` — handler for server events
- `onConnected?: (connectionInfo?: string) => Promise<void>` — called once after an accepted authentication (monitor restoration included)
- `onDisconnected?: (reason?: string, hasError?: boolean) => Promise<void>` — called at most once per connection that published `onConnected`
- `onConnectError?: (error: ConnectionException) => void | Promise<void>` — called per failed automatic reconnect attempt (persist mode)
- `onProtocolMessage?` / `onDebugMessage?: (message: string) => void` — protocol (credential-redacted) / debug logs
- `onTrace?: (traceType: TraceType, message: DAPMessage) => void` — invoked before every `call()` (`TraceType.Request`) and after completion (`Success`/`Error`); credential fields redacted
- `public?: boolean` — open a public (unauthenticated) connection; only `rrext_public_*` commands allowed
- `persist?: boolean` — automatic reconnection (default: false); `requestTimeout?: number` — default per-request timeout in ms (default: none)
- `maxRetryTime?: number` — **deprecated**; accepted but ignored (persistent reconnects retry until stopped)
- `wsPath?: string` — WebSocket path override (default: `/task/service`); `module?: string` — module name for client identification
- `clientName?` / `clientVersion?: string` — friendly client name/version sent during auth

**Reconnect behavior (persist mode):** capped **linear** backoff — the delay grows by 250 ms per failure up to a 15-second ceiling — and transport errors retry forever. An `AuthenticationException` stops retrying (fix credentials and reconnect); each failed attempt is reported through `onConnectError`.

### High-Level: connect() / disconnect()

##### `connect(credential?, options?): Promise<ConnectResult>`

Connect and authenticate in a single call — a wrapper around `attach()` + `login()`. `credential` is an API key string, an `rr_` user token, a Zitadel access token, **or** an OAuth PKCE object `{ code, verifier, redirectUri }`; `options` is `{ uri?, timeout? }` per-call overrides. Returns a `ConnectResult` with the full identity payload (user, organization, teams, apps, capabilities); throws `AuthenticationException` when the server rejects the credential. Credential resolution checks the argument, then the configured environment (`ROCKETRIDE_APIKEY`), then stored client state (seeded by `config.auth`, updated after each successful auth).

```typescript
// API key
const info = await client.connect('your-api-key');

// OAuth PKCE (browser sign-in flows)
const info2 = await client.connect({
	code: authorizationCode,
	verifier: pkceVerifier,
	redirectUri: 'https://yourapp.example/callback',
});
console.log(info2.displayName, info2.organization?.name);
```

**The identity payload is the discovery call** — org, teams, and developer
id all arrive on connect; nothing needs a follow-up request. The fields
that drive deploy/publish decisions:

- `userId` / `displayName` / `email` — who authenticated
- `devTeam` — id of the team used by default when an operation names no
  team; dev-mode runs bill to it
- `organization` — `null` without an org membership, else:
  - `id`, `name`
  - `permissions` — ORG-level grants (e.g. `'org.admin'`)
  - `developerId` — the org's publisher slug, the first segment of every
    app id; `null` until the org registers as a developer, always absent
    on OSS servers
  - `teams` — the user's team MEMBERSHIPS: `{ id, name, permissions }`
    each, with team-scoped permissions (`'team.admin'`, `'task.control'`,
    `'task.data'`, `'task.monitor'`, `'task.store'`). There is **no
    top-level teams list** — memberships live here, under the org.
- `capabilities` — `['oss']` or `['saas']`; `apps` — the user's desktop
  app entries; `serverVersion` — when the server sends it

`disconnect(): Promise<void>` deauthenticates and closes the connection (wrapper around `logout()` + `detach()`); `isConnected(): boolean` is true when the transport is connected regardless of authentication (equivalent to `isAttached()`).

### Lifecycle Primitives: attach / login / logout / detach

Lower-level primitives that `connect()`/`disconnect()` build on — open a transport, authenticate, and tear down independently.

- `attach(uri?: string, options?: { timeout?: number }): Promise<void>` — open the WebSocket transport without authenticating. If `uri` differs from the current one, the client detaches first; if already attached to the same URI this is a no-op. After attach, public (`rrext_public_*`) APIs are available
- `login(credential?, options?): Promise<ConnectResult>` — authenticate over an already-attached transport; same credential forms as `connect()`. If `options.uri` differs, it detaches and re-attaches first. Throws `AuthenticationException` on failure — the transport stays attached. A login superseded by a newer `login()`/`logout()`/`detach()` rejects with `LoginAttemptCancelledError` (`reason`: `'superseded' | 'logout' | 'detached'`)
- `logout(): Promise<void>` — deauthenticate (sends `deauth`) and clear client auth state. The transport stays attached, so public APIs keep working
- `detach(): Promise<void>` — close the WebSocket transport entirely and stop reconnection
- `isAttached(): boolean` — transport connected; `isAuthenticated(): boolean` — auth handshake succeeded on the current connection

```typescript
await client.attach();              // transport only — public APIs now available
await client.login('your-api-key'); // authenticate
await client.logout();              // drop auth, keep transport
await client.detach();              // close transport
```

### Identity & Connection Accessors

- `getAccountInfo(): ConnectResult | undefined` — the `ConnectResult` from the last successful authentication. Refreshed automatically when the server pushes an `apaext_account` event (e.g. after a plan or org change)
- `getOrgId(): string | undefined` — the user's organization ID (shortcut for `getAccountInfo()?.organization?.id`)
- `getConnectionInfo(): { connected: boolean; transport: string; uri: string }` — connection snapshot
- `getApiKey(): string | undefined` — the current credential. After authentication this holds the server-issued `rr_` session token, which persist-mode reconnects replay
- `setEnv(env: Record<string, string>): void` — replace the client's environment map (seeded from `config.env` or `process.env`). `use()` reads it to build the `ROCKETRIDE_*` substitution environment; `login()` consults its `ROCKETRIDE_APIKEY` when no explicit credential is supplied. The map is copied — later caller-side mutations have no effect
- `ping(token?: string): Promise<void>` — lightweight connectivity test; pass a task token to ping through a task context

With `persist: true`, a dropped connection reconnects automatically and replays all active monitor subscriptions; `onConnected`/`onDisconnected`/`onConnectError` report the lifecycle. Call `disconnect()` to stop reconnection.

### Static Methods

##### `RocketRideClient.getServerInfo(uri: string, timeout?: number): Promise<ServerInfoResult>`

Probe a server for its capabilities **without authenticating**. Opens a temporary public connection and returns `{ version, capabilities, platform?, apps?, stripePublishableKey?, endpoints }`. The `endpoints` block is always resolved to absolute URLs (`api` = where clients open the WebSocket, `ui` = the environment's public web address) — never branch on presence.

```typescript
const info = await RocketRideClient.getServerInfo('localhost:5565');
if (info.capabilities.includes('saas')) { /* cloud server — show cloud sign-in options */ }
```

##### `RocketRideClient.normalizeUri(uri: string): string`

Normalize free-form user input into a fully-formed HTTP/HTTPS URL. Bare hostnames get `http://` prepended; non-cloud URIs without an explicit port default to `5565`.

##### `RocketRideClient.resolveEndpoints(endpoints, probedUri): { api: string; ui: string }`

Resolve a raw probe `endpoints` block against the probed URI: the `'origin'` sentinel (and any absent key) resolves to the probed address. `getServerInfo` already applies this — call it directly only when handling raw probe bodies yourself.

##### `RocketRideClient.withConnection(config, callback): Promise<T>`

Static factory for automatic connection management (equivalent to Python's `async with`):

```typescript
const result = await RocketRideClient.withConnection({}, async (client) => {
	// Client is already connected; empty config uses environment settings
	const pipelineResult = await client.use({ pipeline });
	return client.send(pipelineResult.token, 'data');
});
// Client automatically disconnects after the callback completes
```

##### `await using` (Symbol.asyncDispose)

```typescript
// Requires TypeScript 5.2+ and Node.js 20+
await using client = new RocketRideClient({ auth: 'your-api-key' });
await client.connect();
const result = await client.use({ pipeline });
// client.disconnect() runs automatically when leaving scope
```

---

## 3. Pipeline Execution

### `use(options): Promise<Record<string, unknown> & { token: string }>`

Start a RocketRide pipeline. Returns the server response body; `token` is the task token used by every subsequent per-task call.

**Options (all optional, but one of `pipeline`/`filepath` is required):**

- `pipeline?: PipelineConfig` — flat pipeline object (`components`, `source`, `project_id` at top level — do **not** wrap it in `{ pipeline: { ... } }`)
- `filepath?: string` — path to a `.pipe` or JSON file (Node.js only); `{ "pipeline": { ... } }` wrappers are unwrapped automatically
- `token?: string` — custom task token (auto-generated if not provided)
- `source?: string` — override the pipeline's source component
- `threads?: number` — number of execution threads. **No client default** — when omitted, the server decides
- `useExisting?: boolean` — reuse an existing pipeline instance
- `args?: string[]` — extra command-line flags appended to the run's engine process (see the note below); not a data channel
- `ttl?: number` — idle time-to-live in seconds (server default when omitted; `0` = no timeout)
- `pipelineTraceLevel?: 'none' | 'metadata' | 'summary' | 'full'` — when set, captures every lane write and invoke call in the response under `_trace`
- `name?: string` — display name for the task (shown in dashboards); derived from the filename when `filepath` is used
- `env?: Record<string, string>` — per-call substitution values merged over the client's filtered `ROCKETRIDE_*` environment (per-call values are not filtered)

```typescript
// From a .pipe file / from a flat config / reusing an existing pipeline:
const result = await client.use({ filepath: './chat.pipe' });
const result2 = await client.use({ pipeline: { components: [/* ... */], source: 'chat_1', project_id: '...' } });
const result3 = await client.use({ filepath: './chat.pipe', useExisting: true, ttl: 3600 });
console.log(`Pipeline started with token: ${result.token}`);
```

#### Runtime engine arguments (`args`)

`args` rides the start request as a plain string array and is appended to
the command line of the engine process that runs the task — each entry
becomes one argument (an entry containing spaces is split shell-style).
The arguments configure the run's ENGINE, not your components:

```typescript
// Verbose component tracing in the run's output feed:
const { token } = await client.use({ pipeline, args: ['--trace=debugOut'] });
```

- Use them for engine runtime flags such as `'--trace=debugOut'`.
- They are **not** a data channel into the pipeline: components never
  receive them as input. Send data with `send()`/`chat()`, configure
  components in the pipeline config itself, and pass substitution values
  through `env` (`${ROCKETRIDE_*}` placeholders).
- They apply at task start only — attaching to an already-running task
  (`useExisting: true`) leaves the running process's arguments unchanged.

### `restart(options): Promise<void>`

Restart a running pipeline with a new configuration: the server looks up the existing task by project/source, terminates it, and starts a new execution in one round trip. Options: `projectId`, `source`, `pipeline` (required); `token?` (resolved server-side when omitted); `teamId?` (address the team's DEPLOY run; omit for your own dev run).

```typescript
await client.restart({ projectId: 'proj-123', source: 'webhook_1', pipeline });
```

### `terminate(token: string): Promise<void>`

Terminate a running pipeline.

### `getTaskStatus(token: string, options?: { timeout?: number | false }): Promise<TASK_STATUS>`

Get the current status of a running pipeline. The call is bounded to **15 seconds by default** so callers do not hang if the engine stops responding; pass `{ timeout: false }` to fall back to the client-level request timeout only, or a number of milliseconds to override.

```typescript
// status.state is a TASK_STATE number (3 = RUNNING, 5 = COMPLETED, ...)
// Prefer status.completed — it flips true once the task finishes.
while (!(await client.getTaskStatus(token)).completed) {
	await new Promise((resolve) => setTimeout(resolve, 1000));
}
```

### `getTaskToken(options): Promise<string | undefined>`

Resolve a running task's token from its project ID and source component — required for `terminate()`, `restart()`, `send()`, etc. Returns `undefined` when no task is running for that project/source. Options: `projectId`, `source`; `teamId?` resolves the team's DEPLOYED run, omit it for your own dev run (the scope IS the kind).

```typescript
const token = await client.getTaskToken({ projectId: 'proj-123', source: 'webhook_1' });
```

### `getTaskPipeline(token: string): Promise<Record<string, unknown> | undefined>`

Return the **unresolved** pipeline configuration for a running task — `${ROCKETRIDE_*}` placeholders are not substituted, so no secrets are included. Returns `undefined` if the task is not found.

### `validate(options): Promise<ValidationResult>`

Validate a pipeline configuration without starting it — a pre-flight check before `use()`. Options: `pipeline` (required); `source?` override, resolved with the same logic as `use()` (explicit option → pipeline's `source` field → the single component whose `config.mode` is `'Source'`). Returns `{ errors, warnings, ... }`: a pipeline will not execute while it has `errors`; `warnings` are non-fatal.

```typescript
const result = await client.validate({ pipeline });
if (result.errors.length > 0) {
	console.error('Pipeline invalid:', result.errors);
} else {
	const { token } = await client.use({ pipeline });
}
```

### `getServices()` / `getService(service)`

`getServices(): Promise<ServicesResponse>` returns the server's service catalog: one summary per service (title, classType, lanes, capabilities bitmask, ...) plus a deduplicated `icons` table (icon id → raw SVG) that each summary's `icon` id points into. Configuration schemas are **not** included — `getService(service: string): Promise<ServiceDefinition>` returns one service's FULL definition by name (e.g. `'ocr'`, `'chat'`): the summary fields plus the dynamic configuration sections (schema + UI schema per section). An unknown service name is an error, not an `undefined` result.

```typescript
const { services, icons } = await client.getServices();
console.log(Object.keys(services)); // available provider names
const ocr = await client.getService('ocr');
```

---

## 4. Sending Data

### `send(token, data, objinfo?, mimetype?, onSSE?): Promise<PIPELINE_RESULT | undefined>`

Send data directly to a pipeline in one shot (internally: open pipe → write → close).

```typescript
send(token: string, data: string | Uint8Array, objinfo?: Record<string, unknown>, mimetype?: string, onSSE?: (type: string, data: Record<string, unknown>) => Promise<void>)
```

**Important:** use this with pipelines whose source component is `webhook` or `dropper`. For chat/Q&A systems, use `chat()` with a `chat` source component instead.

### `sendFiles(files, token, maxConcurrent?): Promise<UPLOAD_RESULT[]>`

Upload multiple files with bounded parallelism. `maxConcurrent` defaults to **5** and must be a positive integer. Results come back in input order; a single file's failure never kills the batch (it becomes an `action: 'error'` entry). Each file entry is `{ file: File; objinfo?: Record<string, unknown>; mimetype?: string }` — `objinfo.filepath` lets Node stat the real size, and `mimetype` falls back to `file.type`, then `application/octet-stream`.

**Progress events** are emitted through the event system as `apaevt_status_upload` events (actions: `open`, `write`, `close`, then `complete`/`error`), not through a callback parameter — subscribe with the `onEvent` constructor callback.

```typescript
const client = new RocketRideClient({
	auth: 'your-api-key',
	onEvent: async (event) => {
		if (event.event === 'apaevt_status_upload') {
			const body = event.body;
			console.log(`${body.filepath}: ${body.action} - ${body.bytes_sent}/${body.file_size} bytes`);
		}
	},
});
await client.connect();

const results = await client.sendFiles(
	[{ file: fileObject1 }, { file: fileObject2, mimetype: 'application/json' }, { file: fileObject3, objinfo: { custom: 'metadata' } }],
	'task-token',
	10 // at most 10 files in flight at once (default 5)
);
```

### `pipe(token, objinfo?, mimeType?, provider?, onSSE?): Promise<DataPipe>`

Create a streaming data pipe for sending large datasets. `mimeType` defaults to `application/octet-stream`.

### DataPipe

A stream-like interface over one server-side data pipe.

- `open(): Promise<DataPipe>` — open the pipe; must be called before `write()`. Throws `PipeException` when the server rejects the open (wrong token, terminated task, source not `chat`/`webhook`/`dropper`, or MIME type not matching a source lane)
- `write(buffer: Uint8Array): Promise<void>` — write one chunk; call repeatedly to stream large datasets
- `close(): Promise<PIPELINE_RESULT | undefined>` — close the pipe and get the processing result; a closed pipe cannot be reopened
- `tool<T>(tool: string, nodeId?: string, input?: Record<string, unknown>): Promise<T>` — invoke a `@tool_function` on a pipeline node **through this open pipe**, reusing its pipeline instance (no pool borrow). An empty `nodeId` broadcasts to all tool-lane nodes; the first owner of the tool handles it
- Properties: `isOpened: boolean` (true between a successful `open()` and `close()`), `pipeId: number | undefined` (server-assigned by `open()`)

```typescript
const pipe = await client.pipe('task-token', { name: 'data.json' }, 'application/json');
await pipe.open();
await pipe.write(new TextEncoder().encode('{"message": "Hello World"}'));
const result = await pipe.close();
```

### `tool(options): Promise<T>` (client-level)

Invoke a `@tool_function` on a pipeline node without an open pipe — the server borrows a pipeline instance from the pool, dispatches the call, and returns the result directly (no Question/Answer/SSE overhead).

```typescript
const rows = await client.tool({
	token,
	tool: 'search',
	nodeId: '',        // '' broadcasts; first node owning the tool handles it
	input: { q: 'invoices 2026' },
	timeout: 30000,    // optional per-request timeout in ms
});
```

### Streaming callback (`onSSE`)

`pipe()`, `send()`, and `chat()` accept a trailing `onSSE` callback that fires for each server-sent event (e.g. token-by-token AI output) while the request is in flight. It is the last positional parameter on `pipe()` and `send()`, and a field on the `chat()` options object; the signature is the same in every case:

```typescript
onSSE?: (type: string, data: Record<string, unknown>) => Promise<void>
```

```typescript
const response = await client.chat({
	token,
	question,
	// `type` is the SSE event name; `data` is the event payload.
	onSSE: async (type, data) => console.log('sse', type, data),
});
```

---

## 5. Chat & Question

### `chat(options): Promise<PIPELINE_RESULT>`

Ask a question to RocketRide's AI and get an intelligent response.

```typescript
chat(options: { token: string; question: Question; onSSE?: (type: string, data: Record<string, unknown>) => Promise<void> })
```

**Important:** use this with pipelines that have `chat` as the source component — for ALL conversational interfaces (web, console, API, mobile). For document processing/uploads, use `send()`/`sendFiles()` with a `webhook` source instead.

```typescript
import { Question } from 'rocketride';

const question = new Question();
question.addQuestion('What are the key findings?');
const response = await client.chat({ token: 'chat-token', question });
```

### Question

Question builder for AI chat operations.

**Constructor:**

```typescript
new Question(options?: {
	type?: QuestionType;    // QUESTION (default) | SEMANTIC | KEYWORD | GET | PROMPT
	filter?: DocFilter;     // document search/pagination controls
	expectJson?: boolean;   // request a strictly-JSON answer (default false)
	role?: string;          // optional role/system preamble
})
```

Document filtering is configured via the constructor, not a method: `new Question({ filter: { limit: 50 } })`.

> The `add*` builder methods mutate the `Question` in place and return `void`: they do **not** support chaining (e.g. `q.addQuestion(...).addContext(...)` will not compile).

- `addQuestion(question: string): void` — add the main question text (call multiple times for multi-question prompts)
- `addInstruction(title: string, instruction: string): void` — add a titled instruction to guide the response
- `addExample(given: string, result: string | object | unknown[]): void` — an example of the desired response format (objects are JSON-stringified)
- `addContext(context: string | object | string[] | object[]): void` — contextual information (single values or arrays)
- `addHistory(item: QuestionHistory): void` — one conversation-history message: `{ role: 'user' | 'assistant' | 'system'; content: string }`
- `addGoal(goal: string): void` — a high-level goal for the AI to work towards
- `addDocuments(documents: Doc | Doc[]): void` — documents for the question context. A `Doc` carries `page_content`, optional `score`, `tokens`, `metadata`, etc.
- `toDict()` / `Question.fromDict(data)` — serialize / deserialize

### Common Patterns

Start the chat pipeline once, globally — `client.use()` is time-consuming, so start/ask/stop per question is an anti-pattern.

#### Basic Questions

```typescript
import { RocketRideClient, Question } from 'rocketride';

const client = new RocketRideClient(); // configuration from the environment
await client.connect();
const { token } = await client.use({ filepath: 'chat_pipeline.pipe' });

async function myChat(myQuestion: string): Promise<string> {
	const question = new Question();
	question.addQuestion(myQuestion);
	const response = await client.chat({ token, question });
	// `answers` is a dynamic field — present only when the pipeline's
	// result_types maps it. Treat it as optional.
	return response.answers?.[0] ?? 'No answer received';
}

console.log(await myChat('What are the main themes in these documents?'));
```

#### Structured JSON Responses

```typescript
const question = new Question({ expectJson: true });
question.addQuestion('Extract email addresses and phone numbers');
question.addExample('Find contacts', { emails: ['john@company.com'], phones: ['555-1234'] });
question.addContext(sourceDocument);
const response = await client.chat({ token, question });
// For expectJson=true the answer is already parsed as an object
const extracted = response.answers?.[0] ?? {};
```

---

## 6. Cloud File Store

Every authenticated account has a private server-side file store. All paths are **relative** (no leading slash), must not contain `..` segments, and must avoid the metacharacters `* ? < > | "` and control characters — the client validates before any wire traffic.

### Handle-Based Operations

- `fsOpen(path: string, mode?: 'r' | 'w'): Promise<{ handle: string; size?: number }>` — open a handle for reading (default) or writing; read mode also returns the file `size`
- `fsRead(handle: string, offset?: number, length?: number): Promise<Uint8Array>` — read from an open read handle; `length` defaults to 4 MB, an empty result indicates EOF
- `fsWrite(handle: string, data: Uint8Array): Promise<number>` — write bytes; returns bytes written
- `fsClose(handle: string, mode: 'r' | 'w'): Promise<void>` — close a handle (`mode` must match `fsOpen`)

### Whole-File & Directory Operations

- `fsDelete(path: string): Promise<void>` — delete a file
- `fsListDir(path?: string): Promise<{ entries: Array<{ name: string; type: 'file' | 'dir'; size?: number; modified?: number }>; count: number }>` — list immediate children (default: account root)
- `fsMkdir(path: string): Promise<void>` — create a directory
- `fsRmdir(path: string, recursive?: boolean): Promise<void>` — remove a directory; `recursive: true` deletes contents (default false — non-empty directories fail)
- `fsStat(path: string): Promise<{ exists: boolean; type?: 'file' | 'dir'; size?: number; modified?: number }>` — metadata (`modified` is epoch seconds)
- `fsRename(oldPath: string, newPath: string): Promise<void>` — rename/move (copy + delete on object stores; directories move recursively)
- `fsGetUrl(path: string, expiresIn?: number, downloadName?: string): Promise<string>` — direct HTTP URL for a file (presigned/SAS on cloud backends, JWT-signed locally), valid `expiresIn` seconds (default 3600). Works directly as `src` on `<img>`, `<video>`, `<audio>`, `<iframe>`. Set `downloadName` to force a browser download with that filename (`Content-Disposition: attachment`) — the only reliable way to control the filename for cross-origin cloud URLs; omit for inline streaming
- `fsReadMany(paths: string[]): Promise<Array<{ path: string; ok: boolean; data?: Uint8Array; error?: string }>>` — batch-read many small files in one round trip (max **256 paths**; 32 MiB total). Missing/unreadable files are per-entry results (`ok: false`), never a call failure; results come back in request order

### Convenience Wrappers

These handle open/read-loop/close internally:

- `fsReadString(path: string): Promise<string>` — read a file as UTF-8 text
- `fsWriteString(path: string, text: string): Promise<void>` — write UTF-8 text
- `fsReadJson<T>(path: string): Promise<T>` — read and `JSON.parse`
- `fsWriteJson(path: string, obj: unknown): Promise<void>` — `JSON.stringify` (pretty-printed) and write

```typescript
await client.fsMkdir('reports');
await client.fsWriteJson('reports/summary.json', { total: 42 });
const summary = await client.fsReadJson<{ total: number }>('reports/summary.json');
const url = await client.fsGetUrl('reports/summary.json', 600);
```

---

## 7. Templates & Run Logs

### Pipeline Templates

Templates are pipeline configurations stored in the account file store (under a reserved `.templates/` directory — you never touch the path yourself).

- `saveTemplate({ templateId, pipeline }): Promise<void>` — persist a pipeline as a named template (existing ID overwrites; no path separators in `templateId`)
- `getTemplate({ templateId }): Promise<Record<string, any>>` — retrieve a saved template (throws if missing)
- `deleteTemplate({ templateId }): Promise<void>` — delete a template
- `getAllTemplates(): Promise<Array<{ id; name; sources; totalComponents }>>` — list all templates with a summary each; corrupt entries are skipped, not fatal

### Saved Run Logs (JSON snapshots)

Simple per-project log snapshots in the account store (distinct from the run-log continuum below).

- `saveLog({ projectId, source, contents }): Promise<string>` — persist a log payload. `contents.body.startTime` is required — it forms part of the returned filename (e.g. `'ingest-1714000000000.log'`) so logs sort chronologically
- `getLog({ projectId, name }): Promise<Record<string, any>>` — retrieve by the filename `saveLog` returned
- `deleteLog({ projectId, name }): Promise<void>` — delete a saved log
- `listLogs({ projectId, source? }): Promise<Array<{ name: string; modified?: number }>>` — list a project's saved logs, oldest first; `source` filters to one source component

### Run-Log Continuum (`client.log`)

A task's run log is ONE continuous event stream per identity; individual runs are chapters inside it. Streams are addressed by a `LogStreamRef` — never by token:

```typescript
interface LogStreamRef {
	projectId: string;
	source: string;
	teamId?: string;              // present = that team's DEPLOY continuum
	runKind?: 'dev' | 'deploy';   // teamless only: 'dev' (default) or your personal @me deploy stream
}
```

- `client.log.chapters(stream): Promise<LogChaptersResult>` — the whole timeline in one small read: per-run chapters (`beginTime`, `beginSeq`, `endTime`, `outcome`), segment activity spans, the retained window, the retention horizon (`horizonSeq`), and `completed` (false while a run is writing)
- `client.log.read(stream, params?): Promise<LogReadResult>` — read a seq/time range of events, paged. Range forms: `fromSeq`/`toSeq`, `fromTime`/`toTime` (omit the upper bound for "to now"), or `fromTime` → `toSegment`. Optional `types` filters server-side (e.g. `['output']`); `maxEvents`/`maxBytes` bound the page. When the response carries `nextSeq`, pass it back as `cursor` to continue; `truncatedAtSeq` means the request reached below the retention horizon
- `client.log.segment(stream, segment, params?): Promise<LogSegmentResult>` — one segment's raw JSONL bytes, chunked by byte offset (the bulk replay path). Every chunk ends on a line boundary, so each parses standalone; repeat with the returned `nextOffset` until `final`. The segment table (ids + time extents) comes from `chapters()`
- `client.log.delete(stream, options): Promise<LogDeleteResult>` — destructive: `{ beforeTime }` drops segments wholly older than the cutoff; `{ all: true }` removes the entire stream
- `client.log.openEventStream(stream): LogEventStream` — open a DVR session (below); dispose with `closeEventStream()`

### LogEventStream — the DVR Session

The replay/monitoring surface over one stream: you think in **positions**, chapters, traces, and console — storage (segments, keyframes, deltas) is invisible. `seek(pos)` positions the session; the `get*()` calls seed panels from state-at-position; `play(pos, speed, cb)` then delivers events strictly after the seed watermark, in order, paced by speed (`0` = as fast as possible, `1` = real time, `10` = 10×). Playing from a past position **auto-pins to live** on catching the wall clock — replay flows into live with no seam. The session registers its own `all`-types monitor on the stream's scope (refcounted server-side) and releases it on close.

```typescript
const stream = client.log.openEventStream({ projectId: 'proj-123', source: 'webhook_1' });

await stream.seek('live');                    // or an epoch-seconds number
const chapters = await stream.getChapters();  // runs: begin/end/outcome
const status = await stream.getStatus();      // full status snapshot at the position
const lines = await stream.getConsole(100);   // console exactly as it read at the position
const traces = await stream.getTraces(20);    // all in-flight + last 20 closed traces (n <= 50)

// One trace's complete event set. Identity = the BEGIN event's continuum seq
// (LogTraceSummary.beginSeq) — flow body ids are reused slots, not identities.
const detail = await stream.getTrace(traces.closed[0].beginSeq!);

// Replay from 10 minutes ago at 10x, then keep following live:
await stream.play(Date.now() / 1000 - 600, 10, ({ event }) => {
	console.log(event.event, event.body.logSeq);
});

stream.pause();                 // freeze the position (a later play resumes here)
console.log(stream.position()); // epoch seconds; rides the wall clock when live
stream.closeEventStream();      // dispose (stops playback, releases the monitor)
```

---

## 8. Events & Monitoring

### Receiving Events

All server events arrive through the `onEvent` constructor callback as `DAPMessage` objects (`{ type: 'event', event: string, body: {...}, seq }`).

### Monitor Subscriptions — THE Event API

`addMonitor`/`removeMonitor` manage **reference-counted** subscriptions per monitor key. On reconnect the client automatically replays all active monitors, so subscriptions survive connection drops.

**MonitorKey semantics:**

```typescript
type MonitorKey =
	| { token: string }                                                                    // a specific running task
	| { teamId?: string; projectId: string; source: string; pipeId?: number; runKind?: 'dev' | 'deploy' };
```

- `{ token }` — one running task by its session token
- `{ projectId, source }` — **your own dev run** of the project/source (works before the task starts; the server binds your identity)
- `{ teamId, projectId, source }` — the **team's DEPLOYED run** (`teamId` present always addresses the team's deploy continuum; `runKind` is ignored there)
- `{ runKind: 'deploy', projectId, source }` — your **personal (@me) deploy run**: deploy-kind but user-owned, the one case teamId-presence cannot express
- `pipeId` scopes the subscription to a single pipe within the task

**Event-type vocabulary:** the `types` array takes `EVENT_TYPE` names, matched **case-insensitively** — `'task'`, `'summary'`, `'flow'`, `'output'`, `'sse'`, `'detail'`, `'debugger'`, `'dashboard'`, `'billing'`, `'deploy'`, `'all'` (and `'none'` to clear). These are event *categories*, not raw event names — `'summary'` delivers `apaevt_status_*` summaries, `'flow'` delivers `apaevt_flow`, etc.

##### `addMonitor(key: MonitorKey, types: string[]): Promise<void>`

Add a subscription. If the key already exists, the new types are merged via reference counting and the merged set is sent to the server. On server failure the local counts roll back and the error propagates.

```typescript
await client.addMonitor({ token }, ['summary', 'flow']);
await client.addMonitor({ projectId: 'proj-123', source: 'webhook_1' }, ['summary']); // before the task runs
await client.addMonitor({ teamId: 'team-prod', projectId: 'proj-123', source: 'webhook_1' }, ['all']); // team deploy run
```

##### `removeMonitor(key: MonitorKey, types: string[]): Promise<void>`

Decrement the reference counts for the given types; a type is only unsubscribed on the server once its count reaches zero. The `key` must match the one passed to `addMonitor()`.

##### `clearAllMonitors(): Promise<void>`

Remove every monitor subscription this client holds (best-effort per key) and clear the local ref-count map. Useful when a UI module unmounts.

##### `identify(clientName: string): Promise<void>`

Update this connection's display name on the server so dashboards show a descriptive name instead of the generic one sent at auth time.

##### `setEvents(token, eventTypes, pipeId?)` — deprecated

> **Deprecated.** `setEvents` sets an absolute (non-refcounted) subscription for one task and is superseded by `addMonitor`/`removeMonitor`, which merge correctly across multiple consumers and replay on reconnect. Do not use it in new code.

### Monitoring Pattern

```typescript
const client = new RocketRideClient({
	auth: 'your-api-key',
	onEvent: async (event) => {
		if (event.event === 'apaevt_status_update') console.log('Status:', event.body.status);
		if (event.event === 'apaevt_flow') console.log('Flow:', event.body.op, event.body.pipes);
	},
});
await client.connect();
const result = await client.use({ filepath: 'pipeline.pipe' });
await client.addMonitor({ token: result.token }, ['summary', 'flow']);
```

For simple completion waits, polling `getTaskStatus(token)` until `status.completed` is also fine (section 3).

---

## 9. Deploy & Schedules (`client.deploy`)

Teams-as-environments deployments. **Deploy** copies an immutable, sha256-locked version onto the org registry (the one rail door, every kind); **pointing/publishing** binds a team or audience to a version — promotion and rollback are the same pointer move.

##### `client.deploy.add(options): Promise<PublishResult>`

Deploy an object as the next immutable registry version. Returns `{ artifact, deployment? }` — `deployment` only when `deployTo` was given.

- `options.kind?: 'pipe' | 'app' | 'node'` — default `'pipe'`
- `options.pipeline?: PipelineConfig & { name: string }` — the pipeline definition (kind `'pipe'`; `name` is REQUIRED — it renders on every deploy surface forever)
- `options.data?: Uint8Array` — the source zip bytes (kind `'app'`; the server owns the build and never trusts client-produced binaries)
- `options.metadata?: Record<string, unknown>` — optional metadata (e.g. projectId provenance, `appRoot` for workspace-relative app zips)
- `options.comment?: string` — "what changed" note kept in the registry
- `options.deployTo?: string` — team id to deploy the new version to immediately (one-step add+deploy; pipes only)

##### `client.deploy.deploy(projectId: string, version: number, teamId: string): Promise<Deployment>`

Point a team at a published version. Promotion (Staging → Production) and rollback (v3 → v2) are both this call. The team is always explicit; requires `task.control` on it.

**Reads** (list envelopes are `{ rows, total, page, pageSize }`; `params` takes `page`, `pageSize`, `search`, `filters`, `sort`):

- `list(params?): Promise<DeployListEnvelope<Deployment>>` — deployments visible to the caller; `params.teamId` restricts to one team
- `get(projectId, teamId): Promise<Deployment>` — one team's deployment, registry-joined (version, state, schedules, actors)
- `versions(projectId, params?): Promise<DeployListEnvelope<DeployArtifact>>` — the org-registry versions (the version strip), newest first
- `artifact(projectId, version): Promise<PipelineConfig>` — one immutable artifact's pipeline JSON, sha256-verified server-side on load; the source of truth for rendering a deployed version
- `history(projectId, params?): Promise<DeployListEnvelope<DeployHistoryEntry>>` — the immutable audit trail, newest first. Rows carry `seq` (stable identity); `params.teamId` restricts to one team's pointer changes (org-wide publish rows always ride along); `filters.at__gte`/`at__lte` take epoch seconds

**State & runs:**

- `run(projectId, sourceId, teamId): Promise<{ token?: string; version?: number }>` — start one deployed source NOW. Same trusted team dispatch the scheduler uses: the run executes as the team, carries no human identity, and who fired it lands in the audit history. The deployment must be enabled
- `disable(projectId, teamId)` / `enable(projectId, teamId): Promise<Deployment>` — the kill switch: while disabled NOTHING runs (schedules stop firing, manual runs are refused)
- `remove(projectId, teamId): Promise<Deployment>` — soft-remove one team's deployment: listings hide it, audit history and registry artifacts survive, re-deploying any version revives it

**Schedules:**

- `setSchedule(projectId, sourceId, schedule, teamId, options?): Promise<Deployment>` — set (or clear) one source's schedule. `schedule` is a 5-field cron expression (`null` or `'manual'` clears it); `options.ttl` is the run window in seconds (omitted = each run executes until the pipeline finishes). Editing cron/ttl preserves the paused flag — `pauseSchedule`/`resumeSchedule` own it
- `setSourceConfig(projectId, sourceId, teamId, options?): Promise<Deployment>` — per-source settings riding every deploy run: `options.traceLevel?: 'none' | 'metadata' | 'summary' | 'full' | null` (null/omitted = deploy default, full) and `options.debugOut?: boolean`. Editing the schedule never touches them
- `pauseSchedule(projectId, sourceId, teamId)` / `resumeSchedule(...)` — pause ONE source's schedule (cron/ttl stay configured, it just stops firing) / resume it
- `preview(schedule, count?): Promise<SchedulePreview>` — validate a cron expression and get its next occurrences (`{ valid, error?, next? }`). THE cron evaluator: render "next run" lines from it rather than parsing cron client-side, so previews never disagree with what the scheduler fires

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

### Worked Example: a Run Window (Mon/Wed/Fri, 08:00–15:00)

Cron can only express **when a run starts** — there is no cron syntax for "run from 08:00 until 15:00". The window is the schedule's `ttl`: the run starts on the cron tick and the ttl bounds how long it may live.

```typescript
// Prerequisite: the pipe is deployed to the team
const { artifact } = await client.deploy.add({ pipeline: { ...pipeline, name: 'Nightly ingest' }, comment: 'v2' });
await client.deploy.deploy('proj-123', artifact.version!, 'team-prod');

// Mon/Wed/Fri at 08:00 → cron '0 8 * * 1,3,5'
// Stop by 15:00 → ttl = 7 hours = 7 * 3600 = 25200 seconds
await client.deploy.setSchedule('proj-123', 'webhook_1', '0 8 * * 1,3,5', 'team-prod', { ttl: 25200 });

// Sanity-check what the scheduler will fire:
const preview = await client.deploy.preview('0 8 * * 1,3,5', 3);
console.log(preview.valid, preview.next); // next three occurrences (epoch seconds)

// Pause over a holiday week without losing the cron/ttl, then resume:
await client.deploy.pauseSchedule('proj-123', 'webhook_1', 'team-prod');
await client.deploy.resumeSchedule('proj-123', 'webhook_1', 'team-prod');
```

Without the `ttl` the run would start at 08:00 and simply run until the pipeline finishes — the cron alone cannot express the 15:00 boundary.

---

## 10. Apps — Publish Automation

The automation layer under the App Builder UI: the same scaffold, version rail, review flow, and audience bindings, scriptable. Scaffold a new app with `client.deploy.createApp(slug, { template, displayName, developerId, ... })` (Node.js) — the wizard's exact templates, written under `./apps/<slug>`, platform packages vendored from this client's own server, workspace install included. Deploy an app version with `client.deploy.addApp(appFolder, { comment, onProgress? })` (Node.js) — it packs the source exactly as the App Builder does (workspace-rooted layout, `appManifest.include` honored, gitignore + baseline filtering, the 50MB zipped / 512MB uncompressed caps) and ships it through the registry rail, narrating each step through `onProgress` when given; `client.deploy.add({ kind: 'app', data })` (section 9) remains the raw door when you packed the zip yourself. Pre-check everything first with `client.deploy.verifyApp(appFolder)` — a purely local dry run (no server call) returning `{ ok, checks: [{ id, ok, note }], fileCount, uncompressedBytes }` covering the manifest shape, id grammar, declared assets, include entries, and pack size. In CI the same ship is two commands: `rocketride app verify ./apps/reports && rocketride app deploy ./apps/reports --comment 'v1.4'` — both read the `ROCKETRIDE_DEPLOY_*` pair, and deploy refuses to run without a configured deployment target. The methods below manage the deployed versions. For building apps themselves, see ROCKETRIDE_APPS.md.

- `listDeployments(appId): Promise<Array<{ registryVersion, appVersion, sha256, publishedAt, author, message, state, buildStatus, rungs }>>` — the app's version rail, newest first. The developer org sees its FULL rail (published or not); other callers see only versions serving on rows visible to them. `buildStatus: 'ok'` means servable bytes exist; `rungs` names the audiences serving each version
- `submitApp(appId, registryVersion): Promise<{ artifact }>` — submit a deployed version for store review: flips the deployment's state `'private'` → `'submit'` (it enters the review queue). Developer-org gated
- `withdrawApp(appId, registryVersion): Promise<{ artifact }>` — the developer's own cancel: flips `'submit'` → `'private'` (leaves the review queue, back to draft; history records `'withdrawn'`). Only a version in `'submit'` withdraws
- `replyApp(appId, message, registryVersion?): Promise<{ replied: boolean; appId: string }>` — append a developer message to the app's review thread. It rides the app's deployment history as a `'reply'` row (side `'developer'`), the same stream `client.deploy.history()` reads
- `buildLog(appId, registryVersion): Promise<{ appId; version; log }>` — one version's durable server build log, the full phase-by-phase output. Long logs serve their tail; `''` means no log exists. Developer-org gated
- `publishApp(appId, registryVersion, target): Promise<{ publish }>` — bind a deployment to an audience. First publish, update, promote, and rollback are all this one verb ("repoint, never rebuild"). `target` is `'@me'`, `'@team/<name-or-id>'`, or `'@public'`; `'@public'` requires the deployment be `'ready'` (approved), `'@me'`/`'@team'` accept any non-`'failed'` deployment
- `removeAppPublish(appId, target): Promise<{ publish }>` — remove an audience binding (the app stops serving there). SOFT: registry versions and audit history survive; publishing again revives it
- `whereApp(appId): Promise<Array<{ rung, handle, version, appVersion, state, deployedAt? }>>` — the reverse index: which audiences serve which version

```typescript
// Pack + deploy an app folder, check the build, then publish to your team:
await client.deploy.addApp('./apps/reports', { comment: 'v1.4: dark mode' });
const [latest] = await client.listDeployments('acme.reports');
if (latest.buildStatus !== 'ok') {
	console.error((await client.buildLog('acme.reports', latest.registryVersion)).log);
} else {
	await client.publishApp('acme.reports', latest.registryVersion, '@team/qa');
}
```

---

## 11. Account & Billing Sub-Clients

### `client.account`

Typed wrapper for profile, organization, API keys, members, teams, and environment secrets.

**Profile:** `getProfile(): Promise<ConnectResult>` (includes `memberships` and `defaultOrgId`, which the auth handshake omits) · `updateProfile(fields)` · `setDevTeam(teamId)` (the team dev-mode runs bill to and whose environment layer applies) · `setDefaultOrg(orgId)` (switches the active org; the server resets the default team and refreshes all your connections) · `deleteAccount()`

**Organization:** `getOrg(orgId?): Promise<OrgDetail>` (id, name, plan, memberCount, teamCount) · `updateOrgName(orgId, name)`

**API keys:** `listKeys(): Promise<ApiKeyRecord[]>` · `createKey(params): Promise<{ key: string }>` (raw key string, shown once) · `revokeKey(keyId)`

**Members:** `listMembers(orgId): Promise<MemberRecord[]>` · `inviteMember(orgId, { email, givenName, familyName, role })` · `updateMemberRole(orgId, userId, role)` · `removeMember(orgId, userId)` · `resendInvite(orgId, userId)`

**Teams:** `listTeams(orgId): Promise<TeamRecord[]>` · `getTeamDetail(orgId, teamId): Promise<TeamDetail>` (includes members) · `createTeam(orgId, name)` · `deleteTeam(orgId, teamId)` · `addTeamMember(orgId, { teamId, userId, permissions })` · `updateTeamMemberPerms(orgId, { teamId, userId, permissions })` · `removeTeamMember(orgId, { teamId, userId })`

**Environment secrets** (the layered `ROCKETRIDE_*` store, merged server-side at auth):

- `getEnvironmentKeys(): Promise<string[]>` — available key NAMES from the merged environment (no values; for dropdowns)
- `getEnv(scope: 'org' | 'team' | 'user', scopeId?): Promise<Record<string, string>>` — read one scope's dict (org: pass orgId; team: pass teamId; user: omit)
- `setEnv(scope, env, scopeId?): Promise<void>` — write one scope's FULL dict (replaces the entire set at that level)

#### What members can do vs admins

Every operation above is role-checked server-side; an unauthorized call is refused with an explicit error (`'Admin role required ...'`) — nothing fails silently. The split for the documented operations:

- **Any org member**: their own profile (`getProfile`, `updateProfile`, `setDevTeam`, `setDefaultOrg`); their OWN API keys (`listKeys`, `createKey`, revoking their own); reading the org (`getOrg`); listing members and teams and reading a team's detail; USER-scope environment (`getEnv('user')` / `setEnv('user')`) and the merged key names (`getEnvironmentKeys`); billing reads (`getDetails`, `getCreditBalance`, `getProductPrices`) and promo codes (`validatePromoCode`, `redeemPromoCode`).
- **Org admin only**: renaming the org (`updateOrgName`); member management (`inviteMember`, `updateMemberRole`, `removeMember`, `resendInvite`); revoking ANOTHER member's key (own-org keys only); creating teams (`createTeam`); ORG-scope environment — both `getEnv('org', ...)` and `setEnv('org', ...)` (reads too: the org layer holds shared secrets); and every billing operation that moves money or reads the org's ledger — checkout/subscribe, portal, cancel, upgrade, credit purchases and top-ups, `getUsageByUser`/`getUsageByTeam`, `getTransactions`, `getTransactionDistinct`.
- **Team admin** (the `team.admin` permission on that team; org admins pass implicitly): `deleteTeam`, `addTeamMember`, `updateTeamMemberPerms`, `removeTeamMember`, and TEAM-scope `getEnv`/`setEnv` — both read and write.

### `client.billing`

Typed wrapper for subscriptions, Stripe checkout, credit wallets, and usage.

**Subscriptions:**

- `getDetails(orgId): Promise<BillingDetail[]>` — per-app subscription rows
- `getProductPrices(appId): Promise<AppPrice[]>` — active plans for an app, month-first
- `createCheckoutSession(orgId, appId, priceId, promotionCode?): Promise<{ clientSecret: string | null; subscriptionId: string; status: string }>` — `clientSecret` feeds `stripe.confirmPayment()`; `null` when the first invoice is $0 (subscription already active)
- `validatePromoCode(orgId, code, priceId?): Promise<PromoValidation>` — side-effect-free; unknown/expired codes return `{ valid: false, reason }`, never throw
- `redeemPromoCode(orgId, code): Promise<PromoRedemption>` — redeem a credit-grant code ($0 subscription + immediate credits; discount-only codes are rejected — apply those at checkout)
- `createPortalSession(orgId, returnUrl): Promise<{ url: string }>` — Stripe Billing Portal for payment methods
- `cancelSubscription(orgId, appId): Promise<{ canceled: boolean }>` — cancel at period end (access retained until then)
- `upgradeSubscription(orgId, appId, newPriceId)` — swap plans with automatic proration

**Compute credits:** `purchaseTopup(orgId, priceId): Promise<{ status; clientSecret? }>` (charges the card on file; credits land immediately; `clientSecret` returned when 3DS is required) · `getCreditBalance(orgId): Promise<CreditBalance>` (cheap; safe to poll ~1 req/s) · `listCreditPacks(): Promise<CreditPack[]>` · `createCreditCheckout(orgId, packId, returnUrl): Promise<{ url }>` (Stripe-hosted checkout)

**Transactions & usage:** `getTransactions(orgId, options?): Promise<TransactionsResult>` (paginated ledger; options `{ scope?, scopeId?, page?, pageSize?, since?, sort?, filters?, search? }` per the list-API convention) · `getTransactionDistinct(orgId, field)` (distinct column values for filter checklists) · `getUsageByUser(orgId)` / `getUsageByTeam(orgId): Promise<UsageRollup[]>` (consumption rollups, highest first)

---

## 12. Dashboard & Tasks

- `getDashboard(): Promise<DashboardResponse>` — a server dashboard snapshot: `{ overview, connections, tasks }` (active WebSocket connections, tasks in the registry, aggregate metrics). Requires `task.monitor` permission
- `listConnections(req?: ListPageRequest): Promise<ListConnectionsResponse>` — one page of the caller's active connections (default sort `connectedAt` ascending); requires `task.monitor`
- `listTasks(req?: ListPageRequest): Promise<ListTasksResponse>` — one page of the caller's tasks (default sort `startTime` ascending); requires `task.monitor`

**`ListPageRequest`** (wire-shaped — forward it verbatim from a data grid): `page?` (1-based, default 1), `page_size?` (server-clamped 1..100, default 50), `search?` (case-insensitive over searchable keys), `sort?: Array<{ field, dir: 'asc' | 'desc' }>`, `filters?: Record<string, string | string[]>` (string = contains/equality, array = set membership, `${field}__gte` / `${field}__lte` string entries = range bounds). All list responses use the standard envelope `{ rows, total, page, pageSize }`.

---

## 13. Database Sub-Client (`client.database`)

Direct SQL/Cypher execution against a database pipeline node, bypassing the LLM translation layer that `chat()` uses (and its safety checks — you own the statements you send).

- `query(options): Promise<{ rows: Record<string, unknown>[]; affected_rows: number }>` — execute a raw SQL or Cypher statement. Options: `token` and `sql` (required, non-empty); `nodeId?` (empty broadcasts to all tool-lane nodes — the first database node handles it); `sessionId?` (run within a transaction session); `params?: unknown[]` (positional parameters, e.g. `[1, 'foo']` for `$1`, `$2` placeholders)
- `beginTransaction(options: { token: string; nodeId?: string }): Promise<{ session_id: string }>` — begin a transaction; thread the returned `session_id` through subsequent `query`/`commit`/`rollback` calls
- `commit(options: { token: string; sessionId: string; nodeId?: string }): Promise<{ ok: boolean }>` / `rollback(...)` — same shape
- `dialect(options: { token: string; nodeId?: string }): Promise<DatabaseDialect>` — discover the underlying engine (`DatabaseDialect.POSTGRES | MYSQL | NEO4J`); branch on SQL syntax differences or detect a graph DB

##### `sequelize(options): Sequelize`

Build a Sequelize ORM instance that transports its SQL over the RocketRide pipe instead of a TCP socket. `sequelize` is an optional **peer dependency** — import the class yourself and pass it in:

```typescript
import { Sequelize } from 'sequelize';

const db = client.database.sequelize({ Sequelize, token, nodeId: 'db_postgres_1' });
// define models / run queries as usual — traffic rides the RocketRide connection
```

**Transaction example:**

```typescript
const { session_id } = await client.database.beginTransaction({ token, nodeId: 'db_postgres_1' });
try {
	await client.database.query({ token, sql: 'INSERT INTO items (name) VALUES ($1)', params: ['widget'], sessionId: session_id });
	await client.database.commit({ token, sessionId: session_id });
} catch (err) {
	await client.database.rollback({ token, sessionId: session_id });
	throw err;
}
```

Pin `nodeId` on every call of a transaction when the pipeline has more than one database node — broadcasts may land on different nodes.

---

## 14. `rocketride/app-sdk` — Shell App Development

The subpath export for building apps that run inside the RocketRide shell (the document-model host API). At build time it provides full type declarations; at runtime Module Federation substitutes the shell host's real implementations — apps never bundle them. **For app development** — see ROCKETRIDE_APPS.md for the app model, descriptors, and publish flow.

```typescript
import type { AppDescriptor, ShellAppProps } from 'rocketride/app-sdk';
import { useShellConnection, useWorkspace, connectionManager } from 'rocketride/app-sdk';
```

**Type exports:** `ShellAppProps`, `ConnectResult`, `AppDescriptor`, `AppManifestEntry`, `SettingValue`, `SettingSchema`, `AppConfiguration`, `ShellBrandingConfig`, `WorkspacePrefs`, `IWorkspaceContext`, `ShellApiConfig`, `ShellThemeConfig`, `ShellThemeOption`, `IVirtualFileSystem`, `Document`, `Editor`, `EditorGroup`, `SplitOrientation`, `DocumentsState`, `ShellEventMap`.

**Hooks:**

- `useShellConnection(): { client: RocketRideClient | null; isConnected: boolean; statusMessage: string | null }` — the active shell connection; the shell owns auth and the client, apps consume it
- `useShellApiConfig(): ShellApiConfig` — shell-level config keys (server-forwarded environment plus user settings)
- `useWorkspace(): IWorkspaceContext` — preferences, settings, app manifest, opaque app state, dispatch
- `useAuthUser(): ConnectResult | null` — the authenticated identity; `useLogout(): (() => void) | null` — the logout trigger
- `useSubscriptions(): { desktopApps, isOnDesktop(appId), getStatus(appId) }` — desktop apps and subscription state
- `useAppComponent(appId, componentName): React.ComponentType | null` — load a React component from another app's catalog (lazy-loads the descriptor; `null` while loading)

**Documents class** — VS Code-style document model, app-owned:

```typescript
const docs = new Documents(vfs);
await docs.openDocument('myfile.pipe');
const state = docs.useStore(); // React hook — subscribes to state changes
docs.destroy();
```

Methods: `getState()`, `getDocument(uri)`, `useStore()`, `openDocument(uri, groupId?)`, `createDocument(groupId?, initialContent?)`, `closeEditor(editorId)`, `updateContent(uri, content)`, `saveDocument(uri)`, `revertDocument(uri)`, `splitGroup(groupId, orientation)`, `moveEditor(editorId, targetGroupId)`, `closeGroup(groupId)`, `setActiveEditor(groupId, editorIndex)`, `setActiveGroup(groupId)`, `updateEditorViewport(editorId, patch)`, `destroy()`.

**Connection manager (non-React):** `connectionManager.emit(event, payload)` / `connectionManager.on(event, handler)` (typed `ShellEventMap` events; `on` returns an unsubscribe function) · `connectionManager.getClient()` / `connectionManager.isConnected()` · module-level `getClient(): RocketRideClient | null`

**Debug helpers:** `getDebugLog()` (last 500 events), `clearDebugLog()`, `onAny(handler)` (wildcard listener; returns unsubscribe).

---

## 15. CLI Tool

The package installs a `rocketride` command (use `pnpm exec rocketride` /
`npx rocketride` for local installs). The Python client installs the
IDENTICAL command — same verbs, same flags, same output — so recipes port
between languages unchanged.

**Common options** (every command): `--uri <uri>` (default:
`ROCKETRIDE_URI` or `http://localhost:5565`), `--apikey <key>` (default:
`ROCKETRIDE_APIKEY`), and `--json [file]` — the command's entire result
as one JSON value on stdout (or written to `file`), built for scripts and
agents; failures become an `{"error": {"message", "hint"}}` envelope with
a non-zero exit. The CLI loads the workspace `.env`. Deploy verbs
(`deploy *`, `app deploy`) use the `ROCKETRIDE_DEPLOY_*` pair instead and
refuse to run without it.

### Workspace Commands

- `rocketride init` — provision the workspace end-to-end: sign in (see
  `login`), sync the services catalog + schemas, vendor `shell.tgz` and
  `rocketride.tgz` into `.rocketride/`, install the agent docs bundle and
  the CLAUDE.md stub, and ensure `.gitignore` covers `.rocketride/` and
  `.env`. Idempotent — re-run any time to refresh against the connected
  server.
- `rocketride login [--deploy] [--apikey <key>]` — (re)authenticate and
  save credentials to `.env` (and make `.env` git-ignored in the same
  step). OSS servers take an API key; saas servers open the browser to
  sign in and mint a durable personal API key. Run it whenever a command
  reports rejected credentials. `--deploy` targets the
  `ROCKETRIDE_DEPLOY_*` pair.

### Task Commands

```bash
rocketride list                                            # one-shot list of your active tasks
rocketride start --pipeline ./my-pipeline.pipe             # start; prints the task token and exits
rocketride upload files/*.csv --pipeline ./pipeline.pipe   # start + upload + terminate
rocketride upload files/*.csv --token TASK_TOKEN           # upload into an already-running task
rocketride stop --token TASK_TOKEN                         # terminate a task
```

- `start` options: `--pipeline <file>` (or `ROCKETRIDE_PIPELINE`; required), `--token <token>` (or `ROCKETRIDE_TOKEN`), `--threads <num>` (default 4), `--args <args...>`
- `upload` options: `--pipeline <file>` or `--token <token>` (one required), `--threads <num>` (default 4), `--max-concurrent <num>` (default 5), `--args <args...>`

There is no live-monitor command: continuous monitoring belongs to the
platform's event monitor and server monitor apps — the CLI is one-shot,
line-oriented output by design.

### Store Commands (`rocketride store ...`)

File store operations against the account cloud store:

```bash
rocketride store dir [path]                       # list directory contents (DOS-style listing)
rocketride store type <path>                      # print file contents
rocketride store write <path> --file local.bin    # upload a local file
rocketride store write <path> --content "text"    # write inline text
rocketride store rm <path>                        # delete a file
rocketride store mkdir <path>                     # create a directory
rocketride store stat <path>                      # file/directory metadata
```

All store subcommands take the common `--uri`/`--apikey` options.

### App Commands (`rocketride app ...`)

App lifecycle verbs are **deployment-target** operations: they default to
the `ROCKETRIDE_DEPLOY_URI` / `ROCKETRIDE_DEPLOY_APIKEY` pair and refuse
to run when no deployment target is configured — they never fall back to
the development connection.

- `rocketride app create <slug> [--template Blank|Dashboard] [--name <text>]
  [--developer <id>] [--sidebar] [--no-status-footer] [--doc-tabs]
  [--no-install]` — scaffold a new app under `./apps/<slug>` with the same
  templates as the App Builder wizard, vendoring the platform packages
  from the development server (`ROCKETRIDE_URI`). SDK equivalent:
  `client.deploy.createApp(slug, options)`. Scaffolding only — nothing
  deploys.
- `rocketride app verify <folder> [--workspace <dir>]` — the
  no-side-effect precheck: manifest shape, id grammar, declared assets,
  include entries, and a pack dry run against the caps. Exit 0 when ready,
  1 with FAIL lines when not. Needs no server connection at all.
- `rocketride app deploy <folder> [--workspace <dir>] [--comment <text>]
  [--verbose]` — pack the app folder's source (App Builder rules:
  workspace-rooted layout, `appManifest.include`, gitignore + baseline
  filtering, size caps) and deploy it as the next registry version;
  `--verbose` narrates every pack step. Deploying activates nothing —
  publish a rung to serve it.

```bash
# CI: precheck, then deploy the packed source as the next registry version
rocketride app verify ./apps/reports
rocketride app deploy ./apps/reports --comment "ci: $GITHUB_SHA"
```

### Deploy Commands (`rocketride deploy ...`)

Deployment-target verbs (the `ROCKETRIDE_DEPLOY_*` pair), following the
platform vocabulary — **deploy** = version to the server's registry,
**publish** = bind a rung to a version:

```bash
rocketride deploy add pipelines/ingest.pipe --comment "v2 parse"    # next registry version (--kind pipe|node)
rocketride deploy publish <projectId> 3 --team <teamId>             # point the team at version 3
rocketride deploy list                                              # deployments overview
rocketride deploy get <projectId> --team <teamId>                   # one deployment's state + schedules
rocketride deploy versions <projectId>                              # registry versions
rocketride deploy history <projectId>                               # deploy/publish audit trail
rocketride deploy run <projectId> <sourceId> --team <teamId>        # trigger a run now
rocketride deploy schedule set <projectId> <sourceId> "0 9 * * 1-5" --team <teamId> --ttl 32400
rocketride deploy schedule pause <projectId> <sourceId> --team <teamId>
rocketride deploy schedule resume <projectId> <sourceId> --team <teamId>
rocketride deploy schedule preview "0 9 * * 1-5"                    # validate a cron + next firings
rocketride deploy log <appId> <version>                             # read an app version's build log
rocketride deploy enable|disable|remove <projectId> --team <teamId>
```

Every verb here fronts a `client.deploy.*` SDK method — prefer the API in
application code; the CLI is the one-shot form for terminals, CI, and
quick lifecycle operations (all verbs support `--json`).

---

## 16. Data Types & MIME

### PipelineConfig

```typescript
interface PipelineConfig {
	name?: string;             // display name — REQUIRED when deploying (renders on every deploy surface)
	components: Array<{
		id: string;              // unique component identifier
		provider: string;        // component type (e.g. 'webhook', 'parse', 'chat', 'llm_openai')
		config: Record<string, unknown>;
		input?: Array<{ lane: string; from: string }>;        // data-flow connections
		control?: Array<{ classType: string; from: string }>; // invoke (control-flow) connections
		name?: string;
		ui?: Record<string, unknown>;
	}>;
	source?: string;           // entry-point component ID
	project_id?: string;       // project identifier
	// plus optional editor fields: description, version, viewport, ...
}
```

### PIPELINE_RESULT

```typescript
interface PIPELINE_RESULT {
	name: string;                            // result identifier (UUID)
	path: string;                            // file path context (often empty for direct sends)
	objectId: string;                        // object identifier (UUID)
	result_types?: Record<string, string>;   // field name -> data type (e.g. { answers: 'answers' })
	[key: string]: any;                      // dynamic fields per result_types (text, answers, ...)
}
```

Fields named in `result_types` appear as top-level dynamic fields: type `'text'` fields are `string[]`, type `'answers'` fields are the AI responses. Always treat dynamic fields as optional.

### UPLOAD_RESULT

```typescript
interface UPLOAD_RESULT {
	action: 'open' | 'write' | 'close' | 'complete' | 'error';
	filepath: string;          // original filename
	bytes_sent: number;
	file_size: number;
	upload_time: number;       // seconds
	result?: PIPELINE_RESULT;  // present when action is 'complete'
	error?: string;            // present when action is 'error'
}
```

### TASK_STATE / TASK_STATUS

```typescript
enum TASK_STATE { NONE = 0, STARTING = 1, INITIALIZING = 2, RUNNING = 3, STOPPING = 4, COMPLETED = 5, CANCELLED = 6 }
```

`TASK_STATUS` (from `getTaskStatus()`) — key fields:

```typescript
interface TASK_STATUS {
	name: string;              // task display name (project_id and source alongside)
	completed: boolean;        // true once finished — prefer this over comparing state
	state: number;             // TASK_STATE value
	startTime: number;         // Unix seconds (endTime alongside)
	status: string;            // current status message
	errors: string[];          // recent error history (max 50); warnings likewise
	totalCount: number;        // items to process (completedCount / failedCount alongside)
	rateCount: number;         // items/second (instantaneous)
	serviceUp: boolean;        // ready to process requests
	exitCode: number;          // 0 = success (exitMessage carries detail)
	pipeflow: { totalPipes: number; byPipe: Record<number, string[]> };
	metrics: TASK_METRICS;     // cpu_percent, cpu_memory_mb, gpu_memory_mb + peaks/averages
	tokens: TASK_TOKENS;       // cumulative billing tokens (cpu/memory/gpu/custom/total)
	// plus size counters, run analytics (componentStats, slowestDocs, ...) when tracing is on
}
```

### MIME Types

The SDK does not guess MIME types from file extensions. Resolution order for uploads: explicit `mimetype` on the file object / `send()` / `pipe()` call → the browser `File.type` (`sendFiles` only) → `application/octet-stream`. Always pass an explicit MIME type in Node.js, where `File.type` is usually empty.

The MIME type determines which **source lane** receives the data: `application/rocketride-question` → questions lane (the format `chat()` uses); `text/*` → text; `image/*` → image; `video/*` → video; `audio/*` → audio; others → data lane. If a pipe `open()` fails with a lane error, the source component has no lane matching your MIME type (try `text/plain` for text sources).

---

## 17. Profiling

Server-side cProfile sessions for finding where pipeline (or server) time
goes. One session at a time per target; `target` is a task token to profile
that pipeline's subprocess, or omitted/null to profile the server process.

```typescript
await client.cprofileStart(token, 'slow-parse-hunt');
// ... exercise the pipeline ...
await client.cprofileStop(token);
const report = await client.cprofileReport(token);      // full pstats text
const tree = await client.cprofileReportTree(token);    // call tree
```

- `cprofileStart(target?, session?)` — begin a session; returns status with
  session info and start time.
- `cprofileStop(target?)` — end it; returns session name and runtime.
- `cprofileStatus(target?)` — active/inactive, owner, runtime.
- `cprofileReport(target?)` — the full pstats text report of the last
  completed session.
- `cprofileReportTree(target?, maxDepth?, minPct?, includeSystem?)` — the
  call tree (defaults: depth 50, 0.1% cumtime threshold) with `total_time`
  and `total_calls`; raise `minPct` or lower `maxDepth` to shrink it. Read
  it top-down: the widest cumulative-time branch under the run loop is the
  slow pipeline component.

## 18. Exceptions

The SDK exports a typed exception hierarchy so you can catch errors at the right level of specificity. All extend the base `DAPException`, which carries the raw server response on a `dapResult: Record<string, unknown>` property. All are importable from the package root.

```
DAPException                      // base — wraps any DAP error response (.dapResult)
└─ RocketRideException            // root of all RocketRide-specific errors
   ├─ ConnectionException         // connect/transport problems, dropped connections
   │  └─ AuthenticationException  // bad API key / credentials
   ├─ PipeException               // data pipe / upload / streaming failures
   ├─ ExecutionException          // pipeline start/run/management failures
   └─ ValidationException         // invalid pipeline configuration

LoginAttemptCancelledError        // extends Error directly — control flow, not a server failure
```

**Which methods throw what:**

- `AuthenticationException`: thrown by `login()` (and therefore `connect()`) on auth failure. In persist mode the client does **not** retry after an auth failure — fix credentials and reconnect.
- `ConnectionException`: `attach()`/`connect()` transport failures; also delivered to the `onConnectError` constructor callback (whose argument is typed `ConnectionException`).
- `PipeException`: `DataPipe.open()/write()/close()` (and therefore `send()`, `sendFiles()`, `chat()`) on server-reported pipe failures.
- `LoginAttemptCancelledError`: a `login()`/`connect()` superseded by newer intent (`reason`: `'superseded' | 'logout' | 'detached'`) — treat as control flow, not an error condition.

Catch the most specific type first, then fall back to a broader one:

```typescript
try {
	await client.connect('your-api-key');
} catch (err) {
	if (err instanceof AuthenticationException) {
		console.error('Bad credentials:', err.message);
	} else if (err instanceof RocketRideException) {
		console.error('RocketRide error:', err.message, err.dapResult);
	} else {
		throw err;
	}
}
```

---

## 19. Best Practices

1. **Use context managers** (`withConnection` or `await using`) for automatic cleanup.
2. **Keep the process alive for events.** Events arrive over the WebSocket — in Node.js the open socket keeps the event loop (and your process) alive, and `disconnect()` releases it. Do not exit or disconnect while uploads or monitored tasks are still in flight, and keep `onEvent` handlers fast and non-blocking: a long synchronous handler stalls every other message on the connection.
3. **Start long-lived pipelines once.** `use()` is expensive; for chat systems start the pipeline globally and reuse the token (`useExisting: true` reattaches) rather than start/ask/stop per question.
4. **Handle exceptions at the right level of specificity** (section 18), and treat `LoginAttemptCancelledError` as control flow.
5. **Use `addMonitor`/`removeMonitor`** for event subscriptions — they refcount across consumers and replay automatically on reconnect. Never use the deprecated `setEvents`.
6. **Enable persist mode** for long-running applications; reconnect backoff is linear-capped and auth failures stop the retry loop (surface them via `onConnectError`).
7. **Validate before executing**: `validate()` catches structural pipeline errors without burning a task start.
8. **Stream large datasets** through `pipe()` instead of one giant `send()`, bound upload concurrency with `sendFiles`'s `maxConcurrent`, and pass explicit MIME types in Node.js (there is no extension-based detection).
9. **Use `expectJson: true`** plus examples/context in AI questions for reliable data extraction.
10. **Let the server do the cron math**: render schedule previews from `deploy.preview()`, and remember a run *window* is cron (start) + ttl (duration).

## Requirements

Node.js 18+ recommended (the package declares no hard `engines` floor; `await using` / `Symbol.asyncDispose` require Node 20+ and TypeScript 5.2+), a WebSocket connection to a RocketRide DAP server, and a valid API key.

## License

MIT
