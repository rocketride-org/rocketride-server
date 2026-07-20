# weaviate

A RocketRide store node that persists embedded document chunks in a Weaviate instance and retrieves them by semantic or keyword search.

## What it does

Stores pre-embedded documents in a Weaviate collection and answers searches against them. Supports both self-hosted Weaviate and Weaviate Cloud, selected via a profile.

Uses the official **weaviate-client** Python SDK (v4 API): `connect_to_local` for self-hosted instances and `connect_to_weaviate_cloud` for cloud clusters, with connection timeouts of 30 s (init), 60 s (query), and 120 s (insert).

Key behavior to know:

- **Documents must arrive pre-embedded.** Run them through an embedding node first: the collection is created with `Vectorizer.none()`, so Weaviate never embeds anything itself; the pipeline supplies all vectors. A document without an embedding raises an error on ingest.
- **The collection is created automatically** on first write if it does not exist, with an HNSW vector index using the configured distance metric.
- **Re-ingesting is idempotent per document.** Before inserting, all existing chunks with the same `objectId` are deleted, then the new chunks are written via Weaviate's dynamic batch API. If any batch objects fail, the node raises an error.
- **Deletes are soft by default.** Documents can be marked deleted (`isDeleted: true`) and later re-activated; soft-deleted chunks are excluded from every search and get unless the filter explicitly asks for deleted documents. Hard removal by `objectId` is also supported.
- The configured `host` is normalized automatically: leading `http://` / `https://` and trailing slashes are stripped, and the API key is trimmed of whitespace.

---

## Configuration

### Lanes

| Lane in     | Lane out    | Description                                                      |
| ----------- | ----------- | ---------------------------------------------------------------- |
| `documents` | -           | Ingest pre-embedded documents into the collection                |
| `questions` | `documents` | Return matching documents                                        |
| `questions` | `answers`   | Return matching documents as an answer                           |
| `questions` | `questions` | Enrich the question with matching documents for downstream nodes |

The node can also render a stored object back to text: given an object id, it rehydrates all chunks in `chunkId` order (fetched in windows of `renderChunkSize`) and streams the joined text to the text lane.

### Fields

| Field        | Type / Default                  | Description                                                                                  |
| ------------ | ------------------------------- | -------------------------------------------------------------------------------------------- |
| `host`       | string                          | Weaviate server address. Cloud: `<your-instance-name>.weaviate.cloud`. Local default: `localhost`. Scheme and trailing slashes are stripped automatically. |
| `port`       | int: `8080` local, `443` cloud | REST port                                                                                     |
| `grpc_port`  | int: `50051`                   | gRPC port (local profile only)                                                                |
| `apikey`     | string                          | API key. Required for cloud; optional for local (used only when non-empty)                    |
| `score`      | number: `0.5`                  | Minimum retrieval similarity threshold                                                        |
| `collection` | string: `ROCKETRIDE`           | Collection name: must start with an uppercase letter and contain only letters, numbers, and underscores |
| `similarity` | string: `cosine`               | Distance metric: `cosine` · `dot` · `l2-squared` · `hamming` · `manhattan`. Any other value raises an error at startup |
| `renderChunkSize` | int: `33554432`           | Number of chunk ids fetched per window when rendering a full document                          |
| `mode`       | string (set by profile)         | `local` or `cloud`: selects the connection method                                            |

Each ingested chunk is stored with these properties alongside its vector: `content`, `objectId`, `nodeId`, `parent`, `permissionId`, `isDeleted`, `chunkId`, `isTable`, `tableId`, `vectorSize`, `modelName`.

---

## Profiles

| Profile                    | Mode    | Default host                     | Port   |
| -------------------------- | ------- | -------------------------------- | ------ |
| Weaviate cloud server      | `cloud` | _(your Weaviate Cloud endpoint)_ | `443`  |
| Your own Weaviate server   | `local` | `localhost`                      | `8080` |

The preconfig default profile is `cloud`. The cloud profile exposes host, API key, score, and collection; the local profile exposes host, port, gRPC port, score, and collection.

---

## Search behavior

- **Semantic search** runs a `near_vector` query with the question's embedding. The question must carry an embedding (bind an embedding node), and a non-zero result offset is not supported. When the requested limit is 10 or less, the node queries with a limit of 25.
- **Keyword search** matches the question text against chunk content with a `*query*` wildcard `like` filter.
- Both searches apply the document filter (node id, parent, permissions, object ids, chunk id ranges, table flags) and exclude soft-deleted chunks unless deleted documents are requested.
- **Scoring:** with the `cosine` metric the returned distance is mapped to `(distance + 1) / 2`; for all other metrics a sigmoid `1 / (1 + exp(distance / -100))` is used. Results scoring below `0.20` are discarded outright, before the configured `score` threshold is applied.

---

## Configuration validation

When the node config is saved, a fast probe validates it and surfaces problems as warnings:

- The collection name is checked against the official Weaviate rule (`^[A-Z][_0-9A-Za-z]*$`): start with an uppercase letter; only letters, numbers, and underscores; no spaces or special characters.
- Hosts of `localhost` / `127.*` are treated as local, anything else as cloud.
- **Cloud:** an HTTP GET to `/v1/meta` with the API key as a Bearer token (3 s timeout).
- **Local:** the SDK lists collections over REST, then verifies the gRPC port is reachable (channel-ready check, falling back to a plain TCP connect if `grpc` is unavailable).

HTTP error responses are surfaced with their status code and the server's `message`/`error` body so misconfigurations are easy to diagnose.

---

## Authentication

- **Cloud profile:** set `apikey` to your Weaviate Cloud API key, it is passed as `Auth.api_key` credentials.
- **Local profile:** anonymous by default. If `apikey` is set to a non-empty value, it is sent as API-key credentials to the local instance.

---

## Upstream docs

- [Weaviate documentation](https://weaviate.io/developers/weaviate)

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `vector.cloud.host` |  | Enter the server IP address e.g. <your-instance-name>.weaviate.cloud |  |
| `vector.cloud.port` |  |  | `443` |
| `vector.local.grpc_port` |  |  | `50051` |
| `vector.local.host` |  |  | `"localhost"` |
| `vector.local.port` |  |  | `8080` |
| `weaviate.profile` | `string` | **Type of Weaviate host**<br/>Connect to... | `"local"` |
| `weaviate.provider` | `string` |  | const: `"weaviate"` |

## Dependencies

- `authlib`
- `grpcio`
- `grpcio-health-checking`
- `grpcio-tools`
- `httpx`
- `pydantic`
- `requests`
- `validators`
- `weaviate-client`
- `numpy`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/weaviate)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
