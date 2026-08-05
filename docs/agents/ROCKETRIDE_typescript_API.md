# RocketRide Client SDK (TypeScript/JavaScript)

A TypeScript/JavaScript SDK for executing RocketRide pipelines using the Debug Adapter Protocol (DAP). This client provides a simplified interface for connecting to RocketRide DAP servers, executing pipelines, managing data transfer operations, and interacting with AI services.

## Features

- **DAP-based communication** for reliable pipeline execution
- **Simple execute-and-exit workflow** for pipeline automation
- **Comprehensive error handling** and logging
- **Automatic API key management** for all DAP commands
- **Object-oriented data pipe management** with context manager support
- **Parallel file upload capabilities** with progress events
- **Token-based operations** for data pipe commands
- **TypeScript support** with full type definitions
- **AI chat functionality** with structured JSON responses
- **Event monitoring** for real-time pipeline status
- **Automatic reconnection** with configurable persistence
- **Command-line interface** for pipeline management

## Installation

### Using npm

```bash
# Install from npm registry
npm install rocketride

# Install as dev dependency
npm install -D rocketride

# Install globally
npm install -g rocketride
```

### Using pnpm

```bash
# Install from npm registry
pnpm add rocketride

# Install as dev dependency
pnpm add -D rocketride

# Install globally
pnpm add -g rocketride
```

### Uninstalling

```bash
# Using npm
npm uninstall rocketride
npm uninstall -g rocketride  # global

# Using pnpm
pnpm remove rocketride
pnpm remove -g rocketride  # global
```

The package includes both the SDK library and a CLI tool.

## Configuration

### Environment Variables

You can configure the client using a `.env` file:

```env
# .env file
ROCKETRIDE_APIKEY=your-api-key-here
ROCKETRIDE_URI=https://api.rocketride.ai
```

The client will automatically parse the `.env` file if it exists (Node.js only) and use the values as defaults. The priority order is:

1. **Constructor parameters** (highest priority)
2. **`.env` file values**
3. **Default values** (lowest priority)

The client automatically reads configuration from the `.env` file, so you typically don't need to pass any parameters:

```typescript
// Reads ROCKETRIDE_URI and ROCKETRIDE_APIKEY from .env
const client = new RocketRideClient();
```

You can override `.env` settings by passing configuration directly to the constructor if needed:

```typescript
// Override for testing or special cases
const client = new RocketRideClient({
	auth: 'your-api-key',
	uri: 'https://api.rocketride.ai',
});
```

### Environment Variable Substitution in Pipelines

The SDK automatically performs template variable substitution in pipeline configurations. Any string containing `${ROCKETRIDE_*}` will be replaced with the corresponding value from your `.env` file.

**Example `.env` file:**

```env
ROCKETRIDE_APIKEY=your-api-key
ROCKETRIDE_URI=https://api.rocketride.ai
ROCKETRIDE_INPUT_PATH=/data/input
ROCKETRIDE_OUTPUT_PATH=/data/output
```

**Example pipeline configuration:**

```typescript
const pipeline = {
	project_id: '{guid}', // Replace with your unique GUID
	source: 'data-processor',
	components: [
		{
			id: 'data-processor',
			provider: 'transform',
			config: {
				inputPath: '${ROCKETRIDE_INPUT_PATH}', // Replaced with: /data/input
				outputPath: '${ROCKETRIDE_OUTPUT_PATH}', // Replaced with: /data/output
				apiKey: '${ROCKETRIDE_APIKEY}', // Replaced with: your-api-key
				staticValue: 'this stays the same', // Not changed
				unknownVar: '${ROCKETRIDE_UNKNOWN}', // Left as-is (not in .env)
			},
		},
	],
};

// Variables are automatically substituted when you call use()
const result = await client.use({ pipeline });
```

**Key features:**

- Works with deeply nested objects and arrays
- Only replaces variables that exist in `.env` file
- Unknown variables are left unchanged
- Only matches `${ROCKETRIDE_*}` pattern (other variables ignored)
- Performs substitution before sending to server

## CLI Tool

The package includes an `rocketride` command-line tool for managing pipelines and file uploads.

### CLI Installation

After installing the package, the `rocketride` command becomes available:

```bash
# Local installation (use with npx)
npm install rocketride
npx rocketride --help

# Global installation
npm install -g rocketride
rocketride --help
```

### CLI Commands

**Start a pipeline:**

```bash
rocketride start --pipeline ./my-pipeline.pipe --apikey YOUR_KEY
```

**Upload files:**

```bash
rocketride upload files/*.csv --pipeline ./pipeline.pipe --apikey YOUR_KEY
# or with existing task token
rocketride upload files/*.csv --token TASK_TOKEN --apikey YOUR_KEY
# with custom concurrency (default is 64)
rocketride upload files/*.csv --token TASK_TOKEN --max-concurrent 10 --apikey YOUR_KEY
```

Upload command supports parallel file uploads with configurable concurrency (default: 64). Use `--max-concurrent` to control how many files are uploaded simultaneously.

**Monitor pipeline status:**

```bash
rocketride status --token TASK_TOKEN --apikey YOUR_KEY
```

**Stop a pipeline:**

```bash
rocketride stop --token TASK_TOKEN --apikey YOUR_KEY
```

### CLI Configuration

The CLI supports `.env` file configuration. See the Configuration section above.

## SDK Quick Start

### Basic Pipeline Execution

```typescript
import { RocketRideClient } from 'rocketride';

const client = new RocketRideClient({
	uri: 'https://api.rocketride.ai',
	auth: 'your-api-key',
});

await client.connect();

const pipeline = {
	components: [
		{ id: 'input', provider: 'webhook', config: {} },
		{ id: 'process', provider: 'transform', config: {}, input: [{ lane: 'text', from: 'input' }] },
		{ id: 'output', provider: 'response_text', config: {}, input: [{ lane: 'text', from: 'process' }] },
	],
	source: 'input',
	project_id: '{guid}', // Replace with your unique GUID
};

const result = await client.use({ pipeline });
console.log(`Pipeline started with token: ${result.token}`);

await client.disconnect();
```

### Using Context Managers for Automatic Cleanup

The TypeScript client supports automatic resource cleanup using two patterns:

#### Using Symbol.asyncDispose (ECMAScript Explicit Resource Management)

```typescript
import { RocketRideClient } from 'rocketride';

// Requires TypeScript 5.2+ and Node.js with Symbol.asyncDispose support
await using client = new RocketRideClient({
	auth: 'your-api-key',
	uri: 'https://api.rocketride.ai',
});

// Client is automatically connected and will be disconnected when leaving scope
const result = await client.use({ pipeline });
// Client automatically disconnects here
```

#### Using Static withConnection Method

```typescript
import { RocketRideClient } from 'rocketride';

// Python-style async with pattern
// Configuration from .env file
const result = await RocketRideClient.withConnection(
	{}, // Empty config uses .env settings
	async (client) => {
		// Client is already connected
		const pipelineResult = await client.use({ pipeline });
		const data = await client.send('task-token', 'data');
		return data;
	}
);
// Client automatically disconnects after callback completes
console.log('Result:', result);
```

### Persistent Connection with Auto-Reconnect

```typescript
import { RocketRideClient } from 'rocketride';

// Create client with automatic reconnection enabled
const client = new RocketRideClient({
	auth: 'your-api-key',
	uri: 'https://api.rocketride.ai',
	persist: true, // Enable automatic reconnection (exponential backoff)
	maxRetryTime: 60000, // Stop retrying after 60 seconds (omit to retry forever)
	onConnected: async (info) => {
		console.log(`Connected: ${info}`);
	},
	onDisconnected: async (reason, hasError) => {
		if (hasError) {
			console.log(`Connection lost: ${reason}`);
		}
	},
	onConnectError: async (error) => {
		console.log(`Connection attempt failed: ${error}`);
	},
});

await client.connect();

// If connection is lost, the client will automatically attempt to reconnect
// To stop auto-reconnection, call disconnect()
await client.disconnect();
```

### Data Transfer with Pipes

```typescript
import { RocketRideClient } from 'rocketride';

const client = new RocketRideClient({
	uri: 'https://api.rocketride.ai',
	auth: 'your-api-key',
});

await client.connect();

// Create and use a data pipe
const pipe = await client.pipe('task-token', { name: 'data.json' }, 'application/json');

try {
	await pipe.open();

	// Write data in chunks
	const encoder = new TextEncoder();
	await pipe.write(encoder.encode('{"message": "Hello World"}'));

	const result = await pipe.close();
	console.log('Upload completed:', result);
} catch (error) {
	console.error('Upload failed:', error);
}

await client.disconnect();
```

### Bulk File Upload (Parallel)

```typescript
import { RocketRideClient } from 'rocketride';

const client = new RocketRideClient({
	auth: 'your-api-key',
	onEvent: (event) => {
		// Upload progress comes through the event system
		if (event.event === 'apaevt_status_upload') {
			const body = event.body;
			console.log(`${body.filepath}: ${body.action} - ${body.bytes_sent}/${body.file_size} bytes`);
		}
	},
});

await client.connect();

// Upload files in parallel (all files uploaded concurrently)
const results = await client.sendFiles([{ file: fileObject1 }, { file: fileObject2, mimetype: 'application/json' }, { file: fileObject3, objinfo: { custom: 'metadata' } }], 'task-token');

console.log('Upload results:', results);
await client.disconnect();
```

## API Reference

### RocketRideClient

#### Constructor

```typescript
new RocketRideClient(config?: RocketRideClientConfig)
```

**Configuration Options:**

- `auth?: string` - API key for authentication (can also use `ROCKETRIDE_APIKEY` in `.env`)
- `uri?: string` - Server URI (default: `https://api.rocketride.ai`, can also use `ROCKETRIDE_URI` in `.env`)
- `onEvent?: (event: DAPMessage) => void` - Event handler for server events
- `onConnected?: (connectionInfo?: string) => Promise<void>` - Connection established callback
- `onDisconnected?: (reason?: string, hasError?: boolean) => Promise<void>` - Connection lost callback
- `persist?: boolean` - Enable automatic reconnection with exponential backoff (default: false)
- `maxRetryTime?: number` - Maximum total time in milliseconds to keep retrying connections (default: undefined, retry indefinitely)
- `onConnectError?: (error: ConnectionException) => void | Promise<void>` - Called on each failed connection attempt in persist mode (the argument is a `ConnectionException`)
- `module?: string` - Module name for client identification

#### Connection Methods

##### `connect(credential?: string | { code: string; verifier: string; redirectUri: string }, options?: { uri?: string; timeout?: number }): Promise<ConnectResult>`

Establish a connection to the RocketRide server. The optional `credential` may be either an API-key/token string or an OAuth PKCE object (`{ code, verifier, redirectUri }`); `options` (`uri`, `timeout`) override config per call. Returns a `ConnectResult` carrying the resolved auth/identity info (most callers can ignore the return value).

##### `disconnect(): Promise<void>`

Close connection to the RocketRide server and stop automatic reconnection.

##### `isConnected(): boolean`

Check if the client is currently connected to the server.

#### Auth & Connection Lifecycle

Lower-level lifecycle primitives that `connect()`/`disconnect()` build on: open a transport, authenticate, and tear down independently. `connect()` itself is the high-level convenience: it attaches and logs in for you, and its `credential` may be either an API key/token string or an OAuth PKCE object `{ code, verifier, redirectUri }`.

##### `attach(uri?: string, options?: { timeout?: number }): Promise<void>`

Open the WebSocket transport without authenticating. If `uri` differs from the current one, the client detaches first. After attach, public (`rrext_public_*`) APIs are available. No-op if already attached to the same URI.

##### `login(credential?: string | { code: string; verifier: string; redirectUri: string }, options?: { uri?: string; timeout?: number }): Promise<ConnectResult>`

Authenticate over an already-attached transport. Accepts an API key, an `rr_` token, or a PKCE code object. If `options.uri` differs, it detaches and re-attaches first. Returns a `ConnectResult` with user identity. Throws `AuthenticationException` on failure (the transport stays attached).

##### `logout(): Promise<void>`

Deauthenticate (sends `deauth`) and clear client auth state. The transport stays attached, so public APIs keep working.

##### `detach(): Promise<void>`

Close the WebSocket transport entirely.

**Example: manual attach/login/logout/detach:**

```typescript
const client = new RocketRideClient({ uri: 'https://api.rocketride.ai' });

await client.attach(); // transport only — public APIs now available
await client.login('your-api-key'); // authenticate
// ... do authenticated work ...
await client.logout(); // drop auth, keep transport
await client.detach(); // close transport
```

#### Execution Methods

##### `use(options: UseOptions): Promise<{ token: string, ... }>`

Start a RocketRide pipeline for processing data. Automatically performs environment variable substitution on the pipeline configuration.

**Options:**

- `pipeline?: PipelineConfig` - Flat pipeline configuration object (`components`, `source`, `project_id` at top level)
- `filepath?: string` - Path to a `.pipe` or JSON file containing pipeline configuration (Node.js only).
- `token?: string` - Custom token for the pipeline (auto-generated if not provided)
- `source?: string` - Override pipeline source
- `threads?: number` - Number of threads for execution (default: 1)
- `useExisting?: boolean` - Use existing pipeline instance
- `args?: string[]` - Command line arguments to pass to pipeline
- `ttl?: number` - Time-to-live in seconds for idle pipelines (optional, server default if not provided; use 0 for no timeout)
- `pipelineTraceLevel?: 'none' | 'metadata' | 'summary' | 'full'` - When set, captures every lane write and invoke call in the response under `_trace`

##### `terminate(token: string): Promise<void>`

Terminate a running pipeline.

##### `getTaskStatus(token: string): Promise<TASK_STATUS>`

Get the current status of a running pipeline.

##### `validate(options: { pipeline: PipelineConfig | Record<string, unknown>; source?: string }): Promise<ValidationResult>`

Validate a pipeline configuration without starting it: a pre-flight check before `use()`. Returns a `ValidationResult` with `errors` and `warnings` arrays (plus any extra engine fields). A pipeline will not execute while it has `errors`; `warnings` are non-fatal.

```typescript
const result = await client.validate({ pipeline });
if (result.errors.length > 0) {
	console.error('Pipeline invalid:', result.errors);
} else {
	const { token } = await client.use({ pipeline });
}
```

##### `restart(options: { token?: string; projectId: string; source: string; pipeline: Record<string, unknown> }): Promise<void>`

Restart a running pipeline with a new configuration. Looks up the existing task by project/source, terminates it, and starts a new execution in one server round-trip. `token` is optional and resolved server-side if omitted.

```typescript
await client.restart({ projectId: 'proj-123', source: 'input', pipeline });
```

##### `getTaskToken(options: { projectId: string; source: string }): Promise<string | undefined>`

Resolve a running task's token from its project ID and source component. The token is required for operations like `terminate()` and `restart()`. Returns `undefined` if no task is currently running for that project/source.

```typescript
const token = await client.getTaskToken({ projectId: 'proj-123', source: 'input' });
```

##### `getTaskPipeline(token: string): Promise<Record<string, unknown> | undefined>`

Return the unresolved pipeline configuration for a running task. The pipeline is returned exactly as stored: `${ROCKETRIDE_*}` placeholders are **not** substituted, so no secrets are included. Returns `undefined` if the task is not found.

```typescript
const pipeline = await client.getTaskPipeline(token);
```

#### Data Methods

##### `send(token: string, data: string | Uint8Array, objinfo?: Record<string, any>, mimetype?: string): Promise<PIPELINE_RESULT | undefined>`

Send data directly to a pipeline.

**Important:** Use this method with pipelines that have `webhook` or `dropper` as the source component. For chat/Q&A systems, use `chat()` method instead with a `chat` source component.

##### `sendFiles(files: FileObject[], token: string): Promise<UPLOAD_RESULT[]>`

Upload multiple files in parallel.

**Important:** Use this method with pipelines that have `webhook` or `dropper` as the source component for document processing. For chat/Q&A systems, use `chat()` method with a `chat` source component instead.

**Note:** Upload progress events are sent through the event system as `apaevt_status_upload` events, not through a callback parameter. Subscribe to events using the `onEvent` callback in the constructor.

**File Object:**

```typescript
{
  file: File;               // File object to upload
  objinfo?: Record<string, any>;  // Optional metadata
  mimetype?: string;        // Optional MIME type
}
```

##### `pipe(token: string, objinfo?: Record<string, any>, mimeType?: string, provider?: string): Promise<DataPipe>`

Create a streaming data pipe for sending large datasets.

##### Streaming callback (`onSSE`)

`pipe()`, `send()`, and `chat()` accept a trailing `onSSE` callback that fires for each server-sent event (e.g. token-by-token AI output) while the request is in flight. The callback signature is the same in every case:

```typescript
onSSE?: (type: string, data: Record<string, unknown>) => Promise<void>
```

It is the last positional parameter on `pipe()` and `send()`, and a field on the `chat()` options object:

- `send(token, data, objinfo?, mimetype?, onSSE?)`
- `pipe(token, objinfo?, mimeType?, provider?, onSSE?)`
- `chat({ token, question, onSSE? })`

**Example: stream a chat answer:**

```typescript
const response = await client.chat({
	token,
	question,
	onSSE: async (type, data) => {
		// `type` is the SSE event name; `data` is the event payload.
		console.log('sse', type, data);
	},
});
```

#### Chat Methods

##### `chat(options: { token: string, question: Question }): Promise<PIPELINE_RESULT>`

Ask a question to RocketRide's AI and get an intelligent response.

**Important:** Use this method with pipelines that have `chat` as the source component. This is for ALL conversational interfaces (web, console, API, mobile), not just web-based UIs. For document processing/uploads, use `send()` or `sendFiles()` with a `webhook` source instead.

**Example:**

```typescript
import { Question } from 'rocketride';

const question = new Question();
question.addQuestion('What are the key findings?');

const response = await client.chat({ token: 'chat-token', question });
```

#### Event Methods

##### `setEvents(token: string, eventTypes: string[], pipeId?: number): Promise<void>`

Subscribe to specific types of events from the server. The optional `pipeId` scopes the subscription to a single pipe within the task.

**Example:**

```typescript
await client.setEvents('task-token', ['apaevt_status_upload', 'apaevt_status_processing']);
```

##### `addMonitor(key: MonitorKey, types: string[]): Promise<void>`

Add a reference-counted monitor subscription. If the key already exists, the new `types` are merged with the existing set and the merged set is sent to the server. `MonitorKey` is either `{ token: string }` for a running task or `{ projectId: string; source: string; pipeId?: number }` for a project/source.

```typescript
await client.addMonitor({ token }, ['summary', 'flow']);
// or, before the task is running, by project/source:
await client.addMonitor({ projectId: 'proj-123', source: 'input' }, ['summary']);
```

##### `removeMonitor(key: MonitorKey, types: string[]): Promise<void>`

Remove a monitor subscription. Decrements the reference counts for the given `types`; a type is only unsubscribed from the server once its count reaches zero. The `key` must match the one passed to `addMonitor()`.

```typescript
await client.removeMonitor({ token }, ['flow']);
```

#### Connectivity Methods

##### `ping(token?: string): Promise<void>`

Test connectivity to the RocketRide server.

### DataPipe

Created via `client.pipe()` method. Provides a stream-like interface for uploading data.

#### Methods

##### `open(): Promise<DataPipe>`

Open the pipe for data transmission. Must be called before any write() operations.

##### `write(buffer: Uint8Array): Promise<void>`

Write data to the pipe. Can be called multiple times to stream large datasets.

##### `close(): Promise<PIPELINE_RESULT | undefined>`

Close the pipe and get the processing results.

### Question

Question builder for AI chat operations.

#### Methods

> The `add*` builder methods mutate the `Question` in place and return `void`: they do **not** support chaining (e.g. `q.addQuestion(...).addContext(...)` will not compile).

##### `addQuestion(text: string): void`

Add the main question text.

##### `addInstruction(title: string, instruction: string): void`

Add specific instructions to guide the AI's response.

##### `addExample(given: string, result: any): void`

Provide an example of the desired response format.

##### `addContext(context: string | Record<string, any>): void`

Add contextual information for the AI.

##### `addHistory(history: QuestionHistory): void`

Add conversation history for context.

**QuestionHistory:**

```typescript
{
	role: 'user' | 'assistant' | 'system';
	content: string;
}
```

##### `addGoal(goal: string): void`

Add a goal to guide the AI's response.

##### `addDocuments(documents: Doc | Doc[]): void`

Add one or more documents to the question context.

**Note:** Document filtering is configured via the constructor options, not a separate method. Pass a `DocFilter` object in the constructor: `new Question({ filter: { limit: 50 } })`.

## Data Types

### PipelineConfig

```typescript
interface PipelineConfig {
	components: Array<{
		id: string; // Unique component identifier
		provider: string; // Component type (e.g., 'webhook', 'response', 'ai_chat')
		name?: string; // Human-readable name
		description?: string; // Component description
		config: Record<string, any>; // Component-specific configuration
		ui?: Record<string, any>; // UI-specific configuration
		input?: Array<{
			// Input connections from other components
			lane: string; // Data lane/channel name
			from: string; // Source component ID
		}>;
	}>;
	source?: string; // Entry point component ID
	project_id: string; // Project identifier
}
```

### UPLOAD_RESULT

```typescript
interface UPLOAD_RESULT {
	action: 'open' | 'write' | 'close' | 'complete' | 'error'; // Upload status
	filepath: string; // Original filename
	bytes_sent: number; // Bytes transmitted
	file_size: number; // Total file size
	upload_time: number; // Time taken in seconds
	result?: PIPELINE_RESULT; // Processing result (on complete)
	error?: string; // Error message (on error)
}
```

### PIPELINE_RESULT

```typescript
interface PIPELINE_RESULT {
	name: string; // Result identifier (UUID)
	location?: string; // Storage location
	result_types?: Record<string, string>; // Result type mapping
	[key: string]: any; // Dynamic fields based on result_types
}
```

### TASK_STATUS

```typescript
interface TASK_STATUS {
	state: number; // TASK_STATE enum: 0 NONE, 1 STARTING, 2 INITIALIZING, 3 RUNNING, 4 STOPPING, 5 COMPLETED, 6 CANCELLED
	completed: boolean; // true once the task has finished (prefer this over comparing `state`)
	progress?: number; // Progress percentage (0-100)
	message?: string; // Status message
	[key: string]: any; // Additional status fields
}
```

## MIME Types

The SDK supports automatic MIME type detection for common file extensions:

- `.json` → `application/json`
- `.csv` → `text/csv`
- `.txt` → `text/plain`
- `.pdf` → `application/pdf`
- `.jpg/.jpeg` → `image/jpeg`
- `.png` → `image/png`
- `.mp4` → `video/mp4`
- `.mp3` → `audio/mpeg`
- Default → `application/octet-stream`

For data pipes, MIME types determine processing lanes:

- `application/rocketride-question` → AI chat question format
- `text/*` → Text lane
- `image/*` → Image lane
- `video/*` → Video lane
- `audio/*` → Audio lane
- Others → Data lane

## Common Patterns

### Building an AI Chat System

When using a chat system, starting the pipeline should be done as a global part of your system. The `client.use()` function is time-consuming, so starting it, processing a question, and stopping it is not a good pattern.

#### Basic Questions

```typescript
import { RocketRideClient, Question } from 'rocketride';

// Start your chat pipeline once at the beginning
const client = new RocketRideClient(); // Configuration from .env
await client.connect();

const result = await client.use({ filepath: 'chat_pipeline.pipe' });
const token = result.token;

async function myChat(myQuestion: string): Promise<string> {
	// Simple question
	const question = new Question();
	question.addQuestion(myQuestion);

	// Issue the chat request
	const response = await client.chat({ token, question });

	// `answers` is a dynamic field — present only when the pipeline's result_types maps it. Treat it as optional.
	if (!response.answers || response.answers.length === 0) {
		return 'No answer received';
	}

	// Extract the answer (answers is an array, get the first one)
	return response.answers[0];
}

// Use the function
const answer = await myChat('What are the main themes in these documents?');
console.log(answer);
```

#### Structured JSON Responses

```typescript
import { RocketRideClient, Question } from 'rocketride';

async function extract(sourceDocument: string) {
	const question = new Question({ expectJson: true });
	question.addQuestion('Extract email addresses and phone numbers');
	question.addExample('Find contacts', { emails: ['john@company.com'], phones: ['555-1234'] });
	question.addContext(sourceDocument);

	const response = await client.chat({ token, question });

	// For expectJson=true, the answer is already parsed as an object
	if (response.answers && response.answers.length > 0) {
		return response.answers[0];
	}
	return {};
}

// Use the function
const result = await extract('Contact us at john@company.com or 555-1234');
console.log(result);
```

#### Advanced Question Configuration

```typescript
import { RocketRideClient, Question } from 'rocketride';

// Build a question
const question = new Question();

// Add custom instructions
question.addInstruction('Focus', 'Analyze only financial metrics');
question.addInstruction('Format', 'Use bullet points for key findings');

// Provide examples
question.addExample('Revenue question', 'Total revenue increased 15% YoY');

// Add context
question.addContext('This data is from Q4 2024 financial reports');
question.addContext({ company: 'TechCorp', department: 'Sales' });

// Add conversation history
question.addHistory({ role: 'user', content: 'Previous question' });
question.addHistory({ role: 'assistant', content: 'Previous answer' });

// Main question
question.addQuestion('What were the main revenue drivers this quarter?');

const response = await client.chat({ token: 'chat-token', question });
```

### Document Processing

```typescript
import { RocketRideClient } from 'rocketride';

async function processDocuments() {
	const client = new RocketRideClient(); // Configuration from .env

	try {
		await client.connect();

		// Start document processing pipeline
		const result = await client.use({ filepath: 'document_analyzer.pipe' });
		const token = result.token;

		// Files to process
		const fileObjects = [file1, file2, file3]; // File objects from input

		const results = await client.sendFiles(
			fileObjects.map((file) => ({ file })),
			token
		);

		return results;
	} finally {
		await client.disconnect();
	}
}
```

### Real-time Data Streaming

```typescript
import { RocketRideClient } from 'rocketride';

async function streamSensorData(dataGenerator: AsyncIterable<SensorReading>) {
	const client = new RocketRideClient(); // Configuration from .env

	try {
		await client.connect();

		const result = await client.use({ filepath: 'sensor_processor.pipe' });
		const token = result.token;

		// Stream data using pipe
		const pipe = await client.pipe(token, {}, 'application/json');
		await pipe.open();

		for await (const sensorReading of dataGenerator) {
			const data = {
				timestamp: sensorReading.timestamp,
				temperature: sensorReading.temp,
				humidity: sensorReading.humidity,
			};

			const encoder = new TextEncoder();
			await pipe.write(encoder.encode(JSON.stringify(data)));
		}

		const closeResult = await pipe.close();
		return closeResult;
	} finally {
		await client.disconnect();
	}
}
```

### Event Handling

#### Setting Up Event Handlers

```typescript
async function handleEvents(event: DAPMessage) {
	const eventType = event.event;
	const body = event.body;

	if (eventType === 'apaevt_status_upload') {
		if (body.action === 'write') {
			const progress = (body.bytes_sent / body.file_size) * 100;
			console.log(`Upload progress: ${progress.toFixed(1)}%`);
		}
	}
}

// Create client with event handler
const client = new RocketRideClient({
	auth: 'your-api-key',
	onEvent: handleEvents,
});

await client.connect();

// Subscribe to specific events
await client.setEvents(token, ['apaevt_status_upload', 'apaevt_status_processing']);
```

#### Connection Event Handlers

```typescript
async function onConnected(info: string) {
	console.log(`Connected to ${info}`);
}

async function onDisconnected(reason: string, hasError: boolean) {
	if (hasError) {
		console.log(`Connection lost: ${reason}`);
	} else {
		console.log('Disconnected gracefully');
	}
}

const client = new RocketRideClient({
	auth: 'your-api-key',
	onConnected,
	onDisconnected,
});
```

### Monitoring Pipeline Status

#### Monitor Using Polling

```typescript
// Request status
const status = await client.getTaskStatus(token);
const numericState = status.state; // number from the TASK_STATE enum (e.g. 3 = RUNNING, 5 = COMPLETED)

// Poll for progress — `completed` is a boolean that flips true once the task finishes
while (true) {
	const status = await client.getTaskStatus(token);
	if (status.completed) {
		break;
	}
	await new Promise((resolve) => setTimeout(resolve, 1000));
}
```

#### Monitor Using Events

```typescript
// Event handler
async function eventNotification(event: DAPMessage) {
	console.log(event);
}

// Create client with event handler
const client = new RocketRideClient({
	auth: 'your-api-key',
	onEvent: eventNotification,
});

await client.connect();

// Start your pipeline
const result = await client.use({ filepath: 'pipeline.pipe' });
const token = result.token;

// Subscribe to summary events
await client.setEvents(token, ['summary']);
```

## Error Handling

The SDK provides comprehensive error handling:

```typescript
import { RocketRideClient } from 'rocketride';

try {
	const client = new RocketRideClient(); // Configuration from .env
	await client.connect();

	const result = await client.use({ filepath: 'pipeline.pipe' });
	console.log('Pipeline started:', result.token);
} catch (error) {
	if (error instanceof Error) {
		console.error('Error:', error.message);
	} else {
		console.error('Unknown error:', error);
	}
}
```

Common error scenarios:

- **Connection errors**: Server unreachable or network issues
- **Authentication errors**: Invalid API key
- **Pipeline errors**: Invalid pipeline configuration
- **Execution errors**: Pipeline execution failures
- **Upload errors**: File upload failures

### Exception Classes

The SDK exports a typed exception hierarchy so you can catch errors at the right level of specificity. All extend the base `DAPException`, which carries the raw server response on a `dapResult: Record<string, unknown>` property.

```
DAPException                      // base — wraps any DAP error response (.dapResult)
└─ RocketRideException            // root of all RocketRide-specific errors
   ├─ ConnectionException         // connect/transport problems, dropped connections
   │  └─ AuthenticationException  // bad API key / credentials
   ├─ PipeException               // data pipe / upload / streaming failures
   ├─ ExecutionException          // pipeline start/run/management failures
   └─ ValidationException         // invalid pipeline configuration
```

All are importable from the package root:

```typescript
import {
	DAPException,
	RocketRideException,
	ConnectionException,
	AuthenticationException,
	PipeException,
	ExecutionException,
	ValidationException,
} from 'rocketride';
```

**Which methods throw what:**

- `AuthenticationException`: thrown by `login()` (and therefore `connect()`) on auth failure. In persist mode the client catches it, calls `onConnectError`, and does **not** retry, so the app can fix credentials and reconnect.
- `ConnectionException`: `attach()`/`connect()` transport failures; also delivered to the `onConnectError` constructor callback (whose argument is typed `ConnectionException`).

Catch the most specific type first, then fall back to a broader one:

```typescript
import { AuthenticationException, RocketRideException } from 'rocketride';

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

## Performance Considerations

- File uploads are parallelized (all files uploaded concurrently)
- The server handles queuing and rate limiting automatically
- Use pipes for streaming large datasets to avoid memory issues
- Event system provides real-time feedback without polling overhead
- Connection persistence reduces reconnection overhead in long-running applications

## Requirements

- Node.js 18+ recommended. The package declares no hard `engines` floor; the `await using` / `Symbol.asyncDispose` examples require Node 20+ and TypeScript 5.2+.
- WebSocket connection to RocketRide DAP server
- Valid API key for authentication

## Best Practices

1. **Use context managers** (`withConnection` or `await using`) for automatic cleanup
2. **Handle exceptions appropriately** at the right level of specificity
3. **Use event handlers** for progress feedback in UI applications
4. **Provide examples** in AI questions for consistent response formatting
5. **Add context and instructions** to improve AI response quality
6. **Use structured responses** (JSON) for data extraction tasks
7. **Stream large datasets** using pipes instead of single send operations
8. **Enable persistence mode** for long-running applications that need automatic reconnection

## License

MIT

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## Support

For issues and questions:

- GitHub Issues: [Report bugs and feature requests]
- Documentation: [Additional examples and guides]
- Community: [Join our community discussions]
