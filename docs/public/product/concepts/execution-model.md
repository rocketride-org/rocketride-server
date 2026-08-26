---
title: Execution Model
sidebar_position: 5
---

# Execution model

A [pipeline](/concepts/pipelines) describes _what_ to run; the execution model
is _how_ the [engine](/concepts/runtime-engine) runs it. Two mechanisms move
work through the graph: **data lanes** carry data between nodes, and **control
connections** let agents invoke their helpers.

## Data lanes

A **lane** is a typed channel between two nodes. A node declares the lanes it
consumes in its `input` array; the engine routes each output lane to the inputs
that ask for it.

```json
"input": [{ "lane": "questions", "from": "qdrant_1" }]
```

This reads: _take the `questions` lane produced by `qdrant_1` as my input._

### Lane types

Lanes are typed, and the type must match across a connection. This is the
canonical lane table; it is not exhaustive — individual nodes can define
additional lanes (see each node's entry in [Nodes](/nodes)):

| Lane        | Carries                          | Accepted by                                              |
| ----------- | -------------------------------- | -------------------------------------------------------- |
| `questions` | Queries flowing toward a model   | LLMs, vector stores (for retrieval), agents              |
| `answers`   | Model responses flowing back     | `response` target, nodes expecting generated text        |
| `documents` | Vector-ready chunks              | Vector store `documents` input                           |
| `text`      | Plain text content               | Preprocessors, embedding nodes, LLMs                     |
| `tags`      | Structured metadata / parameters | Parsers, embedding nodes                                 |
| `image`     | Image content                    | Vision nodes                                             |
| `audio`     | Audio streams                    | Audio nodes                                              |
| `video`     | Video streams                    | Video nodes                                              |

### Lane flow rules

- **Type compatibility**: the output lane of one node must match the input lane
  of the next. A `text` output feeds a `text` input; mismatched lanes are a
  pipeline error.
- **Transformation**: many nodes change the lane type. An embedding node turns
  `text` into `documents` (vector-ready chunks) for a store; an LLM turns
  `questions` into `answers`.
- **Fan-in**: a node can consume the same lane from several upstream nodes by
  listing multiple entries in `input`. A `response` node, for example, can merge
  `answers` from several agents.

```json
"input": [
  { "lane": "answers", "from": "agent_rocketride_1" },
  { "lane": "answers", "from": "agent_crewai_1" }
]
```

## Control connections

Data lanes are not the only wiring. Agents (and other nodes with an `invoke`
field) reach their LLM, tools, and memory through **control connections**
instead of lanes, see [Agents & tools](/concepts/agents-tools-skills). Control
connections form a side channel: the engine resolves them at startup so an
agent can call a tool mid-run without that tool ever sitting on a data lane.

## How a run flows

The engine streams; it does not run the graph stage by stage. Once a pipeline
starts:

1. Data enters at a **source** (a `webhook`, a `chat` stream, a file).
2. Each node processes data as it arrives and emits onto its output lanes.
   Independent branches run **concurrently** across threads.
3. Agents loop, calling their LLM and tools over one or more **waves** of
   reasoning, until they produce a result. For `agent_rocketride`, `max_waves`
   caps how many reasoning cycles it may take.
4. Results stream out through a **target** (typically a `response` node) back to
   the client as they are produced.

Because data streams rather than buffering, results can begin returning before
the whole input is consumed, which is what makes conversational `chat()` flows
feel live.

## How the engine parallelises

The engine is written in C++ and runs each pipeline run on its own thread pool.
Concurrent requests to the same pipeline do not queue behind each other —
the engine spawns an independent execution context for each incoming task. A
slow request (a large document going through OCR, embedding, and an LLM call)
does not block a fast one (a short question answered directly by the LLM).

### Streaming execution

Nodes process data **as it arrives**, not after the full upstream output is
available. When a preprocessor splits a 100-page document into 200 chunks, the
embedding node starts embedding chunk 1 while the preprocessor is still
producing chunk 2. The vector store starts upserting while the embedder is
computing later chunks. This keeps memory usage low and reduces end-to-end
latency, especially for large documents.

### Vector store batching

Vector stores (Qdrant, Pinecone, Milvus, Weaviate, etc.) accumulate chunks and
flush them in batches rather than upserting one at a time. A batch flushes when
it reaches either a chunk-count limit or a payload-size limit, whichever comes
first. The exact thresholds are backend-specific: for example, Qdrant flushes at
500 points or its payload limit, while Pinecone and Milvus use different
chunk-count defaults.

For small documents that produce few chunks, the flush happens at pipeline
completion. For large document sets, flushing starts mid-run and reduces peak
memory. Tuning batch size is covered in [Performance](/guides/performance).

## Next steps

- [Agents & tools](/concepts/agents-tools-skills): control connections in
  depth.
- [Nodes](/concepts/nodes): what sits on each lane.
- [WebSocket protocol](/connect/websocket): how clients feed and read a run.
- [Observability](/connect/websocket/observability): watch a run stream, with lifecycle, status, metrics, and flow traces.
- [Pipeline JSON reference](/reference/pipeline-reference): the `input`, `lane`, and
  `control` fields.
