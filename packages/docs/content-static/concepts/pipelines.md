---
title: Pipelines
sidebar_position: 1
---

# Pipelines

A **pipeline** is the unit of work in RocketRide: a directed graph of components
that move and transform data. Pipelines are authored as `.pipe` files (JSON) and
executed by the engine.

## Components and providers

Each node in the graph is a **component** with a unique `id` and a `provider`
that determines its behaviour (for example `webhook`, `response`, or an LLM
provider). Provider-specific settings live in the component's `config`.

See the [Nodes](/nodes) catalog for every available provider.

## Data lanes vs. invoke connections

Components are wired together two ways:

- **Data lanes**: a typed channel (e.g. `questions` → `answers`) carrying data
  from one component to the next. Declared as input connections.
- **Invoke (control) connections**: a component calls another by class type
  (e.g. an agent invoking an `llm`), rather than streaming data through a lane.

## The `.pipe` JSON shape

A `.pipe` file is JSON conforming to the pipeline schema. The full field-by-field
reference is generated from the schema source and published at
[Pipeline JSON reference](/pipeline-reference).

## Minimal example

```json
{
  "components": [
    { "id": "in", "provider": "webhook", "config": {} },
    { "id": "out", "provider": "response", "input": [{ "lane": "questions", "from": "in" }] }
  ]
}
```

## Next steps

- [Quickstart](/quickstart): run your first pipeline.
- [Pipeline JSON reference](/pipeline-reference): every field.
- [Nodes](/nodes): the component catalog.
