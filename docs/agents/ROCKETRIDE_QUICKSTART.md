# RocketRide Quick Start - Complete Working Examples

## Python: Complete Working Project

### Step 1: Set Up the `.env` File

When you connect to a **self-hosted engine** (local, docker, service, or on-prem) using the extension's **development connection group**, the extension auto-populates `.env` in your workspace with the live server URI and key — preserving any other variables you've added. In **local** mode the engine listens on a dynamically assigned port, so the extension writes the *actual* resolved address (not a fixed port). In **cloud** mode, set `ROCKETRIDE_APIKEY` yourself (cloud sign-in uses a short-lived OAuth token, which is not a usable SDK key).

```env
# Development-group self-hosted engines: auto-filled on connect (local uses the real dynamic port).
# live engine address (auto-filled)
ROCKETRIDE_URI=http://localhost:54123
# self-hosted default; set your own for cloud
ROCKETRIDE_APIKEY=MYAPIKEY

# Add your custom variables:
ROCKETRIDE_INPUT_PATH=/data/input
ROCKETRIDE_OUTPUT_PATH=/data/output
```

> **Note:** For self-hosted engines in the development connection group, the extension re-syncs `ROCKETRIDE_URI`/`ROCKETRIDE_APIKEY` on every connect while leaving your other variables untouched. For cloud, provide your own API key. Add any additional custom variables as needed. Because `.env` can contain credentials, add it to `.gitignore` and never commit it.

### Step 2: Install Client

```bash
pip install rocketride
```

### Step 3: Create Pipeline (`pipeline.pipe`)

Pipeline files **must** use the `.pipe` extension.

```json
{
	"project_id": "85be2a13-ad93-49ed-a1e1-4b0f763ca618",
	"source": "input",
	"components": [
		{
			"id": "input",
			"provider": "webhook",
			"config": {}
		},
		{
			"id": "processor",
			"provider": "transform",
			"config": {
				"input_path": "${ROCKETRIDE_INPUT_PATH}",
				"output_path": "${ROCKETRIDE_OUTPUT_PATH}"
			},
			"input": [{ "lane": "text", "from": "input" }]
		},
		{
			"id": "output",
			"provider": "response_text",
			"config": {},
			"input": [{ "lane": "text", "from": "processor" }]
		}
	]
}
```

> **Note:** Response components are lane-specific. Use `response_text` for text output, `response_answers` for answers, `response_documents` for documents, etc. See ROCKETRIDE_COMPONENT_REFERENCE.md for the full list.

### Step 4: Create Python Script (`main.py`)

```python
import asyncio
from rocketride import RocketRideClient


async def main():
    # Client reads configuration from .env automatically
    client = RocketRideClient()

    try:
        # Connect to server
        await client.connect()
        print('Connected to RocketRide server')

        # Start pipeline
        result = await client.use(filepath='pipeline.pipe')
        token = result['token']
        print(f'Pipeline started with token: {token}')

        # Send data
        await client.send(token, 'Hello, RocketRide!')
        print('Data sent successfully')

        # Check status
        status = await client.get_task_status(token)
        print(f'Pipeline state: {status["state"]}')

    finally:
        # Always disconnect
        await client.disconnect()
        print('Disconnected')


if __name__ == '__main__':
    asyncio.run(main())
```

### Step 5: Run

```bash
python main.py
```

---

## TypeScript: Complete Working Project

### Step 1: Set Up the `.env` File

When you connect to a **self-hosted engine** (local, docker, service, or on-prem) using the extension's **development connection group**, the extension auto-populates `.env` in your workspace with the live server URI and key — preserving any other variables you've added. In **local** mode the engine listens on a dynamically assigned port, so the extension writes the *actual* resolved address (not a fixed port). In **cloud** mode, set `ROCKETRIDE_APIKEY` yourself (cloud sign-in uses a short-lived OAuth token, which is not a usable SDK key).

```env
# Development-group self-hosted engines: auto-filled on connect (local uses the real dynamic port).
# live engine address (auto-filled)
ROCKETRIDE_URI=http://localhost:54123
# self-hosted default; set your own for cloud
ROCKETRIDE_APIKEY=MYAPIKEY

# Add your custom variables:
ROCKETRIDE_INPUT_PATH=/data/input
ROCKETRIDE_OUTPUT_PATH=/data/output
```

> **Note:** For self-hosted engines in the development connection group, the extension re-syncs `ROCKETRIDE_URI`/`ROCKETRIDE_APIKEY` on every connect while leaving your other variables untouched. For cloud, provide your own API key. The TypeScript client reads `process.env`; it does not load `.env` itself, so load the file when starting the process as shown below. Because `.env` can contain credentials, add it to `.gitignore` and never commit it.

### Step 2: Install Client

```bash
# Using npm:
npm install rocketride

# Using pnpm:
pnpm add rocketride
```

### Step 3: Create Pipeline (`pipeline.pipe`)

Pipeline files **must** use the `.pipe` extension.

```json
{
	"project_id": "85be2a13-ad93-49ed-a1e1-4b0f763ca618",
	"source": "input",
	"components": [
		{
			"id": "input",
			"provider": "webhook",
			"config": {}
		},
		{
			"id": "processor",
			"provider": "transform",
			"config": {
				"input_path": "${ROCKETRIDE_INPUT_PATH}",
				"output_path": "${ROCKETRIDE_OUTPUT_PATH}"
			},
			"input": [{ "lane": "text", "from": "input" }]
		},
		{
			"id": "output",
			"provider": "response_text",
			"config": {},
			"input": [{ "lane": "text", "from": "processor" }]
		}
	]
}
```

### Step 4: Create TypeScript Script (`main.ts`)

```typescript
import { RocketRideClient } from 'rocketride';

async function main() {
	// Client reads ROCKETRIDE_* values from process.env
	const client = new RocketRideClient();

	try {
		// Connect to server
		await client.connect();
		console.log('Connected to RocketRide server');

		// Start pipeline
		const result = await client.use({ filepath: 'pipeline.pipe' });
		const token = result.token;
		console.log(`Pipeline started with token: ${token}`);

		// Send data
		await client.send(token, 'Hello, RocketRide!');
		console.log('Data sent successfully');

		// Check status
		const status = await client.getTaskStatus(token);
		console.log(`Pipeline state: ${status.state}`);
	} finally {
		// Always disconnect
		await client.disconnect();
		console.log('Disconnected');
	}
}

main().catch(console.error);
```

### Step 5: Run

```bash
npx tsx --env-file=.env main.ts
```

---

## Chat Pipeline (Q&A with LLM)

Chat pipelines with `chat` source, LLM nodes, and Q&A flow (questions → answers) work end-to-end. Use this pattern for conversational interfaces.

### Minimal Chat Pipeline (`chat.pipe`)

```json
{
	"project_id": "e30fee74-0f71-4af2-8dab-5d89deee8f84",
	"source": "chat_1",
	"components": [
		{ "id": "chat_1", "provider": "chat", "config": {} },
		{ "id": "llm_1", "provider": "llm_openai", "config": { "profile": "openai-5", "openai-5": { "apikey": "${ROCKETRIDE_OPENAI_KEY}" } }, "input": [{ "lane": "questions", "from": "chat_1" }] },
		{ "id": "response_1", "provider": "response_answers", "config": {}, "input": [{ "lane": "answers", "from": "llm_1" }] }
	]
}
```

### Python: Chat with Question/Answer

```python
import asyncio
from rocketride import RocketRideClient
from rocketride.schema import Question


async def main():
    client = RocketRideClient()
    await client.connect()
    result = await client.use(filepath='chat.pipe')
    token = result['token']

    q = Question()
    q.addQuestion('Hello, how are you?')
    response = await client.chat(token=token, question=q)
    print('Answer:', response.get('answers', [None])[0])

    await client.disconnect()


asyncio.run(main())
```

### TypeScript: Chat with Question/Answer

```typescript
import { RocketRideClient, Question } from 'rocketride';

const client = new RocketRideClient();
await client.connect();
const { token } = await client.use({ filepath: 'chat.pipe' });

const question = new Question();
question.addQuestion('Hello, how are you?');
const response = await client.chat({ token, question });
console.log('Answer:', response.answers?.[0]);

await client.disconnect();
```

> **Note:** Use `client.chat()` for chat pipelines; use `client.send()` for webhook pipelines. See ROCKETRIDE_COMMON_MISTAKES.md for source/method matching.

---

## Key Patterns to Remember

### Always Do This:

1. Configure server URL in extension settings (`rocketride.hostUrl` and API key)
2. When the extension's development connection group connects to a self-hosted engine, it auto-populates `.env` with `ROCKETRIDE_URI` and `ROCKETRIDE_APIKEY` (for cloud, set `ROCKETRIDE_APIKEY` manually)
3. Use empty constructor: `RocketRideClient()` or `new RocketRideClient()`
4. Use literal GUID for `project_id` - generate a new one per pipeline
5. Use `${ROCKETRIDE_*}` variables in component `config` fields
6. Always `connect()` before use, `disconnect()` after
7. Use `.pipe` extension for pipeline files

### Never Do This:

1. Hardcode `uri` or `auth` in the constructor (load `ROCKETRIDE_*` values into the process environment instead)
2. Use variables in `project_id` field (must be literal GUID)
3. Hand-edit `ROCKETRIDE_URI`/`ROCKETRIDE_APIKEY` for a self-hosted engine in the development connection group — the extension re-syncs them on connect (change them via extension settings; for cloud, set `ROCKETRIDE_APIKEY` manually)
4. Skip `connect()` or `disconnect()`
5. Use non-ROCKETRIDE\_\* variables in pipelines
6. Use `.json` extension for pipeline files (use `.pipe`)

---

## Complete Project Structure

```text
my-rocketride-project/
├── .env                    # Configuration (MUST have)
├── pipeline.pipe           # Pipeline definition (.pipe extension required)
├── main.py or main.ts      # Your code
└── package.json            # (TypeScript only)
```

---

Copy these examples exactly. They are guaranteed to work.
