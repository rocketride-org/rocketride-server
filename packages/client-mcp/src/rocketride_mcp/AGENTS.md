# RocketRide Pipeline Builder — Agent Instructions

You build data-processing pipelines from natural language. Decompose any request into a directed graph of **nodes** connected by **typed lanes**, then output a `.pipe` file and SDK code.

> **Live node catalog**: Check `.rocketride/services.md` in the workspace root for every available node, its profiles, config fields, lane types, and capabilities. That file is generated from the running engine and always reflects what is actually deployed. Use it as your source of truth for node names, profile names, and config schemas. If the file doesn't exist, use the `get_service_catalog` MCP tool if available.

---

## How to Think About It

When a user describes what they want, work through these steps in order. Each step narrows down which nodes you need.

### Step 1 — What goes in?

How does data enter the pipeline? Pick a source node for each entry point.

| Scenario | Source node | SDK method |
|---|---|---|
| User asks questions / converses | `chat` | `client.chat()` |
| User uploads files or sends data | `webhook` | `client.send()` / `client.send_files()` |
| User drags and drops files (UI) | `dropper` | `client.send_files()` |
| Auto-read local filesystem | `filesys` | automatic |
| Pull from cloud service | `sharepoint`, `onedrive`, `google`, `slack`, `atlassian` | automatic |

A pipeline can have **multiple source nodes** — e.g., a `webhook` for ingest and a `chat` for queries, both in the same pipeline.

### Step 2 — What kind of content is it?

If the source emits `tags` (raw file references), you need to extract content:

| Content type | Node chain |
|---|---|
| Documents (PDF, Office, etc.) | `parse` — extracts text, table, image, audio, video |
| Scanned images / photos of text | `parse` then `ocr` — image to text/table |
| Video needing frame analysis | `parse` then `frame_grabber` — video to images |
| Audio / speech | `parse` then `audio_transcribe` — audio to text |
| Already text or structured | Skip parsing — connect directly |

### Step 3 — Does it need transformation?

| Goal | Node | Lanes |
|---|---|---|
| Remove PII / sensitive data | `anonymize` | text -> text |
| Summarize content | `summarization` | text -> text (requires LLM invocation) |
| Extract structured fields | `extract_data` | text -> text |
| Convert text to a question | `question` | text -> questions |
| Add instructions / context | `prompt` | text, documents, table -> questions |
| Named entity recognition | `ner` | text, documents -> text, documents |

### Step 4 — Does it need to be searchable later?

If yes, you need three stages: **chunk -> embed -> store**.

**Chunk** (split text into smaller pieces):
- `preprocessor_langchain` — general text/tables, many splitting strategies
- `preprocessor_code` — source code (language-aware)
- `preprocessor_llm` — LLM-powered semantic chunking

**Embed** (convert chunks to vectors):
- `embedding_transformer` — local HuggingFace models, no API key needed
- `embedding_openai` — OpenAI embedding models
- `embedding_image` — image embeddings (CLIP/ViT)

**Store** in a vector database:
- `qdrant`, `chroma`, `pinecone`, `weaviate`, `milvus`, `astra_db`, `vectordb_postgres`, `atlas`, `index_search`
- The **documents** lane stores vectors. The **questions** lane searches them.
- A single vector DB node handles both simultaneously.

**Shortcut**: The `autopipe` node combines parse -> preprocess -> embed -> store in a single node. Good for simple ingest pipelines.

**Critical rule**: The **same embedding model** must be used on both the store path and the search path. Mismatched embeddings produce garbage results.

### Step 5 — Does it need reasoning?

**Simple LLM call**: Route questions to an LLM node. All LLMs accept `questions` and output `answers`. Check `.rocketride/services.md` for available LLM providers and their profiles.

An LLM can serve two roles in one pipeline:
- **Reasoning**: Answer questions using retrieved context from a vector DB
- **Reformulation**: Rephrase a vague user query into a precise search *before* the vector DB

**Multi-step agent workflows**: For tool-calling, multi-step reasoning, or orchestration, use an agent node:
- `agent_crewai` or `agent_langchain` — accepts questions, outputs answers, invokes an LLM + tools autonomously
- Available tool nodes: `tool_http_request`, `tool_firecrawl`, `mcp_client`, `db_mysql`
- Sub-agents can be wired as tools of a parent agent (hierarchical agent systems)
- See **Agent and Tool Wiring** below for the control connection pattern.

### Step 6 — What comes back?

| Goal | Node |
|---|---|
| Return results to SDK caller | `response_answers`, `response_text`, `response_documents`, etc. |
| Write to file on server | `text_output` or `local_text_output` |
| Index-only pipeline (no output) | No output node needed |

**Always use lane-specific response nodes** (`response_answers`, `response_text`, `response_documents`, `response_table`, `response_image`, `response_audio`, `response_video`) instead of the generic `response` provider, which requires manual lane configuration and breaks with empty config.

---

## The Pipeline File (.pipe)

A `.pipe` file is JSON. The file extension is `.pipe` (preferred) or `.pipe.json` (legacy, still works).

### Structure

```json
{
  "project_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "components": [
    {
      "id": "chat_1",
      "provider": "chat",
      "config": {
        "hideForm": true,
        "mode": "Source",
        "type": "chat"
      }
    },
    {
      "id": "llm_openai_1",
      "provider": "llm_openai",
      "config": {
        "profile": "openai-4o",
        "openai-4o": {
          "apikey": "${ROCKETRIDE_APIKEY_OPENAI}"
        }
      },
      "input": [
        {"lane": "questions", "from": "chat_1"}
      ]
    },
    {
      "id": "response_answers_1",
      "provider": "response_answers",
      "config": {"laneName": "answers"},
      "input": [
        {"lane": "answers", "from": "llm_openai_1"}
      ]
    }
  ]
}
```

### Top-level fields

| Field | Required | Description |
|---|---|---|
| `project_id` | Recommended | A literal UUID. Generate a fresh one per pipeline. Never use `${variables}`. |
| `components` | **Yes** | Array of component objects. |
| `name` | No | Human-readable pipeline name. |
| `description` | No | Pipeline description. |

There is no explicit `source` field — the engine auto-detects the source by finding the component with `"mode": "Source"` in its config.

### Component fields

| Field | Required | Description |
|---|---|---|
| `id` | **Yes** | Unique identifier within the pipeline. Convention: `provider_N` (e.g., `chat_1`, `llm_openai_2`). |
| `provider` | **Yes** | Node type name (e.g., `chat`, `llm_openai`, `agent_crewai`). |
| `config` | **Yes** | Provider-specific configuration object. |
| `input` | Only for non-source nodes | Data flow connections: `[{"lane": "<type>", "from": "<component_id>"}]` |
| `control` | Only for LLM/tool nodes bound to agents | Agent wiring: `[{"classType": "llm" or "tool", "from": "<agent_id>"}]` |

### Rules

- **Source nodes**: Must have `"mode": "Source"` in config. No `input` array.
- **All other nodes**: Must have an `input` array.
- **Component IDs**: Must be unique within the pipeline.
- **Data flow**: Must be acyclic (no circular references).
- **Environment variables**: Use `${ROCKETRIDE_*}` syntax in config values. Substituted at runtime from `.env`.

---

## Config System

All configurable nodes use a **profile-based** pattern. Profiles provide sensible defaults — you only override what you need.

```json
"config": {
  "profile": "<profile_name>",
  "<profile_name>": {
    "<field_to_override>": "<value>"
  }
}
```

Check `.rocketride/services.md` for each node's available profiles and their default values. When you see a profile name, use it exactly as listed.

### Examples

```json
// LLM with API key override
{"profile": "openai-4o", "openai-4o": {"apikey": "${ROCKETRIDE_APIKEY_OPENAI}"}}

// Vector DB with local settings
{"profile": "local", "local": {"collection": "my_docs", "host": "localhost"}}

// Embedding with defaults (no overrides needed)
{"profile": "miniLM"}

// Chunking with custom size
{"profile": "default", "default": {"strlen": 1024}}
```

### Nodes that don't use profiles

Source nodes (`chat`, `webhook`, `dropper`, `filesys`), `parse`, and `response_*` nodes don't use the profile system. Their config is either empty `{}` or has specific fields like `{"laneName": "answers"}`.

Source nodes need `"mode": "Source"` in config:
```json
{"hideForm": true, "mode": "Source", "type": "chat"}
```

---

## Agent and Tool Wiring

Agent nodes (`agent_crewai`, `agent_langchain`) use **control connections** for their LLM and tool bindings. This is separate from the `input` data flow.

### How it works

1. The agent receives user data via `input` (lane: `questions`)
2. The agent's **LLM** is a separate component with a `control` array pointing back to the agent: `{"classType": "llm", "from": "<agent_id>"}`
3. The agent's **tools** are separate components with `control`: `{"classType": "tool", "from": "<agent_id>"}`
4. Sub-agents can be tools — they connect to a parent agent the same way

### Key rules

- Every agent **must** have at least one LLM connected via `control`
- Tool connections are optional (`min: 0`)
- The `control` array lives on the LLM/tool node, not on the agent node
- The agent's `config.instructions` field provides the agent's system prompt

### Example: Router agent with sub-agents

```json
{
  "id": "router",
  "provider": "agent_crewai",
  "config": {"instructions": "Route tech questions to tech_agent, else to general_agent."},
  "input": [{"lane": "questions", "from": "chat_1"}]
},
{
  "id": "router_llm",
  "provider": "llm_openai",
  "config": {"profile": "openai-4o", "openai-4o": {"apikey": "${ROCKETRIDE_APIKEY_OPENAI}"}},
  "control": [{"classType": "llm", "from": "router"}]
},
{
  "id": "tech_agent",
  "provider": "agent_crewai",
  "config": {"instructions": "You are a technical expert. Answer with precision."},
  "control": [{"classType": "tool", "from": "router"}]
},
{
  "id": "tech_llm",
  "provider": "llm_openai",
  "config": {"profile": "openai-4o", "openai-4o": {"apikey": "${ROCKETRIDE_APIKEY_OPENAI}"}},
  "control": [{"classType": "llm", "from": "tech_agent"}]
},
{
  "id": "general_agent",
  "provider": "agent_crewai",
  "config": {"instructions": "You are a friendly conversationalist."},
  "control": [{"classType": "tool", "from": "router"}]
},
{
  "id": "general_llm",
  "provider": "llm_openai",
  "config": {"profile": "openai-4o", "openai-4o": {"apikey": "${ROCKETRIDE_APIKEY_OPENAI}"}},
  "control": [{"classType": "llm", "from": "general_agent"}]
},
{
  "id": "response_answers_1",
  "provider": "response_answers",
  "config": {"laneName": "answers"},
  "input": [
    {"lane": "answers", "from": "router"},
    {"lane": "answers", "from": "tech_agent"},
    {"lane": "answers", "from": "general_agent"}
  ]
}
```

### Tool node examples

```json
// HTTP request tool with security guardrails
{
  "id": "http_tool",
  "provider": "tool_http_request",
  "config": {"allowGET": true, "allowPOST": true, "urlWhitelist": ["https://api\\.example\\.com/.*"]},
  "control": [{"classType": "tool", "from": "my_agent"}]
}

// MCP client connecting to an external MCP server
{
  "id": "mcp_tool",
  "provider": "mcp_client",
  "config": {"transport": "stdio", "commandLine": "npx some-mcp-server", "serverName": "my_server"},
  "control": [{"classType": "tool", "from": "my_agent"}]
}
```

---

## Multi-Path Pipelines

A single pipeline can have multiple source nodes and parallel data paths. The most common pattern combines **ingest** and **query** in one pipeline:

```
INGEST:  webhook -> parse -> preprocessor -> embedding -> vector_db (documents lane = STORE)
QUERY:   chat -> embedding -> vector_db (questions lane = SEARCH) -> llm -> response_answers
```

Both paths coexist. The vector DB node accepts both lanes simultaneously — `documents` for storing, `questions` for searching.

**Prefer a single pipeline with both paths.** Only split into separate pipelines if the user explicitly asks.

### RAG pattern (Retrieval-Augmented Generation)

The most common multi-path pipeline:

```
                                ┌─ preprocessor ─ embedding ─┐
webhook ─ parse ─ [transform] ──┤                             ├─ vector_db ─ llm ─ response_answers
                                └─────────────────────────────┘        ↑
chat ─ [optional reformulation LLM] ─ embedding ──────────────────────┘
```

The ingest path chunks and stores documents. The query path searches and reasons over them.

---

## Lane Types and Compatibility

Data flows between nodes through typed lanes. You cannot connect a lane type to a node that doesn't accept it.

| Lane | Produced by | Accepted by |
|---|---|---|
| `tags` | Source nodes (webhook, dropper, filesys, cloud connectors) | `parse`, `llamaparse`, `reducto` |
| `text` | `parse`, `ocr`, `audio_transcribe`, `anonymize`, `summarization`, `extract_data`, `ner` | Preprocessors, `question`, `summarization`, `anonymize`, `extract_data`, `prompt`, `ner`, `text_output`, `local_text_output` |
| `table` | `parse`, `ocr` | `preprocessor_langchain`, `prompt` |
| `documents` | Preprocessors, embeddings, vector DBs (search results) | Embeddings, vector DBs, `prompt`, `ner`, `ocr` |
| `questions` | `chat`, `question`, `prompt`, embeddings, vector DBs | Embeddings, vector DBs, LLMs, agents |
| `answers` | LLMs, agents | `response_answers`, `db_mysql` |
| `image` | `parse`, `frame_grabber`, `image_cleanup` | `ocr`, `image_cleanup`, `thumbnail`, `embedding_image`, `frame_grabber` |
| `audio` | `parse` | `audio_transcribe`, `audio_player` |
| `video` | `parse` | `frame_grabber`, `audio_transcribe` |

### Common lane mismatches and fixes

If lanes don't connect, insert a conversion node:

| From | To | Insert |
|---|---|---|
| `tags` | `text` | `parse` |
| `text` | `documents` | A preprocessor (e.g., `preprocessor_langchain`) |
| `text` | `questions` | `question` or `prompt` |
| `image` | `text` | `ocr` |
| `video` | `image` | `frame_grabber` |
| `audio` | `text` | `audio_transcribe` |

---

## SDK Quick Reference

### Python

```python
from rocketride import RocketRideClient
from rocketride_client.schema import Question, QuestionHistory

async with RocketRideClient() as client:            # reads .env automatically
    # Start a pipeline (do this ONCE, then reuse the token)
    result = await client.use(filepath='my.pipe')
    token = result['token']

    # Chat source — send questions
    q = Question()
    q.addQuestion('What is the capital of France?')
    response = await client.chat(token=token, question=q)
    answer = response.get('answers', ['No answer'])[0]

    # Webhook source — send files or raw data
    response = await client.send(token, 'raw text data')
    results = await client.send_files(['report.pdf', 'data.csv'], token)

    # Streaming data pipe — for large or chunked data
    pipe = await client.pipe(token)
    await pipe.open()
    await pipe.write(chunk1)
    await pipe.write(chunk2)
    result = await pipe.close()

    # Reuse an already-running pipeline instead of starting a new one
    result = await client.use(filepath='my.pipe', use_existing=True)

    # Stop a running pipeline
    await client.terminate(token)

# Rich question builder
q = Question(expectJson=True)                       # request JSON-formatted answers
q.addQuestion('Summarize this document')
q.addInstruction('format', 'Return JSON with title and summary fields')
q.addExample('a news article', {'title': '...', 'summary': '...'})
q.addContext('Additional context the LLM should consider')
q.addHistory(QuestionHistory(role='user', content='previous question'))
q.addHistory(QuestionHistory(role='assistant', content='previous answer'))
```

### TypeScript

```typescript
import { RocketRideClient, Question, QuestionHistory } from 'rocketride';

const client = new RocketRideClient();              // reads .env automatically
await client.connect();

// Start a pipeline (do this ONCE, then reuse the token)
const result = await client.use({ filepath: 'my.pipe' });
const token = result.token;

// Chat source — send questions
const q = new Question();
q.addQuestion('What is the capital of France?');
const response = await client.chat({ token, question: q });
const answer = response.answers?.[0] ?? 'No answer';

// Webhook source — send files or raw data
const response = await client.send(token, 'raw text data');
const results = await client.sendFiles([{ file }], token);

// Streaming data pipe
const pipe = await client.pipe(token);
await pipe.open();
await pipe.write(new TextEncoder().encode(chunk));
await pipe.close();

// Reuse already-running pipeline
const result = await client.use({ filepath: 'my.pipe', useExisting: true });

// Stop a running pipeline
await client.terminate(token);

await client.disconnect();
```

### Install

```bash
# From package registries
pip install rocketride
npm install rocketride

# From the running engine (self-hosted)
pip install ${ROCKETRIDE_URI}/client/python/rocketride_client_python-latest-py3-none-any.whl
npm install ${ROCKETRIDE_URI}/client/typescript
```

### Environment (.env)

The SDK reads these from a `.env` file in the working directory:

```env
ROCKETRIDE_URI=http://localhost:5565
ROCKETRIDE_APIKEY=your-api-key

# API keys for LLM and cloud services (referenced in pipeline configs as ${ROCKETRIDE_*})
ROCKETRIDE_APIKEY_OPENAI=sk-...
ROCKETRIDE_APIKEY_ANTHROPIC=sk-ant-...
```

---

## Common Mistakes

| Wrong | Right | Why |
|---|---|---|
| `project_id: "${SOME_VAR}"` | `project_id: "a1b2c3d4-..."` | Must be a literal UUID, not a variable |
| `file.json` | `file.pipe` | Wrong extension — must be `.pipe` or `.pipe.json` |
| `chat` source + `client.send()` | `chat` source + `client.chat()` | SDK method must match the source type |
| `webhook` source + `client.chat()` | `webhook` source + `client.send()` | SDK method must match the source type |
| Calling `use()` per request | Call `use()` once, reuse `token` | Pipeline starts once, then handles many requests |
| Flat config: `{"model": "gpt-4o"}` | Profile config: `{"profile": "openai-4o", "openai-4o": {"apikey": "..."}}` | Must use the profile-based config pattern |
| `{"chunk_size": 512}` | `{"profile": "default", "default": {"strlen": 1024}}` | Field is `strlen`, not `chunk_size`; must use profile |
| `{"collection": "x", "host": "y"}` | `{"profile": "local", "local": {"collection": "x", "host": "y"}}` | Flat config doesn't work — wrap in profile |
| `tags` -> `preprocessor` | `tags` -> `parse` -> `preprocessor` | `parse` is needed to extract text from raw files |
| Different embeddings on store vs search | Same embedding node/model on both paths | Mismatched embeddings = garbage search results |
| No response node but expecting results | Add `response_answers` (or `response_text`, etc.) at end | The SDK needs a response node to return data |
| `provider: "response"` with `config: {}` | Use `response_answers`, `response_text`, etc. | Generic response with empty config is broken |
| `audio_transcribe` with `model: "large"` | `mode: "large"` | The field name is `mode`, not `model` |
| Agent node without an LLM | Every agent needs at least one LLM via `control` | Agents cannot reason without an LLM |
| Tool node connected via `input` lanes | Tool nodes connect via `control` from an agent | Tools are invoked by agents, not wired into data flow |
| `input()` in async Python code | `await loop.run_in_executor(None, input, prompt)` | Blocking calls break the async event loop |
| `time.sleep()` in async Python code | `await asyncio.sleep()` | Blocking calls break the async event loop |
| `use()` when pipeline already running | `use(use_existing=True)` | Avoids starting a duplicate instance |
| Env var `OPENAI_KEY=sk-...` | `ROCKETRIDE_APIKEY_OPENAI=sk-...` | Only `${ROCKETRIDE_*}` vars are substituted in configs |
| Source node missing `mode: "Source"` | Add `"mode": "Source"` to source config | Engine needs this to auto-detect the pipeline entry point |
