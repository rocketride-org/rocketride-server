# RocketRide SDK Quick Start

<p align="center">
  <strong>RocketRide SDK Quick Start</strong><br/>
  Invoke pipelines from your Python or TypeScript applications in 5 minutes.
</p>

<p align="center">
  <a href="https://pypi.org/project/rocketride/"><img src="https://img.shields.io/pypi/v/rocketride?color=222223&label=PyPI" alt="PyPI"></a>
  <a href="https://www.npmjs.com/package/rocketride"><img src="https://img.shields.io/npm/v/rocketride?color=222223&label=NPM" alt="npm"></a>
  <a href="https://github.com/rocketride-org/rocketride-server"><img src="https://img.shields.io/github/stars/rocketride-org/rocketride-server?style=flat&color=238636&label=GitHub&logo=github&logoColor=white" alt="GitHub"></a>
  <a href="https://discord.gg/9hr3tdZmEG"><img src="https://img.shields.io/badge/Discord-Join-370b7a?logo=discord&logoColor=white" alt="Discord"></a>
</p>

---

## Setup (5 minutes)

### 1. Start the RocketRide Engine

**Local (Recommended):**

Install the [RocketRide VS Code extension](https://marketplace.visualstudio.com/items?itemName=RocketRide.rocketride), then click the RocketRide icon in the Activity Bar and connect. The extension automatically downloads and starts the engine locally.

For manual installation, [download the engine](https://github.com/rocketride-org/rocketride-server/releases) and run:

```bash
./rocketride-engine --port 5565
```

**Docker:**

```bash
docker run -p 5565:5565 ghcr.io/rocketride-org/rocketride-engine:latest
```

**Verify:**

```bash
curl http://localhost:5565/health
```

### 2. Create Your Pipeline File

Save this as `simple_llm.pipe` in your project directory:

```json
{
	"project_id": "e30fee74-0f71-4af2-8dab-5d89deee8f84",
	"source": "webhook_1",
	"components": [
		{
			"id": "webhook_1",
			"provider": "webhook",
			"config": { "hideForm": true, "mode": "Source" }
		},
		{
			"id": "question_1",
			"provider": "question",
			"config": { "type": "question" },
			"input": [{ "lane": "text", "from": "webhook_1" }]
		},
		{
			"id": "llm_1",
			"provider": "llm_openai",
			"config": {
				"profile": "openai-5",
				"openai-5": { "apikey": "${ROCKETRIDE_OPENAI_KEY}" }
			},
			"input": [{ "lane": "questions", "from": "question_1" }]
		},
		{
			"id": "response_1",
			"provider": "response_answers",
			"config": { "laneName": "answers" },
			"input": [{ "lane": "answers", "from": "llm_1" }]
		}
	]
}
```

### 3. Create .env File

```bash
cat > .env << 'EOF'
ROCKETRIDE_URI=ws://localhost:5565
ROCKETRIDE_APIKEY=dev-key-local
ROCKETRIDE_OPENAI_KEY=sk-your-api-key-here
EOF
```

**Note:** Use `ws://` for local WebSocket connections and `wss://` for secure cloud connections. The Python client automatically converts `http://` URIs to their WebSocket equivalents, but explicit `ws://`/`wss://` is recommended for clarity.

### 4. Install SDK

**Python:**

```bash
pip install rocketride python-dotenv
```

**TypeScript:**

```bash
npm install rocketride dotenv
```

---

## Python Quickstart

**Installation:**

```bash
pip install rocketride python-dotenv
python quickstart.py
```

**Code (save as `quickstart.py`):**

```python
import asyncio
import os
import traceback
from dotenv import load_dotenv
from rocketride import RocketRideClient

async def main():
    # Load configuration from .env
    load_dotenv()
    uri = os.getenv("ROCKETRIDE_URI")
    auth = os.getenv("ROCKETRIDE_APIKEY")

    if not uri or not auth:
        print("❌ Error: ROCKETRIDE_URI and ROCKETRIDE_APIKEY must be set in .env")
        return

    client = RocketRideClient(uri=uri, auth=auth)
    token = None

    try:
        # Connect to the RocketRide engine
        await client.connect()

        # Load the pipeline
        result = await client.use(filepath="simple_llm.pipe")
        token = result["token"]

        # Send data to the pipeline
        # IMPORTANT: set mimetype='text/plain' so data routes correctly
        user_input = "What are the top 3 benefits of AI in software development?"

        response = await client.send(token, user_input, mimetype="text/plain")

        # Extract and display the LLM answer
        answers = response.get("answers", [])
        if answers:
            print(answers[0])
        else:
            print("⚠ No answer received (check pipeline configuration)")

    except FileNotFoundError:
        print("❌ Error: simple_llm.pipe not found in current directory")
    except ConnectionRefusedError:
        print("❌ Error: Cannot connect to engine at ws://localhost:5565")
        print("   Is the RocketRide engine running?")
    except Exception as e:
        print(f"❌ Error: {e}")
        traceback.print_exc()

    finally:
        # Always cleanup
        try:
            if token:
                await client.terminate(token)
            await client.disconnect()
        except Exception as e:
            print(f"⚠ Cleanup error: {e}")

if __name__ == "__main__":
    asyncio.run(main())
```

---

## TypeScript Quickstart

**Installation:**

```bash
npm install rocketride dotenv
npx tsx quickstart.ts
```

**Code (save as `quickstart.ts`):**

```typescript
import 'dotenv/config'; // Load .env variables
import { RocketRideClient } from 'rocketride';

const client = new RocketRideClient({
	uri: process.env.ROCKETRIDE_URI || 'ws://localhost:5565',
	auth: process.env.ROCKETRIDE_APIKEY || 'dev-key-local',
});

async function main() {
	let token: string | undefined;

	try {
		// Connect to the RocketRide engine
		await client.connect();

		// Load the pipeline
		const result = await client.use({ filepath: './simple_llm.pipe' });
		token = result.token;

		// Send data to the pipeline
		// IMPORTANT: set mimetype='text/plain' so data routes correctly
		const userInput = 'What are the top 3 benefits of AI in software development?';

		const response = await client.send(token, userInput, {}, 'text/plain');

		// Extract and display the LLM answer
		if (response?.answers?.[0]) {
			console.log(response.answers[0]);
		} else {
			console.log('⚠ No answer received (check pipeline configuration)');
		}
	} catch (error) {
		if (error instanceof Error) {
			if (error.message.includes('ECONNREFUSED')) {
				console.error('❌ Connection refused. Is engine running on ws://localhost:5565?');
			} else if (error.message.includes('ENOENT')) {
				console.error('❌ simple_llm.pipe not found in current directory');
			} else {
				console.error(`❌ Error: ${error.message}`);
			}
		} else {
			console.error(`❌ Unknown error: ${error}`);
		}
	} finally {
		// Always cleanup
		try {
			if (token) {
				await client.terminate(token);
			}
			await client.disconnect();
		} catch (error) {
			if (error instanceof Error) {
				console.warn(`⚠ Cleanup error: ${error.message}`);
			}
		}
	}
}

main().catch((error) => {
	console.error('Fatal error:', error);
	process.exit(1);
});
```

---

## Web Framework Integration

### FastAPI Integration

Use RocketRide in a FastAPI application to handle LLM requests in your API endpoints.

**Installation:**

```bash
pip install fastapi uvicorn rocketride python-dotenv
```

**Code (save as `app.py`):**

```python
from fastapi import FastAPI, HTTPException
from contextlib import asynccontextmanager
from pydantic import BaseModel
import os
from dotenv import load_dotenv
from rocketride import RocketRideClient

load_dotenv()

uri = os.getenv("ROCKETRIDE_URI")
auth = os.getenv("ROCKETRIDE_APIKEY")

if not uri or not auth:
    raise ValueError("ROCKETRIDE_URI and ROCKETRIDE_APIKEY must be set in .env")

client = RocketRideClient(uri=uri, auth=auth)

@asynccontextmanager
async def lifespan(app: FastAPI):
    await client.connect()
    yield
    await client.disconnect()

app = FastAPI(lifespan=lifespan)

class Question(BaseModel):
    text: str

class AnswerResponse(BaseModel):
    answer: str

@app.post("/ask", response_model=AnswerResponse)
async def ask_llm(question: Question):
    token = None
    try:
        result = await client.use(filepath="simple_llm.pipe")
        token = result["token"]

        response = await client.send(token, question.text, mimetype="text/plain")
        answers = response.get("answers", [])

        if answers:
            return AnswerResponse(answer=answers[0])
        else:
            raise HTTPException(status_code=500, detail="No answer received from pipeline")

    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="Pipeline file not found")
    except ConnectionRefusedError:
        raise HTTPException(status_code=503, detail="Cannot connect to RocketRide engine")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    finally:
        if token:
            try:
                await client.terminate(token)
            except Exception:
                pass

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
```

**Usage:**

```bash
python app.py
# In another terminal:
curl -X POST http://localhost:8000/ask \
  -H "Content-Type: application/json" \
  -d '{"text":"What is AI?"}'
```

---

### Express.js Integration

Use RocketRide in an Express.js application to handle LLM requests in your API endpoints.

**Installation:**

```bash
npm install express rocketride dotenv
```

**Code (save as `app.ts`):**

```typescript
import 'dotenv/config';
import express, { Request, Response } from 'express';
import { RocketRideClient } from 'rocketride';

const app = express();
app.use(express.json());

const client = new RocketRideClient({
	uri: process.env.ROCKETRIDE_URI || 'ws://localhost:5565',
	auth: process.env.ROCKETRIDE_APIKEY || 'dev-key-local',
});

let isConnected = false;

app.listen(3000, async () => {
	try {
		await client.connect();
		isConnected = true;
		console.log('Server running on http://localhost:3000');
	} catch (error) {
		console.error('Failed to connect to RocketRide:', error);
		process.exit(1);
	}
});

process.on('SIGTERM', async () => {
	if (isConnected) {
		await client.disconnect();
	}
	process.exit(0);
});

app.post('/ask', async (req: Request, res: Response): Promise<void> => {
	const { text } = req.body;
	let token: string | undefined;

	if (!text) {
		res.status(400).json({ error: 'text field is required' });
		return;
	}

	try {
		const result = await client.use({ filepath: './simple_llm.pipe' });
		token = result.token;

		const response = await client.send(token, text, {}, 'text/plain');

		if (response?.answers?.[0]) {
			res.json({ answer: response.answers[0] });
		} else {
			res.status(500).json({ error: 'No answer received from pipeline' });
		}
	} catch (error) {
		if (error instanceof Error) {
			if (error.message.includes('ECONNREFUSED')) {
				res.status(503).json({ error: 'Cannot connect to RocketRide engine' });
			} else if (error.message.includes('ENOENT')) {
				res.status(500).json({ error: 'Pipeline file not found' });
			} else {
				res.status(500).json({ error: error.message });
			}
		} else {
			res.status(500).json({ error: 'Unknown error' });
		}
	} finally {
		if (token) {
			try {
				await client.terminate(token);
			} catch (error) {
				// Termination error, but response already sent
			}
		}
	}
});
```

**Usage:**

```bash
npx tsx app.ts
# In another terminal:
curl -X POST http://localhost:3000/ask \
  -H "Content-Type: application/json" \
  -d '{"text":"What is AI?"}'
```

---

## Key Points

- **MIME type matters:** Always set `mimetype='text/plain'` when sending text. Without it, data routes to the wrong lane.
- **Answer location:** LLM responses are in `response['answers']` array (first element is the answer).
- **Cleanup:** Always call `terminate()` and `disconnect()` in a finally block.
- **Error handling:** Check for connection errors (engine not running) and file-not-found errors.
- **Environment variables:** Use `.env` for `ROCKETRIDE_URI` and `ROCKETRIDE_APIKEY`.
- **URI protocol:** Use `ws://` for local and `wss://` for cloud. The Python client accepts both `http://` and `ws://`, but explicit WebSocket URIs are recommended for consistency.

---

## Troubleshooting

| Error                       | Solution                                                                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Connection refused`        | Is the engine running? Check `curl http://localhost:5565/health`                                                                                          |
| `simple_llm.pipe not found` | Copy the pipeline file to your project directory                                                                                                          |
| `No answer received`        | Check the LLM API key in the pipeline config (`ROCKETRIDE_OPENAI_KEY`, etc.)                                                                              |
| `Task token is required`    | Verify you're passing a valid token argument to `send()` (e.g., `send(token, ...)`) — check token variable is populated and not lost during serialization |

---

## Next Steps

- **Build your own pipeline:** Open a `.pipe` file in VS Code with the RocketRide extension
- **More examples:** See `../examples/` directory for RAG, agent workflows, and more
- **API reference:** See [Python API docs](./agents/ROCKETRIDE_python_API.md) or [TypeScript API docs](./agents/ROCKETRIDE_typescript_API.md)
- **Component reference:** [All 50+ pipeline nodes](./agents/ROCKETRIDE_COMPONENT_REFERENCE.md)
