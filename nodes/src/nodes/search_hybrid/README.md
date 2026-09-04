# search_hybrid

A RocketRide filter node that re-ranks the documents already attached to a question by fusing their upstream vector score with a BM25 keyword score via Reciprocal Rank Fusion (RRF).

## What it does

Takes questions that already carry retrieved documents (from an upstream vector-store search) and re-orders those documents so both semantic relevance and exact keyword overlap influence the final ranking. For each question it tokenizes the document `page_content`, scores every candidate with BM25 against the query, and fuses the BM25 ranking with the vector ranking using RRF. Put it downstream of a retrieval or vector-store node so it can re-rank the documents attached to each question.

BM25 scoring is delegated to the **rank_bm25** `BM25Okapi` implementation, resolved at runtime by `depends()`. The incoming question is **deep-copied** before processing, so shared question objects in fan-out pipelines are never mutated.

### This is a post-retrieval re-ranker, not true hybrid retrieval

The node does **not** perform a vector or embedding lookup of its own. It reuses each document's existing `score` (set by the upstream vector store that already retrieved the candidate set) as the "vector" signal, and BM25 only scores that same already-retrieved candidate set. As a consequence:

- A keyword-relevant document the vector store did **not** return can never be surfaced here — the node can only re-order what it is given.
- If upstream documents carry no `score`, the vector signal is `0.0` for those documents, so the vector ranking degenerates to the documents' input order (still fused with the BM25 ranking for `0 < alpha < 1`).

This is a reasonable, dependency-light design for an `experimental` node, but treat it as a re-ranking stage rather than a replacement for a dedicated dense+sparse retrieval index.

---

## Configuration

### Lanes

| Lane in     | Lane out    | Description                                                             |
|-------------|-------------|-------------------------------------------------------------------------|
| `questions` | `documents` | Documents re-ranked by hybrid score (vector + BM25 fused via RRF)       |
| `questions` | `answers`   | An answer composed from the top-ranked documents                        |

The query text is taken from the question's **first** question entry. An empty/whitespace-only query, or a question with no attached documents, is **skipped**: the node logs a debug line and emits nothing on either lane (see [Downstream-consumer notes](#downstream-consumer-notes)). Each lane is written only when it has a downstream listener **and** at least one re-ranked document was produced.

### Fields

| Field | Type | Description |
|---|---|---|
| `alpha` | number | Default 0.5. Weight for vector scores (0.0 = BM25 only, 1.0 = vector only, 0.5 = balanced) |
| `top_k` | number | Default 10. Maximum number of results to return after hybrid ranking |
| `rrf_k` | number | Default 60. RRF constant; higher values reduce the impact of top rankings |
| `profile` | string | Default "balanced". Selects the balance between vector and keyword search |

Config validation runs at load time: `alpha` outside `[0.0, 1.0]` is clamped and a warning is logged (not silently coerced); `top_k < 1` and `rrf_k < 0` fail fast with a `ValueError` so a misconfigured profile surfaces immediately instead of producing empty slices or runtime errors.

### Profiles

The **Search mode** dropdown selects a preconfigured profile:

| Profile    | Title                                             | alpha | top_k | rrf_k |
|------------|---------------------------------------------------|-------|-------|-------|
| `balanced` | Balanced — equal weight to vector and keyword     | 0.5   | 10    | 60    |
| `semantic` | Semantic-heavy — emphasize vector similarity      | 0.8   | 10    | 60    |
| `keyword`  | Keyword-heavy — emphasize BM25 keyword matching   | 0.2   | 10    | 60    |

All profiles expose `alpha`, `top_k`, and `rrf_k`.

---

## How ranking works

RRF is rank-based, not score-magnitude based: each document's fused score is `sum(weight_i / (rrf_k + rank_i + 1))` across the vector and BM25 lists, with the vector list weighted by `alpha` and the BM25 list by `1 - alpha`. Documents are deduplicated by id (falling back to text content, then to a unique synthetic id) so the same document appearing in both lists accumulates both contributions.

`alpha` behaves as two pure endpoints plus a blended middle:

| `alpha`        | Ranking method                    | Emitted `score` field         |
|----------------|-----------------------------------|-------------------------------|
| `0.0`          | BM25 only, sorted by BM25 score   | the BM25 score                |
| `0.0 < a < 1.0`| Weighted RRF of both lists        | the RRF score                 |
| `1.0`          | Vector only, sorted by vector score | the vector score            |

> If either signal produces no ranking (e.g. every document tokenizes to empty for BM25), the node falls back to the other signal's single sorted list even for `0 < alpha < 1`.

---

## Downstream-consumer notes

- **The endpoints are discontinuous with the blended range.** At `alpha == 0.0` or `alpha == 1.0` the node returns a single pure sorted list; anywhere in between it returns weighted RRF. So `alpha = 0.99` behaves qualitatively unlike `alpha = 1.0` — both the ordering method and the emitted score field change. Configure the endpoints deliberately.
- **The emitted `score` is overwritten with the ranking signal.** In the blended case that is the RRF score, which is a small rank-derived value (roughly `1 / (rrf_k + rank)`, e.g. ~0.016 at `rrf_k = 60`), not the original vector similarity. Do not treat the post-node `score` as a calibrated similarity; treat it as a relative ordering key.
- **Empty results are dropped, not passed through.** If the query or document list is empty, or re-ranking yields nothing, the node emits on neither lane — downstream nodes receive no object for that question. If a downstream stage requires an always-present result, place a node that guarantees pass-through after it.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `search_hybrid.alpha` | `number` | **Alpha (vector weight)**<br/>Weight for vector scores (0.0 = BM25 only, 1.0 = vector only, 0.5 = balanced) | `0.5` |
| `search_hybrid.profile` | `string` | **Search mode**<br/>Select the balance between vector and keyword search | `"balanced"` |
| `search_hybrid.rrf_k` | `number` | **RRF constant (k)**<br/>Reciprocal Rank Fusion constant. Higher values reduce impact of top rankings | `60` |
| `search_hybrid.top_k` | `number` | **Top K results**<br/>Maximum number of results to return after hybrid ranking | `10` |

## Dependencies

- `rank_bm25` `>=0.2.2,<1.0.0`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/search_hybrid)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
