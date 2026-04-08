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
