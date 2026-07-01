# cache — design, test coverage & security notes

Companion to [`README.md`](./README.md). Records the architecture, the exact test
coverage, and the security review for the `cache` (Semantic Cache) node.

## Architecture

The node splits into an engine-free policy core and thin engine/ML wiring so the
cache logic is unit-testable without the C++ engine or a downloaded model.

| Layer | File | Responsibility | Engine coupling |
|---|---|---|---|
| Cache policy | `semantic_cache.py` | cosine match, TTL expiry, LRU eviction, thread-safety, stats | none (plain `list[float]`, stdlib only) |
| Embedding | `embedder.py` | `embed(text) -> list[float]` via `ai.common.models.SentenceTransformer` | shared loader (same as `embedding_transformer`) |
| Pipe state | `IGlobal.py` | build embedder + cache once per pipe; release on close | `IGlobalBase` |
| Request flow | `IInstance.py` | hit → answer & skip LLM; miss → forward & store | `IInstanceBase` |

### Dataflow (how a hit skips the LLM)

Wire it on both lanes around an LLM (same shape as `memory_persistent`):

```text
... → cache → llm → cache → response
```

- **Hit** (cosine ≥ `threshold`): build `Answer()`, `setAnswer(cached)`, call
  `self.instance.writeAnswers(answer)`, and do **not** forward the question — the
  same "question in → answer out" move the LLM node makes in `llm_base.py`, so the
  LLM downstream never runs.
- **Miss**: forward the question; stash `(embedding, text)` in per-object
  `_pending`; store the LLM's answer when it returns via `writeAnswers` — the same
  per-object correlation pattern `memory_persistent` uses (`open()` resets it).

The cache key is the question text **plus its context**, so a different RAG
context correctly produces a miss.

## Test coverage (26 offline tests)

Run: `pytest nodes/test/cache/`

### `nodes/test/cache/test_semantic_cache.py` (18) — pure cache core

exact hit + counters · similar-above-threshold hit · below-threshold miss ·
empty-cache miss · zero-vector add rejected · empty-answer rejected · zero-query
miss · TTL expiry · TTL-zero never expires · LRU eviction by size · LRU hit
protects entry · unbounded when `max_entries=0` · dimension-mismatch skipped ·
threshold clamped to [0,1] · mixed hit-rate · clear keeps counters · most-similar
entry wins · **8-thread concurrent add/lookup safety**.

### `nodes/test/cache/test_cache_instance.py` (8) — real IInstance/IGlobal

miss→store→hit-skips-LLM full cycle · dissimilar question misses & forwards ·
empty question passthrough (not embedded) · passthrough when uninitialised · hit
leaves no `_pending` (no double-store) · context change → different key · CONFIG
mode builds nothing · RUN mode builds cache+embedder and `endGlobal` releases them.

**Not covered offline:** live run through the C++ engine + a real provider (the
embedding model also downloads on first use). All node logic is covered by mocks.

## Security review

| # | Finding | Severity | Resolution |
|---|---|---|---|
| 1 | Shared cache raced across concurrent per-object instances (unguarded `OrderedDict` mutation) | Medium | Added `threading.Lock` around all reads/mutations; concurrency test added |
| 2 | Cache is shared per pipe — a similar question from another user could be served a prior answer | Medium (privacy) | Documented in README "Security & privacy"; per-tenant pipe / `session_id` scoping recommended |
| 3 | Too-low `threshold` could return a near-but-different answer | Low | Conservative default (0.92) + tuning guidance |

Clean checklist: no `eval`/`exec`/`pickle`/`subprocess`/`os.system`/`trust_remote_code`;
no question/answer text in logs (counts/rates only); no file/network I/O in the
node; no secrets/API keys; memory bounded by LRU (`max_entries`) + `ttl_seconds`;
`model` is operator-configured, not end-user input.
