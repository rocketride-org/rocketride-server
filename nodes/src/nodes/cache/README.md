# cache

A RocketRide node that semantically caches LLM answers, returning a stored answer for a similar earlier question and skipping the LLM call.

## What it does

The cache sits in front of an LLM. For each incoming question it:

1. Embeds the question text (plus any context) with a local sentence-transformer model.
2. Looks the embedding up against previously seen questions by **cosine similarity**.
3. **Hit** (similarity ≥ threshold): emits the stored answer immediately and **does not forward the question**, so the LLM never runs.
4. **Miss**: forwards the question to the LLM, then stores the LLM's answer keyed by the question embedding so the next similar question is a hit.

This cuts cost and latency for repeated or near-duplicate prompts (FAQs, retried requests, paraphrased questions). The cache is **in-memory and lives for the duration of the pipe** — it is not shared across separate pipeline runs or processes.

The cache key incorporates the question text, its context, and all response-shaping parameters. Context contributes to the semantic match but does not guarantee complete isolation: a changed yet sufficiently similar context may reuse a cached answer and bypass the LLM, while tenant and session scope metadata (`tenant_id`, `session_id`) strictly partition cached entries.

Uses `ai.common.models.SentenceTransformer` (the same local loader as `embedding_transformer`) — no API key required. The embedding model is downloaded once on first use.

## Lanes

| Lane in | Lane out | Description |
|---|---|---|
| `questions` | `answers` | Cached answer returned immediately on a hit, bypassing the LLM |
| `questions` | `questions` | Question forwarded to the LLM on a cache miss |
| `answers` | `answers` | LLM answer stored in cache, then forwarded downstream |

## Profiles

Default: **Balanced - good hit rate with low false matches** (`balanced`).

| Profile | Threshold | Description |
|---|---|---|
| `balanced` **(default)** | 0.92 | Good hit rate with few false matches |
| `strict` | 0.97 | Only near-identical questions hit |
| `lenient` | 0.85 | Aggressive matching, higher hit rate |

All profiles use `sentence-transformers/all-MiniLM-L6-v2` by default; override `model`, `threshold`, `max_entries`, `ttl_seconds`, or `scope` per node.

## Configuration

Select a profile to match your tolerance for semantic variation. The default **Balanced** profile (`threshold: 0.92`) balances hit rate and precision for most conversational workloads. Select **Strict** (`0.97`) when even slight paraphrasing could alter the meaning, or **Lenient** (`0.85`) for broader matching on general FAQs.

You can override individual settings in the configuration panel:

- **Similarity threshold (`threshold`):** Cosine similarity threshold (0.0 to 1.0) required to count as a cache hit. Higher values require closer semantic matches.
- **Embedding model (`model`):** Local SentenceTransformers model used to generate embeddings. Defaults to `sentence-transformers/all-MiniLM-L6-v2`.
- **Max entries (`max_entries`):** Upper limit on entries kept in memory. When exceeded, least-recently-used (LRU) entries are evicted (`0` = unbounded).
- **TTL (`ttl_seconds`):** Expiration duration in seconds for cached entries (`0` = entries never expire).
- **Scope (`scope`):** Optional tenant/environment namespace to isolate cached entries across pipelines.

## Notes

### Wiring

The node sits on both the `questions` and `answers` lanes, around an LLM:

```text
... → cache → llm → cache → response
```

- `cache` (questions out) → `llm`
- `llm` (answers out) → `cache` (answers in)
- `cache` (answers out) → `response`

On a hit the cache emits directly on its `answers` output, bypassing the LLM. This is the same lane shape as `memory_persistent`.

### Limits & eviction

- **Scope:** in-memory, per-pipe. Restarting the pipeline empties the cache. (A persistent backend is a natural future extension.)
- **Eviction:** least-recently-used once `max_entries` is exceeded (`0` = unbounded); a hit or a store counts as a use.
- **Expiry:** entries older than `ttl_seconds` are dropped (`0` = never expire).
- **Threshold:** too low risks returning an answer to a *different* question; `0.92` is a conservative default for MiniLM. Tune per use case.

### Security & privacy

- **Scope & Isolation.** All requests flowing through one pipe share the same cache unless scoped. Cached answers are strictly partitioned by tenant and session identifiers (`tenant_id`, `session_id`, `user_id` in question metadata) and the optional pipe-level `scope` configuration, ensuring cross-tenant and cross-session isolation.
- **False hits.** A too-low `threshold` can return the answer to a *semantically near but different* question. Keep `threshold` conservative for correctness-sensitive use.
- **No content is logged.** The node logs only hit-rate and entry counts (never question or answer text), so prompts/answers aren't leaked to logs.
- **Operator-configured model.** `model` is set by the pipeline author, not by end-user input; it is loaded through the same local loader as `embedding_transformer`.
- **Bounded by default.** `max_entries` (LRU) and `ttl_seconds` bound memory; the in-memory store is thread-safe for concurrent pipeline instances.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `max_entries` | `number` | **Max entries**<br/>Maximum cached entries before least-recently-used eviction (0 = unbounded) | `1000` |
| `model` | `string` | **Embedding model**<br/>SentenceTransformers model used to embed questions for similarity matching | `"sentence-transformers/all-MiniLM-L6-v2"` |
| `threshold` | `number` | **Similarity threshold**<br/>Minimum cosine similarity (0.0-1.0) for a cache hit. Higher = stricter matching | `0.92` |
| `ttl_seconds` | `number` | **TTL (seconds)**<br/>How long a cached answer stays valid before expiring (0 = never expire) | `0` |

## Dependencies

- `numpy`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/cache)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
