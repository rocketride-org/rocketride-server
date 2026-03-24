---
name: rocketride-pipelines
description: Build and edit RocketRide data processing pipelines (.pipe files). Use when the user asks to create, modify, or debug a pipeline — including chatbots, RAG systems, video/audio processing, multi-agent workflows, or any data flow.
license: MIT
compatibility: Requires RocketRide engine running locally or connected via on-prem/cloud mode
metadata:
  author: rocketride-ai
  version: '2.0'
---

# RocketRide Pipeline Builder

Pipelines are directed acyclic graphs (DAGs) of components connected by typed data lanes, saved as `.pipe` JSON files.

## Step 1: Decompose the Request

Before writing any JSON, break the user's request into a data flow:

1. **What comes in?** → Determines the source node (`chat`, `webhook`, `dropper`)
2. **What transformations are needed?** → Each transformation is a node. Think about what data type goes in and what comes out.
3. **What does the user want back?** → Determines the response node type.

Example: "ingest a video and let me search for scenes"

- IN: video file → `dropper` (source, outputs `video`)
- Extract frames → `frame_grabber` (video → image)
- Describe frames → `accessibility_describe` (image → text)
- Convert to query format → `question` (text → questions)
- Embed for search → `embedding_openai` (documents → documents with vectors)
- Store vectors → `qdrant` (documents → stored)
- Query interface → `chat` (source, outputs questions)
- Search vectors → `qdrant` (questions → documents)
- Build context → `prompt` (documents + questions → enhanced questions)
- Generate answer → `llm_openai` (questions → answers)
- Return result → `response_answers` (answers → client)

Note: this is actually TWO pipelines — one for ingestion, one for querying. Complex workflows often split into separate pipelines sharing a vector DB collection.

## Step 2: Chain by Lane Types

Lanes are the type system. A connection is valid ONLY when the output lane name from the source node matches an input lane name on the target node.

**Core lane types:**

- `text` — plain text
- `questions` — query objects (trigger LLMs and search)
- `answers` — LLM responses
- `documents` — structured docs with metadata and optional embeddings
- `table` — tabular data
- `image` — image frames
- `audio` — audio streams
- `video` — video streams
- `tags` — metadata from sources

**Common transformation chains:**

- Video pipeline: `video` → frame_grabber → `image` → accessibility_describe → `text`
- Audio pipeline: `audio` → audio_transcribe → `text`
- Text to LLM: `text` → question → `questions` → llm → `answers`
- RAG ingest: `text` → embedding → `documents` → vector_db
- RAG query: `questions` → vector_db → `documents` → prompt(+questions) → `questions` → llm → `answers`

**If lane types don't match, you need a converter node.** For example, `image` can't go directly to `questions` — you need accessibility_describe (image→text), then question (text→questions).

## Step 3: Look Up Available Nodes

Read `references/services.md` (adjacent to this file) for the live catalog of every node with its lanes, profiles, and config fields. That file is generated from the running engine and always current.

## Pipeline JSON Format

```json
{
	"name": "Pipeline Name",
	"description": "What it does",
	"version": 1,
	"project_id": "<generate-a-uuid>",
	"viewport": { "x": 0, "y": 0, "zoom": 1 },
	"components": []
}
```

## Component JSON Format

```json
{
	"id": "<provider>_<n>",
	"provider": "<provider_key>",
	"config": {},
	"ui": {
		"position": { "x": 0, "y": 0 },
		"measured": { "width": 160, "height": 65 },
		"data": {
			"provider": "<provider_key>",
			"class": "<source|data|llm|infrastructure|store|embedding|agent>",
			"type": "default"
		}
	},
	"input": [{ "lane": "<lane_name>", "from": "<source_component_id>" }]
}
```

**Rules:**

- `id`: Unique. Pattern: `<provider>_<n>` (e.g., `chat_1`, `qdrant_1`, `llm_anthropic_1`)
- `provider`: Exact key from the services catalog
- `input`: Array of lane connections. Source nodes have no `input` (they are entry points).
- `ui.data.class`: Use the `classType` from the services catalog for that node
- `ui.position`: Layout left-to-right, ~220px horizontal spacing, start at x:20 y:200. For nodes with multiple lanes, use height 135 instead of 65.

## Config Patterns

**Source nodes** (chat, webhook, dropper):

```json
"config": { "hideForm": true, "mode": "Source", "type": "chat", "parameters": {} }
```

**LLM nodes** — profile selects the model:

```json
"config": { "type": "llm_anthropic", "parameters": { "llm_anthropic": { "profile": "claude-sonnet-4-6" } } }
```

**Embedding nodes** — profile selects the model:

```json
"config": { "type": "embedding_openai", "parameters": { "embedding_openai": { "profile": "text-embedding-3-small" } } }
```

**Vector DB nodes** — profile selects local vs cloud, set collection name:

```json
"config": { "type": "qdrant", "parameters": { "qdrant": { "profile": "local", "local": { "host": "localhost", "port": 6333, "collection": "my_collection" } } } }
```

**Response nodes** — laneName identifies the key in the JSON response:

```json
"config": { "laneName": "answers" }
```

**Prompt nodes** — instructions array defines the system prompt:

```json
"config": { "instructions": ["You are a helpful assistant. Use the provided context to answer questions."], "parameters": {} }
```

**Frame grabber** — profile selects extraction mode:

```json
"config": { "type": "frame_grabber", "parameters": { "frame_grabber": { "profile": "transition", "transition": { "percent": 0.4 } } } }
```

**General pattern**: `config.type` = provider key. `config.parameters.<provider>.profile` = profile key from the node's preconfig. Profile-specific fields nest under `config.parameters.<provider>.<profile_key>`.

## Agent Pipelines (Control Connections)

Agent nodes use TWO connection types:

1. **Data lanes** (`input`) — receive questions, output answers. These flow **left-to-right**.
2. **Control connections** (`control`) — link LLMs, tools, and memory to agents. These flow **top-to-bottom**.

**CRITICAL: Control connections live on the CONTROLLED node, NOT on the agent.** The `control` array goes on the LLM/tool/memory node, with `from` pointing to the agent that invokes it. The agent node itself has NO `control` array.

```json
// The LLM node declares it is controlled by the agent:
{ "id": "llm_openai_1", "control": [{ "classType": "llm", "from": "agent_rocketride_1" }] }

// The tool node declares it is controlled by the agent:
{ "id": "tool_http_request_1", "control": [{ "classType": "tool", "from": "agent_rocketride_1" }] }

// The memory node declares it is controlled by the agent:
{ "id": "memory_internal_1", "control": [{ "classType": "memory", "from": "agent_rocketride_1" }] }

// The agent has NO control array — only input lanes:
{ "id": "agent_rocketride_1", "input": [{ "lane": "questions", "from": "chat_1" }] }
```

**Agent invoke requirements:**

- `llm`: Required (exactly 1). Control node with `classType: "llm"`.
- `tool`: Optional (0+). Control node with `classType: "tool"`. Tools, other agents, MCP clients, etc.
- `memory`: Required (exactly 1). Control node with `classType: "memory"`. Use `memory_internal`.

**Agent config is flat** — `instructions` and `max_waves` go directly in `config`, not nested under `parameters`:

```json
{
	"id": "agent_rocketride_1",
	"provider": "agent_rocketride",
	"config": {
		"instructions": ["You are a research assistant. Use the HTTP request tool to gather data. Store findings in memory."],
		"max_waves": 10,
		"parameters": {}
	},
	"input": [{ "lane": "questions", "from": "chat_1" }]
}
```

**Layout rule for agents:** Controlled nodes (LLM, tools, memory) are positioned **below** the agent. The agent's invoke handles are on its **bottom edge**, the controlled node's invoke handle is on its **top edge**.

```text
  Chat (y:200) --questions--> Agent (y:180) --answers--> Response (y:160)
                                  |
                     +------------+-------------------+
                     |            |                   |
                  LLM (y:340)  Tool (y:360)    Memory (y:360)
```

**Multi-agent pipelines:** An agent can invoke another agent as a tool. The sub-agent has `control: [{ classType: "tool", from: "parent_agent_id" }]`. The sub-agent's own dependencies (LLM, memory) are positioned below it, forming tiers.

```text
  Chat (y:200) ---> Agent_1 (y:180) --answers--> Response (y:160)
                        |
           +------------+------------+
           |            |            |
        LLM_1 (y:340) Tool (y:360) Memory_1 (y:360)
                        |
                   Agent_2 (y:480)  ← control: [{ classType: "tool", from: "agent_1" }]
                        |
              +---------+---------+
              |                   |
           LLM_2 (y:660)    Memory_2 (y:660)
```

Agent_2's control: `[{ classType: "tool", from: "agent_rocketride_1" }]`
LLM_2's control: `[{ classType: "llm", from: "agent_2_id" }]`
Memory_2's control: `[{ classType: "memory", from: "agent_2_id" }]`
Agent_2 has no input lanes — it is invoked as a tool by Agent_1.

## RAG Pattern (Retrieval-Augmented Generation)

For simple RAG query pipelines, the vector DB can enrich queries directly:

```text
chat → embedding (questions) → vector_db (questions → questions with context) → llm → response
```

For more control over context merging (e.g., combining retrieved documents with custom instructions), use a prompt node between the vector DB and LLM — see the Prompt Node section below.

## The Prompt Node (Context Merging)

Use the `prompt` node when you need to merge multiple data types or add custom instructions before an LLM:

- Accepts: `documents`, `text`, `table` (collected silently)
- Triggered by: `questions` (fires the merge)
- Outputs: enhanced `questions` with all collected context + instructions
- Config: `instructions` array (strings) directly in config

```json
{
	"id": "prompt_1",
	"provider": "prompt",
	"config": {
		"instructions": ["Use the provided context to answer the question."],
		"parameters": {}
	}
}
```

## When to Use (and Not Use) Response Nodes

- **Query pipelines** (chat → LLM → user) need a response node to return results to the client
- **Ingestion pipelines** (webhook → process → store) do NOT need a response node — the data flows into the vector DB or storage and stops there. The store node is the terminal node.

If the pipeline's purpose is to store/index data for later retrieval, don't add a response node.

## Constraints

- **No cycles** — pipelines are DAGs
- **Lane types must match** — output lane name = input lane name
- **At least one source node** — every pipeline needs an entry point
- **Unique component IDs** — no duplicates within a pipeline
- **Source nodes have no `input`** — they are entry points
- **Agent control connections are separate from data lanes** — use `control`, not `input`
- **Terminal nodes** — nodes with empty output lanes (like vector DBs receiving `documents`) are valid endpoints. Not every pipeline needs a response node.

## Available Nodes

Read `references/services.md` for the complete, live catalog. It lists every node's provider key, category, lane mappings, available profiles, and config fields.
