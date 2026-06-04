# rerank_cohere

Reranks retrieved documents by relevance using [Cohere's Rerank API](https://docs.cohere.com/reference/rerank).

## What it does

Improves search quality by reordering a set of already-retrieved documents based on their relevance to the query. Each document is scored by the Cohere Rerank API, results are sorted by relevance, optionally truncated to the top N, and filtered by a minimum score threshold. Supports the `rerank-english-v3.0` and `rerank-v3.5` models, plus a custom model option.

**Lanes:**

| Lane in     | Lane out    | Description                                                |
| ----------- | ----------- | ---------------------------------------------------------- |
| `questions` | `documents` | Produces reranked documents ordered by relevance score     |
| `questions` | `answers`   | Produces an answer with reranked documents                 |

Place this node downstream of a retrieval/vector-store node so it can rerank the documents attached to each question.

## Setup

Requires a Cohere API key. Provide it via the node config field **API Key**, or via the environment variable:

```bash
ROCKETRIDE_RERANK_COHERE_KEY=...
```

## Configuration

| Field     | Default                | Description                                          |
| --------- | ---------------------- | ---------------------------------------------------- |
| Model     | `rerank-english-v3.0`  | Cohere rerank model (`rerank-english-v3.0`, `rerank-v3.5`, or custom) |
| Top N     | `5`                    | Number of top results to return (minimum 1)          |
| Min Score | `0.0`                  | Minimum relevance score threshold (0.0–1.0); results below it are dropped |
| API Key   | *(empty)*              | Cohere API key                                       |
