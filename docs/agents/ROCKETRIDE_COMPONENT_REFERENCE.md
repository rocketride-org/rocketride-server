# RocketRide Component Reference

**Last Updated:** March 2026

---

## How Component Information Is Organized

When the RocketRide VS Code extension is installed, it populates a `.rocketride/` directory in your workspace:

```text
.rocketride/
├── services-catalog.json    # Summary of ALL components (name, class, lanes, descriptions)
├── schema/                  # Detailed config schema for each component
│   ├── webhook.json
│   ├── llm_openai.json
│   ├── qdrant.json
│   └── ...                  # One file per component
└── docs/                    # Documentation files (these files)
```

**IMPORTANT:** Always read `.rocketride/services-catalog.json` for the current list of available components. The catalog is the single source of truth — it is generated from the connected server and may contain components not listed in this document.

### Reading the Catalog

Each entry in `services-catalog.json` has this structure:

```json
{
	"name": "component_provider_name",
	"classType": ["category"],
	"description": "What the component does",
	"lanes": {
		"input_lane": ["output_lane_1", "output_lane_2"]
	},
	"invoke": {
		"llm": { "description": "LLM used by the component", "min": 1 },
		"tool": { "description": "Tools available to the component", "min": 0 },
		"memory": { "description": "Memory store", "min": 0, "max": 1 }
	}
}
```

**Key fields:**

- `name` — the `provider` value you use in pipeline files
- `classType` — component category: source, data, text, image, audio, video, embedding, llm, store, database, tool, agent, memory, infrastructure, target, preprocessor
- `lanes` — the definitive reference for data flow. Each key is an input lane; its value array lists the output lanes produced. An empty array `[]` means the component consumes data with no lane output (e.g., storage, response). Source components use `_source` as the input lane key
- `invoke` — (optional) defines what control-plane connections the component requires or accepts. Each key is a `classType` (e.g., `llm`, `tool`, `memory`) with `min`/`max` constraints and a description. Components with `invoke` need corresponding entries in the `control` array of the pipeline definition

### Reading Component Schemas

For detailed configuration (profiles, required fields, defaults), read the schema file:

```text
.rocketride/schema/{component_name}.json
```

Each schema file contains:

- `description` — full component description
- `classType` — component categories
- `lanes` — input/output lane mappings (same as catalog)
- `invoke` — control-plane connection requirements (same as catalog, if applicable)
- `Pipe.schema` — JSON Schema for the component's `config` object, including:
  - Profile definitions (`dependencies.profile.oneOf`)
  - Required fields
  - Default values
  - Field descriptions and types
- `documentation` — link to external documentation (if available)

**Example:** To find what profiles `llm_openai` supports:

```text
Read .rocketride/schema/llm_openai.json → Pipe.schema.dependencies.profile.oneOf
```

---

## Pipeline File Format

Pipelines are directed acyclic graphs (DAGs) of components connected by typed data lanes, saved as `.pipe` JSON files.

### Required Fields

```json
{
	"project_id": "<unique-uuid>",
	"source": "<source_component_id>",
	"components": []
}
```

- `project_id` — unique GUID per pipeline file. Must be a literal UUID, not a variable
- `source` — ID of the entry-point component
- `components` — array of component objects

### Component Structure

```json
{
	"id": "<provider>_<n>",
	"provider": "<provider_key>",
	"config": {},
	"input": [{ "lane": "<lane_name>", "from": "<source_component_id>" }],
	"ui": {}
}
```

- `id` — unique within the pipeline. Pattern: `<provider>_<n>` (e.g., `chat_1`, `qdrant_1`, `llm_openai_1`)
- `provider` — exact key from the services catalog (`name` field)
- `config` — component-specific configuration (see Config Patterns below)
- `input` — array of lane connections. Source nodes have no `input`
- `ui` — (optional) visual layout for the graphic pipeline designer. See UI Layout below

### Multiple Pipelines

Each `.pipe` file contains a single pipeline (`{ project_id, source, components }`). To build multi-pipeline workflows (e.g., an ingestion pipeline + a query pipeline sharing the same vector DB collection), create separate `.pipe` files and use the same collection name in the vector DB config to share data between them.

---

## Data Lanes

Lanes are typed data channels that connect components. A connection is valid ONLY when the output lane name from the source node matches an input lane name on the target node.

| Lane        | Data Type        | Description                                        |
| ----------- | ---------------- | -------------------------------------------------- |
| `tags`      | Metadata         | File metadata and raw file info from sources       |
| `text`      | Plain text       | Extracted or generated text content                |
| `table`     | Structured data  | Tables from documents or databases                 |
| `documents` | Document objects | Chunked/processed documents with embeddings        |
| `questions` | Question objects | Questions to be answered (trigger LLMs and search) |
| `answers`   | Answer objects   | Answers from LLMs or vector stores                 |
| `image`     | Image data       | Images extracted from documents                    |
| `audio`     | Audio streams    | Audio content                                      |
| `video`     | Video streams    | Video content                                      |

**Source components** use `_source` as the internal lane name in the catalog. You do not reference `_source` in pipeline files; source components automatically produce their output lanes.

### Lane Flow Rules

1. **Type Compatibility**: The output lane from one component must match the input lane of the next
2. **Multiple Inputs**: A component can accept multiple inputs from different components
3. **Multiple Outputs**: One component's output can feed multiple downstream components
4. **Empty output `[]`**: Means the component consumes data with no lane output (storage, response) — these are valid terminal nodes
5. **If lane types don't match, you need a converter node.** For example, `image` can't go directly to `questions` — you need `accessibility_describe` (image -> text), then `question` (text -> questions). Consult the catalog to find nodes that accept your source lane type and produce your target lane type.

---

## Key Concepts

### Source Components

Source components are pipeline entry points (classType `source`). They have no `input` array — they produce data. Read the catalog to find all available sources and what lanes they produce.

**Critical Distinction:**

- Use `chat` for **ALL conversational interfaces** (web, console, API, mobile). Use with `client.chat()` method.
- Use `webhook` for **document/data processing** (file uploads, ETL). Use with `client.send()` or `client.sendFiles()` methods.

### Response Components

Response components (classType `infrastructure`) send processed data back to the requesting client. Each response component handles a **specific lane type** — use the one that matches the output lane of your pipeline (e.g., `response_answers` for answers from an LLM, `response_text` for extracted text).

```json
{
	"id": "response_answers_1",
	"provider": "response_answers",
	"config": { "laneName": "answers" },
	"input": [{ "lane": "answers", "from": "llm_1" }]
}
```

The `laneName` in config determines the key name in the JSON response returned to the client.

**When NOT to use response nodes:** Ingestion pipelines (webhook -> process -> store) do NOT need a response node — the data flows into the vector DB and stops there. The store node is the terminal node. Only add a response node when results need to be returned to the client.

### The Prompt Node (Context Merging)

Use the `prompt` node when you need to merge multiple data sources or add custom instructions before an LLM:

- **Input lanes:** `documents`, `text`, `table` (collected silently), `questions` (triggers the merge)
- **Output lane:** `questions` (enhanced with all collected context + instructions)

```json
{
	"id": "prompt_1",
	"provider": "prompt",
	"config": {
		"instructions": ["Use the provided context to answer the question."]
	},
	"input": [
		{ "lane": "documents", "from": "qdrant_1" },
		{ "lane": "questions", "from": "qdrant_1" }
	]
}
```

This is useful in RAG pipelines where you want control over how retrieved documents are combined with the user's question before sending to an LLM.

### Embeddings — Required Before Any Store

**Vector stores cannot accept data without embedding vectors.** You must always place an embedding component before a store in your pipeline. The embedding component adds vector representations to the data so the store can index and search it.

- **Documents:** Run through an embedding component (e.g., `embedding_transformer`, `embedding_openai`) which takes `documents` in and outputs `documents` with vectors added
- **Questions:** Run through the same embedding component — it takes `questions` in and outputs `questions` with vectors added, enabling similarity search against stored documents
- **Images:** Use `embedding_image` which takes `image` or `documents` containing images and outputs `documents` with image vectors

**Correct — embedding before store:**

```text
webhook → parse → preprocessor → embedding_transformer → qdrant
```

**Wrong — no embedding, store has no vectors to work with:**

```text
webhook → parse → preprocessor → qdrant   ← WILL NOT WORK
```

**For search (questions), the same embedding model must be used:**

```text
chat → embedding_transformer → qdrant → llm → response_answers
```

The embedding model used for ingestion and the one used for search **must be the same** (same model, same vector dimensions), otherwise similarity scores will be meaningless.

### Vector Databases (Stores)

All vector database components (classType `store`) follow a dual-mode pattern visible in their `lanes`:

- **Store mode** (`documents` input → `[]` output): Stores embedded documents, no output — terminal node
- **Search mode** (`questions` input → `[documents, answers, questions]` output): Retrieves similar documents

---

## Control Connections (invoke / control)

Some components require control-plane connections — typically an LLM, tools, or memory. The catalog's `invoke` field describes these requirements with `min`/`max` constraints.

**CRITICAL: The `control` array goes on the CONTROLLED node, NOT on the invoking component.** The LLM/tool/memory node declares which component invokes it via `control`, with `from` pointing to the invoker. The agent (or other invoking component) itself has NO `control` array.

```json
// The AGENT has no control array — only input lanes:
{
  "id": "agent_rocketride_1",
  "provider": "agent_rocketride",
  "config": { "instructions": [], "max_waves": 10 },
  "input": [{"lane": "questions", "from": "chat_1"}]
}

// The LLM declares it is controlled BY the agent:
{
  "id": "llm_openai_1",
  "provider": "llm_openai",
  "config": { "profile": "openai-4o", "openai-4o": {"apikey": "${ROCKETRIDE_OPENAI_KEY}"} },
  "control": [{"classType": "llm", "from": "agent_rocketride_1"}]
}

// The tool declares it is controlled BY the agent:
{
  "id": "tool_http_request_1",
  "provider": "tool_http_request",
  "config": { "type": "tool_http_request" },
  "control": [{"classType": "tool", "from": "agent_rocketride_1"}]
}

// The memory declares it is controlled BY the agent:
{
  "id": "memory_internal_1",
  "provider": "memory_internal",
  "config": { "type": "memory_internal" },
  "control": [{"classType": "memory", "from": "agent_rocketride_1"}]
}
```

A single LLM/tool/memory node can be shared by multiple invokers — just add multiple entries in its `control` array:

```json
{
	"id": "llm_openai_1",
	"control": [
		{ "classType": "llm", "from": "agent_rocketride_1" },
		{ "classType": "llm", "from": "agent_crewai_1" },
		{ "classType": "llm", "from": "chart_chartjs_1" },
		{ "classType": "llm", "from": "db_postgres_1" }
	]
}
```

This applies to agents, but also to non-agent components like `summarization`, `extract_data`, `dictionary`, `db_postgres`, and `chart_chartjs` — any component whose catalog entry has an `invoke` field.

### Multi-Agent Pipelines

An agent can invoke another agent as a tool. The sub-agent declares `control: [{ classType: "tool", from: "parent_agent_id" }]`. The sub-agent's own dependencies (LLM, memory) are controlled by the sub-agent, not the parent.

```text
  chat → Agent_1 → response_answers
           |
    +------+------+
    |      |      |
   LLM  Tool  Memory
          |
       Agent_2    ← control: [{ classType: "tool", from: "agent_1" }]
          |
     +----+----+
     |         |
   LLM_2   Memory_2
```

Agent_2 has no `input` lanes — it is invoked as a tool by Agent_1. LLM_2 and Memory_2 have `control` pointing to Agent_2.

### Tool Components

Tool components (classType `tool`) have empty `lanes` (`{}`). They are not connected via data lanes — they are invoked by agents at runtime. The tool declares which agent controls it via the `control` array with `"classType": "tool"`.

---

## Config Patterns

### Source Nodes

```json
"config": { "hideForm": true, "mode": "Source", "type": "chat" }
```

### LLM Nodes — Profile-Based

The `profile` field selects the model. API keys nest under the profile key. Read the schema file for available profiles.

```json
"config": {
  "profile": "openai-4o",
  "openai-4o": { "apikey": "${ROCKETRIDE_OPENAI_KEY}" }
}
```

### Embedding Nodes — Profile-Based

```json
"config": { "profile": "miniLM" }
```

### Vector DB Nodes — Profile-Based

```json
"config": {
  "profile": "local",
  "local": { "host": "localhost", "port": 6333, "collection": "my_collection" }
}
```

### Response Nodes

The `laneName` identifies the key in the JSON response returned to the client:

```json
"config": { "laneName": "answers" }
```

### Prompt Nodes

The `instructions` array defines the system prompt:

```json
"config": { "instructions": ["You are a helpful assistant. Use the provided context to answer questions."] }
```

### Agent Nodes

Agent config is flat — `instructions` and `max_waves` go directly in `config`:

```json
"config": { "instructions": ["You are a research assistant."], "max_waves": 10 }
```

### Environment Variable Substitution

Any string value in `config` can use `${ROCKETRIDE_<name>}` to inject values from the environment or `.env` file at runtime:

```json
"config": {
  "profile": "openai-4o",
  "openai-4o": { "apikey": "${ROCKETRIDE_OPENAI_KEY}" }
}
```

**When creating a pipeline with environment variables, you MUST also:**

1. **Update `.env`** in the project with all injected variables and their values so the pipeline can run immediately:

   ```env
   ROCKETRIDE_OPENAI_KEY=sk-...
   ROCKETRIDE_QDRANT_HOST=localhost
   ROCKETRIDE_QDRANT_PORT=6333
   ```

2. **Update `env.example`** with the same variable names but placeholder values. This file can be safely committed to the repo so other developers know what to configure:
   ```env
   ROCKETRIDE_OPENAI_KEY=your-openai-api-key-here
   ROCKETRIDE_QDRANT_HOST=localhost
   ROCKETRIDE_QDRANT_PORT=6333
   ```

Only variables prefixed with `ROCKETRIDE_` are substituted. Unknown variables are left unchanged.

---

## UI Layout (Optional)

The `ui` field is optional and is used by the graphic pipeline designer. When building pipelines programmatically, it is recommended to include `ui` with at least a `position` so the visual editor renders the pipeline with a clean layout. The remaining fields (`measured`, `nodeType`, `formDataValid`) are managed by the designer and can be omitted.

```json
"ui": {
  "position": { "x": 0, "y": 0 },
  "measured": { "width": 150, "height": 66 },
  "nodeType": "default",
  "formDataValid": true
}
```

### Layout Rules

- **Horizontal flow:** Position nodes left-to-right with ~220px horizontal spacing
- **Starting position:** Begin at approximately x: 20, y: 200
- **Node heights:** Use height 66 for single-lane nodes, 86 for nodes with invoke handles (agents), 121 for multi-lane nodes (databases)
- **Width:** 150px for all nodes
- **Control-plane nodes below their invoker:** LLM, tool, and memory nodes are positioned below the agent that controls them (~160px vertical offset)
- **Multi-agent tiers:** Sub-agents and their dependencies form vertical tiers below the parent agent

**Example layout for an agent pipeline:**

```text
  Chat (x:20, y:200)  →  Agent (x:240, y:200)  →  Response (x:460, y:200)
                              |
                   +----------+-----------+
                   |          |           |
                LLM (x:130  Tool (x:350  Memory (x:570
                    y:360)      y:360)       y:360)
```

---

## Component Selection Guide

### Choose a Source Component

| Need             | Use       | Client Method                         |
| ---------------- | --------- | ------------------------------------- |
| Chat/Q&A system  | `chat`    | `client.chat()`                       |
| Document uploads | `webhook` | `client.send()`, `client.sendFiles()` |
| Drag & drop      | `dropper` | `client.sendFiles()`                  |

### Choose an LLM

| Priority      | Suggested Providers                     |
| ------------- | --------------------------------------- |
| Best quality  | `llm_openai`, `llm_anthropic`           |
| Speed         | `llm_openai`, `llm_gemini`, `llm_qwen`  |
| Cost          | `llm_mistral`, `llm_gemini`, `llm_qwen` |
| Local/Private | `llm_ollama`                            |
| Long context  | `llm_anthropic`                         |

### Choose a Vector Database

| Priority          | Suggested Providers         |
| ----------------- | --------------------------- |
| Easy setup        | `chroma`                    |
| Production        | `qdrant`, `pinecone`        |
| Existing Postgres | `postgres`                  |
| Hybrid search     | `weaviate`, `elasticsearch` |
| Large scale       | `milvus`                    |

---

## Transformation Chains

### Data Lane Chains

**Video to searchable text:**

```text
video → frame_grabber → image → accessibility_describe → text
```

**Audio to searchable text:**

```text
audio → audio_transcribe → text
```

**Text to LLM answer:**

```text
text → question → questions → llm → answers
```

**Document to vector storage (RAG ingest):**

```text
tags → parse → text → preprocessor_langchain → documents → embedding_transformer → documents → qdrant (stored)
```

**Question to RAG answer (simple):**

```text
questions → embedding_openai → questions → qdrant → questions → llm_openai → answers
```

**Question to RAG answer (with prompt node for context merging):**

```text
questions → embedding_openai → questions → qdrant → documents + questions → prompt → questions → llm_openai → answers
```

**Image OCR to searchable documents:**

```text
tags → parse → image → ocr → text → preprocessor_langchain → documents → embedding_transformer → documents → qdrant (stored)
```

**Text extraction with anonymization:**

```text
tags → parse → text → anonymize_text → text → response_text
```

**Document summarization (requires LLM via invoke):**

```text
tags → parse → text → summarization [control: llm] → text → response_text
```

**Structured data extraction (requires LLM via invoke):**

```text
tags → parse → text → extract_data [control: llm] → answers → response_answers
```

### Agent + Control-Plane Chains

**Simple agent with tools:**

```text
questions → agent_rocketride → answers
    [controlled by agent: llm_openai, memory_internal, tool_http_request, tool_python]
```

**Agent with database tools:**

```text
questions → agent_rocketride → answers
    [controlled by agent: llm_openai, memory_internal, db_postgres, db_mysql, chart_chartjs]
```

**Multi-agent comparison (fan-out from single chat):**

```text
chat → agent_rocketride → response_answers (laneName: "Wave")
chat → agent_crewai → response_answers (laneName: "CrewAI")
chat → agent_langchain → response_answers (laneName: "LangChain")
    [all three agents share the same llm_openai and tool nodes via control]
```

**Hierarchical agents (agent as tool):**

```text
questions → agent_rocketride_1 → answers
    [controlled by agent_1: llm_openai_1, memory_1, agent_rocketride_2 (as tool)]
        [controlled by agent_2: llm_openai_2, memory_2, tool_http_request]
```

**Video ingestion + chat query (two pipelines, shared collection):**

Pipeline 1 — Ingestion (no response node):

```text
dropper → video → frame_grabber → [images] → accessibility_describe → [text] → preprocessor_langchain → [documents] → embedding_openai → [documents] → qdrant (collection: "scenes")
```

Pipeline 2 — Query:

```text
chat → [questions] → embedding_openai → [questions] → qdrant (collection: "scenes") → [prompt] → llm_openai → [answers] → response_answers
```

---

## Discovering Components

**List all available components:**

```text
Read .rocketride/services-catalog.json
```

**Get detailed config for a specific component:**

```text
Read .rocketride/schema/{component_name}.json
```

**Find components by category:**
Filter `services-catalog.json` entries where `classType` includes the desired category.

**Find what lanes a component supports:**
Check the `lanes` field in the catalog entry. Keys are input lanes, values are output lane arrays.

**Find what control-plane connections a component needs:**
Check the `invoke` field in the catalog entry. Each key is a `classType` with `min`/`max` constraints.

---

**Remember:** The `.rocketride/services-catalog.json` file is the authoritative source. Always consult it for the current list of components available on your connected server.
