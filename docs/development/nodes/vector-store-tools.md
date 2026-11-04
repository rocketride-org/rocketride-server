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
| `list_documents` | read | `expose_tools` is on and the driver sets `supports_document_listing` |
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
object ID the store does not hold. Pagination values go through
`ai.common.utils.optional_int`: integers or integer strings, bounds checked,
booleans and floats rejected, caps applied silently (100 chunks for `get`, 1000
documents for `list_documents`, 1000 paths for `objdir`).

## The reserved object ID

`DocumentStoreBase.createCollection` writes one control row per collection
under the object ID `schema` (its `isDeleted` is true; it carries the model
name and vector size, read on every collection check). `upsert`, `delete`,
`soft_delete`, `restore` and `get` refuse that ID before any driver call.

## Optional capability: listing documents

`getPaths` lists active documents only, filtering out soft-deleted chunks
before applying the page. It keys its result by parent path, so documents
that share a path collapse into one entry and no chunk count is available.
On most drivers `offset` and `limit` count chunk-0 records, so a page can
hold fewer than `limit` paths while more follow; the two Postgres stores and
Astra group by path first and count paths. `parent` is an exact match except
on Atlas (a case-insensitive pattern) and Qdrant (a text match).
A driver that can do better opts in:

```python
class Store(DocumentStoreBase):
    supports_document_listing = True

    def listDocuments(self, parent=None, offset=0, limit=100, deleted=False) -> List[Dict[str, Any]]: ...
    def countDocuments(self, parent=None, deleted=False) -> int: ...
```

The contract:

- One row per document, `{'object_id': str, 'parent': str | None, 'chunk_count': int}`,
  ordered by `object_id`, then the requested `offset` and `limit` applied.
- `deleted=False` lists active documents, `deleted=True` the soft-deleted ones;
  `chunk_count` counts the chunks in the listed state. The control row is never
  listed.
- `parent` is an exact filter. When a document's chunks carry different parents,
  pick one deterministically (the Postgres drivers take the lowest).
- `countDocuments` returns the number of documents `listDocuments` would page
  through for the same filter.
- Without a collection both return empty (`[]`, `0`), not an error.

The `list_documents` tool asks the driver for `limit + 1` rows to derive
`has_more` from the same read as the page, and `total` from `countDocuments`.
`stats` adds `document_count` (active documents) on such a driver and reports
`null` on the others. Only the literal `True` counts as opting in, so a
stand-in object in a test does not advertise the tool by accident. The two
Postgres drivers implement it with `GROUP BY objectId` and
`COUNT(DISTINCT objectId)`; other drivers keep their tool surface unchanged
until they implement both methods.

## Trash: `markDeleted` and `markActive`

`soft_delete` and `restore` call the driver methods every store already has.
Both may return the number of chunk rows the backend matched, or `None` as
before; the tools report it as `matched_chunks` (`null` when the driver gives
no count) and never claim a count the driver did not give. The Postgres
drivers return the statement's row count; Chroma returns the number of
chunks it updated.

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
  `IInstanceBase` collector where available.
- `nodes/test/test_vector_store_writes_full.py` and
  `nodes/test/test_vector_store_listing_full.py`: both Postgres drivers on a
  real pgvector database (`RR_TEST_PG_DSN`, `RR_REQUIRE_DB_TESTS=1` to fail
  instead of skip), driver methods and tools alike.
- `nodes/test/test_rocketride_vector_tools_full.py`: the managed node's
  switches and shipped profile on the real store.

Run them with the built engine (`dist/engine -m pytest <path> -q -p
no:cacheprovider -c /dev/null`, `--noconftest` for files directly under
`nodes/test/`), as `nodes:test` does.
