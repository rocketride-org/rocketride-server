# search_hybrid

A RocketRide filter node that re-orders the documents already attached to a question, fusing each document's upstream vector score with a BM25 keyword score. Pick it when a retrieval step returns roughly the right candidates but ranks them badly.

## What it does

The node reads a question that already carries retrieved documents, scores those same documents with BM25 against the question text, and merges the BM25 ranking with the incoming vector ranking using Reciprocal Rank Fusion (RRF). It emits the re-ordered documents, and can also emit them as a composed answer. Place it downstream of a vector-store search or another node that attaches documents to questions.

It is a re-ranker, not a retriever: no embedding or index lookup happens here, and the incoming document `score` is reused as the vector signal. A keyword-relevant document the upstream search did not return can therefore never be surfaced — for that, put a store that does dense and sparse retrieval in one query upstream instead. The node is marked experimental.

## Lanes

| Lane in | Lane out | Description |
|---|---|---|
| `questions` | `documents` | Documents re-ordered by the fused vector + BM25 ranking. |
| `questions` | `answers` | The top-ranked documents composed into a single answer, each entry showing its rank, its score and the first 500 characters of its content. |

The query is the text of the question's **first** question entry. A question with no query text, or with no documents attached, is skipped: nothing is emitted on either lane. Each lane is written only when it has a downstream listener and at least one document survived re-ranking, so a question can produce no output object at all — put a pass-through-guaranteeing node after this one if a downstream stage requires a result for every question.

## Profiles

Default: **Balanced - Equal weight to vector and keyword search** (`balanced`).

| Profile | Alpha | Top K | RRF k |
|---|---|---|---|
| `balanced` **(default)** | 0.5 | 10 | 60 |
| `semantic` | 0.8 | 10 | 60 |
| `keyword` | 0.2 | 10 | 60 |

The three profiles differ only in `alpha`; they all return ten results and use an RRF constant of 60.

## Configuration

Pick the profile whose balance matches the corpus — `balanced` when both signals are worth the same, `semantic` when the questions are paraphrases of the content, `keyword` when they carry names, codes or other exact strings. The profile fills in all three fields, so most pipelines change nothing else. Values are validated when the node loads: an out-of-range alpha is clamped to `[0.0, 1.0]` with a warning, while `top_k` below 1 or a negative `rrf_k` raise an error rather than starting with a configuration that cannot produce sensible results.

### Search mode

Selects one of the profiles above and, with it, the alpha / top-k / RRF-constant triple shown in the configuration panel. Change the individual values below only when no profile fits.

### Alpha (vector weight)

Weights the vector ranking; BM25 gets `1 - alpha`. `0.5` treats both signals equally. Raise it when the incoming vector scores are trustworthy and the questions are semantic; lower it when exact term overlap decides relevance.

The endpoints are the limits of the weighting, not a switch to a single-signal mode. A leg weighted `0.0` contributes nothing to its documents' fused scores, so they sort below everything the weighted leg ranked — but they are still returned. `alpha = 1.0` emits the vector ranking followed by the unscored documents in BM25 order, which is exactly what `alpha = 0.99` emits. Alpha changes the order of the results, never which documents come back.

### Top K results

Caps how many documents are emitted, applied after fusion. The default of `10` suits a retrieval step that already narrowed the candidate set; raise it when a downstream reader can use more context, lower it when the consumer is a prompt with a tight budget. BM25 always scores the full incoming set — `top_k` only truncates the final ranking.

### RRF constant (k)

The `k` in the RRF term `weight / (k + rank + 1)`. It flattens the curve: at the default `60`, the difference between rank 1 and rank 2 is small, so a document needs to place well in *both* rankings to reach the top. Lower it (single digits) to let a strong first-place finish in one ranking dominate; raise it to spread influence further down both lists. It is not a score threshold and never removes a document.

## Notes

### How the ranking is built

Two ranked lists are formed from the same incoming documents: the vector list, sorted by the document scores that arrived, and the BM25 list, scored against the query. Text is tokenized by lowercasing and splitting on non-alphanumeric characters, so BM25 matches whole words, not substrings or stems. RRF then sums `weight / (rrf_k + rank + 1)` per list, weighting vector by `alpha` and BM25 by `1 - alpha`, and sorts by that total. Because RRF is rank-based, the magnitudes of the incoming vector scores do not matter — only the order they impose.

### Documents that arrive without a score

`Doc.score` is unset unless an upstream node fills it in, and a missing score is treated as absence of evidence rather than a score of zero. Such documents are left out of the vector list entirely but still ranked by BM25, and still returned. When no document carries a score there is no vector signal to fuse and the node ranks by BM25 alone; when only some do, the rest are ranked on their BM25 evidence. Either case logs a warning naming the missing signal, once per instance rather than once per question.

The only document the node does not return is one with no evidence in either leg — no score *and* no text BM25 can rank, such as empty content or content that tokenizes to nothing. That holds at every alpha.

### The emitted score is a ranking key, not a similarity

Each returned document's `score` is overwritten with the value that ordered it: the RRF score whenever both legs produced a ranking. That is a small rank-derived number (roughly `1 / (rrf_k + rank)`, about 0.016 at `rrf_k = 60`), and a document contributed only by a zero-weighted leg scores exactly `0.0`, meaning "contributed nothing", not "matched badly". Only when one leg produces no ranking at all does the node fall back to returning the other leg's list with its own raw BM25 or vector score. Do not compare these values against a calibrated similarity threshold downstream.

### Fan-out safety

The incoming question and the documents mapped back into the result are deep-copied, so a question fanned out to several branches is not mutated by this node.

## Upstream docs

- [rank_bm25](https://github.com/dorianbrown/rank_bm25) — the BM25 implementation this node uses.

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
