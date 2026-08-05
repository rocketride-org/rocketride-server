---
title: Nodes
sidebar_position: 3
---

# Nodes

A [pipeline](/concepts/pipelines) is a graph, and **nodes** are its vertices.
Every node is one component that does one job: call a model, embed text, query a
vector store, parse a document, run a tool. You assemble nodes into a pipeline;
the [engine](/concepts/runtime-engine) runs them.

## Anatomy of a node

Each node in a `.pipe` file is an object with a stable identity and a behaviour:

- **`id`**: a unique name for this node within the pipeline (e.g. `llm_1`).
- **`provider`**: what the node _is_ (e.g. `llm_openai`, `qdrant`, `webhook`).
  The provider determines the node's behaviour and which lanes it supports.
- **`config`**: provider-specific settings: API keys, model profiles,
  collection names, instructions. Swapping a provider or model is a config edit,
  not a code change.
- **`input`**: the data lanes this node consumes and the nodes they come from.

```json
{ "id": "llm_1", "provider": "llm_openai", "config": { "profile": "openai-5-2" }, "input": [{ "lane": "questions", "from": "qdrant_1" }] }
```

## Class types

Every provider belongs to a **class type** that describes the kind of work it
does. The class type also governs how the node is wired: data nodes connect
through lanes, while `agent`, `tool`, `llm`, and `memory` nodes participate in
control connections (see [Agents & tools](/concepts/agents-tools-skills)).

> source · data · text · image · audio · video · embedding · llm · store ·
> database · tool · agent · memory · infrastructure · target · preprocessor

## Connectors

**Connectors** are the nodes at the edges of the graph, the ones that read from
or write to the world outside the pipeline:

- **Sources** bring data in: a `webhook` that receives a request, a `chat`
  source that streams a conversation, a file or database reader.
- **Targets** send results out: a `response` node that returns data to the
  caller, or a node that writes to a store or external system.

Everything between a source and a target (embedding, retrieval, LLM calls,
preprocessing) transforms data as it flows through.

## Swap providers, keep the pipeline

Because behaviour lives in `provider` + `config`, you can change _which_ LLM or
vector store a pipeline uses without touching its shape. Point an `llm` node at
a different provider, or repoint a `store` node at a different collection, and
the surrounding graph is unchanged.

## The catalog
 
 Every available provider (50+ nodes across 13+ LLM providers, 8 vector
 databases, OCR, NER, PII anonymization, transcription, and web tools) is
 documented with its config, inputs, and outputs in
 **[Nodes](/nodes)**.
 
 ## Next steps
 
 - [Nodes](/nodes): every provider and its schema.
- [Agents & tools](/concepts/agents-tools-skills): the control-plane nodes.
- [Execution model](/concepts/execution-model): how lanes carry data between
  nodes.
- [Pipeline JSON reference](/pipeline-reference): every field of a node.
