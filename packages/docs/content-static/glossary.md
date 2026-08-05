---
title: Glossary
---

# Glossary

Terms used across the RocketRide docs.

### Pipeline

A directed graph of [components](#component--node) that moves and transforms
data, authored as a [`.pipe`](#pipe-file) file. The unit of work in RocketRide.
See [Pipelines](/concepts/pipelines).

### Component / node

One vertex of the pipeline graph: a single unit that does one job (call a model,
embed text, query a store, run a tool). Has a unique `id`, a
[provider](#provider), and `config`. See
[Nodes](/concepts/nodes).

### Provider

What a component _is_: the value that determines its behaviour (e.g.
`llm_openai`, `qdrant`, `webhook`). Swapping providers is a config change, not a
code change.

### Connector

A [node](#component--node) at the edge of the graph that reads from or writes to
an external system: a **source** (brings data in) or a **target** (sends results
out).

### Class type

The category a provider belongs to (`llm`, `tool`, `agent`, `memory`, `store`,
`source`, `target`, …), which governs how the node is wired.

### Data lane

A typed channel carrying data between nodes (`questions`, `answers`, `text`,
`image`, …). A node's `input` declares which lanes it consumes and from where.
See the [Execution model](/concepts/execution-model).

### Control (invoke) connection

A side-channel connection by which an [agent](#agent) invokes a helper (LLM,
tool, memory) instead of streaming data through a lane. Declared as `control` on
the helper, pointing back at the invoker.

### Agent

A node that reasons in a loop, choosing which model to call and which tools to
use, over one or more **waves** until it produces a result. See
[Agents & tools](/concepts/agents-tools-skills).

### Tool

A capability an agent can invoke at runtime (HTTP request, web search, shell,
another pipeline). Tools have no data lanes; they are wired by `control`.

### Memory

State an agent carries across turns (`memory_internal`, `memory_persistent`).
Only `agent_rocketride` has a memory port.

### Engine

The multithreaded C++ runtime that loads a [`.pipe`](#pipe-file), instantiates
its nodes, and streams data through the graph. Runs locally, [self-hosted](/self-hosting),
or on [Cloud](/cloud). See [Runtime & engine](/concepts/runtime-engine).

### `.pipe` file

The JSON file that defines a pipeline, conforming to the
[Pipeline JSON Reference](/pipeline-reference). The same file runs unchanged in
every environment.

### Task

A single running instance of a pipeline on the engine, identified by a token and
controlled over the [WebSocket protocol](/protocols/websocket).

### MCP

The Model Context Protocol: exposes running pipelines as tools for AI
assistants. See [MCP](/protocols/mcp).

### WebSocket protocol

The engine's native protocol (port 5565) that SDKs and the MCP server use to
start pipelines and stream results. See [WebSocket](/protocols/websocket).
