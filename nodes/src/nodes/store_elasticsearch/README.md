# store_elasticsearch

A RocketRide store node that indexes text or embedded document chunks in Elasticsearch or OpenSearch and retrieves them through pipeline lanes.

## About Elasticsearch and OpenSearch

Elasticsearch and OpenSearch are search backends that index text and can search embedding vectors. This directory provides a RocketRide service for each backend, choosing one from configuration at runtime. Both services can use either text-index or vector-store mode, but their deployment and index-management behavior is not interchangeable.

## What it does

This directory provides two services: Elasticsearch and OpenSearch. Both ingest raw text for BM25-style index search or embedded documents for vector retrieval, then emit matching text, documents, or answers for incoming questions. Elasticsearch also supports a `questions` → `questions` lane for retrieved-context enrichment; OpenSearch does not declare that lane.

Pick this node when Elasticsearch or OpenSearch is already the searchable index for your pipeline, especially when the same lane layout must support either keyword or embedding retrieval. Choose a dedicated vector-store sibling when its database is where your vectors belong and you do not need the dual-mode search behavior.

In **index mode**, use the `text` lane for raw text and queries run BM25-style matching. In **vector-store mode**, use the `documents` lane after an embedding node. Changing mode changes how the inputs are handled; it is not merely a different ranking option on one index.

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| `text` | — | Ingest raw text for index mode. |
| `documents` | — | Ingest embedded documents for vector-store mode. |
| `questions` | `text` | Emit matching text. |
| `questions` | `documents` | Emit matching documents. |
| `questions` | `answers` | Emit matching content as answers. |
| `questions` | `questions` | Enrich the question with matching documents for the Elasticsearch service. |

## Profiles

The directory registers two backends and each keeps its own default: the
Elasticsearch service defaults to **Self-managed Elasticsearch**
(`self-managed`), the OpenSearch service to **Local OpenSearch** (`local`).
Both are marked below; which one applies depends on the service you added
to the pipeline.

| Profile | Backend | Mode |
| --- | --- | --- |
| Self-managed Elasticsearch **(default)** | Elasticsearch | Vector store |
| Elastic Cloud Hosted | Elasticsearch | Vector store |
| Elastic Cloud Serverless | Elasticsearch | Vector store |
| Local OpenSearch **(default)** | OpenSearch | Index |

## Configuration

Select the service and deployment profile before choosing the index or collection and search mode. Elasticsearch and OpenSearch have separate connection fields and separate index implementations, even though both expose the same core input lanes. Set the mode and index deliberately before first ingest; otherwise data can be written to an index with mappings intended for the other mode.

### Elasticsearch

The Elasticsearch profiles are self-managed, cloud-hosted, and cloud-serverless. Self-managed starts with `localhost:9200`; cloud-hosted uses port `9243`, and cloud-serverless uses port `443`. Pick the cloud profile for an Elastic Cloud endpoint so the client uses the correct connection values; keep self-managed for a local or independently hosted cluster.

The index name defaults to `rocketride` and must be 1–255 lowercase letters, digits, `.`, `_`, or `-`. Slashes and spaces are invalid. Configuration validation warns about a bad name or a zero port and then makes a short cluster-health request, so a warning about connectivity is a cue to correct the endpoint or credentials before attempting ingestion.

### Elasticsearch Store Mode and retrieval

Elasticsearch starts in vector-store mode. Turn **Store Mode** off to ingest and search raw text instead. In index mode, documents arriving on the `documents` lane are ignored; use `text`. In vector-store mode, documents must contain embeddings, and semantic questions need an embedding as well. If a pipeline appears to accept input but returns no results, first verify that its lane matches the selected mode.

The Elasticsearch vector store uses a dense-vector mapping, and its similarity defaults to cosine. Use another supported similarity only when the stored embedding model calls for it; an existing vector index should not be treated as metric-agnostic. The standard retrieval-score setting is the cutoff for semantic results: raise it when unrelated chunks contaminate context and lower it when recall is too sparse.

### Retrieval Score

The retrieval-score control is meaningful only for vector-store retrieval. Start with the default when bringing up a new embedding corpus, then raise it if the documents injected into an answer are merely adjacent in topic rather than useful context. Lower it when a precise question has no supporting chunks, but check the embedding model and index dimension first—threshold changes cannot make incompatible vectors comparable.

Tune the score after testing queries that represent the vocabulary and specificity of the actual pipeline. Text-index matches use the BM25-style path instead, so changing this field will not repair unexpectedly broad or narrow keyword results. Use the match operator and phrase controls for that job.

### Elasticsearch text search behavior

Enable **Customize Indexing Search Behavior** only when the default broad matching needs refinement. `or` is the default and is useful for recall; `and` requires all terms when queries are returning too much; `exact` performs phrase matching. **Slop** applies only to `exact` and defaults to `0`; increase it when the same phrase is expected with intervening words.

Enable contextual snippets when downstream consumers need just the matching passage instead of the full stored text. The default snippet size is 250 characters; increase it for more surrounding context and reduce it to keep answer payloads focused. These choices alter searching only, so they can be adjusted between runs without re-ingesting the text index.

The node scans every matching text hit in batches of 500 with a one-minute scroll context. That favors a pipeline which intentionally processes the complete matching set rather than a small top-k result page. Constrain the query or select a more specific index when a broad keyword search would make that full result set too large for downstream processing.

### OpenSearch

OpenSearch uses the configured host, collection, and optional basic-auth credentials. Its local profile starts in index mode, unlike Elasticsearch's vector-store default. The collection defaults to `rocketride` and allows lowercase letters, numbers, and underscores. Choose a new collection before switching a production workload between modes, rather than relying on a common name to be safe for both mappings.

When basic authentication is enabled, a host without a scheme gets `http://`, then an `http://` URL is upgraded to `https://`. The client also disables certificate verification in that branch. This accommodates self-managed clusters with self-signed certificates, but it means the host and authentication toggle jointly determine the connection—not just the text entered in **Host**.

### OpenSearch Store Mode, embedding dimension, and score

Turn **Store Mode** on to create and use an OpenSearch vector index. **Embedding Dimension** is required in that mode and defaults to `768`; it must match every vector you send. A missing, non-numeric, or wrong-sized question embedding is skipped rather than searched, and a document without an embedding is skipped rather than indexed. If a vector query produces nothing without an error, compare the model dimension to this setting first.

**Retrieval Score** defaults to `0.5` and filters lower-scoring OpenSearch vector hits. Raise it for a more precise context window, or lower it when useful matches are missing. The same optional index-search controls—match operator, slop, and contextual snippets—apply only when index mode is active; do not expect them to tune k-NN ranking.

OpenSearch verifies the existing vector mapping before using it. If the index is not a `knn_vector` index or its dimension differs, the implementation deletes and recreates the index. Treat an embedding-dimension change as destructive for that index: use a new collection name when preserving existing data matters.

### OpenSearch text search behavior

With **Store Mode** off, raw `text` input creates a text mapping when the collection does not already exist, and questions use the shared BM25-style search path. Configure match operator, phrase slop, and snippets for the query shape rather than the ingest shape: none of these fields changes how the text is indexed. This makes them safe controls to experiment with between pipeline runs.

The OpenSearch text path emits every matching hit it scans, as answers, text, and documents when the corresponding listeners exist. If a large result set is surprising, narrow the query or use a more restrictive match operator; the node is not limiting text hits to the ten k-NN neighbors used by the vector path.

## Authentication

Elasticsearch cloud profiles use the configured API key. OpenSearch optionally uses the configured username and password when **Use basic auth** is enabled; the connection normalizes the host to HTTPS in that case. Self-managed Elasticsearch supplies no credentials to its client configuration. When OpenSearch authentication is disabled, the implementation does not pass the entered username or password to the client.

## Notes

### Index-mode output behavior

In index mode, the node writes text from the `text` lane and searches it with BM25-style queries. Text search scans all matching results in batches of 500 using a one-minute scroll window, instead of returning only an initial page. Each result can be emitted as an answer, text, and document; with highlighting enabled, the highlighted fragments are emitted in place of the full content.

The `questions` → `questions` lane belongs only to the Elasticsearch service. Do not wire downstream behavior that depends on that enrichment lane when the configured service is OpenSearch, even though both services can emit text, documents, and answers.

In both backends, a highlighted text result replaces the otherwise emitted full content with each returned fragment. This is useful for prompt-sized evidence windows, but it also means a downstream consumer needing the whole source should leave snippets off or retrieve the source through a different flow.

### Vector ingestion and lifecycle

For OpenSearch vector ingest, an application document ID is built from `objectId` and `chunkId`, so writing the same pair updates that record. The vector mapping uses a k-NN field with an HNSW/FAISS cosine setup. Elasticsearch uses its document-store implementation, which batches writes at 500 actions or its payload limit, supports soft deletion through `meta.isDeleted`, and permanently removes matching object IDs with a delete-by-query operation.

The OpenSearch vector path does not silently coerce a bad question vector into a compatible query. It skips missing, non-numeric, or wrong-dimensional vectors, then applies the score threshold to the ten returned k-NN hits. That behavior protects the index from invalid input but can look like an empty retrieval result; confirm the embedding before reducing the score.

Elasticsearch can reconstruct a stored object by fetching chunk ranges in chunk-ID order. That render path is Elasticsearch-only; the OpenSearch service does not implement the equivalent object rendering path in this node.

### Mode-switching checklist

Before switching a pipeline, confirm the selected backend, mode, index name, and—when using OpenSearch vectors—embedding dimension. Then send data on the correct input lane: `text` for index mode or embedded `documents` for vector mode. This avoids the two silent skips in the implementation: document-lane input in index mode and invalid OpenSearch vector input in vector mode.

For a destructive migration, use a new OpenSearch collection name and ingest the new vectors before retiring the old one. Reusing a collection while changing its dimension gives the node a reason to delete and recreate its vector index, which removes the existing indexed data.

## Upstream docs

- [Elasticsearch documentation](https://www.elastic.co/guide/index.html)
- [OpenSearch documentation](https://docs.opensearch.org/)

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

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/store_elasticsearch)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
