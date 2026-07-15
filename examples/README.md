# Example Pipeline Templates

Ready-to-use `.pipe` templates for common AI workflows. Open any template in the RocketRide VS Code extension to view it in the visual canvas builder, or run it programmatically with the Python or TypeScript SDK.

## Templates

### rag-pipeline.pipe

**Full RAG (Retrieval-Augmented Generation) system** with separate ingestion and query flows.

```
Ingestion:  webhook -> parse -> preprocessor -> embedding -> Qdrant
Query:      chat -> embedding -> Qdrant -> prompt -> LLM -> response
```

- Ingests documents via webhook, chunks text, embeds with miniLM, and stores in Qdrant
- Answers questions by embedding the query, retrieving relevant documents, and generating an answer with GPT-4o
- Uses the prompt node to merge retrieved context with the user's question

**Required env vars:** `ROCKETRIDE_OPENAI_KEY`, `ROCKETRIDE_QDRANT_HOST`, `ROCKETRIDE_COLLECTION_NAME`

---

### llm-benchmark.pipe

**Compare three LLM providers side-by-side** using parallel agent fan-out.

```
chat -> agent (OpenAI)    ->
chat -> agent (Anthropic)  -> response (all answers)
chat -> agent (Gemini)     ->
```

- Sends the same question to three agents, each backed by a different LLM provider
- All answers are collected into a single response for comparison
- Uses RocketRide, CrewAI, and LangChain agent frameworks

**Required env vars:** `ROCKETRIDE_OPENAI_KEY`, `ROCKETRIDE_ANTHROPIC_KEY`, `ROCKETRIDE_GEMINI_KEY`

---

### document-processor.pipe

**Document processing pipeline** with OCR, named entity recognition, and PII anonymization.

```
webhook -> parse -> OCR (images) -> NER -> anonymize -> response
```

- Accepts documents via webhook and parses all content types
- Runs OCR on extracted images to recover text
- Identifies named entities with NER
- Anonymizes PII (names, addresses, etc.) before returning the cleaned text

**Required env vars:** None (uses local models)

---

### agent-workflow.pipe

**Multi-agent pipeline** with hierarchical tool use and a research sub-agent.

```
chat -> orchestrator agent -> response
           |
    +------+------+------+
    |      |      |      |
   LLM  Memory  HTTP  Python
                  |
            research agent (sub-agent as tool)
                  |
           +------+------+
           |      |      |
          LLM  Memory  HTTP
```

- An orchestrator agent coordinates tools and delegates to a research sub-agent
- The research sub-agent uses HTTP requests to gather web information
- Each agent has its own LLM and memory for independent reasoning
- The orchestrator uses GPT-4o; the research agent uses Claude

**Required env vars:** `ROCKETRIDE_OPENAI_KEY`, `ROCKETRIDE_ANTHROPIC_KEY`

### n8n-roundtrip.pipe

**Call an n8n workflow from a RocketRide pipeline** (pairs with `n8n-call-rocketride.workflow.json`).

```text
webhook -> tool_n8n (triggers n8n workflow "rocketride-demo") -> response
```

- Lane input is POSTed to the n8n workflow's webhook; the workflow's response flows downstream
- Import the companion `n8n-call-rocketride.workflow.json` into n8n for the other half of an RR→n8n→RR round-trip
- See the [n8n integration guide](../docs/README-n8n.md) for setup, activation, and Docker-reachability notes

**Required env vars:** `ROCKETRIDE_N8N_URL` (e.g. `http://localhost:5678`), `ROCKETRIDE_N8N_KEY` (only for async mode / listing)

The [`n8n/`](n8n/) subfolder has runnable test pipes covering every mode — `n8n-fanout.pipe` (sync + async + sequential), `n8n-agent.pipe` (agent calls n8n as a tool), and `n8n-roundtrip.pipe` + `n8n-roundtrip-target.pipe` (the full RR→n8n→RR loop).

---

### agent-llamaindex.pipe

**Single-agent pipeline** using the LlamaIndex agent framework, backed by Claude.

```text
chat -> LlamaIndex agent -> response
              |
        +-----+-----+
        |           |
       LLM        HTTP
     (Claude)    (tool)
```

- A LlamaIndex ReAct agent answers questions, calling the HTTP request tool when it helps
- Backed by Anthropic's Claude (Sonnet 4.6) via the `llm` control channel

**Required env vars:** `ROCKETRIDE_ANTHROPIC_KEY`

---

### slack-agent.pipe

**Slack-connected agent** that can post messages, list channels, and read channel history.

```text
chat -> agent (RocketRide Wave) -> response
                 |
          +------+------+
          |      |      |
         LLM  Memory  Slack (tool)
```

- The agent acts on your Slack workspace via the `slack.*` tools: `message_post` (channel or thread), `channels_list`, `channel_history`, and `check_connection`
- Ask it to announce a result in a channel, or to summarize recent discussion before answering
- The bot must be invited to any channel it should post to or read (`/invite @your-bot`); see the [tool_slack README](../nodes/src/nodes/tool_slack/README.md) for the app setup and required scopes
- For zero-scope, post-only setups, set the node's `webhookUrl` (Slack incoming webhook) instead of `token`

**Required env vars:** `ROCKETRIDE_ANTHROPIC_KEY`, `ROCKETRIDE_SLACK_TOKEN` (a bot token with `chat:write`, `channels:read`, `channels:history`)

## Getting Started

1. Copy a template to your project directory
2. Set the required environment variables in your `.env` file
3. Open the `.pipe` file in VS Code with the RocketRide extension, or run it with the SDK:

**Python:**
```python
from rocketride import RocketRideClient

client = RocketRideClient()
await client.connect()
result = await client.use(filepath='rag-pipeline.pipe')
```

**TypeScript:**
```typescript
import { RocketRideClient } from 'rocketride';

const client = new RocketRideClient();
await client.connect();
const result = await client.use({ filepath: 'rag-pipeline.pipe' });
```

See the [Pipeline Rules](../docs/agents/ROCKETRIDE_PIPELINE_RULES.md) and [Component Reference](../docs/agents/ROCKETRIDE_COMPONENT_REFERENCE.md) for detailed documentation.
