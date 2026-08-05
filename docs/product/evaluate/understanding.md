---
title: Understanding RocketRide
sidebar_label: Understanding RocketRide
---

# Understanding RocketRide

RocketRide has a small number of moving parts. Once you know how they fit together, the rest
of the docs map cleanly onto them.

## The pipeline

A **pipeline** is a graph of nodes defined in a `.pipe` file (JSON). Data flows between nodes
along typed **data lanes**: a node declares which input lanes it consumes and which output
lanes it produces, and the engine routes data accordingly. See
[Pipelines](/concepts/pipelines) and the [Execution model](/concepts/execution-model).

## Nodes

**[Nodes](/nodes)** are the building blocks: LLM providers, vector stores, embedding models,
preprocessors, OCR/NER, web tools, agents, and sources like Chat. Each node ships a schema
(its config, inputs, and outputs) and runs inside the engine. Connectors are the nodes that
read from and write to external systems. See
[Nodes](/concepts/nodes) and
[Agents & tools](/concepts/agents-tools-skills).

## The runtime engine

Pipelines execute on a multithreaded **C++ engine** (the runtime). It loads the `.pipe`
definition, instantiates the nodes, and streams data through the graph. The same engine runs
locally, on-premises, and on RocketRide Cloud. See [Runtime & engine](/concepts/runtime-engine).

## Talking to the engine

You start and feed pipelines through one of two protocols:

- **[WebSocket](/protocols/websocket)**: the native engine protocol (port 5565). The
  [TypeScript](/develop/typescript) and [Python](/develop/python) SDKs speak it for you:
  `use()` to start a pipeline, `send()`/`pipe()` to stream data, `chat()` for conversational
  flows, `terminate()` to stop.
- **[MCP](/protocols/mcp)**: expose a pipeline as a tool for AI assistants like Claude and
  Cursor.

## How you build

- **Visually**: the VS Code [extension](/ide-extensions/overview) opens `.pipe` files on a
  canvas; wire nodes by connecting lanes and press Run.
- **In code**: author or run the same pipeline from your application with the SDKs.

## Putting it together

A typical flow: author a `.pipe` visually → run it locally to iterate → integrate it into
your app via an SDK → deploy the engine on-prem or to [Cloud](/cloud). The pipeline JSON never
changes across those steps.

See the [Use cases](/evaluate/use-cases) walkthroughs to do this end to end.
