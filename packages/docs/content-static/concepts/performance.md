---
title: Performance
sidebar_position: 7
---

# Performance

Understanding how the RocketRide engine executes pipelines helps you make good
decisions about node selection, chunk sizes, and deployment topology.

## Multithreaded C++ core

The engine is written in C++ and runs each pipeline run on its own thread pool.
Concurrent requests to the same pipeline do not queue behind each other —
the engine spawns an independent execution context for each incoming task.

This means a slow request (a large document going through OCR, embedding, and
an LLM call) does not block a fast one (a short question answered directly by
the LLM).

## Streaming execution

Nodes process data **as it arrives**, not after the full upstream output is
available. When a preprocessor splits a 100-page document into 200 chunks, the
embedding node starts embedding chunk 1 while the preprocessor is still
producing chunk 2. The vector store starts upserting while the embedder is
computing later chunks.

This pipeline streaming keeps memory usage low and reduces end-to-end latency,
especially for large documents.

## Vector store batching

Vector stores (Qdrant, Pinecone, Milvus, Weaviate, etc.) accumulate chunks and
flush them in batches rather than upserting one at a time. A batch flushes when
it reaches either a chunk-count limit or a payload-size limit, whichever comes
first. The exact thresholds are backend-specific: for example, Qdrant flushes at
500 points or its payload limit, while Pinecone and Milvus use different
chunk-count defaults.

For small documents that produce few chunks, the flush happens at pipeline
completion. For large document sets, flushing starts mid-run and reduces peak
memory.

Batch size affects throughput: larger batches reduce round-trip overhead but
increase memory usage per run. The defaults suit most workloads.

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

## Profiling a pipeline

The engine emits per-node timing in its WebSocket event stream. Use the CLI to
watch live timings during a run:

```bash
rocketride status --token <task-token>
```

The [Observability](/protocols/websocket/observability) page documents the event
schema. To find bottlenecks, look for the node with the longest gap between its
`start` and `complete` events — that is usually the LLM call or the embedding
step.

## Deployment topology

- **Local**: engine and nodes on the same machine. Zero network latency between
  nodes; API calls to LLM/vector store providers cross the internet normally.
- **Self-hosted**: engine in Docker or Kubernetes, co-located with vector store.
  Reduces vector store latency significantly.
- **Cloud**: managed engine. Best for production — automatic scaling, managed
  auth, no infrastructure to operate.

For high-throughput workloads, run the vector store and embedding service on the
same network as the engine to minimise round-trip latency on the embedding and
upsert steps.

## Related

- [Concepts: Execution Model](/concepts/execution-model): lane flow and concurrency.
- [Self-hosting](/self-hosting): deployment options.
- [WebSocket: Observability](/protocols/websocket/observability): timing events.
