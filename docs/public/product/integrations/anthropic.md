---
title: Anthropic
sidebar_position: 1
---

# Anthropic

RocketRide ships a native Anthropic node that connects Claude models directly to
your pipelines — no adapter layer required. It covers every Claude 4 model
including Opus, Sonnet, and Haiku, and automatically enables extended thinking
for reasoning-capable models.

## Nodes

| Node | Provider | What it does |
| --- | --- | --- |
| [`llm_anthropic`](/nodes/llm_anthropic) | `llm_anthropic` | Generates text via Claude (Sonnet, Opus, Haiku). Streams extended thinking on reasoning-capable models. |

## Authentication

The node accepts an `apikey` config field. Use an environment variable so the
key stays out of your `.pipe` file:

```json
{ "config": { "apikey": "${ANTHROPIC_API_KEY}" } }
```

Set the variable before starting the pipeline:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
rocketride start --pipeline ./my-pipeline.pipe
```

The node validates the key and model at pipeline startup. If the key is invalid
or the model is inaccessible, the pipeline reports an error before processing
any data. Keys must start with `sk-ant`.

## Choosing a model profile

Set the `profile` field in config:

```json
{ "config": { "profile": "claude-sonnet-4-6", "apikey": "${ANTHROPIC_API_KEY}" } }
```

| Profile | Model ID | Context | Output |
| --- | --- | --- | --- |
| `claude-sonnet-4-6` _(default)_ | `claude-sonnet-4-6` | 1M tokens | 128K tokens |
| `claude-opus-4-7` | `claude-opus-4-7` | 1M tokens | 128K tokens |
| `claude-opus-4-6` | `claude-opus-4-6` | 1M tokens | 128K tokens |
| `claude-sonnet-4-5` | `claude-sonnet-4-5` | 1M tokens | 64K tokens |
| `claude-opus-4-5` | `claude-opus-4-5` | 200K tokens | 64K tokens |
| `claude-haiku-4-5` | `claude-haiku-4-5` | 200K tokens | 64K tokens |
| `custom` | _(user-specified)_ | configurable | — |

**Choosing a tier:**

- **Haiku** — fastest and cheapest; good for classification, routing, and short
  structured outputs where latency matters.
- **Sonnet** — best balance of speed and capability; the right default for most
  RAG, summarization, and Q&A pipelines.
- **Opus** — highest capability; use for complex reasoning, long-document
  analysis, and tasks that benefit from extended thinking.

## Extended thinking

When the selected model supports extended thinking (Opus 4.6+, Sonnet 4.6+),
the node enables it automatically. The model's reasoning trace is streamed over
the `thinking` SSE lane in parallel with the `answers` lane. You can wire a
downstream node to the `thinking` lane to capture or display the chain of
thought, or ignore it — the `answers` lane delivers the final response either
way.

No extra config is required to enable thinking; it activates based on the
selected profile.

## Minimal pipeline: chat

```json
{
  "nodes": [
    { "id": "source_1", "provider": "webhook" },
    {
      "id": "llm_1",
      "provider": "llm_anthropic",
      "config": { "profile": "claude-sonnet-4-6", "apikey": "${ANTHROPIC_API_KEY}" },
      "input": [{ "lane": "questions", "from": "source_1" }]
    },
    {
      "id": "target_1",
      "provider": "response",
      "input": [{ "lane": "answers", "from": "llm_1" }]
    }
  ]
}
```

See the [Webhook Pipeline example](/examples/webhook-pipeline) for a walkthrough
of this pattern.

## Minimal pipeline: RAG with Anthropic

```json
{
  "nodes": [
    { "id": "source_1", "provider": "webhook" },
    {
      "id": "embed_1",
      "provider": "embedding_openai",
      "config": { "profile": "text-embedding-3-small", "apikey": "${OPENAI_API_KEY}" },
      "input": [{ "lane": "text", "from": "source_1" }]
    },
    {
      "id": "store_1",
      "provider": "qdrant",
      "config": { "profile": "self-hosted", "serverName": "localhost", "collection": "docs" },
      "input": [
        { "lane": "documents", "from": "embed_1" },
        { "lane": "questions", "from": "source_1" }
      ]
    },
    {
      "id": "llm_1",
      "provider": "llm_anthropic",
      "config": { "profile": "claude-sonnet-4-6", "apikey": "${ANTHROPIC_API_KEY}" },
      "input": [{ "lane": "questions", "from": "store_1" }]
    },
    {
      "id": "target_1",
      "provider": "response",
      "input": [{ "lane": "answers", "from": "llm_1" }]
    }
  ]
}
```

## Swapping providers

Because `llm_anthropic` and every other LLM node share the same lane contract
(`questions` → `answers`), you can swap providers by changing the `provider`
and `config` fields — the rest of the pipeline is unchanged.

## Related

- [`llm_anthropic` node reference](/nodes/llm_anthropic)
- [RAG Pipeline example](/examples/rag-pipeline)
- [Qdrant integration](/integrations/qdrant)
