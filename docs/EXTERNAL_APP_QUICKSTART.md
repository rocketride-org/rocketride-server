# Quickstart: Invoking RocketRide Pipelines from External Applications

This guide walks you through connecting to the RocketRide engine from a standalone Python or TypeScript application, loading a pipeline, sending data, and handling results. You should be up and running in under 5 minutes.

---

## Prerequisites

### 1. RocketRide Engine

You need a running RocketRide engine. The quickest options:

**Docker (recommended for external apps):**

```bash
docker pull ghcr.io/rocketride-org/rocketride-engine:latest
docker run -d --name rocketride-engine -p 5565:5565 ghcr.io/rocketride-org/rocketride-engine:latest
```

**Local via the VS Code extension:**

Install the RocketRide extension, open the Connection Manager, and start a local server. The default address is `ws://localhost:5565`.

### 2. A Pipeline File

You need a `.pipe` or `.json` pipeline file. If you do not have one, create a minimal pipeline in the VS Code extension or use one from the `testdata/` directory in this repository.

For this guide we assume a pipeline named `text-llm.pipe` that accepts text input, processes it through an LLM node, and returns text output.

### 3. An API Key

If your engine requires authentication, set your API key in the environment:

```bash
export ROCKETRIDE_APIKEY="your-api-key"
export ROCKETRIDE_URI="ws://localhost:5565"
```

---

## Python Quickstart

### Install the SDK

```bash
pip install rocketride
```

Or install directly from a running engine:

```bash
curl -O http://localhost:5565/client/python
pip install rocketride-*.whl
```

### Minimal Example

```python
import asyncio
from rocketride import RocketRideClient

async def main():
    async with RocketRideClient(uri="ws://localhost:5565", auth="your-api-key") as client:
        # Load and start the pipeline
        result = await client.use(filepath="text-llm.pipe")
        token = result["token"]

        # Send text data and get the result
        output = await client.send(
            token,
            "Summarize the key benefits of open-source software.",
            objinfo={"name": "input.txt"},
            mimetype="text/plain",
        )
        print("Pipeline output:", output)

        # Clean up
        await client.terminate(token)

asyncio.run(main())
```

### Step-by-Step Breakdown

**1. Connect to the engine**

The `async with` context manager calls `connect()` on entry and `disconnect()` on exit, so the connection is always cleaned up -- even if an exception occurs.

```python
async with RocketRideClient(uri="ws://localhost:5565", auth="your-api-key") as client:
    # client is connected here
    ...
# client is disconnected here
```

You can also connect manually:

```python
client = RocketRideClient(uri="ws://localhost:5565", auth="your-api-key")
await client.connect()
# ... do work ...
await client.disconnect()
```

**2. Load a pipeline**

`use()` starts a pipeline on the engine and returns a token that identifies the running task. Pass either `filepath` (path to a `.pipe` or `.json` file) or `pipeline` (a dict with the pipeline configuration).

```python
result = await client.use(filepath="text-llm.pipe")
token = result["token"]
```

**3. Send data**

`send()` is a one-shot method: it opens a data pipe, writes the payload, closes the pipe, and returns the pipeline result.

```python
output = await client.send(token, "Your input text here", objinfo={"name": "input.txt"}, mimetype="text/plain")
```

**4. Terminate the pipeline**

Always terminate the pipeline when you are done to free server resources.

```python
await client.terminate(token)
```

---

## TypeScript Quickstart

### Install the SDK

```bash
npm install rocketride
# or
pnpm add rocketride
# or
yarn add rocketride
```

Or install directly from a running engine:

```bash
curl -O http://localhost:5565/client/typescript
npm install rocketride-*.tgz
```

### Minimal Example

```typescript
import { RocketRideClient } from 'rocketride';

const client = new RocketRideClient({
	uri: 'ws://localhost:5565',
	auth: process.env.ROCKETRIDE_APIKEY!,
});

await client.connect();

// Load and start the pipeline
const { token } = await client.use({ filepath: './text-llm.pipe' });

// Send text data and get the result
const result = await client.send(token, 'Summarize the key benefits of open-source software.', { name: 'input.txt' }, 'text/plain');
console.log('Pipeline output:', result);

// Clean up
await client.terminate(token);
await client.disconnect();
```

### Using `withConnection` for Automatic Cleanup

`RocketRideClient.withConnection()` handles connect and disconnect for you, similar to Python's `async with`:

```typescript
import { RocketRideClient } from 'rocketride';

const result = await RocketRideClient.withConnection(
	{ uri: 'ws://localhost:5565', auth: process.env.ROCKETRIDE_APIKEY! },
	async (client) => {
		const { token } = await client.use({ filepath: './text-llm.pipe' });
		const output = await client.send(token, 'Summarize the key benefits of open-source software.', { name: 'input.txt' }, 'text/plain');
		await client.terminate(token);
		return output;
	}
);
console.log('Pipeline output:', result);
```

---

## Common Patterns

### Webhook Triggers

To build a web server that triggers a pipeline on each HTTP request, keep the client connected and create a new pipeline task per request:

**Python (with FastAPI):**

```python
import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from rocketride import RocketRideClient

client = RocketRideClient(uri="ws://localhost:5565", auth="your-api-key", persist=True)

@asynccontextmanager
async def lifespan(app: FastAPI):
    await client.connect()
    yield
    await client.disconnect()

app = FastAPI(lifespan=lifespan)

@app.post("/process")
async def process(request: Request):
    body = await request.body()
    result = await client.use(filepath="text-llm.pipe")
    token = result["token"]
    output = await client.send(token, body.decode(), objinfo={"name": "request.txt"}, mimetype="text/plain")
    await client.terminate(token)
    return {"result": output}
```

**TypeScript (with Express):**

```typescript
import express from 'express';
import { RocketRideClient } from 'rocketride';

const client = new RocketRideClient({
	uri: 'ws://localhost:5565',
	auth: process.env.ROCKETRIDE_APIKEY!,
	persist: true,
});

await client.connect();
const app = express();
app.use(express.text());

app.post('/process', async (req, res) => {
	const { token } = await client.use({ filepath: './text-llm.pipe' });
	const result = await client.send(token, req.body, { name: 'request.txt' }, 'text/plain');
	await client.terminate(token);
	res.json({ result });
});

app.listen(3000, () => console.log('Listening on :3000'));
```

### Batch Processing

Send multiple items through a pipeline and poll for completion:

**Python:**

```python
import asyncio
from rocketride import RocketRideClient

async def main():
    async with RocketRideClient(uri="ws://localhost:5565", auth="your-api-key") as client:
        result = await client.use(filepath="batch-pipeline.pipe")
        token = result["token"]

        # Subscribe to processing events
        await client.set_events(token, ["apaevt_status_processing"])

        # Send multiple files
        files = ["doc1.md", "doc2.md", "doc3.md"]
        upload_results = await client.send_files(files, token)
        for r in upload_results:
            if r["action"] == "complete":
                print(f"Uploaded: {r['filepath']}")
            else:
                print(f"Failed: {r['filepath']} - {r.get('error')}")

        # Poll until the pipeline finishes processing all items
        while True:
            status = await client.get_task_status(token)
            print(f"Progress: {status.get('completedCount', 0)}/{status.get('totalCount', 0)}")
            if status.get("completed"):
                break
            await asyncio.sleep(2)

        await client.terminate(token)

asyncio.run(main())
```

### Streaming Large Data

Use `pipe()` when you have large payloads or data arriving in chunks:

**Python:**

```python
pipe = await client.pipe(token, objinfo={"name": "large-file.csv"}, mime_type="text/csv")
await pipe.open()
with open("large-file.csv", "rb") as f:
    while True:
        chunk = f.read(64 * 1024)
        if not chunk:
            break
        await pipe.write(chunk)
result = await pipe.close()
```

**TypeScript:**

```typescript
import { createReadStream } from 'fs';
import { createInterface } from 'readline';

const pipe = await client.pipe(token, { name: 'large-file.csv' }, 'text/csv');
await pipe.open();
const rl = createInterface({ input: createReadStream('large-file.csv') });
for await (const line of rl) {
	await pipe.write(new TextEncoder().encode(line + '\n'));
}
const result = await pipe.close();
```

### Error Handling

Both SDKs provide a structured exception hierarchy. Always handle connection and execution errors:

**Python:**

```python
from rocketride import RocketRideClient, AuthenticationException
from rocketride.core.exceptions import PipeException, ExecutionException, ConnectionException

try:
    async with RocketRideClient(uri="ws://localhost:5565", auth="your-api-key") as client:
        result = await client.use(filepath="text-llm.pipe")
        token = result["token"]
        output = await client.send(token, "Hello, pipeline!")
        await client.terminate(token)
except AuthenticationException:
    print("Authentication failed. Check your API key.")
except ConnectionException:
    print("Could not connect to the engine. Is it running?")
except ExecutionException as e:
    print(f"Pipeline execution failed: {e}")
except PipeException as e:
    print(f"Data transfer error: {e}")
```

**TypeScript:**

```typescript
import { RocketRideClient } from 'rocketride';

const client = new RocketRideClient({
	uri: 'ws://localhost:5565',
	auth: process.env.ROCKETRIDE_APIKEY!,
});

try {
	await client.connect();
	const { token } = await client.use({ filepath: './text-llm.pipe' });
	const result = await client.send(token, 'Hello, pipeline!');
	await client.terminate(token);
} catch (error) {
	if (error instanceof Error) {
		console.error('Pipeline error:', error.message);
	}
} finally {
	await client.disconnect();
}
```

---

## Troubleshooting

### Connection refused on `ws://localhost:5565`

The engine is not running or is listening on a different port.

- **Docker:** Check that the container is running: `docker ps | grep rocketride-engine`
- **Local:** Open the Connection Manager in VS Code and verify the server status.
- **Port conflict:** If port 5565 is in use, map to a different port: `docker run -p 6000:5565 ...` and update your URI to `ws://localhost:6000`.

### Authentication errors

- Verify your API key is correct and matches what the engine expects.
- Check that the `ROCKETRIDE_APIKEY` environment variable is set if you are not passing `auth` directly.
- In persist mode, `AuthenticationException` stops retries so you can fix credentials and call `connect()` again.

### Pipeline file not found

- `use(filepath=...)` resolves paths relative to the engine's working directory, not your application. For Docker deployments, mount the pipeline file into the container:
  ```bash
  docker run -v /path/to/pipelines:/pipelines -p 5565:5565 ghcr.io/rocketride-org/rocketride-engine:latest
  ```
  Then reference it as `/pipelines/text-llm.pipe`.
- Alternatively, pass the pipeline configuration as a dict/object using the `pipeline` parameter instead of `filepath`.

### Timeouts on `send()` or `use()`

- Set `request_timeout` (Python) or `requestTimeout` (TypeScript) on the client constructor to bound individual requests.
- For long-running pipelines, increase the timeout or use `pipe()` for streaming data and `get_task_status()` to poll for completion.

### Connection drops in long-running applications

Enable persist mode so the client automatically reconnects with exponential backoff:

```python
client = RocketRideClient(
    uri="ws://localhost:5565",
    auth="your-api-key",
    persist=True,
    max_retry_time=300000,  # give up after 5 minutes
    on_connect_error=lambda msg: print(f"Reconnecting: {msg}"),
)
```

```typescript
const client = new RocketRideClient({
	uri: 'ws://localhost:5565',
	auth: process.env.ROCKETRIDE_APIKEY!,
	persist: true,
	maxRetryTime: 300000,
	onConnectError: (msg) => console.log(`Reconnecting: ${msg}`),
});
```

### Engine URI format

The SDKs accept `http`, `https`, `ws`, or `wss` schemes and convert as needed. For local development use `ws://localhost:5565`. For TLS-secured deployments use `wss://`.

---

## Next Steps

- [Python SDK Reference](README-python-client.md) -- full API documentation
- [TypeScript SDK Reference](README-typescript-client.md) -- full API documentation
- [Client Libraries Overview](README-clients.md) -- installation options and comparison
- [Engine Reference](README-engine.md) -- engine configuration and task types
- [Contributing Guide](../CONTRIBUTING.md) -- how to contribute to RocketRide
