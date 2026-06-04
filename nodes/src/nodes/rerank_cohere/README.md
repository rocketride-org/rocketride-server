# rerank_cohere

Got search results, but not in the right order? This node reranks them by relevance with [Cohere's Rerank API](https://docs.cohere.com/reference/rerank).

## What it does

Takes documents you've already retrieved and reorders them by how well they match the query. Cohere scores each one, then results are sorted, optionally cut to the top N, and dropped below a minimum score. Works with the `rerank-english-v3.0` and `rerank-v3.5` models, or a custom one.

**Lanes:**

| Lane in     | Lane out    | Description                                                |
| ----------- | ----------- | ---------------------------------------------------------- |
| `questions` | `documents` | Produces reranked documents ordered by relevance score     |
| `questions` | `answers`   | Produces an answer with reranked documents                 |

Put it downstream of a retrieval or vector-store node so it can rerank the documents attached to each question.

## Setup

You'll need a Cohere API key. Set it in the node's **API Key** field, or via the environment variable:

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
