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
ROCKETRIDE_URI=https://cloud.rocketride.ai
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
	uri: 'https://cloud.rocketride.ai',
});
```

### Environment Variable Substitution in Pipelines

The SDK automatically performs template variable substitution in pipeline configurations. Any string containing `${ROCKETRIDE_*}` will be replaced with the corresponding value from your `.env` file.

**Example `.env` file:**

```env
ROCKETRIDE_APIKEY=your-api-key
ROCKETRIDE_URI=https://cloud.rocketride.ai
ROCKETRIDE_INPUT_PATH=/data/input
ROCKETRIDE_OUTPUT_PATH=/data/output
```

**Example pipeline configuration:**

```typescript
const pipeline = {
	project_id: '{guid}', // Replace with your unique GUID
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
	uri: 'https://cloud.rocketride.ai',
	auth: 'your-api-key',
});

await client.connect();

const pipeline = {
	components: [
		{ id: 'input', provider: 'webhook', config: {} },
		{ id: 'process', provider: 'transform', config: {} },
		{ id: 'output', provider: 'response', config: {} },
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
	uri: 'https://cloud.rocketride.ai',
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
	uri: 'https://cloud.rocketride.ai',
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
	uri: 'https://cloud.rocketride.ai',
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
- `uri?: string` - Server URI (default: `https://cloud.rocketride.ai`, can also use `ROCKETRIDE_URI` in `.env`)
- `onEvent?: (event: DAPMessage) => void` - Event handler for server events
- `onConnected?: (connectionInfo?: string) => Promise<void>` - Connection established callback
- `onDisconnected?: (reason?: string, hasError?: boolean) => Promise<void>` - Connection lost callback
- `persist?: boolean` - Enable automatic reconnection with exponential backoff (default: false)
- `maxRetryTime?: number` - Maximum total time in milliseconds to keep retrying connections (default: undefined, retry indefinitely)
- `onConnectError?: (error?: string) => Promise<void>` - Called on each failed connection attempt in persist mode
- `module?: string` - Module name for client identification

#### Connection Methods

##### `connect(): Promise<void>`

Establish connection to the RocketRide server.

##### `disconnect(): Promise<void>`

Close connection to the RocketRide server and stop automatic reconnection.

##### `isConnected(): boolean`

Check if the client is currently connected to the server.

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

#### Data Methods

##### `send(token: string, data: string | Uint8Array, objinfo?: Record<string, any>, mimetype?: string): Promise<PIPELINE_RESULT>`

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

##### `setEvents(token: string, eventTypes: string[]): Promise<void>`

Subscribe to specific types of events from the server.

**Example:**

```typescript
await client.setEvents('task-token', ['apaevt_status_upload', 'apaevt_status_processing']);
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

##### `addQuestion(text: string): Question`

Add the main question text.

##### `addInstruction(subtitle: string, instructions: string): Question`

Add specific instructions to guide the AI's response.

##### `addExample(given: string, result: any): Question`

Provide an example of the desired response format.

##### `addContext(context: string | Record<string, any>): Question`

Add contextual information for the AI.

##### `addHistory(history: QuestionHistory): Question`

Add conversation history for context.

**QuestionHistory:**

```typescript
{
	role: 'user' | 'assistant' | 'system';
	content: string;
}
```

##### `addGoal(goal: string): Question`

Add a goal to guide the AI's response.

##### `addDocuments(documents: Doc | Doc[]): Question`

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
	state: 'running' | 'completed' | 'failed' | 'terminated';
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

- `application/rocketride-tag` → RocketRide tag stream format
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

	// Check if we got answers
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

		const result = await pipe.close();
		return result;
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
const state = status.state; // 'running', 'completed', 'failed', etc.

// Poll for progress
while (true) {
	const status = await client.getTaskStatus(token);
	if (['completed', 'failed', 'terminated'].includes(status.state)) {
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

## Performance Considerations

- File uploads are parallelized (all files uploaded concurrently)
- The server handles queuing and rate limiting automatically
- Use pipes for streaming large datasets to avoid memory issues
- Event system provides real-time feedback without polling overhead
- Connection persistence reduces reconnection overhead in long-running applications

## Requirements

- Node.js 16.0.0 or higher
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
