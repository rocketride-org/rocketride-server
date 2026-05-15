# RocketRide Client SDK (Python)

A Python SDK for executing RocketRide pipelines using the Debug Adapter Protocol (DAP). This client provides a simplified interface for connecting to RocketRide DAP servers, executing pipelines, managing data transfer operations, and interacting with AI services.

## Features

- **DAP-based communication** for reliable pipeline execution
- **Simple execute-and-exit workflow** for pipeline automation
- **Comprehensive error handling** and logging
- **Automatic API key management** for all DAP commands
- **Object-oriented data pipe management** with context manager support
- **Parallel file upload capabilities** with progress events
- **Token-based operations** for data pipe commands
- **Type hints** with full typing support
- **AI chat functionality** with structured JSON responses
- **Event monitoring** for real-time pipeline status
- **Automatic reconnection** with configurable persistence
- **Command-line interface** for pipeline management

## Installation

### Using pip

```bash
# Install from PyPI
pip install rocketride

# Install with development dependencies
pip install rocketride[dev]

# Install with test dependencies
pip install rocketride[test]
```

### Uninstalling

```bash
pip uninstall rocketride
```

**Usage:**

```python
from rocketride import RocketRideClient
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

The client will automatically parse the `.env` file if it exists and use the values as defaults. The priority order is:

1. **Constructor parameters** (highest priority)
2. **`.env` file values**
3. **Default values** (lowest priority)

The client automatically reads configuration from the `.env` file, so you typically don't need to pass any parameters:

```python
# Reads ROCKETRIDE_URI and ROCKETRIDE_APIKEY from .env
client = RocketRideClient()
```

You can override `.env` settings by passing parameters directly to the constructor if needed:

```python
# Override for testing or special cases
client = RocketRideClient(
    uri='https://cloud.rocketride.ai',
    auth='your-api-key'
)
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

```json
{
	"project_id": "{guid}", // Replace with your unique GUID
	"source": "data-processor",
	"components": [
		{
			"id": "data-processor",
			"provider": "transform",
			"config": {
				"inputPath": "${ROCKETRIDE_INPUT_PATH}",
				"outputPath": "${ROCKETRIDE_OUTPUT_PATH}",
				"apiKey": "${ROCKETRIDE_APIKEY}",
				"staticValue": "this stays the same",
				"unknownVar": "${ROCKETRIDE_UNKNOWN}"
			}
		}
	]
}
```

**Using the pipeline:**

```python
# Variables are automatically substituted when the pipeline starts
result = await client.use(filepath='pipeline.pipe')
# The server receives the pipeline with all ${ROCKETRIDE_*} variables replaced
```

**Key features:**

- Only variables starting with `ROCKETRIDE_` are substituted (for security)
- Unknown variables are left unchanged (e.g., `${ROCKETRIDE_UNKNOWN}` stays as-is)
- Works with nested objects and arrays
- Preserves the original pipeline configuration object
- Supports quoted and unquoted values in `.env` file
- Ignores comments and empty lines in `.env` file

**Security Note:** The `.env` file is parsed separately and does not modify your system environment variables.

## CLI Tool

The package includes an `rocketride` command-line tool for managing pipelines and file uploads.

### CLI Installation

After installing the package, the `rocketride` command becomes available:

```bash
pip install rocketride
rocketride --help
```

### CLI Commands

**Start a pipeline:**

```bash
rocketride start my-pipeline.pipe --apikey YOUR_KEY
```

**Upload files:**

```bash
rocketride upload files/*.csv --pipeline ./pipeline.pipe --apikey YOUR_KEY
# or with existing task token
rocketride upload files/*.csv --token TASK_TOKEN --apikey YOUR_KEY
# with custom thread count (default is 4)
rocketride upload files/*.csv --token TASK_TOKEN --threads 10 --apikey YOUR_KEY
```

Upload command supports parallel file uploads. Use `--threads` to control concurrency.

**Monitor pipeline status:**

```bash
rocketride status --token TASK_TOKEN --apikey YOUR_KEY
```

**Monitor pipeline events:**

```bash
rocketride events DETAIL,SUMMARY --token TASK_TOKEN --apikey YOUR_KEY
# or monitor all events
rocketride events ALL --token TASK_TOKEN --apikey YOUR_KEY
# with log file
rocketride events ALL --token TASK_TOKEN --log events.log --apikey YOUR_KEY
```

**Stop a pipeline:**

```bash
rocketride stop --token TASK_TOKEN --apikey YOUR_KEY
```

### CLI Configuration

The CLI supports `.env` file configuration. See the Configuration section above.

## SDK Quick Start

### Basic Pipeline Execution

```python
from rocketride import RocketRideClient

# Create client - configuration from .env
client = RocketRideClient()

# Connect to server
await client.connect()

# Define pipeline
pipeline = {
    'components': [
        {'id': 'input', 'provider': 'webhook', 'config': {}},
        {'id': 'process', 'provider': 'transform', 'config': {}, 'input': [{'lane': 'text', 'from': 'input'}]},
        {'id': 'output', 'provider': 'response_text', 'config': {}, 'input': [{'lane': 'text', 'from': 'process'}]}
    ],
    'source': 'input',
    'project_id': '{guid}'  # Replace with your unique GUID
}

# Start pipeline
result = await client.use(pipeline=pipeline)
print(f'Pipeline started with token: {result["token"]}')

# Disconnect
await client.disconnect()
```

### Using Context Manager for Automatic Cleanup

The Python client supports automatic resource cleanup using async context managers:

```python
from rocketride import RocketRideClient

# Context manager handles connect/disconnect automatically
# Configuration is read from .env file
async with RocketRideClient() as client:
    # Client is automatically connected
    result = await client.use(filepath='pipeline.pipe')
    token = result['token']

    # Send data
    response = await client.send(token, 'Process this text')

    # Client automatically disconnects here
```

### Persistent Connection with Auto-Reconnect

```python
from rocketride import RocketRideClient

# Declare connection callbacks
async def on_connected(info: str) -> None:
    print(f'Connected: {info}')

async def on_disconnected(reason: str, has_error: bool) -> None:
    if has_error:
        print(f'Connection lost: {reason}')

async def on_connect_error(error: str) -> None:
    print(f'Connection attempt failed: {error}')

# Create client with automatic reconnection enabled
client = RocketRideClient(
    uri='https://cloud.rocketride.ai',
    auth='your-api-key',
    persist=True,                # Enable automatic reconnection (exponential backoff)
    max_retry_time=60000,        # Stop retrying after 60 seconds (None = retry forever)
    on_connected=on_connected,
    on_disconnected=on_disconnected,
    on_connect_error=on_connect_error
)

# Connect to server
await client.connect()

# If connection is lost, the client will automatically attempt to reconnect
# Reconnection uses exponential backoff (0.25s initial, doubling up to 2.5s max)
# To stop auto-reconnection, call disconnect()
await client.disconnect()
```

### Data Transfer with Pipes

```python
from rocketride import RocketRideClient

client = RocketRideClient(
    uri='https://cloud.rocketride.ai',
    auth='your-api-key'
)

await client.connect()

# Manual pipe management
pipe = await client.pipe(token, mimetype='text/csv')
await pipe.open()
await pipe.write(b'header1,header2\n')
await pipe.write(b'value1,value2\n')
results = await pipe.close()

await client.disconnect()
```

**Using context manager (recommended):**

```python
import json

async with await client.pipe(token=myToken, mime_type='application/json') as pipe:
    # For each item we need to send
    for item in data_items:
        # Write it to the pipe
        await pipe.write(json.dumps(item).encode())
    # Close it to get the results
    results = await pipe.close()
```

### Bulk File Upload (Parallel)

```python
from rocketride import RocketRideClient

# Declare event handler
async def handle_events(event):
    if event['event'] == 'apaevt_status_upload':
        body = event['body']
        print(f"{body['filepath']}: {body['action']} - {body['bytes_sent']}/{body['file_size']} bytes")

client = RocketRideClient(
    auth='your-api-key',
    on_event=handle_events
)

await client.connect()

# Simple file list (all files uploaded concurrently)
files = ['doc1.pdf', 'data.csv', 'report.docx']
results = await client.send_files(files, token)

# With metadata and MIME types
files = [
    ('report.pdf', {'department': 'finance'}),
    ('data.csv', {'type': 'sales_data'}, 'text/csv')
]
results = await client.send_files(files, token)

# Process results
for result in results:
    if result['action'] == 'complete':
        print(f"✓ {result['filepath']}: {result['upload_time']:.2f}s")
    else:
        print(f"✗ {result['filepath']}: {result['error']}")

await client.disconnect()
```

## API Reference

### RocketRideClient

#### Constructor

```python
RocketRideClient(uri: str, auth: str, **kwargs)
```

**Parameters:**

- `uri` (str): Server URI (default: uses `ROCKETRIDE_URI` from `.env` or `https://cloud.rocketride.ai`)
- `auth` (str): API key for authentication (can also use `ROCKETRIDE_APIKEY` in `.env`)
- `on_event` (EventCallback, optional): Event handler for server events
- `on_connected` (ConnectCallback, optional): Connection established callback
- `on_disconnected` (DisconnectCallback, optional): Connection lost callback
- `persist` (bool, optional): Enable automatic reconnection with exponential backoff (default: False)
- `max_retry_time` (float, optional): Maximum total time in milliseconds to keep retrying connections (default: None, retry indefinitely)
- `module` (str, optional): Module name for client identification
- `on_connect_error` (ConnectErrorCallback, optional): Called on each failed connection attempt in persist mode

#### Connection Methods

##### `async connect() -> None`

Establish connection to the RocketRide server.

##### `async disconnect() -> None`

Close connection to the RocketRide server and stop automatic reconnection.

#### Execution Methods

##### `async use(**kwargs) -> Dict[str, Any]`

Start a RocketRide pipeline for processing data. Automatically performs environment variable substitution on the pipeline configuration.

**Parameters:**

- `pipeline` (dict, optional): Flat pipeline configuration dict (`components`, `source`, `project_id` at top level)
- `filepath` (str, optional): Path to a `.pipe` or JSON file containing pipeline configuration.
- `token` (str, optional): Custom token for the pipeline (auto-generated if not provided)
- `source` (str, optional): Override pipeline source
- `threads` (int, optional): Number of threads for execution (default: 1)
- `use_existing` (bool, optional): Use existing pipeline instance
- `args` (List[str], optional): Command line arguments to pass to pipeline
- `ttl` (int, optional): Time-to-live in seconds for idle pipelines (server default if not provided; use 0 for no timeout)
- `pipelineTraceLevel` (str, optional): Trace level: 'none', 'metadata', 'summary', or 'full'. When set, captures every lane write and invoke call in the response under `_trace`.

**Returns:** Dictionary containing the task token and other metadata

##### `async terminate(token: str) -> None`

Terminate a running pipeline.

**Parameters:**

- `token` (str): Task token of the pipeline to terminate

##### `async get_task_status(token: str) -> Dict[str, Any]`

Get the current status of a running pipeline.

**Parameters:**

- `token` (str): Task token of the pipeline

**Returns:** Dictionary containing status information

#### Data Methods

##### `async send(token: str, data: Union[str, bytes], objinfo: Dict[str, Any] = {}, mimetype: str = None) -> Dict[str, Any]`

Send data directly to a pipeline.

**Parameters:**

- `token` (str): Task token of the pipeline
- `data` (str or bytes): Data to send
- `objinfo` (dict, optional): Metadata about the data
- `mimetype` (str, optional): MIME type of the data

**Returns:** Processing result dictionary

**Important:** Use this method with pipelines that have `webhook` or `dropper` as the source component. For chat/Q&A systems, use `chat()` method instead with a `chat` source component.

##### `async send_files(files: List, token: str) -> List[Dict[str, Any]]`

Upload multiple files in parallel.

**Parameters:**

- `files` (list): List of file paths or tuples `(filepath, objinfo)` or `(filepath, objinfo, mimetype)`
- `token` (str): Task token of the pipeline

**Returns:** List of upload result dictionaries

**Important:** Use this method with pipelines that have `webhook` or `dropper` as the source component for document processing. For chat/Q&A systems, use `chat()` method with a `chat` source component instead.

**Note:** Upload progress events are sent through the event system as `apaevt_status_upload` events.

##### `async pipe(token: str, objinfo: Dict[str, Any] = None, mime_type: str = None, provider: str = None) -> DataPipe`

Create a streaming data pipe for sending large datasets.

**Parameters:**

- `token` (str): Task token of the pipeline
- `objinfo` (dict, optional): Metadata about the data
- `mime_type` (str, optional): MIME type of the data
- `provider` (str, optional): Provider name

**Returns:** DataPipe instance

#### Chat Methods

##### `async chat(token: str, question: Question) -> Dict[str, Any]`

Ask a question to RocketRide's AI and get an intelligent response.

**Parameters:**

- `token` (str): Task token of the chat pipeline
- `question` (Question): Question object containing the query

**Returns:** Response dictionary containing answers

**Important:** Use this method with pipelines that have `chat` as the source component. This is for ALL conversational interfaces (web, console, API, mobile), not just web-based UIs. For document processing/uploads, use `send()` or `send_files()` with a `webhook` source instead.

**Example:**

```python
from rocketride.schema import Question

question = Question()
question.addQuestion('What are the key findings?')

response = await client.chat(token='chat-token', question=question)
```

#### Event Methods

##### `async set_events(token: str, event_types: List[str]) -> None`

Subscribe to specific types of events from the server.

**Parameters:**

- `token` (str): Task token of the pipeline
- `event_types` (list): List of event type names

**Example:**

```python
await client.set_events(token, ['apaevt_status_upload', 'apaevt_status_processing'])
```

#### Connectivity Methods

##### `async ping(token: str = None) -> None`

Test connectivity to the RocketRide server.

**Parameters:**

- `token` (str, optional): Task token for context

### DataPipe

Created via `client.pipe()` method. Provides a stream-like interface for uploading data.

#### Methods

##### `async open() -> DataPipe`

Open the pipe for data transmission. Must be called before any write() operations.

##### `async write(buffer: bytes) -> None`

Write data to the pipe. Can be called multiple times to stream large datasets.

##### `async close() -> Optional[Dict[str, Any]]`

Close the pipe and get the processing results.

### Question

Question builder for AI chat operations.

#### Constructor

```python
Question(expectJson: bool = False)
```

**Parameters:**

- `expectJson` (bool, optional): Whether to expect JSON response (default: False)

#### Methods

##### `addQuestion(text: str) -> Question`

Add the main question text.

##### `addInstruction(subtitle: str, instructions: str) -> Question`

Add specific instructions to guide the AI's response.

##### `addExample(given: str, result: Any) -> Question`

Provide an example of the desired response format.

##### `addContext(context: Union[str, Dict[str, Any]]) -> Question`

Add contextual information for the AI.

##### `addHistory(history: QuestionHistory) -> Question`

Add conversation history for context.

**QuestionHistory:**

```python
from rocketride.schema import QuestionHistory

history = QuestionHistory(role='user', content='Previous question')
```

##### `addGoal(goal: str) -> Question`

Add a goal to guide the AI's response.

##### `addDocuments(documents: Union[Doc, List[Doc]]) -> Question`

Add one or more documents to the question context.

## Data Types

### Pipeline Configuration

```python
pipeline = {
    'components': [
        {
            'id': str,              # Unique component identifier
            'provider': str,        # Component type (e.g., 'webhook', 'response', 'ai_chat')
            'name': str,            # Human-readable name (optional)
            'description': str,     # Component description (optional)
            'config': dict,         # Component-specific configuration
            'ui': dict,             # UI-specific configuration (optional)
            'input': [              # Input connections (optional)
                {
                    'lane': str,    # Data lane/channel name
                    'from': str     # Source component ID
                }
            ]
        }
    ],
    'source': str,                  # Entry point component ID
    'project_id': str               # Project identifier
}
```

### Upload Result

```python
{
    'action': str,           # 'open', 'write', 'close', 'complete', or 'error'
    'filepath': str,         # Original filename
    'bytes_sent': int,       # Bytes transmitted
    'file_size': int,        # Total file size
    'upload_time': float,    # Time taken in seconds
    'result': dict,          # Processing result (on complete, optional)
    'error': str             # Error message (on error, optional)
}
```

### Pipeline Result

```python
{
    'name': str,             # Result identifier (UUID)
    'location': str,         # Storage location (optional)
    'result_types': dict,    # Result type mapping (optional)
    # Additional dynamic fields based on result_types
}
```

### Task Status

```python
{
    'state': str,            # 'running', 'completed', 'failed', 'terminated'
    'progress': float,       # Progress percentage 0-100 (optional)
    'message': str,          # Status message (optional)
    # Additional status fields
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

```python
from rocketride import RocketRideClient
from rocketride.schema import Question

# Start your chat pipeline once at the beginning
client = RocketRideClient()  # Configuration from .env
await client.connect()

result = await client.use(filepath='chat_pipeline.pipe')
token = result['token']

async def my_chat(my_question: str) -> str:
    # Simple question
    question = Question()
    question.addQuestion(my_question)

    # Issue the chat request
    response = await client.chat(token=token, question=question)

    # Check if we got answers
    if 'answers' not in response or len(response['answers']) == 0:
        return 'No answer received'

    # Extract the answer (answers is a list, get the first one)
    answer = response['answers'][0]
    return answer

# Use the function
answer = await my_chat('What are the main themes in these documents?')
print(answer)
```

#### Structured JSON Responses

```python
from rocketride.schema import Question

async def extract(source_document: str):
    question = Question(expectJson=True)
    question.addQuestion('Extract email addresses and phone numbers')
    question.addExample(
        'Find contacts',
        {'emails': ['john@company.com'], 'phones': ['555-1234']}
    )
    question.addContext(source_document)

    response = await client.chat(token=token, question=question)

    # For expectJson=True, the answer is already parsed as a dict
    if 'answers' in response and len(response['answers']) > 0:
        structured_answer = response['answers'][0]
        return structured_answer
    return {}

# Use the function
result = await extract('Contact us at john@company.com or 555-1234')
print(result)
```

#### Advanced Question Configuration

```python
from rocketride.schema import Question, QuestionHistory

# Build a question
question = Question()

# Add custom instructions
question.addInstruction('Focus', 'Analyze only financial metrics')
question.addInstruction('Format', 'Use bullet points for key findings')

# Provide examples
question.addExample('Revenue question', 'Total revenue increased 15% YoY')

# Add context
question.addContext('This data is from Q4 2024 financial reports')
question.addContext({'company': 'TechCorp', 'department': 'Sales'})

# Add conversation history
question.addHistory(QuestionHistory(role='user', content='Previous question'))
question.addHistory(QuestionHistory(role='assistant', content='Previous answer'))

# Main question
question.addQuestion('What were the main revenue drivers this quarter?')

response = await client.chat(token='chat-token', question=question)
```

### Document Processing

```python
from rocketride import RocketRideClient

async def process_documents():
    async with RocketRideClient() as client:  # Configuration from .env
        # Start document processing pipeline
        result = await client.use(filepath='document_analyzer.pipe')
        token = result['token']

        # Files to process
        files = ['report1.pdf', 'data.xlsx', 'notes.txt']
        results = await client.send_files(files, token)

        # Return the upload results
        return results
```

### Real-time Data Streaming

```python
import json
from rocketride import RocketRideClient

async def stream_sensor_data(data_generator):
    async with RocketRideClient() as client:  # Configuration from .env
        result = await client.use(filepath='sensor_processor.pipe')
        token = result['token']

        # Stream data using pipe
        async with await client.pipe(token, mimetype='application/json') as pipe:
            async for sensor_reading in data_generator:
                data = {
                    'timestamp': sensor_reading.timestamp,
                    'temperature': sensor_reading.temp,
                    'humidity': sensor_reading.humidity
                }
                await pipe.write(json.dumps(data).encode())
            result = await pipe.close()

        # Return the results
        return result
```

### Event Handling

#### Setting Up Event Handlers

```python
from typing import Dict, Any

async def handle_events(event: Dict[str, Any]) -> None:
    event_type = event['event']
    body = event['body']

    if event_type == 'apaevt_status_upload':
        if body['action'] == 'write':
            progress = (body['bytes_sent'] / body['file_size']) * 100
            print(f'Upload progress: {progress:.1f}%')

# Create client with event handler
client = RocketRideClient(on_event=handle_events)  # Configuration from .env

await client.connect()

# Subscribe to specific events
await client.set_events(token, [
    'apaevt_status_upload',
    'apaevt_status_processing'
])
```

#### Connection Event Handlers

```python
async def on_connected(info: str) -> None:
    print(f'Connected to {info}')

async def on_disconnected(reason: str, has_error: bool) -> None:
    if has_error:
        print(f'Connection lost: {reason}')
    else:
        print('Disconnected gracefully')

client = RocketRideClient(
    uri='https://cloud.rocketride.ai',
    auth='api_key',
    on_connected=on_connected,
    on_disconnected=on_disconnected
)
```

### Monitoring Pipeline Status

#### Monitor Using Polling

```python
import asyncio

# Request status
status = await client.get_task_status(token)
state = status.get('state')  # 'running', 'completed', 'failed', etc.

# Poll for progress
while True:
    status = await client.get_task_status(token)
    if status['state'] in ['completed', 'failed']:
        break
    await asyncio.sleep(1)
```

#### Monitor Using Events

```python
# Declare an EventCallback function
async def event_notification(event: Dict[str, Any]) -> None:
    print(event)

# Create the client
client = RocketRideClient(
    uri='https://cloud.rocketride.ai',
    auth='your_api_key',
    on_event=event_notification,
)

await client.connect()

# Start your pipeline
result = await client.use(filepath='pipeline.pipe')
token = result['token']

# Subscribe to summary events
await client.set_events(token=token, event_types=['summary'])
```

## Error Handling

The SDK provides comprehensive error handling:

```python
from rocketride import RocketRideClient, RocketRideException

try:
    client = RocketRideClient()  # Configuration from .env
    await client.connect()

    result = await client.use(filepath='pipeline.pipe')
    print(f'Pipeline started: {result["token"]}')

except RocketRideException as e:
    print(f'RocketRide Error: {e}')
except ConnectionError as e:
    print(f'Connection Error: {e}')
except Exception as e:
    print(f'Error: {e}')
finally:
    if client:
        await client.disconnect()
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

- Python 3.10 or higher
- WebSocket connection to RocketRide DAP server
- Valid API key for authentication

## Best Practices

1. **Use context managers** (`async with`) for automatic cleanup
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
