---
title: Runtime & Engine
sidebar_position: 2
---

# Runtime & engine

Pipelines don't run themselves. The **engine** is the runtime that loads a
[`.pipe` definition](/concepts/pipelines), brings its nodes to life, and moves
data through the graph until the work is done.

## A multithreaded C++ core

The engine is a native, multithreaded **C++ runtime**, not a thin wrapper
around HTTP calls. It is built for throughput and reliability: nodes that have
no dependency on one another run concurrently, and data streams between them
rather than buffering the whole pipeline in memory. The same binary powers a
quick local iteration loop and a production workload.

## What the engine does

When a pipeline starts, the engine:

1. **Parses** the `.pipe` JSON and validates it against the pipeline schema.
2. **Instantiates** each component from its `provider`, applying the component's
   `config` (API keys, model profiles, collection names, and so on).
3. **Wires** the graph: connecting output [data lanes](/concepts/execution-model)
   to the input lanes that consume them, and resolving control (`invoke`)
   connections between agents and the LLMs, tools, and memory they drive.
4. **Streams** data through the graph, scheduling work across threads and
   emitting results as they are produced.
5. **Tears down** the run when the inputs are exhausted or the client calls
   `terminate()`.

For the full picture of how data and control flow at step 4, see the
[Execution model](/concepts/execution-model).

## One engine, anywhere

The pipeline JSON never changes across environments — only where the engine
lives does: locally behind the [VS Code extension](/clients/vscode) while you
build, self-hosted in your own network, or managed on RocketRide Cloud. See
[Choose How to Run RocketRide](/operate) for the comparison.

## Talking to the engine

You never call the engine's internals directly. Clients connect over one of two
protocols and the engine handles the rest:

- **[WebSocket](/connect/websocket)**: the native engine protocol. The
  [TypeScript](/clients/typescript) and [Python](/clients/python) SDKs speak it
  for you.
- **[MCP](/connect/mcp/stdio)**: exposes running pipelines as tools for AI
  assistants.

As pipelines run, the engine reports call trees, token usage, and memory so you
can observe what happened. See [Troubleshooting](/support/troubleshooting) for reading
that signal.

## Next steps

- [Execution model](/concepts/execution-model): how the engine schedules and
  streams a run.
- [Nodes](/concepts/nodes): the components the engine
  instantiates.
- [Self-hosting](/operate/self-hosting): run the engine in your own infrastructure.
