# Vector-store tools

Every vector-store node that sits on the shared store base offers the same
tool functions to agents and apps: `rocketride_vector`, `store_astra`,
`store_atlas`, `store_chroma`, `store_milvus`, `store_pinecone`,
`store_postgres`, `store_qdrant` and `store_weaviate`. The functions live in
`VectorStoreToolMixin` (`packages/ai/src/ai/common/store/document_store.py`),
which `StoreInstanceBase` carries; the driver (`DocumentStoreBase`
implementation) owns storage, the mixin owns argument handling, the switches
and the reply shapes. This page is the contract a driver author needs; the
node READMEs describe the functions for the people who call them.

## The tool surface

| Function | Kind | Offered when |
| --- | --- | --- |
| `search`, `objdir`, `get`, `stats` | read | `expose_tools` is on |
| `list_documents` | read | `expose_tools` is on (every driver lists; see below) |
| `upsert`, `delete`, `soft_delete`, `restore` | write | `expose_tools` and `allow_write` are on |

`StoreGlobalBase.beginGlobal` resolves `expose_tools` and `allow_write` from
the merged node config, with class defaults of `True` (a managed store such as
`rocketride_vector` sets both `False` and exposes them as settings). A tool
that is not offered is left out of `_collect_tool_methods`, which the engine
uses for both `tool.query` and `tool.invoke`: an agent never sees it and an
app's `client.tool` call fails with "No handler found for tool". A direct call
on the instance is refused with `{"success": false, "error": "..."}` naming the
switch. Both switches are node-wide policy; the node applies no per-user
authorization.

Every function returns `{"success": false, "error": "..."}` for a missing or
invalid input, a refused write, a missing embedding provider, or (for `get`) an
object ID the store does not hold (`code: "NOT_FOUND"`; a document that is in
the trash is `IN_TRASH`, the reserved ID `RESERVED_ID`). Pagination values go through
`ai.common.utils.optional_int`: integers or integer strings, bounds checked,
booleans and floats rejected, caps applied silently (100 chunks for `get`, 1000
paths for `objdir`, a page counting distinct paths; `list_documents` defaults to
100 documents, clamps to 1000 and says so in `warnings`, and refuses a limit
below 1). The explorer's tools (`dialect`, `chunks`, `vectors`,
`sample`, ...) sit beside these for apps and are specified in
[vector-tool-contract.md](vector-tool-contract.md), which is the authority for
every answer shape; this page covers what a driver author has to implement.

## The reserved object ID

`DocumentStoreBase.createCollection` writes one control row per collection
under the object ID `schema` (its `isDeleted` is true; it carries the model
name and vector size, read on every collection check). `upsert`, `delete`,
`soft_delete`, `restore` and `get` refuse that ID before any driver call.

## Listing documents

`getPaths` lists active documents only, filtering out soft-deleted chunks
before applying the page. It keys its result by parent path, so documents
that share a path collapse into one entry and no chunk count is available.
On most drivers `offset` and `limit` count chunk-0 records, so a page can
hold fewer than `limit` paths while more follow; the two Postgres stores and
Astra group by path first and count paths (every chunk counts, so a document
whose chunks start above 0 is listed too). `parent` is an exact match except
on Atlas (a case-insensitive pattern).

`list_documents` is offered by every driver. It lists one row per document,
paged with a cursor, through `DocumentStoreBase.listDocumentPage`: the default
reads the first chunk of each document through `get`; a driver with a native
listing overrides it (the Postgres drivers group by object ID and count the
page's chunks). The answer carries the explorer's keys (`items`,
`next_cursor`, `total`, ...) and #2704's as aliases: `documents` (rows
`{object_id, parent, chunk_count}`), `total`, `offset` (always 0) and
`has_more`. An `offset` other than 0 is refused with `INVALID_INPUT` naming
`cursor`. `stats` adds `document_count` (active documents, `null` where the
store cannot count them). #2704's opt-in (`supports_document_listing`,
`listDocuments`, `countDocuments`) no longer exists; a driver implements
`listDocumentPage` (and `countDocumentsWhere` / `countChunks` for counts) as
described in the contract, section 2.2.

## Trash: `markDeleted` and `markActive`

`soft_delete` and `restore` call the driver methods every store already has.
Both return the number of chunks the call moved into or out of the trash (0
for a document already in that state), or `None` where the backend cannot
count; the tools report it as `moved_chunks` and never claim a count the driver
did not give (a negative number, a boolean or a string is `null`). The Postgres
drivers return the statement's row count of the rows in the other state (-1,
not known, is `None`); Chroma returns the number of chunks it updated.
`matched_chunks` keeps #2704's meaning, the chunk rows the store holds for the
IDs in either state, counted once for the whole call where the store can count
(otherwise it equals `moved_chunks`).

Both operations must preserve content and all metadata other than
`isDeleted`, and must update every matching chunk even when a document spans
multiple backend query pages (Milvus still reads all matches in one query, so
a very large document, or many documents in one call, can exceed its message
limit). A successful restore makes its paths visible to `objdir` again. Qdrant
updates only the nested flag; Weaviate drains bounded batches of chunks still
in the opposite state, without offsets into a shrinking result set, recounts
the chunks still pending after each batch, pauses when a batch shows no
progress (a replica may lag), and fails the operation instead of looping when
a third batch in a row shows none. The drain keeps two counters, however many
chunks it touches, and pays one count query per batch.

## Verification

- `packages/ai/tests/ai/common/store/`: the mixin on a mock store, one file per
  behaviour (switches, trash tools, listing, `get` not-found, `upsert` chunk
  numbering, `stats`, the base contract), plus the engine's real
  `IInstanceBase` collector where available. The tools run as an agent's call
  (the write gate fails closed without a call context): see `as_agent` in
  `_vectordb_tool_harness.py`.
- `nodes/test/test_vector_store_writes_full.py`,
  `nodes/test/test_vector_store_listing_full.py` and
  `nodes/test/test_pgvector_search.py` (filtered HNSW recovery): both Postgres
  drivers on a real pgvector database (`RR_TEST_PG_DSN`,
  `RR_REQUIRE_DB_TESTS=1` to fail instead of skip), driver methods and tools
  alike.
- `nodes/test/test_rocketride_vector_tools_full.py`: the managed node's
  switches and shipped profile on the real store.

Run them with the built engine (`dist/engine -m pytest <path> -q -p
no:cacheprovider -c /dev/null`, `--noconftest` for files directly under
`nodes/test/`), as `nodes:test` does.
