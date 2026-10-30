# rocketride_vector

A RocketRide vector store node that stores embedded document chunks and retrieves
them by keyword or semantic similarity from the managed tenant database. Pick it
over the SQL and graph nodes for retrieval-augmented document search.

## What it does

The node writes documents from the documents lane into a pgvector-backed table,
replacing existing chunks for the same object IDs. Questions can produce
matching documents, answers, or enriched questions through the three configured
question outputs. Use it when retrieval should flow through a pipeline. The
same store can be offered to an agent or app as tools once Expose as tools is
on; the write tools also need Allow writes through tools. Both are off by
default because the table lives in the team's managed database. There is no
raw-SQL execution surface.

## Lanes

| Lane in | Lane out | Description |
| --- | --- | --- |
| documents | — | Stores document chunks in the configured vector table. |
| questions | documents | Returns matching documents. |
| questions | answers | Returns matching documents as answers. |
| questions | questions | Enriches a question with matching documents. |

## As a tool

An agent node in the same pipeline sees each function as
`<node id>.<function>`, where the node id is this node's id in the pipeline
(for example `rrvector_1.search`). An app calls `client.tool` with the bare
function name and this node's id (`tool='search', node_id='rrvector_1'`); with
no node id the call goes to the first node in the pipeline that owns a tool of
that name. The functions are offered only while Expose as tools is on, which
is off by default because the table lives in the team's managed database and
`list_documents` and `get` together return all of it. `upsert`, `delete`,
`soft_delete`, and `restore` are offered only while Allow writes through tools
is also on, because they change that table. While a switch is off the affected
functions are left out of the tool list: an agent's call fails with "not found
in tool catalog", an app's `client.tool` call fails with the engine's "No
handler found for tool" error, and a direct call returns a failure object
naming the switch. Both switches are node-wide: every caller who may invoke
tools on the pipeline gets the same functions, and the node applies no
per-user access control of its own. `examples/rocketride-vector-agent.pipe` in
the repository is a chat agent wired to this node's tools.

| Function | Description |
| --- | --- |
| `search` | Searches the store for a non-empty `query`; accepts optional `top_k` and a metadata `filter` (`objectId`, `nodeId`, `parent`) and returns matching content, metadata, and scores. Needs the node's Embedding setting (the embedding sub-block under Parameters) configured; without it the tool returns a failure object naming the node. |
| `objdir` | Lists the distinct parent paths in the table as a map of parent path to one object ID each; accepts optional `parent`, `offset`, and `limit`, and pages count paths. Documents that share a parent path appear as one entry; `list_documents` lists them all. Deleted documents are not listed. Neither listing has an index to use, so every `objdir` and `list_documents` page scans the whole table (`list_documents` a second time for `total`); ask for large pages. |
| `list_documents` | Lists the documents one by one, ordered by object ID, each with `object_id`, `parent`, and `chunk_count`; accepts optional `parent` (exact match), `deleted` (true lists the trash), `offset`, and `limit`. The reply carries `total` (documents matching the filter), `offset`, and `has_more`. |
| `get` | Returns up to `limit` chunks of one document by `object_id`, sorted by chunk ID; use `offset` to retrieve subsequent pages. Each call reads at most 10,000 chunks. The reply carries `total` (the number of chunks fetched), `has_more` (whether another page exists within that fetched set), and `truncated`. When `truncated=true`, the read ceiling was reached: `total` may be incomplete, and even `has_more=false` does not guarantee the whole document was retrieved. The tool pages the document itself, ordering chunks by chunk ID and then content, so `offset` behaves the same on every store. An object ID the table does not hold returns a failure object, and so does a document in the trash: the message says that `restore` makes it readable again while writes through tools are allowed, and that this node does not offer `restore` while they are off. |
| `stats` | Returns the row (chunk) count of the whole table, including the store's one internal schema row and soft-deleted documents, the number of active documents (`document_count`), the embedding model name, and the vector size. |
| `upsert` | Adds or replaces a non-empty `documents` array (content, object ID, optional metadata, optional embedding and model). The chunks sent for one object ID in a call are numbered 0, 1, 2 ... in the order given unless each carries its own `chunkId`, which may not repeat within the call; a later call for the same object ID replaces all of its chunks. Offered only while writes are allowed. |
| `delete` | Deletes the chunks of a non-empty `object_ids` array for good. The reply echoes the distinct IDs and `deleted_count`, their number, not the number of documents found. Offered only while writes are allowed. |
| `soft_delete` | Moves the documents of a non-empty `object_ids` array to the trash: their chunks stay stored but leave `search`, `objdir`, `list_documents`, and `get` until restored. The reply echoes the distinct IDs and `matched_chunks`, the number of chunk rows the table held for them (0 when none exists). Offered only while writes are allowed. |
| `restore` | Takes the documents of a non-empty `object_ids` array out of the trash, with the same reply as `soft_delete`. A document removed with `delete` cannot be restored. Offered only while writes are allowed. |

The functions return `{"success": false, "error": "..."}` for a missing or
invalid input, a missing embedding provider, a refused write, or an object ID
`get` does not find. `upsert` reports database errors the same way. `search`
falls back to a keyword search when the semantic search fails and reports a
failure object only if that fails too; `delete`, `soft_delete`, `restore`,
`objdir`, `list_documents`, `get`, and `stats` raise database errors. `get`,
`objdir`, and `list_documents` require integer pagination values (integer
strings are accepted; booleans and floats are rejected), with `offset` at
least 0 and `limit` at least 1. Invalid values return a failure object without
querying the store. Missing or null values use the defaults: offset 0, limit
100 for `get` and `list_documents`, and limit 1000 for `objdir`. Larger limits
are capped at 100 chunks for `get`, 1000 documents for `list_documents`, and
1000 paths for `objdir`. The object ID `schema` names the store's own control
row and is refused by every function that takes object IDs.

## Configuration

The single cloud profile provides a table, cosine similarity, a score threshold,
and HNSW index defaults. RocketRide provisions a per-tenant database for its
managed database nodes, and this node resolves it from the signed-in RocketRide
identity instead of a host, user, password, or database name you enter. On a
server without a RocketRide cloud database (for example, a local or self-hosted
engine with no database broker) the task fails at start with a message that
says so; use PostgreSQL (pgvector), provider `postgres`, with your own connection
settings there. On RocketRide Cloud, missing broker configuration is a server
configuration error: contact the server operator to restore it and retry.
Bind an
embedding module for semantic search; the embedding dimension is taken from the
first stored document rather than from a configuration field.

### Table

Table defaults to rocketride and is the PostgreSQL table that holds the chunks
and embeddings. Choose a distinct table when separate corpora need separate
retrieval indexes or retention behavior. The node accepts only an unquoted
PostgreSQL identifier: it must start with a letter or underscore, use only
letters, digits, and underscores, and be at most 63 characters. Invalid names
are rejected during configuration validation and at startup.

### Score threshold and similarity metric

Score threshold defaults to 0.5; it is the minimum returned similarity score.
Raise it when loose matches are polluting downstream context, and lower it when
relevant documents are being excluded. Scores are calculated from the
configured metric: cosine uses 1 - distance, L2 uses 1 / (1 + distance), and
inner product negates the returned distance. Regardless of this setting, the
store drops results below its fixed 0.20 minimum similarity floor.

Similarity Metric defaults to cosine; l2 and inner_product are also accepted.
Select the metric that matches the embeddings and expected notion of closeness
before the table is first written, because it chooses the HNSW operator class
used for the index. An unsupported value prevents startup.

### HNSW m and ef_construction

The table's HNSW index is created on first write. HNSW m defaults to 16 and
controls the graph degree; HNSW ef_construction defaults to 64 and controls the
candidate list used while building it. Higher values can improve search quality
at the cost of a more expensive, larger index. Values are clamped to pgvector's
supported ranges (m 2–100 and ef_construction 4–1,000), and ef_construction is
raised to at least twice m. These values do not rebuild an index that already
exists.

### Tool Server Name

The tool-server name defaults to `rrvector`. It labels this node in the
messages the tool functions return (for example a refused write names
`rrvector.delete`); agents and apps address the functions by the node's
pipeline id, which already keeps several vector stores apart.

### Expose as tools

Off by default. When off, the node offers no tool functions: an agent's call
fails with "not found in tool catalog", an app's with the engine's "No handler
found for tool" error, and a direct call returns a failure object. The
documents and questions lanes are unaffected. Turn it on only for a pipeline
whose agent or app is meant to read this table through tools. These reads are
not restricted to the matches above the questions lane's score threshold;
`list_documents` lists every document, `objdir` one object ID per distinct
parent path.

### Allow writes through tools

Off by default, and read only while Expose as tools is on. When off, `upsert`,
`delete`, `soft_delete`, and `restore` are not offered: an agent's call fails
with "not found in tool catalog", an app's with the engine's "No handler found
for tool" error. `search`, `objdir`, `list_documents`, `get`, and `stats` keep
working, and the documents lane still writes. Turn it on only for a pipeline
whose agent or app is meant to manage the documents in this table.

### Database

Database picks which RocketRide cloud database the node uses. It defaults to
Organization, so existing pipelines keep using the database they already had.

- **Organization**: the database shared by everyone in the organization the
  pipeline runs in. Data from before this choice existed lives here.
- **Team**: the database of the run's team. A run from the builder uses your
  current dev team and needs run rights (task.control) on it; a deployed
  pipeline uses the team it is billed to.
- **Personal**: your own database in this organization. It works only when you
  are the person running the pipeline: builder runs, store apps you run, and
  pipelines you deploy for yourself (@me). A pipeline deployed for a team has
  no person behind it, so it fails at start with an error that says so.
  Organization admins can reach members' personal databases, and that access
  is logged.

Each choice is a separate database. Switching does not move or copy data, and
a database you have not used yet is created empty on the first run that needs
it. Documents indexed into one database are not searchable from another; after
switching, send your documents through again to index them into the new one.

A pipeline exposed through a public link (a chat, dropper, webhook, Discord or
Telegram source) runs as you, so visitors' requests use your team or personal
database, not their own.

Access is checked when the run starts. If the run may not use the chosen
database, it does not start, and the error says which database and why. A
self-hosted engine supports only Organization; Team and Personal fail at start
because they need RocketRide cloud. Access is approved for the whole run, not
each node: every node in a run can reach every database the run was approved
for.

## Notes

### Storage and retrieval behavior

The node creates the table on the first write and creates a metric-compatible
HNSW index then. pgvector cannot create that index for embeddings wider than
2,000 dimensions, so the node warns and searches without the index in that
case. Keyword search uses a content LIKE match; semantic search needs an
embedding bound to the question and raises if none is available. Missing tables
produce empty search results rather than an error.

Deleted objects are excluded by default, while document rendering reassembles
stored chunks by chunkId. The store removes all existing chunks for incoming
object IDs before inserting the replacement chunks, preventing duplicate data
for a re-ingested object. The deleted mark is the same one the `soft_delete`
tool sets and `restore` clears: a document in the trash keeps its rows and its
chunk IDs, and the `delete` tool removes rows for good.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `rrvector.allow_write` | `boolean` | **Allow writes through tools**<br/>Permit the upsert, delete, soft_delete and restore tool functions to change this table in your RocketRide cloud database. Applies only while Expose as tools is on. Leave OFF unless a trusted application or agent needs to manage documents through tools; the documents lane and the read tools (search, objdir, list_documents, get, stats) are unaffected. | `false` |
| `rrvector.collection` | `string` | **Table**<br/>Name of the table to store vectors in your RocketRide cloud database. | `"rocketride"` |
| `rrvector.expose_tools` | `boolean` | **Expose as tools**<br/>Offer this table to agents and apps as tool functions: search, objdir, list_documents, get and stats, plus upsert, delete, soft_delete and restore when writes through tools are allowed. Leave OFF unless a trusted application or agent in this pipeline is meant to read the table through tools; objdir and get together return the whole table, not only the matches the questions lane returns. The documents and questions lanes are unaffected. | `false` |
| `rrvector.hnsw_ef_construction` | `integer` | **HNSW ef_construction**<br/>HNSW build-time candidate list size used when the index is first created. | `64` |
| `rrvector.hnsw_m` | `integer` | **HNSW m**<br/>HNSW graph degree (max connections per layer) used when the index is first created. | `16` |
| `rrvector.profile` | `string` | **RocketRide cloud database**<br/>Connect to... | `"cloud"` |
| `rrvector.provider` | `string` |  | const: `"rocketride_vector"` |
| `rrvector.scope` | `string` | **Database**<br/>Organization (default): shared by everyone in the organization. Team: the run's team (your current dev team, or the team a deploy is billed to). Personal: your own, for runs you start yourself. Each is a separate database: switching doesn't move data, and a new one starts empty. | `"org"` |
| `rrvector.score` | `number` | **Score threshold**<br/>Minimum similarity score for a document to be returned by search. | `0.5` |
| `rrvector.serverName` | `string` | **Tool Server Name**<br/>Label for this store in tool-response messages (for example, a refused write names rrvector.delete). Pipeline agents address the available functions as node-id.function; apps use the function name and node ID. Changing this label does not change those addresses. See the node README for the available functions and their tool-exposure and write-permission settings. | `"rrvector"` |
| `rrvector.similarity` | `string` | **Similarity Metric**<br/>The similarity metric to use for vector search. Also selects the HNSW index operator class. | `"cosine"` |
| `rrvector.target` | `string` | **Team or user**<br/>Another team's or user's database (admins only). Leave empty to use your own team's or your own | `""` |

## Dependencies

- `psycopg2-binary`
- `pgvector`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/rocketride_vector)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
