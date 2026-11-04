# rocketride_vector

A RocketRide vector store node that stores embedded document chunks and retrieves
them by keyword or semantic similarity from a managed RocketRide database: your
organization's, your team's or your own (see Database). Pick it over the SQL and
graph nodes for retrieval-augmented document search.

## What it does

The node writes documents from the documents lane into a pgvector-backed table.
A batch that carries a document's first chunk replaces every chunk stored for
that document; a later batch of the same document adds its chunks, so a long
document that the embedding node sends in several batches is stored whole. A
batch without chunk 0 that repeats a chunk number already stored replaces that chunk
instead of keeping a second copy, and the document's other chunks stay.
Questions can produce matching documents, answers, or enriched questions through
the three configured question outputs. The same store can be offered to an agent
or app as tools once Expose as tools is on, and the Vector Explorer app browses,
maps and edits it through a Tools source; the write tools also need Allow writes
through tools. Both are off by default because the table lives in a managed
database. There is no raw-SQL execution surface.

It stores through the same pgvector driver as the PostgreSQL store
(`store_postgres`); the two differ only in how they reach the database and in
their configuration.

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
is off by default because the table lives in a managed database and `objdir`
and `get` together return all of it. The write functions (`upsert`, `delete`,
`soft_delete` and `restore`) are offered only while Allow
writes through tools is also on, because they change that table. While a
switch is off the affected functions are left out of the tool list: an agent's
call fails with "not found in tool catalog", an app's `client.tool` call fails
with the engine's "No handler found for tool" error, and a direct call returns
a failure object naming the switch. Both switches are node-wide: every caller
who may invoke tools on the pipeline gets the same functions, and the node
applies no per-user access control of its own.
`examples/rocketride-vector-agent.pipe` in the repository is a chat agent
wired to this node's tools.

| Function | Description |
| --- | --- |
| `search` | Searches the store for a non-empty `query`; accepts optional `top_k` and a metadata `filter` (`objectId`, `nodeId`, `parent`) and returns matching content, metadata, and scores. Needs the node's Embedding setting (the embedding sub-block under Parameters) configured; without it the tool returns a failure object naming the node. |
| `objdir` | Lists the stored document paths, optionally under a `parent` path, with `offset` and `limit`. Deleted documents and the collection's control record are not listed. |
| `get` | Returns up to `limit` chunks of one document by `object_id`, sorted by chunk ID; use `offset` to retrieve subsequent pages. The reply carries `total` (the document's chunk count), `has_more`, and `truncated`. The tool pages the document itself, so `offset` behaves the same on every store; a document is read up to 10,000 chunks, and `truncated` is true when that ceiling was hit. |
| `stats` | Reports the number of stored rows, the embedding model and the vector size. |
| `upsert` | Adds or replaces a non-empty `documents` array; each needs `content` and an `object_id`. Offered only while writes are allowed. |
| `delete` | Removes every chunk of the documents in a non-empty `object_ids` array. Offered only while writes are allowed. |
| `list_documents` | Lists the documents one by one with their path and chunk count, in pages ordered by path; pass `next_cursor` for the next page. `deleted: 'deleted'` (or `true`) lists the trash, and `parent` keeps one exact path. |
| `soft_delete` | Moves the documents of a non-empty `object_ids` array to the trash: their chunks stay stored but leave search, `objdir`, `get` and the listing until `restore`. Returns `moved_chunks`, the chunks it moved, and `matched_chunks`, the chunk rows the table holds for those IDs. Offered only while writes are allowed. |
| `restore` | Takes the documents of a non-empty `object_ids` array out of the trash. Offered only while writes are allowed. |

The Vector Explorer reads the store through the same tool surface (`dialect`,
`list_documents`, `chunks`, `vectors`, `sample`, `project`, `neighbors` and the
other functions of the vector tool contract), so it too needs Expose as tools.

Past those two switches, every write still passes the store's write gate. An
agent's `upsert` or `delete` goes through. A call from a Tools source (an SDK
script, or the Vector Explorer) also needs Allow document management from tool
calls, which is off by default, and must come from a Tools source of the
pipeline, addressed to this node. A call the engine did not identify as coming
from an agent or a Tools source is always refused. The collection's control
record (object ID `schema`) can never be removed or overwritten through a tool.

A refused call or an invalid input returns `{"success": false, "code": "...",
"error": "..."}` (a call refused by one of the two switches above carries no
`code`). `get` and `objdir` require integer pagination values, with `offset` at
least 0 and `limit` at least 1; missing or null values use the defaults
(offset 0, limit 100 for `get` and 1000 for `objdir`), and larger limits are
capped at those values.

## Configuration

The single cloud profile provides a table, cosine similarity, a score threshold,
and HNSW index defaults. The node uses the managed database chosen under
Database (Organization by default); the RocketRide server authorizes it for the
run and delivers its connection at task start, instead of a host, user,
password, or database name you enter. On a server without a
RocketRide cloud database (for example, a local or self-hosted engine with no
database broker) the task fails at start with a message that says so; use
PostgreSQL (pgvector), provider `postgres`, with your own connection settings
there. On RocketRide Cloud, missing broker configuration is a server
configuration error: contact the server operator to restore it and retry. Bind
an embedding module for semantic search; the embedding dimension is taken from
the first stored document rather than from a configuration field.

### Table

Table defaults to rocketride and is the PostgreSQL table that holds the chunks
and embeddings. Choose a distinct table when separate corpora need separate
retrieval indexes or retention behavior. The node accepts only an unquoted
PostgreSQL identifier: it must start with a letter or underscore, use only
letters, digits, and underscores, and be at most 63 characters. Invalid names
are rejected during configuration validation and at startup. The name is used
in lower case, as PostgreSQL itself would read it (`MyDocs` is the table
`mydocs`).

The table is shared by every pipeline that names it on the same database: they
all read and write the same rows.

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
`delete`, `soft_delete` and `restore` are not offered: an agent's call fails with
"not found in tool catalog", an app's with the engine's "No handler found for
tool" error.
`search`, `objdir`, `get`, and `stats` keep working, and the documents lane
still writes. Turn it on only for a pipeline whose agent or app is meant to
manage the documents in this table.

### Allow document management from tool calls

Off by default (`allow_writes`), and read only while Expose as tools and Allow
writes through tools are on. Turn it on in the pipeline whose Tools source
should be able to add and remove documents in the table, for example the
pipeline the Vector Explorer manages. Even when it is on, a write is accepted
only from a Tools source of the pipeline, addressed to this node; calls from
the pipeline's chat or ingest sources are refused. Because the table is shared
by every pipeline that names it in the same database, removing a document
removes it for all of them. Agents need only Allow writes through tools.

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

The node creates the table on the first write, with an index on object ID and
chunk ID and, up to 2,000 dimensions, a metric-compatible HNSW index. pgvector
cannot create the HNSW index for wider embeddings, so the node warns and
searches without it in that case. Metadata the table has no column for, such as
a file's size or ingest time, is kept in a `meta` JSON column. A table written by
an earlier version of the node gets that column when the node starts; if
another session holds the table at that moment, the node writes without it for
now (the extra metadata is not stored) and tries again at most once a minute.

Keyword search is a case-insensitive substring match on the question text.
Semantic search needs an embedding bound to the question and raises if none is
available; filtered searches keep scanning the HNSW index until they have enough
rows (pgvector 0.8 and later; with an older pgvector a filtered search can
return fewer rows than its limit, reported as the caveat
`filtered_search_may_underfill`). A filtered search that HNSW still leaves
short is recovered with an exact search on a table that has an approximate
index: when no result meets the score threshold (and the 0.20 floor), the same
search runs again exactly, in the same transaction, with the same filters and
limit. On pgvector 0.8 and later a nonempty result stays approximate and does
not trigger the retry merely because it falls short of the limit; before 0.8
an underfilled result also retries. A table without an approximate index is
never scanned twice, and a search with no limit runs the exact statement at
once. Exact retries can be expensive on large tables, including queries that
genuinely have no matches. Missing tables produce empty search results rather than an error. Deleted
objects are excluded by default (a row with no deletion flag at all counts as
not deleted), while document rendering reassembles stored chunks in chunkId
order.

### Connections

The node opens at most four connections to the database, only when it needs
them, and closes a connection that stayed idle for a minute. Every call runs in
one short transaction that always ends: reads are read-only and limited to 30
seconds per statement, and a batch of writes is applied together or not at all,
one batch at a time across every pipeline writing the table. Nothing is set for
the database session, so the node works through a transaction-mode connection
pooler. Errors never name the database server, user or database.

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `rrvector.allow_write` | `boolean` | **Allow writes through tools**<br/>Permit the upsert, delete, soft_delete and restore tool functions (soft_delete and restore move documents into and out of the trash; delete removes them for good) to change this table in your RocketRide cloud database. Applies only while Expose as tools is on; a call from a Tools source also needs Allow document management from tool calls. Leave OFF unless a trusted application or agent needs to manage documents through tools; the documents lane and the read tools (search, objdir, get, stats, list_documents and the Vector Explorer's) are unaffected. | `false` |
| `rrvector.allow_writes` | `boolean` | **Allow document management from tool calls**<br/>Lets a Tools source of this pipeline add, trash, restore and remove documents through tool calls (the Vector Explorer, and the upsert, soft_delete, restore and delete tools). Off by default, and read only while Expose as tools and Allow writes through tools are on. The table is shared by every pipeline that names it in the same database. | `false` |
| `rrvector.collection` | `string` | **Table**<br/>Name of the table to store vectors in your RocketRide cloud database. | `"rocketride"` |
| `rrvector.expose_tools` | `boolean` | **Expose as tools**<br/>Offer this table to agents and apps as tool functions: search, objdir, get, stats and list_documents (and the Vector Explorer's read tools), plus upsert, delete, soft_delete and restore when writes through tools are allowed. Leave OFF unless a trusted application or agent in this pipeline is meant to read the table through tools; objdir and get together return the whole table, not only the matches the questions lane returns. The documents and questions lanes are unaffected. | `false` |
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

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/nihalnihalani/rocketride-server/tree/develop/nodes/src/nodes/rocketride_vector)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
