---
name: rocketride-pipelines
description: Build and run RocketRide data processing pipelines programmatically using the Python SDK. Use when the user asks to create, run, or debug pipelines in Python code.
license: MIT
compatibility: Requires rocketride Python package (pip install rocketride) and a running RocketRide engine
metadata:
  author: rocketride-ai
  version: '2.0'
---

# RocketRide Programmatic Pipeline Builder

Build and run RocketRide data processing pipelines in Python using the SDK. Pipelines are Python dicts passed to `client.use()` — no `.pipe` files or visual editor needed.

## Quick Start

```python
import asyncio
from rocketride import RocketRideClient
from rocketride.schema import Question

async def main():
    async with RocketRideClient(uri='http://localhost:5565', auth='your-api-key') as client:
        # Define a pipeline as a dict
        pipeline = {
            'project_id': 'my-chat-bot',
            'source': 'chat_1',
            'components': [
                {'id': 'chat_1', 'provider': 'chat', 'config': {}},
                {
                    'id': 'llm_openai_1',
                    'provider': 'llm_openai',
                    'config': {'profile': 'openai-5-2', 'openai-5-2': {'apikey': 'sk-...'}},
                    'input': [{'lane': 'questions', 'from': 'chat_1'}],
                },
                {
                    'id': 'response_answers_1',
                    'provider': 'response_answers',
                    'config': {'laneName': 'answers'},
                    'input': [{'lane': 'answers', 'from': 'llm_openai_1'}],
                },
            ],
        }

        # Start the pipeline
        result = await client.use(pipeline=pipeline, ttl=3600)
        token = result['token']

        # Chat with it
        question = Question()
        question.addQuestion('What is the capital of France?')
        response = await client.chat(token=token, question=question)
        print(response.get('answers', []))

        # Clean up
        await client.terminate(token)

asyncio.run(main())
```

## Step 1: Decompose the Request

Before writing code, break the user's request into a data flow:

1. **What comes in?** → Source node (`chat`, `webhook`, `dropper`)
2. **What transformations?** → Processing nodes chained by lane types
3. **What comes out?** → Response node (for query pipelines) or storage node (for ingestion)

## Step 2: Build the Pipeline Dict

### Pipeline Structure

```python
pipeline = {
    'project_id': 'unique-id',       # Required: unique identifier
    'source': 'chat_1',              # Required: entry point component ID
    'components': [...]              # Required: array of components
}
```

### Component Structure

```python
{
    'id': '<provider>_<n>',           # Unique ID (e.g., 'chat_1', 'llm_openai_1')
    'provider': '<provider_key>',     # Node type from the engine
    'config': {},                     # Provider-specific configuration
    'input': [                        # Data lane connections (omit for source nodes)
        {'lane': '<lane_name>', 'from': '<source_component_id>'}
    ],
    'control': [                      # Control connections (only on controlled nodes)
        {'classType': '<llm|tool|memory>', 'from': '<agent_id>'}
    ],
}
```

**No `ui` block needed** — that's only for the visual editor.

## Lane System

Lanes are typed data channels. Connections are valid ONLY when output lane names match input lane names.

**Lane types:**

- `text` — plain text
- `questions` — query objects (used by LLMs and search)
- `answers` — LLM responses
- `documents` — structured docs with metadata/embeddings
- `table` — tabular data
- `image`, `audio`, `video` — media
- `tags` — metadata from sources

**Common chains:**

- Chat to LLM: `chat` →(questions)→ `llm` →(answers)→ `response_answers`
- Audio pipeline: `webhook` →(audio)→ `audio_transcribe` →(text)→ processing
- Video pipeline: `dropper` →(video)→ `frame_grabber` →(image)→ `accessibility_describe` →(text)→ processing
- RAG ingest: `webhook` →(tags)→ `parse` →(text)→ `preprocessor_langchain` →(documents)→ `embedding` →(documents)→ `qdrant`
- RAG query: `chat` →(questions)→ `embedding` →(questions)→ `qdrant` →(questions)→ `llm` →(answers)→ `response_answers`

## Config Patterns

**Source nodes** (chat, webhook, dropper):

```python
'config': {}  # Minimal — engine handles defaults
```

**LLM nodes** — profile selects model, API key at profile level:

```python
'config': {
    'profile': 'openai-5-2',
    'openai-5-2': {'apikey': 'sk-...'},
}
```

**Response nodes** — laneName identifies the output key:

```python
'config': {'laneName': 'answers'}
```

**Vector DB nodes** — profile selects mode, config at profile level:

```python
'config': {
    'profile': 'local',
    'local': {'host': 'localhost', 'port': 6333, 'collection': 'my_docs'},
}
```

**Embedding nodes:**

```python
'config': {
    'profile': 'text-embedding-3-small',
    'text-embedding-3-small': {'apikey': 'sk-...'},
}
```

## Agent Pipelines (Control Connections)

Agent nodes use TWO connection types:

1. **Data lanes** (`input`) — receive questions, output answers
2. **Control connections** (`control`) — link LLMs, tools, and memory

**CRITICAL: `control` goes on the CONTROLLED node, NOT the agent.** The `from` field points to the agent.

```python
# Agent — has input lanes only, NO control array
{
    'id': 'agent_rocketride_1',
    'provider': 'agent_rocketride',
    'config': {
        'instructions': ['You are a helpful assistant.'],
        'max_waves': 10,
    },
    'input': [{'lane': 'questions', 'from': 'chat_1'}],
}

# LLM — controlled BY the agent
{
    'id': 'llm_openai_1',
    'provider': 'llm_openai',
    'config': {'profile': 'openai-5-2', 'openai-5-2': {'apikey': 'sk-...'}},
    'control': [{'classType': 'llm', 'from': 'agent_rocketride_1'}],
}

# Memory — controlled BY the agent
{
    'id': 'memory_internal_1',
    'provider': 'memory_internal',
    'config': {'type': 'memory_internal'},
    'control': [{'classType': 'memory', 'from': 'agent_rocketride_1'}],
}

# Tool — controlled BY the agent
{
    'id': 'tool_http_request_1',
    'provider': 'tool_http_request',
    'config': {'type': 'tool_http_request'},
    'control': [{'classType': 'tool', 'from': 'agent_rocketride_1'}],
}
```

**Agent requirements:**

- `llm`: Exactly 1 (required)
- `memory`: Exactly 1 (required, use `memory_internal`)
- `tool`: 0 or more (optional — other agents, HTTP tools, MCP clients, etc.)

**Multi-agent:** An agent can invoke another agent as a tool. The sub-agent has `control: [{'classType': 'tool', 'from': 'parent_agent_id'}]` and its own LLM + memory.

## SDK API Reference

### Client Lifecycle

```python
from rocketride import RocketRideClient

# Option 1: Context manager (recommended)
async with RocketRideClient(uri='http://localhost:5565', auth='key') as client:
    # Connected here, auto-disconnects on exit
    ...

# Option 2: Manual
client = RocketRideClient(uri='http://localhost:5565', auth='key')
await client.connect()
# ... operations ...
await client.disconnect()
```

### Start a Pipeline

```python
result = await client.use(
    pipeline=pipeline_dict,   # The pipeline configuration
    ttl=3600,                 # Time-to-live in seconds
    use_existing=True,        # Reuse if same project_id exists
)
token = result['token']       # Use this token for all subsequent calls
```

### Chat with a Pipeline

```python
from rocketride.schema import Question

question = Question()                    # Plain text response
question = Question(expectJson=True)     # JSON response

question.addQuestion('Your question here')

response = await client.chat(token=token, question=question)
answers = response.get('answers', [])
```

### Send Data to a Pipeline

```python
# Send a file/bytes
result = await client.send(token, data=file_bytes, mimetype='application/pdf')

# Stream data
async with await client.pipe(token, mime_type='text/csv') as pipe:
    await pipe.write(chunk1)
    await pipe.write(chunk2)
    result = await pipe.close()
```

### Stop a Pipeline

```python
await client.terminate(token)
```

## Ingestion vs Query Pipelines

**Ingestion** (store data, no response node):

```python
pipeline = {
    'project_id': 'doc-ingest',
    'source': 'webhook_1',
    'components': [
        {'id': 'webhook_1', 'provider': 'webhook', 'config': {}},
        # ... processing chain ...
        {'id': 'qdrant_1', 'provider': 'qdrant', 'config': {...},
         'input': [{'lane': 'documents', 'from': 'embedding_openai_1'}]},
    ],
}
# No response node — qdrant is the terminal
```

**Query** (return results to the client):

```python
# Must have a response node at the end
{'id': 'response_answers_1', 'provider': 'response_answers',
 'config': {'laneName': 'answers'},
 'input': [{'lane': 'answers', 'from': 'llm_openai_1'}]},
```

## Constraints

- Pipelines must be DAGs — no cycles
- Lane types must match between connected components
- At least one source node required
- `source` field in the pipeline dict must reference a source component ID
- Component IDs must be unique
- Agent control connections go on the controlled node, not the agent

## Discovering Available Nodes

If a running engine is available, query it for the current node catalog:

```python
services = await client.get_services()
```

Check `examples/` adjacent to this file for complete working pipeline scripts.
