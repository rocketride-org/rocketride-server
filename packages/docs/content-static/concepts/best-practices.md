---
title: Best Practices
sidebar_position: 10
---

# Best Practices

Practical guidance for building reliable, maintainable RocketRide pipelines.

## Credential management

**Store API keys in environment variables, never in `.pipe` files.**

A `.pipe` file is plain JSON. If you hard-code an API key, it will end up in
version control. Use `${ENV_VAR}` substitution in the config instead:

```json
{ "provider": "llm_openai", "config": { "apikey": "${OPENAI_API_KEY}" } }
```

The engine expands `${...}` references at startup from the process environment.

Credentials are **per-node**: each node holds only its own key, and nodes do not
share credential state. A compromised node config does not expose keys belonging
to other nodes in the pipeline.

For production deployments, inject keys via a secrets manager (AWS Secrets
Manager, HashiCorp Vault, Doppler) rather than a `.env` file.

## Choosing a preprocessor

The preprocessor splits documents into chunks before embedding. The right choice
depends on your content and latency budget:

| Preprocessor | Best for | Notes |
| --- | --- | --- |
| [`preprocessor_langchain`](/nodes/preprocessor_langchain) | Most text content | Fast, deterministic chunking by character or token count. Good default. |
| [`preprocessor_llm`](/nodes/preprocessor_llm) | Semantic coherence matters | Uses an LLM to split at meaningful boundaries. Slower and costs tokens; best for long-form prose where chunk boundaries affect retrieval quality. |
| [`preprocessor_code`](/nodes/preprocessor_code) | Source code | Splits at function and class boundaries. Do not use for prose. |

Start with `preprocessor_langchain` and a chunk size of 512–1024 tokens.
Only switch to `preprocessor_llm` if retrieval quality is measurably poor.

Chunk size affects both retrieval precision and embedding cost. Smaller chunks
retrieve more precisely but increase the number of embeddings to store and query.

## Selecting a memory node

Memory nodes give an agent conversational context across turns. Choose based on
whether that context needs to survive pipeline restarts:

| Node | Scope | Use when |
| --- | --- | --- |
| [`memory_internal`](/nodes/memory_internal) | In-process, single session | The conversation is self-contained and can reset on restart. Zero external dependencies. |
| [`memory_persistent`](/nodes/memory_persistent) | Persisted to a store, cross-session | The agent must remember previous conversations. Requires a configured backing store. |
| `tool_mem0` | Semantic, long-term | The agent benefits from extracted facts and preferences rather than raw history. Requires a Mem0 account or self-hosted instance. |

If you don't need cross-session memory, `memory_internal` is the right default —
it has no dependencies and no latency overhead.

## Agents vs. direct LLM calls

Use a **direct LLM node** (`llm_openai`, `llm_anthropic`, etc.) when:

- The task is a single-step transformation: summarise this text, classify this
  input, translate this sentence.
- The output schema is predictable.
- Latency is a concern — agents add at least one extra LLM round-trip.

Use an **agent node** (`agent_rocketride`, `agent_langchain`, etc.) when:

- The task requires deciding *which* tool to call based on the input.
- The task involves multiple steps that depend on intermediate results.
- You want the model to search, retrieve, compute, or call external APIs as part
  of answering a question.

A common mistake is wrapping a simple Q&A task in an agent "for flexibility."
Start with a direct LLM node; promote to an agent only when the task genuinely
requires tool use.

## Lane typing

Data in RocketRide flows through typed lanes. Wiring the wrong lane type is the
most common configuration error.

| Lane | Carries | Accepted by |
| --- | --- | --- |
| `questions` | User queries / prompts | LLMs, vector stores (for retrieval), agents |
| `answers` | LLM responses | `response` target, downstream nodes expecting generated text |
| `text` | Raw or parsed text | Preprocessors, embedding nodes, LLMs |
| `tags` | File metadata objects | Parsers, embedding nodes |
| `documents` | Vector-ready chunks | Vector store `documents` input |
| `image` / `audio` / `video` | Media | Vision/audio/video nodes |

**Common mistake:** wiring `text` to a node that expects `questions`. Text
arrives but the node waits for a question signal and never processes it. Check
the node's reference page (the **Lanes** table) when a node appears to receive
data but produces no output.

The VS Code extension highlights lane type mismatches in the canvas before you
run the pipeline.

## Related

- [Concepts: Execution Model](/concepts/execution-model): how lanes carry data.
- [Concepts: Agents & Tools](/concepts/agents-tools-skills): when agents are the right abstraction.
- [Concepts: Error Handling](/concepts/error-handling): what happens when things go wrong.
