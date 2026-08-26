---
title: Performance
---

# Performance

Practical levers for making pipelines faster and cheaper. For *why* these
levers exist — the engine's threading, streaming, and batching behaviour — see
the [Execution Model](/concepts/execution-model).

## Preprocessor chunk size

Chunk size directly affects embedding throughput and retrieval quality:

| Smaller chunks | Larger chunks |
| --- | --- |
| More precise retrieval | Fewer embedding API calls |
| More vectors to store and query | Lower storage cost |
| More embedding requests (cost) | Less precise retrieval for long queries |

A chunk size of 512–1024 tokens is a reasonable starting point for most text
content. Reduce chunk size if retrieval recall is poor on short queries; increase
if you're hitting embedding API rate limits.

## LLM context and cost

LLM nodes send the full accumulated context (system prompt, retrieved chunks,
conversation history) on every call. Costs scale with context size:

- **Retrieved chunks**: more chunks retrieved from the vector store = more
  tokens per LLM call. Tune the `top_k` parameter on the store node.
- **Memory nodes**: conversation history grows each turn. Use `memory_internal`
  with a window limit to cap history length.
- **Model selection**: larger models (GPT-5, Claude Opus) cost more per token.
  Use them for reasoning-heavy tasks; use smaller models for classification and
  extraction where a cheaper model performs just as well.

## Vector store batch sizing

Vector stores flush chunks in batches (see
[Execution Model](/concepts/execution-model) for the mechanics). Batch size
affects throughput: larger batches reduce round-trip overhead but increase
memory usage per run. The defaults suit most workloads.

## Profiling a pipeline

The engine emits per-node timing in its WebSocket event stream. Use the CLI to
watch live timings during a run:

```bash
rocketride status --token <task-token>
```

The [WebSocket Events](/connect/websocket/observability) page documents the
event schema. To find bottlenecks, look for the node with the longest gap
between its `start` and `complete` events — that is usually the LLM call or the
embedding step.

## Related

- [Execution Model](/concepts/execution-model): threading, streaming, and batching.
- [Production](/operate/self-hosting/production): deployment topology for throughput.
- [WebSocket Events](/connect/websocket/observability): timing events.
