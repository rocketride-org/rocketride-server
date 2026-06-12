# index_search

Store and retrieve documents by keyword (BM25) or by meaning (vectors), backed by Elasticsearch or OpenSearch.

## What it does

One node, two service variants (Elasticsearch and OpenSearch) that ingest documents and retrieve them at query time. Each variant operates in one of two modes, selected by the Store Mode toggle; no pipeline rewiring is required to switch between them:

- **Index mode:** classic BM25 full-text search over the index, with a configurable match operator (`or`, `and`, `exact` phrase) and optional contextual snippet highlighting. Text arrives on the `text` lane and results are returned via scan/scroll with a batch size of 500 and a scroll window of `1m`, so all matches are returned rather than just the first page.
- **Vector store mode:** semantic similarity search over embedded documents. Documents must pass through an embedding node before reaching this one. Hits below the configured Retrieval Score threshold are dropped.

Uses the official **elasticsearch** Python client (8.x, `dense_vector` + kNN, cosine similarity by default; `l2_norm` and `dot_product` are also accepted) and **opensearch-py** (`knn_vector` indices with HNSW / FAISS / `cosinesimil`). The backend is resolved automatically from the node config at startup.

Elasticsearch covers self-managed, Elastic Cloud Hosted, and Elastic Cloud Serverless deployments. OpenSearch covers self-managed OpenSearch. Default mode differs per variant: Elasticsearch starts in **vector store** mode (`store_enabled: true`); OpenSearch starts in **index** mode (`mode: false`).

Saving the node config runs a fast connectivity probe: the index/collection name format is checked, then the cluster is contacted (Elasticsearch: `cluster.health` with a 10 s timeout; OpenSearch: `ping`). Failures surface as warnings with the backend's inner error `reason` extracted.

---

## Configuration

### Lanes

| Lane in     | Lane out    | Description                                                                                  |
| ----------- | ----------- | -------------------------------------------------------------------------------------------- |
| `text`      | (none)      | Ingest raw text (index mode)                                                                 |
| `documents` | (none)      | Ingest pre-embedded documents (vector store mode only)                                       |
| `questions` | `text`      | Search and stream matching text                                                               |
| `questions` | `documents` | Search and stream matching documents                                                          |
| `questions` | `answers`   | Search and stream matching documents as answers                                               |
| `questions` | `questions` | Enrich question with matching documents for downstream nodes (Elasticsearch variant only)     |

The `documents` input lane is only processed in vector store mode; documents arriving in index mode are silently ignored. Documents without an embedding are skipped in vector store mode.

Index and collection names must be 1-255 characters of lowercase letters, digits, `.`, `_`, or `-`; slashes and spaces are not allowed.

### Elasticsearch variant

The Deployment Type field selects a connection profile:

| Field | Type | Description |
|---|---|---|
| `host` | string | Default "http://localhost:9200". Localhost URL for OpenSearch. |
| `enabled` | boolean | Default true. Enable basic authentication when connecting. |
| `username` | string | Default "admin".  |
| `password` | string | Default empty.  |
| `collection` | string | Default "rocketride". The name of the collection to use for the OpenSearch index. Only lowercase letters, numbers, and underscores are allowed. |
| `mode` | boolean | Default false. Toggle between index and vector store. |
| `search` | boolean | Default false. Customize the search behavior of the index. This option does not affect the ingestion and creation of the index. You can switch between behaviors when searching between pipeline runs. |
| `matchOperator` | string | Default "or". Controls how multiple query terms are matched: 'or' (default) matches documents containing ANY of the query terms, 'and' matches documents containing ALL of the query terms, 'exact' requires the exact phrase to appear in order (phrase matching). |
| `slop` | number | Default 0. The number of words to allow between terms when exact phrase search is enabled. |
| `highlight` | boolean | Default false. Use the unified highlighter to return snippets around matches. |
| `fragment_size` | number | Default 250. Maximum characters in the returned highlight snippet (context window) per hit. |
| `score` | number | Default 0.5. Minimum retrieval score for vector stores |
| `dim` | integer | Default 768. Required in vector store mode; dimension of embedding vectors. |
| `index_label` | object |  |
| `vstore_label` | object |  |
| `provider` | string | Default "opensearch".  |
| `index` | string | Default "rocketride". Enter the name of the Elasticsearch index (must be lowercase) |
| `type` | string | Default "vector_database". Elasticsearch operation type |
| `store_enabled` | boolean | Default true. Enable document storage |
| `profile` | string | Default "self-managed". Connect to... |

| Field                   | Type / Default       | Description                                                                                        |
| ----------------------- | -------------------- | -------------------------------------------------------------------------------------------------- |
| `elasticsearch.profile` | enum, `self-managed` | `self-managed` / `cloud-hosted` / `cloud-serverless`                                               |
| `vector.local.host`     | string, `localhost`  | Server address (self-managed)                                                                      |
| `vector.local.port`     | number, `9200`       | Server port (self-managed)                                                                         |
| `vector.cloud.host`     | string, empty        | Cloud host URL, e.g. `<deployment-id>.es.<region>.cloud.es.io` (cloud profiles)                   |
| `vector.cloud.port`     | number, `9243`/`443` | Cloud port (9243 for cloud-hosted, 443 for cloud-serverless)                                       |
| `vector.apikey`         | string, empty        | Elastic Cloud API key (cloud profiles)                                                             |
| `vector.index`          | string, `rocketride` | Elasticsearch index name (lowercase)                                                               |
| `elasticsearch.mode`    | boolean, `true`      | `true` = vector store (semantic search); `false` = index (BM25)                                    |
| `vector.score`          | number, `0.5`        | Minimum similarity threshold in vector store mode (0.0-1.0)                                        |

### OpenSearch variant

| Field                            | Type / Default                  | Description                                                         |
| -------------------------------- | ------------------------------- | ------------------------------------------------------------------- |
| `opensearch.host`                | string, `http://localhost:9200` | OpenSearch server URL                                               |
| `opensearch.collection`          | string, `rocketride`            | Index name (lowercase letters, digits, underscores)                 |
| `opensearch.auth.enabled`        | boolean, `true`                 | Enable basic authentication                                         |
| `opensearch.auth.username`       | string, `admin`                 | Basic auth username (shown when auth is enabled)                    |
| `opensearch.auth.password`       | string, empty                   | Basic auth password (shown when auth is enabled)                    |
| `opensearch.mode`                | boolean, `false`                | `true` = vector store (kNN); `false` = index (BM25)                 |
| `opensearch.dim`                 | integer, `768`                  | Embedding dimension (required in vector store mode; must be > 0)    |
| `opensearch.score`               | number, `0.5`                   | Minimum similarity score to include a result (0-1)                  |

---

## Modes

### Index mode

Raw text from the `text` lane is stored in a plain `content` text field. Questions trigger a BM25 match query; every hit is streamed out on the `answers`, `text`, and `documents` lanes (using the hit `_id` as `objectId`).

The Customize Indexing Search Behavior toggle exposes additional search options. These affect querying only, never ingestion or index creation, so they can be changed between pipeline runs without re-ingesting data.

| Field                              | Default | Description                                                                          |
| ---------------------------------- | ------- | ------------------------------------------------------------------------------------ |
| `elasticsearch.matchOperator` / `opensearch.matchOperator` | `or` | `or` matches any term; `and` matches all terms; `exact` is phrase match |
| `elasticsearch.search.exact.slop` / `opensearch.search.exact.slop` | `0` | Words allowed between terms in `exact` phrase match             |
| `elasticsearch.search.highlight` / `opensearch.search.highlight`   | `false` | Use the unified highlighter to return snippets around matches instead of the full document |
| `elasticsearch.search.highlight.fragment_size` / `opensearch.search.highlight.fragment_size` | `250` | Maximum characters per highlight snippet per hit   |

### Vector store mode

Pre-embedded documents from the `documents` lane are upserted into a vector index. Questions are answered by kNN similarity search; hits below the Retrieval Score threshold are dropped.

For Elasticsearch, the index uses a `dense_vector` field with cosine similarity by default. Similarity can be changed via the `similarity` config value (`cosine`, `l2_norm`, or `dot_product`). Search dispatches through the `DocumentStoreBase` using kNN with `num_candidates` set to 10x the requested limit.

For OpenSearch, the vector index uses `knn_vector` with HNSW / FAISS / `cosinesimil`. The top 10 nearest neighbours are returned and filtered against the Retrieval Score threshold.

> **Gotcha (OpenSearch vector store):** the vector index is created automatically with the configured Embedding Dimension. If an index with the same name already exists but is not a `knn_vector` index, or its dimension does not match the configured value, the index is deleted and recreated, and all existing data in that index is lost. Keep the dimension in sync with your embedding model.

---

## Authentication

### Elasticsearch

Self-managed instances connect without credentials (`http://` is assumed for `localhost`, `127.*`, and self-managed mode). Elastic Cloud Hosted and Serverless profiles require the host URL plus an API key; connections use `https://`.

### OpenSearch

Basic auth (username and password). When basic auth is enabled, an `http://` host is automatically upgraded to `https://`, and TLS certificate verification is disabled (`verify_certs=False`), which is suitable for self-managed clusters with self-signed certificates. Both username and password are required when auth is on.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

### Elasticsearch (`services.elasticsearch.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `elasticsearch.index` | `string` | **Index Name / Collection Name**<br/>Enter the name of the Elasticsearch index | `"rocketride"` |
| `elasticsearch.index_label` | `object` | **Index Mode** |  |
| `elasticsearch.matchOperator` | `string` | **Match Operator**<br/>Controls how multiple query terms are matched: 'or' (default) matches documents containing ANY of the query terms, 'and' matches documents containing ALL of the query terms, 'exact' requires the exact phrase to appear in order (phrase matching). | `"or"` |
| `elasticsearch.mode` | `boolean` | **Store Mode**<br/>Toggle between index (text search) and vector store (semantic search). | `true` |
| `elasticsearch.profile` | `string` | **Deployment Type**<br/>Connect to... | `"self-managed"` |
| `elasticsearch.provider` | `string` |  | const: `"elasticsearch"` |
| `elasticsearch.search` | `boolean` | **Customize Indexing Search Behavior**<br/>Customize the search behavior of the index. This option does not affect the ingestion and creation of the index. You can switch between behaviors when searching between pipeline runs. | `false` |
| `elasticsearch.search.exact.slop` | `number` | **Slop**<br/>The number of words to allow between terms when exact phrase search is enabled. | `0` |
| `elasticsearch.search.highlight` | `boolean` | **Return contextual snippets**<br/>Use the unified highlighter to return snippets around matches. | `false` |
| `elasticsearch.search.highlight.fragment_size` | `number` | **Snippet size (characters)**<br/>Maximum characters in the returned highlight snippet (context window) per hit. | `250` |
| `elasticsearch.store_enabled` | `boolean` | **Store**<br/>Enable document storage | `true` |
| `elasticsearch.type` | `string` | **Type**<br/>Elasticsearch operation type | `"vector_database"` |
| `elasticsearch.vstore_label` | `object` | **Vector Store Mode** |  |
| `vector.cloud.host` |  | Enter the Elastic Cloud host URL e.g. <your-deployment-id>.es.<region>.cloud.es.io |  |
| `vector.cloud.port` |  |  | `9243` |
| `vector.index` | `string` | **Index Name / Collection Name**<br/>Enter the name of the Elasticsearch index (must be lowercase) | `"rocketride"` |
| `vector.local.host` |  |  | `"localhost"` |
| `vector.local.port` |  |  | `9200` |

### OpenSearch (`services.opensearch.json`)

| Field | Type | Description | Default |
|---|---|---|---|
| `opensearch.auth.enabled` | `boolean` | **Use basic auth**<br/>Enable basic authentication when connecting. | `true` |
| `opensearch.auth.password` | `string` | **Password** | `""` |
| `opensearch.auth.username` | `string` | **Username** | `"admin"` |
| `opensearch.collection` | `string` | **Collection**<br/>The name of the collection to use for the OpenSearch index. Only lowercase letters, numbers, and underscores are allowed. | `"rocketride"` |
| `opensearch.dim` | `integer` | **Embedding Dimension**<br/>Required in vector store mode; dimension of embedding vectors. | `768` |
| `opensearch.host` | `string` | **Host**<br/>Localhost URL for OpenSearch. | `"http://localhost:9200"` |
| `opensearch.index_label` | `object` | **Index Mode** |  |
| `opensearch.matchOperator` | `string` | **Match Operator**<br/>Controls how multiple query terms are matched: 'or' (default) matches documents containing ANY of the query terms, 'and' matches documents containing ALL of the query terms, 'exact' requires the exact phrase to appear in order (phrase matching). | `"or"` |
| `opensearch.mode` | `boolean` | **Store Mode**<br/>Toggle between index and vector store. | `false` |
| `opensearch.provider` | `string` |  | const: `"opensearch"` |
| `opensearch.score` | `number` | **Retrieval Score**<br/>Minimum retrieval score for vector stores | `0.5` |
| `opensearch.search` | `boolean` | **Customize Indexing Search Behavior**<br/>Customize the search behavior of the index. This option does not affect the ingestion and creation of the index. You can switch between behaviors when searching between pipeline runs. | `false` |
| `opensearch.search.exact.slop` | `number` | **Slop**<br/>The number of words to allow between terms when exact phrase search is enabled. | `0` |
| `opensearch.search.highlight` | `boolean` | **Return contextual snippets**<br/>Use the unified highlighter to return snippets around matches. | `false` |
| `opensearch.search.highlight.fragment_size` | `number` | **Snippet size (characters)**<br/>Maximum characters in the returned highlight snippet (context window) per hit. | `250` |
| `opensearch.vstore_label` | `object` | **Vector Store Mode** |  |

## Dependencies

- `elasticsearch` `>=8.0.0,<9.0.0`
- `opensearch-py` `==3.2.0`
- `numpy`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/index_search)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
