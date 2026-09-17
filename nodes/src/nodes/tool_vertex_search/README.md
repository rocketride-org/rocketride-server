# tool_vertex_search

A RocketRide tool node that looks up nearest neighbors in a Google Cloud Vertex AI Vector Search index. Pick it when an agent already has an embedding vector and needs the matching IDs out of an index that is deployed and managed in Vertex AI.

## About Vertex AI Vector Search

Vertex AI is Google Cloud's managed platform for machine-learning models and
the services around them. Vector Search, formerly called Matching Engine, is
its approximate-nearest-neighbor service: an index of embedding vectors is
built, then deployed onto an index endpoint that answers similarity queries at
low latency. Applications on Google Cloud use it as the retrieval layer behind
semantic search and recommendations.

## What it does

The node connects to one deployed Vertex AI Vector Search index when the pipeline starts and holds that endpoint open for the run. It has no data lanes and no invoke connections: its entire surface is a single nearest-neighbor lookup offered to a connected agent. Reach for it when the index already lives in Vertex AI and the pipeline only needs to query it.

It is a query-only tool, not a vector-store adapter. There is no way to add, upsert, or delete vectors through this node, and it does not embed text — the caller supplies the query vector, and indexing stays in Vertex AI.

## As a tool

The server-name prefix is `vertex`, producing this registered function.

| Function | Description |
| --- | --- |
| `search` | Return the nearest neighbors of a supplied embedding vector. |

`search` requires `query_vector`, an array of numbers holding the query embedding. `top_k` sets how many neighbors to request and falls back to `10` when it is omitted, zero, or not a number. `score_threshold` is optional and defaults to `0.0`.

A successful call returns a list of `{id, distance}` objects, one per neighbor, in the order Vertex AI returned them. Failures are not raised: a disconnected index endpoint or an error from the Vertex AI call comes back as a one-item list holding a single `error` key, so an agent should check for that key before treating the result as neighbors.

`score_threshold` is applied by the node after Vertex AI answers, and only when the value is greater than zero — a zero or negative threshold filters nothing. Neighbors whose `distance` is below the threshold are dropped, which assumes similarity semantics where a higher number is a better match, such as an index built with `DOT_PRODUCT_DISTANCE`. It is wrong for a distance metric such as `SQUARED_L2_DISTANCE`, where a lower number is the better match and thresholding this way discards the closest results. Because the filter runs locally on the `top_k` neighbors Vertex AI already returned, a threshold can return fewer than `top_k` results and never more.

## Configuration

Point the node at one deployed index: the region it lives in, the index endpoint, and the deployed index on that endpoint. Those three, plus the credential settings under Authentication, are the whole configuration — there is a single profile and nothing else to choose.

### Index Endpoint ID and Deployed Index ID

These two identify the exact index the tool queries, and both are required — startup fails with an explicit error when either is blank, and configuration validation warns about each one separately while you are still editing. The index endpoint is the deployed serving resource; the deployed index ID names one of the indexes deployed onto it, since an endpoint can carry several. Take both from the Vertex AI console rather than guessing: the deployed index ID is not the index's own resource ID.

### Location

The Google Cloud region holding the index endpoint, defaulting to `us-central1`. It must match the region the endpoint was created in — a valid endpoint ID looked up in the wrong region simply will not be found. Change it whenever the index lives elsewhere, for example `europe-west4`.

## Authentication

The node uses RocketRide's shared Google Cloud credential resolution and requests the `https://www.googleapis.com/auth/cloud-platform` scope.

**Authentication Type** selects between Application Default Credentials and Service Account JSON. Application Default Credentials is the default and suits an engine running on Google Cloud infrastructure with an attached service account, or any host where ADC has already been provisioned. Selecting Service Account JSON reveals **Service Account Key JSON**, an upload field for the key file; it is stored as a secret and is required in that mode.

**Project ID** is optional. Left blank, the project is taken from the uploaded key file or from the ambient default credentials; set it explicitly when the credentials could resolve to a different project than the one holding the index.

Grant the credential enough IAM to read the index endpoint and query the deployed index.

## Limitations

Declared `noremote`: this node runs on the local engine host only and is not available for remote execution. It needs network access to the Vertex AI API and, in Application Default Credentials mode, to whatever credential source the host provides.

## Notes

### Startup checks

Connecting builds the index endpoint handle with the resolved project, region, and credentials passed in directly; the node deliberately avoids `aiplatform.init()`, which would mutate process-global SDK state and affect other nodes in the same runtime. It then lists the endpoint's deployed indexes and fails startup when the configured deployed index ID is not among them, so a wrong ID surfaces at pipeline start instead of as empty search results later. In configuration-only open mode the node skips connecting entirely.

### Missing dependency

`google-cloud-aiplatform` is imported optionally, and its absence is reported as an explicit `ImportError` when the node starts rather than as a confusing failure on the first tool call.

## Upstream docs

- [Vertex AI Vector Search documentation](https://cloud.google.com/vertex-ai/docs/vector-search/overview)
- [google-cloud-aiplatform Python client](https://cloud.google.com/python/docs/reference/aiplatform/latest)

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `vertex.deployedIndexId` | `string` | **Deployed Index ID**<br/>The ID of the deployed index. |  |
| `vertex.indexEndpointId` | `string` | **Index Endpoint ID**<br/>The ID of the Vector Search Index Endpoint. |  |
| `vertex.location` | `string` | **Location**<br/>The Google Cloud region, e.g. us-central1. | `"us-central1"` |
| `vertex.profile` | `string` |  | `"default"` |

## Dependencies

- `google-auth` `>=2.23.3`
- `google-cloud-aiplatform` `>=1.40.0`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/tool_vertex_search)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
