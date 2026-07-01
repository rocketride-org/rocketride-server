---
title: Use Cases
sidebar_label: Use Cases
---

import ThemedImage from '@theme/ThemedImage';
import { LuPlay } from 'react-icons/lu';

# Use cases

Two end-to-end walkthroughs: **build a pipeline visually in your IDE**, then **integrate
that pipeline into your own application with an SDK**. Both start from zero and finish with
a running pipeline.

For a curated, community-maintained list of RocketRide projects, templates, and
integration examples, see
[**awesome-rocketride**](https://github.com/rocketride-org/awesome-rocketride).

## Build a pipeline in your IDE {#build-a-pipeline-in-your-ide}

The visual canvas in the VS Code extension is the fastest way to author a `.pipe` file.

### 1. Install the extension

Search for **RocketRide** in the VS Code Extension Marketplace and install it. The
extension also works in VS Code forks (Cursor, Windsurf, VSCodium) via the
[Open VSX Registry](https://open-vsx.org/extension/RocketRide/rocketride).

### 2. Deploy a server

Click the RocketRide
(<ThemedImage alt="RocketRide" className="rr-inline-icon" sources={{ light: '/img/rocketride-icon-colored.svg', dark: '/img/rocketride-icon-white.svg' }} />)
icon in your IDE sidebar, then choose how to run the runtime:

- **Local (recommended)**: pulls the server straight into your IDE, no extra setup.
- **On-premises**: run on your own hardware via Docker or build from source.
- **RocketRide Cloud**: managed hosting (coming soon).

### 3. Create a pipeline file

Create a file ending in `.pipe` (e.g. `my-first-pipeline.pipe`). The extension opens it in
the visual builder canvas. `.pipe` files are JSON under the hood, but you author them
visually.

### 4. Build a simple chat pipeline

Every pipeline starts with a **source node**:

1. Add a **Chat** source node: an interactive conversational interface.
2. Add an **LLM** node: pick a provider (OpenAI, Anthropic, Google, …) and set your API key.
3. Connect the Chat source's output lane to the LLM's input lane.

The result is a `Chat → LLM` pipeline; the LLM's response routes back to the chat interface
automatically.

### 5. Run it

Press the **<LuPlay className="rr-inline-icon" /> Run button** on the source node, or launch
from the **Connection Manager** panel. Open the chat interface, send a message, and watch
the LLM respond in real time. Use the Connection Manager to trace call trees, token usage,
and memory consumption.

Save the `.pipe` file, you'll run it from code in the next walkthrough.

## Integrate a pipeline with an SDK {#integrate-a-pipeline-with-an-sdk}

Once you have a `.pipe` file, run it from your own application with the
[Python](/develop/python) or [TypeScript](/develop/typescript) SDK. Both connect to a
running engine, a local server (`ws://localhost:5565`) or RocketRide Cloud
(`https://cloud.rocketride.ai`), start the pipeline with `use()`, stream data with
`send()`, and stop it with `terminate()`.

### Python

```bash
pip install rocketride
```

```python
import asyncio
from rocketride import RocketRideClient

async def main():
    async with RocketRideClient(uri='ws://localhost:5565', auth='my-key') as client:
        result = await client.use(filepath='my-first-pipeline.pipe')
        token = result['token']
        out = await client.send(token, 'Hello, pipeline!', objinfo={'name': 'input.txt'}, mimetype='text/plain')
        print(out)
        await client.terminate(token)

asyncio.run(main())
```

See the [Python SDK reference](/develop/python) for chat, file uploads, streaming pipes,
events, and persist-mode reconnection.

### TypeScript

```bash
npm install rocketride
```

```typescript
import { RocketRideClient } from 'rocketride';

const client = new RocketRideClient({ uri: 'ws://localhost:5565', auth: process.env.ROCKETRIDE_APIKEY! });
await client.connect();
const { token } = await client.use({ filepath: './my-first-pipeline.pipe' });
const result = await client.send(token, 'Hello, pipeline!', { name: 'input.txt' }, 'text/plain');
console.log(result);
await client.terminate(token);
await client.disconnect();
```

See the [TypeScript SDK reference](/develop/typescript) for chat, file uploads, streaming
pipes, events, and persist-mode reconnection.

## More use cases

Browse the [**awesome-rocketride**](https://github.com/rocketride-org/awesome-rocketride)
list for real-world pipelines (RAG over your docs, document extraction (OCR/NER), PII
anonymization, multi-provider LLM routing, and agent workflows), plus starter templates you
can clone and run.
