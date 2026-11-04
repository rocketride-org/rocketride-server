# Vector store tool contract

The interface between the vector store nodes and Vector Explorer
(`apps/vector-ui`): the optional driver hooks on `DocumentStoreBase`, the tools
on `VectorStoreToolMixin` and their JSON, the pipeline shape the app expects,
and the write gate. Read it before changing a store driver, the store tools, the
`embed` tool on the embedding nodes, or the app's tool calls.

Where it lives in code:

| What | File |
| --- | --- |
| Hook signatures and base defaults | `packages/ai/src/ai/common/store/document_store.py` (`DocumentStoreBase`) |
| Hook value types and vocabularies (codes, capabilities, caveats), the `list_documents` filter (`DocListFilter`, `parse_doc_list_filter`) | `packages/ai/src/ai/common/store/vx_types.py` |
| The additive tools (`recommend`, `similarity_matrix`, §4.4), mixed in ahead of the explorer tools | `packages/ai/src/ai/common/store/vx_tools_ext.py` (`VectorExplorerExtTools`) |
| Hook and tool exceptions | `packages/ai/src/ai/common/store/errors.py` |
| Write-switch defaults and tool limits (the single source) | `packages/ai/src/ai/common/store/vx_defaults.py`, exported to `apps/vector-ui/tests/fixtures/defaults.json` by `apps/vector-ui/scripts/gen_defaults.py` |
| Call context of a tool invoke | `packages/ai/src/ai/common/tool_context.py` |
| Tool audience | `@tool_function(audience=...)` in `packages/server/engine-lib/rocketlib-python/lib/rocketlib/filters.py` |
| The app's view of every answer | `apps/vector-ui/src/contract/types.ts` |
| Example answers | `apps/vector-ui/tests/fixtures/provisional/` (hand-written), `apps/vector-ui/tests/fixtures/v1/live/` (captured) |

A change to any signature, JSON shape, code or limit here is a contract change:
update this page, the files above and the app's contract types in the same change.

How the app, the shared Explorer library and these nodes fit together, and
which suites test them, is in `apps/vector-ui/docs/development.md`.
What users see is in `apps/vector-ui/README.md`.

Path legend: `ds` = `packages/ai/src/ai/common/store/document_store.py`; `sgb` = `.../store_global_base.py`; `sib` = `.../store_instance_base.py`; `dm` = `packages/client-python/src/rocketride/schema/doc_metadata.py`; `df` = `.../doc_filter.py`; `q` = `.../question.py`; `dc` = `packages/ai/src/ai/modules/data/data_conn.py`; `cmd_data` = `packages/ai/src/ai/modules/task/commands/cmd_data.py`; `host` = `packages/ai/src/ai/common/agent/_internal/host.py`; `flt` = `packages/server/engine-lib/rocketlib-python/lib/rocketlib/filters.py`; `types` = `.../rocketlib/types.py`. Line references (`file:line`) point at the code as it stood before this contract was implemented and drift as the code changes.

---

## 1. Principles

1. **The app never talks to a database.** Every call is a tool call on a node of the user's pipeline through the engine, which checks `task.data` on the calling task (`cmd_data.py:136`) and dispatches by node id inside the task subprocess (`dc:1001-1037`). Tool names are bare method names (`flt:1116-1127`); the app always passes `nodeId`.
2. **Optional, non-abstract hooks** on `DocumentStoreBase`. A driver that does not override a hook gets the base default or `StoreUnsupported`, which the mixin maps to `{success:false, code:'UNSUPPORTED'}`. No driver is rewritten to ship.
3. **Logical key** is `(objectId, chunkId)`. Every hook and tool excludes `objectId == 'schema'` (the control record, `ds:505-535`) from listings and refuses it on every external write path (§6.3). Chunk 0 is the preferred display row; a document without chunk 0 is still a document.
4. **Envelope.** Every tool returns `{success:true, ...}` or `{success:false, code, error, detail?}` and never raises past the tool boundary.
5. **Tool-call caps are enforced on the node**; the client copies them for UX. Upload limits are enforced by the app: a file over a limit is excluded before it is sent, not ingested. The parser does not apply the templates' `parse_1.config.index.maxFileSize` (it reads the cap from a task configuration section the engine does not build from a `.pipe`; a phase-0 pin fails the day it does), and the engine does not enforce bytes written in this release.
6. **No reply carries a host, DSN, credential or tenant database name.** The live tool-path suite asserts this with the fixture values and a keyword regex over non-content fields.
7. **One similarity definition for visuals.** `sim` in `sample`, `project` and `neighbors` is recomputed from raw vectors by the store's metric in `vx_math.similarity`; the driver's own `score` is reported separately and labelled by `dialect.score`.
8. **Writes are gated on the node and the gate fails closed** (§6).
9. **Raw vectors leave the node only through `vectors` (≤2 keys).** Positions come from server-side PCA. A `vectors` answer exceeds the 2 KB tool-trace window (`dc:58,77-90`); when a run is traced its first 2 KB persist in the run log and the README's privacy paragraph says so.
10. **Agent catalogs do not change.** Explorer tools are DAP-only (`audience`, §4.0). The six legacy tools keep their descriptors (`inputSchema`, `description`, `outputSchema`, as `_build_tool_descriptors` builds them, `flt:1141-1190`) byte-identical, and keep their legacy output keys and semantics; every extension is additive. An agent sees exactly today's six descriptors.
11. **Pooler-safe SQL.** Every pgvector read or write is self-contained in one transaction: session-level `SET` is never used, because the managed store reaches tenant databases through a transaction-mode pooler (`nodes/scripts/tasks.js:94-97`; the live suites run a second pass through PgBouncer with `pool_mode = transaction`).

---

## 2. `DocumentStoreBase` extension (`ds`, after line 111; new modules beside it)

New files in `packages/ai/src/ai/common/store/`: `errors.py` (`StoreUnsupported`, `StoreError`, `ToolRefusal`), `vx_types.py`, `vx_math.py`, `vx_sample_cache.py`, `vx_tools.py` (the explorer tool methods, mixed into `VectorStoreToolMixin`), `vx_write_gate.py`, `vx_defaults.py` (`VECTOR_ALLOW_WRITES_DEFAULT = False`), `pgvector/` (`driver.py`, `pool.py`, `sql.py`).

### 2.1 Types (`vx_types.py`)

```python
Deleted = Literal['active', 'deleted', 'all']
Key = Tuple[str, int]  # (objectId, chunkId)


@dataclass(frozen=True)
class StoreInfo:
    backend: str  # 'pgvector'|'qdrant'|'chroma'|'milvus'|'weaviate'|'pinecone'|'astra'|'atlas'
    backend_version: Optional[str]
    collection: Optional[str]  # collection/table name, never the database name; None when absent
    collection_exists: bool
    control_record: Optional[bool]  # None when the collection does not exist
    meta_column: Optional[bool]  # pgvector only: False while the ALTER is pending; None elsewhere
    metric: Optional[str]  # 'cosine'|'l2'|'ip'|None
    dimension: Optional[int]
    model: Optional[str]
    index: Optional[Dict[str, Any]]
    size_bytes: Optional[int]
    caveats: List[str]


@dataclass(frozen=True)
class DocumentRow:
    objectId: str
    path: str
    chunks: Optional[int]
    has_first_chunk: bool
    deleted: bool
    tables: Optional[int]
    nodeId: Optional[str]
    size: Optional[int]
    modifyTime: Optional[int]
    ingestedAt: Optional[str]
    pointId: Optional[str]


@dataclass(frozen=True)
class DocPage:
    items: List[DocumentRow]
    next_cursor: Optional[str]
    total: Optional[int]
    counts_exact: bool
    distinct: bool
    sorted: bool
    caveats: List[str]
    filter_ignored: Tuple[str, ...] = ()  # §4.4-A: the given filter keys the hook did not apply


@dataclass(frozen=True)
class ChunkPage:
    docs: List[Doc]
    has_more: bool
    next_after: int  # docs never carry embeddings


@dataclass(frozen=True)
class KnnGraph:
    k: int
    offsets_row: np.ndarray
    cols: np.ndarray
    sims: np.ndarray
    source: str  # 'native'|'node'


@dataclass(frozen=True)
# the `list_documents` filter (§4.4-A); every field Optional, None = not filtered
class DocListFilter:
    path_prefix: str
    file_types: Tuple[str, ...]
    ingested_after: str
    ingested_before: str
    min_chunks: int
    max_chunks: int
    has_first_chunk: bool
    has_tables: bool
    path_contains: str

    def given(self) -> Tuple[str, ...]: ...  # the keys it sets, in DOC_LIST_FILTER_KEYS order


# ValueError(sentence) -> INVALID_INPUT; None when it sets nothing
def parse_doc_list_filter(value) -> Optional[DocListFilter]: ...
```

`parse_doc_list_filter` refuses: a filter that is not an object, an unknown key, text that is not text or is longer than 1,024 characters (`DOC_LIST_FILTER_TEXT_MAX`), a date not in ISO-8601's extended form, a chunk count that is not a whole number of 0 or more, `min_chunks > max_chunks`, a flag that is not a boolean, more than 32 `file_types` (`DOC_LIST_FILTER_TYPES_MAX`) or one that is not an extension. It normalises dates to UTC `YYYY-MM-DDTHH:MM:SSZ` (the stored `ingestedAt` form, so the bounds compare as text; no offset means UTC) and extensions to lower case without the dot; an empty text or list is the same as leaving the key out. The value lists of the additive answers are constants beside the vocabularies: `FILTER_APPLIED_VALUES`, `LISTING_REASONS`, `CLUSTER_METHODS`, `CLUSTER_LABEL_SOURCES`, `RECOMMEND_STRATEGIES`, `MATRIX_SOURCES`, `KEYWORD_MATCHES`.

### 2.2 Hooks (all non-abstract; defaults in the base)

```python
class DocumentStoreBase(ABC):
    # existing abstract API unchanged: count_documents, searchKeyword, searchSemantic, get, getPaths, addChunks, remove, markDeleted, markActive, render
    # except that markDeleted / markActive return Optional[int]: the chunks moved into / out of the trash (§4.5), or None

    # introspection (type(self).hook is not DocumentStoreBase.hook) plus driver constants
    def capabilities(self) -> FrozenSet[str]: ...

    # Default: control record via doesCollectionExist() (ds:429-442), configured similarity; version/index/size None. Never raises for a missing collection.
    def describe(self) -> StoreInfo: ...
    # default {'formula':'unknown','higher_is_better':True,'floor':0.2,'threshold':self.threshold_search}
    def scoreInfo(self) -> Dict[str, Any]: ...

    # docFilter.minScore when set (may be -inf), else the driver's legacy floor. Agents never set minScore: unchanged results.
    def effectiveFloor(self, docFilter: DocFilter) -> float: ...

    def countChunks(self, docFilter: DocFilter) -> Optional[int]: ...  # default None
    def countDocumentsWhere(self, docFilter: DocFilter) -> Optional[int]: ...  # distinct objectIds; default None

    # Default (distinct=False, sorted=False): get(DocFilter(chunkIds=[0], deleted=deleted, limit=limit+1, offset=cursor.offset)),
    # sorted by (parent, objectId) within the page; chunks=None; counts_exact=False; total=None; caveat 'documents_by_first_chunk'.
    # The opaque cursor is {'o': offset, 'f': first key of the previous page}. When a page's first key equals cursor['f'],
    # the backend ignored the offset: the page ends with next_cursor=None and caveat 'documents_paging_unsupported'.
    # A native override validates its own cursor and raises invalidCursor() for one it did not issue (the tool answers
    # INVALID_INPUT 'cursor must be the next_cursor of a previous page.'); invalidCursor and defaultCursorState are
    # exported by document_store. A plain ValueError from the hook stays STORE_ERROR.
    # §4.4-A: `filter` is handed over only when the driver declares documents_filter; the default applies no key and names every given one in filter_ignored.
    def listDocumentPage(
        self,
        *,
        cursor: Optional[str],
        limit: int,
        object_ids: Optional[Sequence[str]],
        deleted: Deleted,
        sort: str,
        filter: Optional[DocListFilter] = None,
    ) -> DocPage: ...

    # Default: get(DocFilter(objectIds=[objectId], minChunkId=after_chunk+1, maxChunkId=after_chunk+limit, deleted=deleted)) sorted by chunkId.
    def scrollChunks(self, objectId: str, *, after_chunk: int, limit: int, deleted: Deleted) -> ChunkPage: ...

    # (docs WITH embeddings, strategy_used in {'random','stratified','first'}). strategy='stratified' is native where cheap
    # (pgvector ROW_NUMBER() OVER (PARTITION BY objectid ORDER BY random()); Atlas $sample per $group) and otherwise raises
    # StoreUnsupported so the base sampler falls back (§2.4). Default: raise StoreUnsupported.
    def sampleChunks(
        self, *, n: int, seed: int, strategy: str, docFilter: DocFilter, include_keys: Sequence[Key]
    ) -> Tuple[List[Doc], str]: ...

    # Vectors by key, BY FILTER (objectId IN ... AND chunkId IN ..., paired client-side, deleted='all'). A driver with deterministic
    # ids may try retrieve/get/fetch(ids=[uuid5(NAMESPACE_URL, f'{objectId}#{chunkId}')]) first and MUST fall back to the filter
    # for every miss (legacy rows have uuid4 ids). Each Doc carries metadata.pointId. Default: raise StoreUnsupported.
    def getVectors(self, keys: Sequence[Key]) -> List[Doc]: ...

    # kNN graph over the sampled keys. Default: vx_math.knn over the cached vectors (source='node'). Qdrant: search_matrix_offsets(
    # sample=len(keys), limit=k, query_filter=has_id(pointIds)) (source='native'; qdrant_client.py:657) up to 500 keys.
    def knnGraph(self, keys: Sequence[Key], vectors: np.ndarray, metric: str, k: int) -> KnnGraph: ...

    # Rows actually removed. Default: n = countChunks(DocFilter(objectIds=ids, deleted='all')); self.remove(ids); return n.
    def removeCounted(self, objectIds: List[str]) -> Optional[int]: ...
    # Permanently remove only the chunks of the ids that are in the trash, in ONE store operation (the deleted
    # flag is in the delete's own filter). Default: raise StoreUnsupported (there is no safe default).
    def removeTrashed(self, objectIds: List[str]) -> Optional[int]: ...

    @staticmethod
    # docFilter.deleted if set, else isDeleted None/False -> 'active', True -> 'all'
    def resolveDeleted(docFilter: DocFilter) -> Deleted: ...
```

The listing and count hooks are named `listDocumentPage` and `countDocumentsWhere`. The names `listDocuments` and `countDocuments` belong to the agent tools' simple document listing (PR #2704: `listDocuments(parent, offset, limit, deleted)` and `countDocuments(parent, deleted)`), so no explorer class defines them; `nodes/test/test_vector_hook_names.py` pins this.

`capabilities()` returns the hooks named in the class constant `DocumentStoreBase.VX_HOOKS` that the driver overrides, plus the names in the class constant `DocumentStoreBase.VX_DRIVER_CAPABILITIES`: an empty frozenset in the base, which a driver overrides with what its backend does natively beyond the hooks (such as `sample_stratified_native`, `knn_native`, `documents_distinct`, `documents_sorted` or `search_keyword`; the vocabulary is `vx_types.CAPABILITY_KEYS`).

The additive extensions (§4.4) add to the hooks: `listDocumentPage(..., filter: Optional[DocListFilter] = None)` (the base default ignores it and names every given key in `DocPage.filter_ignored`, and the tool then answers `filter_applied: 'none'`), and the class constant `VX_KEYWORD_MATCH` (`'substring' | 'token' | None`, base `None`) reported as `dialect.keyword_match`. A driver that applies the filter declares `documents_filter` in `VX_DRIVER_CAPABILITIES`; one that ranks Qdrant's `best_score` recommendation natively declares `recommend_best_score`.

Base-class changes that ride along: `doesCollectionExist(modelName)` **keeps today's read-path behaviour** (never refuses on model); the comparison is exposed as `describe().caveats` `model_mismatch` and `dialect.health.model_mismatch`, and `search` adds `warnings:['model_mismatch']`. `BaseException` for non-zero offsets (`qdrant.py:404`, `chroma.py:536`, `milvus.py:365`, `weaviate.py:404`, `pinecone.py:278`) becomes `ValueError`. **The control-record path is untouched:** `createCollection` keeps calling `self.addChunks([doc], checkCollection=False)` (`ds:535`); no driver refuses `schema` inside `addChunks`.

### 2.3 Schema changes (`packages/client-python/src/rocketride/schema/`)

- `DocFilter` gains `deleted: Optional[Literal['active','deleted','all']] = None` and `minScore: Optional[float] = None`.
- `DocMetadata(pInstance)` defaults (`dm:126-139`) gain extras `size`, `modifyTime` (from `Entry`) and `ingestedAt` (UTC ISO-8601) (`VX_METADATA_EXTRAS`). Stored as payload by Qdrant/Chroma/Weaviate/Milvus, in `meta jsonb` by pgvector when the column exists, dropped by Astra/Atlas, null in `list_documents` when absent. `DocumentStoreBase.__init_subclass__` routes every driver's `addChunks` through `vxWritableChunks()`, which hands a driver copies without the extras unless `vxStoresExtras()` is true: the class constant `VX_STORES_EXTRAS` when the driver sets it (pgvector sets `True`), else false for the pgvector backend and the column-per-key drivers and true for the payload stores. A driver whose backend refuses unknown keys sets `False`.
- `QuestionText.__str__` returns `self.text` (`q:270-285`); drivers also read `query.text` explicitly.

### 2.4 Numpy helpers (`vx_math.py`, pure, golden-tested with fixed seeds)

```python
def similarity(metric, A, B, block=512) -> np.ndarray             # cosine: normalised dot; ip: dot; l2: 1/(1+d)
def pca(X, k=3) -> (coords, explained_variance_ratio, mean, basis) # float32 SVD; sign fixed: largest |loading| positive
def knn(metric, X, k) -> (offsets_row, cols, sims)                 # Qdrant offsets shape, exact, blocked
def density(offsets_row, sims) -> np.ndarray
def outliers(dens, pct=1.0) -> List[int]
def duplicates(offsets_row, cols, sims, threshold=0.97) -> List[Tuple[int,int,float]]
def stratified_pick(rows_by_doc: Dict[str, List[Key]], n, seed, pinned) -> List[Key]   # pinned, then lowest chunk of every doc, then round-robin
def knn_overlap(offsets_row, cols, positions, k=15) -> float       # layout-quality metric
```

**Sampling algorithm (`vx_tools.sample`).** (1) Pin `include_keys`. (2) If the driver's `sampleChunks('stratified')` is native, take the remainder from it (`strategy_used='stratified'`, `biased:false`). (3) Otherwise, when `listDocumentPage` returned exact `chunks`, synthesise `(objectId, 0..chunks-1)` for ≤500 documents, run `stratified_pick`, and read through `getVectors`; **every miss** (non-contiguous ids, chunk-0-less documents) is refilled from `sampleChunks('random')`, else `'first'`, until `n` real rows or the collection is exhausted; the answer reports the actual `n`, `strategy_used` of the fill and `biased:true` when any refill happened. (4) Without counts: pin the chunk-0 row of every listed document (≤500) and fill as in (3). Pinned by mock-driver tests with chunk ids {3,7,64} and with `chunks=None`.

### 2.5 Sample cache (`vx_sample_cache.py`)

Per store instance: LRU of 2 entries, 600 s TTL, keyed by `sample_id = 's-<seed>-<8 hex of sha1(keys)>'`, holding `keys`, float32 vectors, PCA mean/basis, metric, dimension, mode, pointIds. One `threading.Lock` per instance: a second `sample`/`project` while one runs answers `BUSY`. Light mode refused above 2,000 points when `dimension × n × 4 > 64 MB` (`LIMIT_EXCEEDED`). A removal or a trash write through the driver (`remove`, `removeCounted`, `markDeleted`, `markActive`) drops the cached samples (`vxForgetSamples`), so `project`, `neighbors` and `similarity_matrix` never serve a point that left the collection or went to the trash; the next call answers `SAMPLE_EXPIRED` and the app draws again. An upload (`addChunks`) keeps them.

---

## 3. Per-driver implementation notes (what each driver overrides)

| Driver | describe | counts | listDocumentPage | scrollChunks / getVectors | sampleChunks / knnGraph | removeCounted | Repairs bundled |
|---|---|---|---|---|---|---|---|
| **pgvector**: `store_postgres` + `rocketride_vector` via `ai.common.store.pgvector.driver.PgVectorStore` | catalog (`format_type(atttypmod)`, `pg_indexes`, `pg_total_relation_size`, `SHOW server_version`, `to_regclass`, `information_schema.columns` for `meta`) | `COUNT(*) WHERE`; `COUNT(DISTINCT objectid)` | a page's keys from `GROUP BY objectid` over `min(parent)` alone (keyset cursor `(path, objectId)`), then `COUNT(*)`, `bool_or(chunkid=0)`, `bool_or(isdeleted)`, `COUNT(*) FILTER (WHERE istable)` and `(array_agg(meta ORDER BY chunkid))[1]` (omitted when no `meta` column) for that page's objectIds only; the total is counted on the first page and carried in the cursor; `distinct=True`, `sorted=True` | `ORDER BY chunkid OFFSET`; `WHERE objectid = ANY(%s) AND chunkid = ANY(%s)` → `.tolist()` | ordered by a seeded hash of each row's id (`hashtextextended(id::text, seed)`), so nothing is set for the session (`setseed` would leak to the next client of a transaction pooler): stratified native (each document's rows ranked chunk 0 first, then by one hash; the ranks taken in the order of a second, independent hash), random (one hash); knnGraph default | the `DELETE` row count | **D1** insert from a column allowlist (`TABLE_COLUMNS`) with `psycopg2.sql.Identifier`; unknown keys → `meta jsonb`. **Meta column:** `ALTER TABLE ... ADD COLUMN IF NOT EXISTS meta jsonb` runs once at instance open in its own transaction with `SET LOCAL lock_timeout = '2s'`, never inside a batch write; on lock failure the instance writes without `meta` (extras dropped, caveat `extras_not_stored`, `health.meta_column:false`) and retries at most once per 60 s on later writes; reads tolerate a missing `meta`. **D2/D5** `ConnectionPool` (`ai.common.connection_pool`), lazy, min 0, max 4, idle release 60 s; **every read transaction** runs, in order, `SELECT '[0]'::vector` (loads the extension library; no `LOAD`), `SET TRANSACTION READ ONLY`, `SET LOCAL statement_timeout`, `SET LOCAL hnsw.iterative_scan = strict_order`, the query, then commit/rollback in `finally`; writes under one lock in one transaction. **D6** stats via control record. **D8** `ORDER BY chunkid OFFSET` in `get`. `getPaths` excludes `schema`/deleted, `ORDER BY parent`. Keyword on `query.text`. Floor via `effectiveFloor`. A NULL `isdeleted` reads as active. Re-ingest delete only in the batch holding chunk 0. New tables get an `(objectid, chunkid)` index and, up to 2,000 dimensions, an HNSW index; every write transaction first takes the table's advisory lock (`pg_advisory_xact_lock`). An index name longer than 63 characters becomes `<prefix>_<digest>_<suffix>` (8 hex of the table name's SHA-1), so two long tables never share one. The extras go to `meta` (`VX_STORES_EXTRAS = True`). Before pgvector 0.8 there is no iterative HNSW scan and `describe()` adds the caveat `filtered_search_may_underfill`. `rocketride_vector` joins `StoreGlobalBase`/`StoreInstanceBase`, `classType ['store','tool']`, `capabilities ['invoke']`, `rrvector.allow_writes` (it gains tools only together with the write gate). **Legacy table shape** (seeded for the live suites): old DDL + `signature text`, no `meta`, serial ids, hand-inserted control row, one document missing chunk 0. |
| **qdrant** | `get_collection` | `count(exact=True)`; documents = `count(chunkId==0 ∧ isDeleted==false ∧ objectId≠schema)` with caveat `documents_by_first_chunk` | scroll chunk-0 with `next_page_offset` cursor (`sorted=False`), `facet(key='meta.objectId', facet_filter objectId∈page, exact=True)` for counts; orphan sweep `facet(limit=1000)` minus the chunk-0 set (`has_first_chunk=False`; above 1,000 → `document_count_capped`) | `scroll(order_by='meta.chunkId')`; `retrieve(ids=[uuid5...], with_vectors=True)` fast path, filter scroll for misses | `query_points(query=SampleQuery(sample=Sample.RANDOM), with_vectors=True)` → `'random'`; **knnGraph native** via `search_matrix_offsets` (`knn_source:'native'`) for samples of at most 500 points (`Store.NATIVE_KNN_MAX`); a larger sample, or a native failure, gets the node's graph (`knn_source:'node'`), so the app reads `knn_source` per sample, not `capabilities.knn_native` | count then delete by filter | offset-as-point-id → cursor; deterministic ids for new writes; `parent` `MatchValue`; non-zero offset → `ValueError`; floor; `exact=True` kept (caveat `brute_force_search`); Dot scores `(1 + dot) / 2` (was a sigmoid of `dot / 100`, which put every result near 0.5), `scoreInfo.range` null for Dot. Merged from develop (#2704): `getPaths` reads `offset + limit` points in scroll requests of at most `_OBJDIR_SCROLL_PAGE` (1,000), following `next_page_offset`, so no request exceeds a collection's `max_query_limit`. |
| **chroma** | `metadata['hnsw:space']`, `count()` | `len(get(where, include=[])['ids'])` (O(N), cached per §4.2 `stats`); documents None | `get(where={'chunkId':0}, include=['metadatas'], offset, limit)` + one `get(where objectId $in page, include=[])`; `sorted=False` | native offset; `getVectors` by `$and` filter with `include=['embeddings','metadatas']` | random offset page → `'first'`; knnGraph default | count then delete | score `(d+1)/2` → `(2-d)/2`; floor; objdir key (`:586`); `render` (`:797`); `markDeleted`/`markActive` (`:721,745`); `isTable=False` (`:398`); tri-state; deterministic ids. Merged from develop (#2704): `markDeleted` / `markActive` update in slices of the batch limit the client reports (`get_max_batch_size()`), else in one call. |
| **milvus** (mock) | `describe_collection`, `describe_index` | `count(*)` with filter; documents None | chunk-0 `query(offset, limit)` + per-page counts; `sorted=False` | native; by filter | default | count then delete | `meta: model_dump(exclude_none=True)` (`:506`); `render` (`:662`); quoted filters (`:203-213`); keyword on text; chunk-0-batch delete; L2 sigmoid → `1/(1+d)`; the driver keeps develop's cut at the node threshold unless `DocFilter.minScore` is set (then it cuts at `minScore`). Merged from develop: `getPaths` writes the boolean as `false` (the node's own filter for chunk 0 of live documents, never the control record). |
| **weaviate** (mock) | `config.get()` | `aggregate.over_all(total_count=True)`; documents via `GroupByAggregate` | `GroupByAggregate(prop='objectId')` + chunk-0 fetch; `sorted=False` | `fetch_objects(include_vector=True, after=uuid)`; by filter | uuid order → `'first'` | count then `delete_many` | objdir `TypeError` (`:459`); inversion (`:321`); floor; keyword; offset (`:431`); every-call delete; uuid5 keyed ids. Merged from develop (#2704): `_setDeleted` drains the chunks in the other state a page at a time and recounts the pending chunks after each page; a page that leaves the count where it was is a stall (a lagging replica, or an update that did not persist): it pauses `_REPEAT_PAUSE_SECONDS` and goes on for `_MAX_STALLS` stalls in a row, then fails with `isDeleted=… did not persist on N chunk(s)`. |
| **pinecone** (mock, cloud) | `describe_index` | None; None | `fetch_by_metadata(filter={'chunkId':0}, limit≤1000, pagination_token)`; `sorted=False` | token paging; `fetch(ids)` fast path, filter for misses | serverless `list`+`fetch` → `'first'`; pod → UNSUPPORTED | None | `get` top_k ≤1000 paged; None metadata; `threshhold_search` typo; keyword → UNSUPPORTED (develop's `$contains` keyword search never reached Pinecone: it handed its filter dict to `get`, whose `_convertFilter` raised `AttributeError`, and Pinecone's metadata filters have no `$contains` operator); every-call delete; tri-state. |
| **astra** (mock, cloud) | `collection.definition()` | `count_documents(filter, upper_bound=1000)`; documents None | chunk-0 `find` + per-page counts; `sorted=False` | `find(sort chunkId, projection={'$vector':True})`; by filter | default | count then `delete_many` | `aggregate` AttributeError (`:346`); `meta` dump (`:425`); `upper_bound` (`:248`); offset (`:312`); floor. Merged from develop (#2704, #2912): `count_documents` counts up to 10,000 and, past that or past the server's own limit (`TooManyDocumentsToCountException`), answers the server's estimate but never less than the count known to be exceeded; `getPaths` follows every server page of an unsorted `find` (a sorted one returns at most 20 documents), keeps each path's lowest object id and pages the sorted paths locally. |
| **atlas** (mock, cloud) | `list_search_indexes` | `count_documents`; `$group` | `$group` + `$skip/$limit`, `$sort` by path → `sorted=True` | `find` skip/limit; by filter | `$sample` → `'random'`; stratified native (`$sample` per group) | `deleted_count` | double-normalised score (`:543`); floor; `meta` dump (`:348`); `knnVector` caveat; `UnboundLocalError` (`:268-275`); info logging removed. |
| **elasticsearch/opensearch** | out of v1 (no mixin); never a card | | | | | | |

`support` per provider (reported by `dialect`): `postgres`, `rocketride_vector`, `qdrant`, `chroma` = `'supported'` once their **unmocked** live suite passes on both a new and a legacy collection (and, for the two pgvector providers, under the pooler pass); `milvus`, `weaviate`, `pinecone`, `astra_db`, `mongodb+srv` = `'experimental'`. The value is the driver's class constant `DocumentStoreBase.VX_SUPPORT` (base default `'experimental'`, for which `dialect` also adds the `experimental` caveat); a driver sets `'supported'` only on that evidence. **A mocked `services.json` case or a mock-driver unit test never flips `support`**.

**Mocks.** `nodes/test/mocks/` shadows every store client engine-wide under `ROCKETRIDE_MOCK` (`nodes/scripts/tasks.js:196-215`). A driver change that uses a new native client call adds it to the mock of that client (`psycopg2.sql` with `Identifier`/`SQL`/`Composed`; qdrant `facet`, `count`, `retrieve`, `search_matrix_offsets`, `SampleQuery`; chroma `get(include=['embeddings'])`; etc.). A mock change is paired with the same assertion in the unmocked suite where one exists.

**Legacy collections.** Written by today's drivers: uuid4 point ids, chunk 0 missing for some documents, no `size`/`modifyTime`/`ingestedAt`, no `meta` column on pgvector. Every hook works on them.

---

## 4. Tools on `VectorStoreToolMixin` (`vx_tools.py` and `vx_tools_ext.py`, mixed in; `ds:657` keeps its name)

`class VectorStoreToolMixin(VectorExplorerExtTools, VectorExplorerTools)`: the additive tools of §4.4 live in `vx_tools_ext.py`, which may import from `vx_tools` and is never imported by it.

### 4.0 Wrapper and audience

```python
def vectordb_tool(fn):  # applied under @tool_function on every tool, new and legacy
    # 1. args = _normalize_vectordb_tool_input(args) (ds:603-654)
    # 2. try: return fn(self, args)
    #    except StoreUnsupported as e: {'success': False, 'code': 'UNSUPPORTED', 'error': str(e)}
    #    except ToolRefusal as e:      {'success': False, 'code': e.code, 'error': e.message, **e.extra}
    #    except (KeyboardInterrupt, SystemExit): raise
    #    except BaseException as e:    {'success': False, 'code': 'STORE_ERROR', 'error': f'{type(e).__name__}: {e}'}
    # 3. post-process: numpy -> list, float rounding (5 dp scalars, 4 dp bulk, 2 dp light), size assertion vs LIMITS
```

A `STORE_ERROR` message is scrubbed before it leaves the node: URLs, DSNs, `user:pass@host`, bearer tokens, API keys, `key=value` and `key: value` secrets, quoted user, role, database, relation, schema and tenant names, "to/for tenant|database X", IP addresses, `host:port` and DNS names are removed. A connection, DNS, TLS or authentication failure (stdlib connection errors, the client libraries' connection and auth errors, HTTP 401/403/407, Milvus code 2, MongoDB auth codes, gRPC unavailable and authentication status codes, psycopg2/psycopg `OperationalError` and `InterfaceError`, following `__cause__` and `__context__`) answers the fixed sentence "The store could not be reached or refused the credentials; see the engine log." and the scrubbed text goes to the engine log only. An answer that cannot be serialised is a `STORE_ERROR`.

`@tool_function` (`flt:67-94`) gains `audience: Tuple[str, ...] = ('agent', 'dap')` stored in `__tool_meta__`; `_build_tool_descriptors` (`flt:1141-1190`), called from `tool.query` with `audience='agent'`, lists only tools whose audience includes it; `tool.invoke` dispatches every `@tool_function` regardless. The six legacy tools keep the default audience and their descriptors byte-identical. `list_documents`, `soft_delete` and `restore` (#2704's names, §4.5) are listed for agents too. Every other new tool and `embed` is `audience=('dap',)`. `test_tool_audience.py` (the `packages/ai` suite, `./builder ai:test`) asserts: the agent catalog (`host.py:93-123` descriptors) is byte-identical before and after; legacy inputs of `search`/`stats`/`delete`/`get`/`objdir`/`upsert` are accepted; legacy output keys are present with legacy semantics, including `stats` on a missing collection answering `{success:true, count:0, model:'', vector_size:0}`.

### 4.1 Codes, capabilities, caveats, limits

Codes: `INVALID_INPUT`, `UNSUPPORTED`, `NOT_FOUND`, `RESERVED_ID`, `COLLECTION_MISSING`, `STORE_ERROR`, `DIMENSION_MISMATCH`, `MODEL_MISMATCH`, `NO_EMBEDDER`, `LIMIT_EXCEEDED`, `SAMPLE_EXPIRED`, `BUSY`, `TIMEOUT`, `RATE_LIMITED`, `WRITES_DISABLED`, `WRITES_SOURCE`, `WRITES_PUBLIC`, `WRITES_BROADCAST`, `WRITES_UNKNOWN_CALLER`, `READS_PUBLIC` (§6.6), `IN_TRASH` (§4.5).

Capabilities (`dialect.capabilities`): `describe`, `count`, `count_documents`, `documents`, `documents_distinct`, `documents_sorted`, `chunks`, `vectors`, `sample`, `sample_light`, `sample_stratified_native`, `knn_native`, `project`, `neighbors`, `search_vector` (always true), `search_keyword`, `remove`, `remove_count`, `soft_delete` (true wherever the driver implements `markDeleted` / `markActive`: every driver, §4.5), `embed_node` (filled by the app); `projection: ['pca']`. Additive (§4.4), reported by every node and false until offered: `clusters` (the node computes `sample.clusters`), `documents_filter` (the driver declares it), `recommend_best_score` (the driver declares it).

Caveats: `brute_force_search`, `no_filtered_count`, `biased_sample`, `score_scale_raw`, `score_scale_inverted_fixed`, `shared_org_table`, `experimental`, `cloud_only_unverified`, `extras_not_stored`, `documents_by_first_chunk`, `document_count_capped`, `documents_unsorted`, `documents_paging_unsupported`, `model_mismatch`, `meta_column_pending`, `filtered_search_may_underfill` (pgvector older than 0.8, which has no iterative HNSW scan: a filtered search may return fewer than `k` rows). Additive (§4.4): `listing_truncated` (the sampler's document listing stopped with pages left), `documents_filter_partial` (the store applied some filter keys), `documents_filter_client` (the store applied none; the app filters what it loaded). The trash (§4.5): `trash_scan_cut` (an Active listing stopped reading the trash at its bound, so a partly trashed document may be missing).

Limits (node-enforced; reported in `dialect.limits`):

| Key | Default / max |
|---|---|
| `documents_page` | 200 / 500 |
| `chunks_page` | 100 / 200 |
| `vectors_keys_max` | 2 |
| `sample_default` / `sample_max` / `sample_max_light` | 1,000 / 2,000 / 5,000 (light: `include_text:false`, `knn_k ≤ 10`, 2-dp floats) |
| `snippet_chars` | 120 (word boundary, ellipsis) |
| `knn_k_max` | 30 (10 in light mode) |
| `neighbors_k_max` | 50 (default 12) |
| `project_keys_max` | 200 |
| `scope_keys_max` | 2,000 |
| `top_k_max` | 100 |
| `write_ids_max` | 100 |
| `sample_budget_ms` | 60,000 |
| `statement_timeout_ms` | 30,000 (pgvector; others null) |
| `counts_cached_s` | 60 |
| `recommend_examples_max` | 10 example keys per side of `recommend` (§4.4-D) |
| `matrix_keys_max` | 100 keys of `similarity_matrix` (§4.4-E) |
| `max_components` | 200 clusters kept in `sample.clusters`; the rest are noise (§4.4-C) |
| `embed_texts_max` | 8; `embed_per_minute` 30, burst 5 |

### 4.2 Tool table

Every input goes through the wrapper; every output has `success`. `key` is always `[objectId, chunkId]`. Server-side filters are `object_ids`, plus the `list_documents` filter of §4.4-A. The additive tools `recommend` and `similarity_matrix`, and the additive keys of `documents`, `sample`, `search` and `dialect`, are in §4.4.

**`dialect`** (new; the shared library's default probe) — `{}` → always a success envelope when the node is up:
```json
{"success":true,"dialect":"vector","contract":"vector/1","provider":"postgres","backend":"pgvector","backend_version":"0.8.0",
 "collection":"vx_demo_docs","metric":"cosine","model":"sentence-transformers/all-MiniLM-L6-v2","dimension":384,
 "index":{"type":"hnsw","params":{"m":16,"ef_construction":64}},
 "score":{"formula":"1 - cosine_distance","range":[-1,1],"higher_is_better":true,"floor":0.2,"threshold":0.3},
 "support":"supported","allow_writes":true,"writes_scope":"tools_source",
 "write_tools":["upsert","delete","soft_delete","restore"],
 "capabilities":{"describe":true,"count":true,"count_documents":true,"documents":true,"documents_distinct":true,"documents_sorted":true,"chunks":true,"vectors":true,"sample":true,"sample_light":true,"sample_stratified_native":true,"knn_native":false,"project":true,"neighbors":true,"search_vector":true,"search_keyword":true,"remove":true,"remove_count":true,"soft_delete":true,"clusters":false,"documents_filter":false,"recommend_best_score":false,"projection":["pca"]},
 "limits":{"documents_page":500,"chunks_page":200,"vectors_keys_max":2,"sample_default":1000,"sample_max":2000,"sample_max_light":5000,"snippet_chars":120,"knn_k_max":30,"neighbors_k_max":50,"project_keys_max":200,"scope_keys_max":2000,"top_k_max":100,"write_ids_max":100,"sample_budget_ms":60000,"statement_timeout_ms":30000,"counts_cached_s":60,"recommend_examples_max":10,"matrix_keys_max":100,"max_components":200},
 "health":{"collection_exists":true,"control_record":true,"model_mismatch":null,"meta_column":true},
 "caveats":[]}
```
A missing collection answers the same envelope with nulls and `health.collection_exists:false`, `health.control_record:null`; `health.control_record:false` → "Repair needed"; `health.meta_column:false` → caveat `meta_column_pending`. Only `STORE_ERROR` is a failure envelope. Never includes host, port, DSN or database name.

**`stats`** (legacy descriptor unchanged; answer extended) — `{"mode":"full"}` (default) or `{"mode":"quick"}` → `{"success":true,"count":1319,"model":"…","vector_size":384,"collection_exists":true,"documents":42,"documents_without_first_chunk":1,"chunks":1318,"deleted_chunks":0,"raw_count":1319,"tables":3,"avg_chunks_per_document":31.4,"dimension":384,"metric":"cosine","computed_at":"2026-10-08T18:31:03Z","counts_as_of":"2026-10-08T18:30:40Z"}`. `count` keeps today's semantics (`count_documents()`); `document_count` repeats `documents` under #2704's name (null where the store cannot count); `model`/`vector_size` are loaded from the control record first (D6). **A missing collection keeps the legacy success envelope** `{success:true, count:0, model:'', vector_size:0, collection_exists:false}` with the extended keys null. `documents = countDocumentsWhere(active)` where supported, else `countChunks(chunkIds=[0], active)` with caveat `documents_by_first_chunk`, plus, while the trash holds at most 1,000 documents (`_TRASH_READ_MAX`, read through the Trash listing in at most 8 calls, `_TRASH_READ_PAGES`; not counted when that read is cut), the trashed documents that still have a live chunk and no live chunk 0 (§4.5); a document with no chunk 0 at all is not counted under that caveat; `deleted_documents` (the Trash listing's size: documents with at least one chunk in the trash) `= countDocumentsWhere(deleted)`, else the first-chunk count where `documents` fell back to it, else null; `chunks`, `deleted_chunks`, `tables` from `countChunks`; null where unsupported. **Filtered counts are cached per instance for `counts_cached_s`.** `mode:'full'` always recounts; `mode:'quick'` returns the raw `count` plus the cached figures with `counts_as_of` while they are at most `counts_cached_s` old, and recounts once they are older. Any write through the driver (`addChunks`, `remove`, `markDeleted`, `markActive`, so the data lane's uploads too) drops the cached figures.

**`list_documents`** (new; #2704's name, the explorer's shape; listed for agents) — `{"cursor":null,"limit":100,"object_ids":null,"deleted":"active","sort":"path"}` → `{"success":true,"items":[{"objectId":"060f…","path":"C:/demo/field/kestrel_field_guide.md","chunks":2,"has_first_chunk":true,"tables":0,"deleted":false,"nodeId":"chunk_1","size":7419,"modifyTime":null,"ingestedAt":"2026-10-08T18:20:11Z","pointId":"a3f…"}],"next_cursor":"eyJvIjoy…","total":42,"counts_exact":true,"distinct":true,"sorted":true,"caveats":[]}`. A list, never a dict. `sorted:false` → the client sorts loaded rows (caveat `documents_unsorted`); a repeated page ends the listing with `documents_paging_unsupported`. `limit` > 1,000 → clamped with `warnings:["limit_clamped"]`. `deleted:'active'` (the default) lists the documents with a live chunk and `deleted:'deleted'`, the Trash view, the documents with at least one chunk in the trash (§4.5 says how a driver that lists by chunk 0 finds a partly trashed document). For #2704's callers it also takes `deleted: true` / `false` (= `'deleted'` / `'active'`) and `parent`, an exact path: handed to a driver that filters as a `path_prefix`, matched exactly here, so a page may hold fewer rows than `limit` and `total` is null. An `offset` other than 0 → `INVALID_INPUT` naming `cursor`; `offset: 0` (or null) is accepted. #2704's answer keys are kept beside the explorer's, as aliases that only repeat them: `documents` (the rows as `{"object_id", "parent", "chunk_count"}`, `chunk_count` null where the store does not count), `offset` (always 0) and `has_more` (`next_cursor` is not null), with `total` as above (null where the store does not count; #2704 answered an integer). The page size is #2704's: `limit` defaults to 100 and is clamped to 1,000 (with `warnings:["limit_clamped"]`); a `limit` below 1 or not a whole number is refused with `INVALID_INPUT`, as on develop. The app sends its own `limit` (at most `limits.documents_page`, which `dialect` still reports).

**`chunks`** (new) — `{"object_id":"060f…","after_chunk":-1,"limit":100,"deleted":"active"}` → `{"success":true,"items":[{"chunkId":0,"content":"…","length":3702,"isTable":false,"tableId":0,"isDeleted":false,"pointId":"a3f…","metadata":{…}}],"has_more":true,"next_after":99,"total":112}`. Never calls `render`. **Never returns vectors.** `NOT_FOUND` for `schema` or an unknown id; `IN_TRASH` (§4.5) for a document whose chunks are all in the trash, read with the default `deleted:'active'`. `{"object_id": X, "limit": 1}` is the app's existence probe.

**`vectors`** (new) — `{"keys":[["060f…",0],["9fa0…",0]]}` (≤2) → `{"success":true,"items":[{"key":["060f…",0],"pointId":"a3f…","dimension":384,"norm":1.0,"values":[…]}],"model":"…"}`. The single path that returns raw vectors. A key lookup, not retrieval: a key resolves whatever its chunk's trash state.

**`sample`** (new) — `{"n":1000,"seed":7,"strategy":"stratified","mode":"detailed","include_keys":[["060f…",0]],"filter":{"object_ids":null},"deleted":"active","knn_k":15,"components":3,"duplicate_threshold":0.97,"include_text":true}` →
```json
{"success":true,"sample_id":"s-7-a1b2c3d4","expires_in_s":600,"n":1000,"n_requested":1000,"mode":"detailed","of":{"chunks":1318,"documents":42},"strategy_used":"stratified","biased":false,"knn_source":"node","metric":"cosine","dimension":384,
 "docs":[{"i":0,"objectId":"060f…","path":"C:/demo/field/kestrel_field_guide.md","chunks":2,"in_sample":2}],
 "points":{"doc":[0,0,1],"chunk":[0,1,0],"x":[…],"y":[…],"z":[…],"len":[3702,3714,…],"snip":["Kestrel field guide …"],"pinned":[1,0,0]},
 "knn":{"k":15,"offsets_row":[…],"cols":[…],"sims":[…]},
 "density":[…],"outliers":[311,5],"duplicates":[{"a":12,"b":87,"sim":0.991}],
 "pca":{"explained":[0.21,0.13,0.08]},"took_ms":420}
```
`snip` ≤ `snippet_chars`. `mode:'light'`: `n ≤ sample_max_light`, no text, `knn_k ≤ 10`, 2-dp floats. Server side: §2.4 sampling, PCA, `knnGraph` (native on Qdrant), density, outliers, duplicates. Columnar JSON; the node test asserts ≤1 MB at n=2,000/k=15 detailed and n=5,000/k=10 light **on a corpus whose chunks are ≥3,000 characters**, and ≤1.1 MB at n=2,000 with `knn_k_max` (30; about 1.03 MB). `outliers` is empty below 10 points and when every density is the same. Errors: `UNSUPPORTED`, `BUSY`, `TIMEOUT`, `LIMIT_EXCEEDED`, `COLLECTION_MISSING`.

**`project`** (new) — exactly one of `vector` or `keys`: `{"sample_id":"…","vector":[…],"m":10,"with_similarities":true}` or `{"sample_id":"…","keys":[["9fa0…",3]],"m":10}` → `{"success":true,"items":[{"key":null,"in_sample":null,"pca":[…],"neighbors":[{"i":12,"sim":0.83}]}],"similarities":[…],"dimension":384}`. Errors: `SAMPLE_EXPIRED`, `DIMENSION_MISMATCH`, `NOT_FOUND`, `INVALID_INPUT`.

**`neighbors`** (new) — `{"key":["060f…",0]}` or `{"vector":[…]}`, plus `"k":12,"exclude_self":true,"filter":{"object_ids":null},"scope_keys":null` → `{"success":true,"items":[{"key":["9fa0…",3],"sim":0.83,"score":0.83,"below_floor":false,"path":"…","chunkId":3,"preview":"…"}],"metric":"cosine","scope":"collection","k_requested":12}`. Whole-collection `searchSemantic(..., DocFilter(limit=k+1, minScore=-inf))`. With `scope_keys` (≤2,000): `{"success":true,"scores":[…]}`. One in flight per instance (`BUSY`).

**`search`** (legacy descriptor unchanged; additive) — legacy input keeps today's behaviour and gains `success:true`, `rank`, `warnings` (e.g. `["keyword_fallback","<semantic error>"]`, `["model_mismatch"]`) and `mode_used`. DAP extension: `{"vector":[…],"embedding_model":"…","mode":"auto|semantic|keyword","filter":{"objectIds":[…],"isTable":false,"minChunkId":0,"maxChunkId":99},"deleted":"active","include_below_floor":true,"include_below_threshold":true}` → results add `raw_score`, `sim`, `below_threshold`, `below_floor`. `query` without a bound embedder → `NO_EMBEDDER`; wrong length → `DIMENSION_MISMATCH`; `mode:'keyword'` on Pinecone → `UNSUPPORTED`. Results sorted by `score` desc when `vector` is given.

**`delete`** (legacy descriptor unchanged, gated; the only permanent delete) — `{"object_ids":["060f…"]}`, optionally `"deleted_only":true` → `{"success":true,"deleted_count":3,"object_ids":["060f…"],"removed_chunks":2,"not_found":["…"],"kept_live":[],"audit":{"action":"vector.delete","node":"store_1","provider":"postgres","collection":"vx_demo_docs","object_ids":["060f…"],"rows":2,"caller":{"auth":"account","userId":"…","teamId":"…"}}}`. `object_ids` echoes the distinct ids the request named (stripped, in order) and `deleted_count` is their number, as on develop (#2704), not the entries the request carried; `removed_chunks` is what went (null where the driver cannot count). With `deleted_only` (the Vector Explorer's "Empty trash"), a document is removed only when every chunk of it is in the trash; one that still has a live chunk (a later ingest batch added it after it went to the trash) is left whole and named in `kept_live`, which is always present. `audit.object_ids` names every id the call named; `kept_live` and `not_found` say which of them were left alone. The check for a live chunk (the pre-check that fills `kept_live`) and the removal are separate steps, but the removal itself is conditional on the trashed state inside the store operation (`removeTrashed`): a document a concurrent `restore` made live between the two is not deleted, and the answer names it in `kept_live`. `removed_chunks` is what the store actually deleted (null where it does not count); `not_found` names ids with nothing stored. Per driver: **pgvector** one `DELETE … WHERE objectid = ANY(%s) AND isdeleted IS TRUE` (a concurrent restore's UPDATE is waited for and the row re-read); **Qdrant** delete by filter on `meta.isDeleted == true`; **Chroma** `delete(where={'$and': [objectId $in, isDeleted $eq true]})`; **Weaviate** `delete_many` with the same flag condition; **Milvus** `delete(filter=… and meta['isDeleted'] == true)`; **Astra** and **Atlas** `delete_many` with `meta.isDeleted: true`; **Pinecone** one `delete(filter=…)` that includes `isDeleted` (it counts nothing: `removed_chunks` is null). No driver needed the refusal fallback; a driver that cannot express the condition keeps the base `removeTrashed`, and `delete {deleted_only}` on it answers `UNSUPPORTED` (a plain `delete` without `deleted_only` is unchanged, and is the one permanent delete that removes in every state). A chunk an ingest adds between the pre-check and the removal to a still-trashed document is not removed: only chunks still in the trash are. `RESERVED_ID` for `schema`. External callers send at most 100 ids; with `deleted_only` an agent sends at most 1,000 (`AGENT_WRITE_IDS_MAX`), and an agent's plain `delete` keeps develop's open list. The `audit` block never carries content or vectors. (`remove_document`, the first contract's DAP-only removal, is gone.)

**`upsert`** (legacy descriptor unchanged, gated) — unchanged input/output; an external caller supplying `embedding`/`embedding_model` → `INVALID_INPUT`; `object_id == 'schema'` → `RESERVED_ID`. Into an existing collection built with another embedding model it answers `MODEL_MISMATCH`, with another dimension `DIMENSION_MISMATCH`, before anything is written. For every write tool the gate (§6.3) runs before the input is checked, so a refused caller sending too many ids or a malformed list gets the gate's code, not `INVALID_INPUT`.

**`get`, `objdir`** (legacy descriptors unchanged; fixed) — `get` guards `int()`, clamps `limit`, pages in chunk order, adds `has_more`, answers `IN_TRASH` (§4.5) for a document whose chunks are all in the trash, `NOT_FOUND` for an id nothing is stored under and `RESERVED_ID` for `schema` (#2704; an empty page is only an offset past the end of a document that exists); `objdir` keeps `paths` and pages them as #2668 did (`offset` and `limit` count distinct PATHS, each mapped to its lowest object id; a folder browser that needs per-document paging uses `list_documents`), adds `entries` (every document under the page's paths), excludes `schema` and deleted rows, clamps `limit`, reads `parent` as an exact path (as develop's drivers do; a non-string `parent` is `INVALID_INPUT`), and answers `truncated` (with a `warning` when true) when its listing stopped at the 10,000-row scan cap, the `sample_budget_ms` time budget or a store that stopped paging before the page was full.

### 4.3 `embed` on the embedding nodes (new mixin `packages/ai/src/ai/common/embed_tool.py`)

`{"texts":["…"],"kind":"query"}` (1–8 texts, each ≤8,000 chars) → `{"success":true,"model":"…","dimension":384,"vectors":[[…]],"prefix_applied":null,"ms":12}`. Token bucket per task: 30/min, burst 5 → `RATE_LIMITED` with `retry_after_s`. A call from a connection signed in with a task's public key → `READS_PUBLIC` before anything else (§6.6). The mixin owns `IGlobal.embed_lock`; the tool and the flush path (`embedding_transformer/IInstance.py:83-102`, `embedding_openai/IInstance.py:52-59`) both acquire it. `audience=('dap',)`. Reachability from the tools token is pinned by a phase-0 test (`scripts/acceptance/vector-explorer/phase0/`).

- `kind:'query'` encodes like the `questions` lane (query prefix), `'document'` like the `documents` lane; vectors are rounded to 6 decimals; `ms` includes any wait for the lock.
- `IGlobal.embed_lock` is a shared/exclusive lock that prefers the exclusive side: the node's own batches hold it shared, an `embed` call exclusively, so a call waits for the batches already on the model and new batches queue behind it. It covers the model call only, not the write that follows a flush. A call still waiting after 60 s answers `BUSY` and its token is refunded.
- The token bucket lives on `IGlobal.embed_bucket`; a call refused before it reaches the model (`INVALID_INPUT`, `NO_EMBEDDER`, `BUSY`) spends no token. Blank texts are `INVALID_INPUT`.
- A model failure is a `STORE_ERROR` whose message names only the exception type; the full text goes to the engine log.

### 4.4 Additive extensions

Every extension below is an optional input, a new answer key or a new tool. An agent's catalog does not change (the six legacy descriptors stay byte-identical, `nodes/test/test_vector_tool_envelope.py`); every new tool is `audience=('dap',)`, runs `vx_write_gate.check_read()` first and goes through `vectordb_tool`. None accepts or returns a stored vector. The shapes, vocabularies and limits are fixed here and in `vx_types.py`, `vx_defaults.py` and `apps/vector-ui/src/contract/types.ts` (provisional answers in `apps/vector-ui/tests/fixtures/provisional/`: `documents_filter_{server,partial,client}`, `sample_demo_1000_clusters`, `sample_listing_truncated`, `recommend_{ok,unsupported}`, `similarity_matrix_ok`, `dialect_enriched`). Until a node implements one, it reports the matching capability false and leaves the key out, and the app treats the feature as unavailable on that node.

**A. `list_documents` filter.** Input key `filter` (keys `DOC_LIST_FILTER_KEYS`, parsed by `parse_doc_list_filter`, §2.1), passed to `listDocumentPage(..., filter=...)`:

```json
{"cursor":null,"limit":200,"deleted":"active","sort":"path",
 "filter":{"path_prefix":"C:/demo/handbooks/","file_types":["md","pdf"],
           "ingested_after":"2026-10-01T00:00:00Z","ingested_before":null,
           "min_chunks":1,"max_chunks":null,"has_first_chunk":true,"has_tables":null,"path_contains":null}}
→ {"success":true,"items":[…],"next_cursor":"…","total":12,"counts_exact":true,"distinct":true,"sorted":true,
   "filter_applied":"server","filter_ignored":[],"caveats":[]}
```

`path_prefix` matches the start of the path exactly, `file_types` the extension, `ingested_after` is inclusive and `ingested_before` exclusive, `path_contains` ignores case. The tool hands the parsed filter to the hook only when the driver declares `documents_filter` (a driver without it may keep the first contract's signature, which has no `filter`, and is never handed one); the driver names the given keys it did not apply in `DocPage.filter_ignored` (§2.1), and the tool answers from that. `filter_applied` is `"server"` when the driver applied every given key, `"partial"` (caveat `documents_filter_partial`) with `filter_ignored` naming the keys it skipped, or `"none"` (caveat `documents_filter_client`) with every given key in `filter_ignored`: the app then filters the rows it loaded and says so. Without a filter the answer carries neither key. Capability `documents_filter` (the driver declares it). pgvector applies the keys inside the statement that pages the keys (`LIKE … ESCAPE` on the escaped prefix, `lower("parent") LIKE '%.' || ext`, `ILIKE` for `path_contains`, `"meta"->>'ingestedAt'` only when the `meta` column exists, else `"partial"` with `filter_ignored:["ingested_after", …]`, `HAVING` for chunk counts, `bool_or` for the flags), so the keyset cursor and the carried total stay right; Chroma applies `has_first_chunk` itself (a filter with only that key is `"server"`, any other key makes it `"partial"`); Qdrant and the experimental drivers answer `"none"`. `INVALID_INPUT` for an unknown key, a date not in ISO-8601, text over 1,024 characters or `min_chunks > max_chunks`.

**B. Scope and the sampler's listing** (no new input key). The scope limit is `limits.scope_keys_max` (2,000), already enforced on `filter.object_ids` of `sample` and `neighbors`; `recommend` and `similarity_matrix` use it too, and `search` caps its extension key `filter.objectIds` at it (`LIMIT_EXCEEDED`; the legacy `objectId` key is unchanged). With `filter.object_ids`, the sampler lists up to `max(500, len(object_ids))` documents instead of 500 (at most 4 pages of `documents_page`), so a stratified pick spans the whole scope. Every `sample` answer gains `"listing":{"documents":412,"truncated":false,"reason":"complete"}`: `truncated` is true whenever the last page the listing received still had a `next_cursor` when the listing ended, and `reason` (`LISTING_REASONS`) is `"complete"` (no cursor left), `"cap"` (the row cap), `"stale"` (pages without a new document), `"pages"` (the page budget) or `"budget"` (the deadline). A truncated listing adds the caveat `listing_truncated`. `of` is unchanged (null where the store cannot count) and is never a scope count.

**C. `sample` clusters and table flags.** Input `"cluster":{"method":"knn-components","labels":true}`; the answer gains `clusters` and `points.table` (1 for a table chunk):

```json
{"n":1000,"seed":7,"strategy":"stratified","mode":"detailed","knn_k":15,"components":3,
 "cluster":{"method":"knn-components","labels":true}}
→ {…,"points":{…,"table":[0,1,0,…]},
   "clusters":{"method":"knn-components","edge_threshold":0.6123,"percentile":60,"count":23,"noise":38,
               "labels":[0,0,3,-1,…],"sizes":[412,205,…,2],
               "keywords":[["falcon","station","water","spring","intake"],…,[]],"labelled":12,
               "label_source":"text","labelled_from":50,"took_ms":{"clusters":41,"labels":120}}}
```

The node keeps the mutual kNN edges whose similarity is at least `edge_threshold`, the `percentile`-th percentile of all the sample's kNN edge similarities (60 first); groups are the connected components of the kept edges by union-find, numbered by size (largest first). While the largest group holds half the points or more and `percentile` is below 95, the percentile rises by 10 and the groups are computed again; the final `percentile` and `edge_threshold` are reported. Every group of 2 or more points is kept, up to `limits.max_components`; singletons and the rest are noise (`-1`). The node never applies a user's minimum group size: the app folds small groups itself, without a call. `keywords`: for the largest groups of at least 5 points (at most 50, `labelled` of them), the top 5 terms by TF-IDF over at most `labelled_from` (50) of their chunk texts, lower-cased, stop words and tokens shorter than 3 characters removed, ties by frequency then alphabet; other groups get `[]`. `label_source` is `"text"`, `"paths"` (path segments) when the driver returns no text, or null. `clusters` is absent unless `cluster` is sent. Capability `clusters`. Budgets: 2,000 points with `knn_k` 15 (detailed): clusters ≤ 300 ms, labels ≤ 500 ms, ≤ 12 KB more; 5,000 points with `knn_k` 10 (light): ≤ 500 ms, ≤ 500 ms, ≤ 25 KB. `INVALID_INPUT` for an unknown method (`label-propagation` is reserved) or a non-boolean `labels`.

**D. `recommend`** (new tool; keys, and at most the query vector `embed` returned):

```json
{"positive":[["060f…",0],["9fa0…",3]],"negative":[["aa12…",7]],"vector":null,
 "k":12,"strategy":"average_vector","filter":{"object_ids":null},"exclude_examples":true}
→ {"success":true,"items":[{"key":["bb34…",2],"sim":0.71,"score":0.71,"below_floor":false,"path":"…","chunkId":2,"preview":"…"}],
   "strategy_used":"average_vector","native":false,"metric":"cosine","k_requested":12,
   "examples_resolved":{"positive":2,"negative":1},"not_found":[]}
```

At most `limits.recommend_examples_max` keys per side, read through `getVectors`. `average_vector`: `avg_positive` is the mean of the positive vectors and `vector`, `avg_negative` the mean of the negative ones; the query is `avg_positive + avg_positive − avg_negative` with negatives and `avg_positive` without (unit-normalised for cosine), searched over the whole collection as `neighbors` does, with the examples left out. `best_score` only where `capabilities.recommend_best_score` (Qdrant's recommend query, `native:true`; it accepts negatives alone), elsewhere `UNSUPPORTED`. `INVALID_INPUT` (no positive and no vector under `average_vector`), `NOT_FOUND` (no positive key resolved; unresolved keys are always listed in `not_found`), `DIMENSION_MISMATCH`, `BUSY` (one `neighbors` or `recommend` at a time per instance).

**E. `similarity_matrix`** (new tool; keys only, scalars back):

```json
{"keys":[["060f…",0],["9fa0…",3],["c1d2…",0]]}
→ {"success":true,"n":3,"keys":[["060f…",0],["9fa0…",3],["c1d2…",0]],"metric":"cosine","dp":2,
   "matrix":[[1,0.91,0.12],[0.91,1,0.08],[0.12,0.08,1]],"source":"cache","not_found":[]}
```

2 to `limits.matrix_keys_max` keys, resolved from the latest cached sample, else `getVectors`; `source` (`MATRIX_SOURCES`) says which (`"cache"`, `"store"` or `"mixed"`). The matrix covers the resolved keys (`n`, in `keys` order) by the store's metric (`vx_math.similarity`), rounded to `dp` places; unresolved keys are listed in `not_found`. Like `vectors`, it is a key lookup, not retrieval: a key resolves whatever its chunk's trash state (the app only holds keys from a sample, which leaves the trash out). There is no `sample_id` input, so the matrix cannot go stale. `NOT_FOUND` (fewer than 2 resolved), `LIMIT_EXCEEDED`, `INVALID_INPUT`. ≤ 60 KB.

**F. Per-document health and the store's size.** `list_documents` items gain `"max_chunk_id"` and `"deleted_chunks"`: `chunks`, `has_first_chunk`, `tables` and `max_chunk_id` count the rows the listing's `deleted` mode selects; `deleted_chunks` counts the document's soft-deleted rows whatever the mode. pgvector computes them for the page's objectIds under `deleted='all'` with the mode applied per column (`count(*) FILTER (WHERE <mode>)`), so which documents are listed does not change; other drivers answer null for both. `dialect` gains `"size_bytes"` from `StoreInfo.size_bytes` (pgvector: `pg_total_relation_size`; null elsewhere).

**G. `dialect.keyword_match`**: `"substring"` (pgvector `ILIKE`, Chroma `$contains`), `"token"` (Qdrant's `MatchText` over the content text index) or null, from the driver constant `VX_KEYWORD_MATCH`, beside `capabilities.search_keyword`; null whenever `search_keyword` is false or the constant names no known matching. The `search` row of §4.2 keeps one keyword mode; this key says what a keyword hit means on that store, so a client can say "matches text fragments" or "matches whole words".

**Where it is checked.** The node suites (`nodes/test/test_vector_clusters.py`, `test_vector_sample_ext.py`, `test_vector_recommend.py`, `test_vector_similarity_matrix.py`, `test_vector_documents_filter.py`, `store_qdrant/test_vx_recommend.py`) pin each extension on mocks; `nodes/test/test_vector_toolpath_full.py` calls every one through a real engine on the four supported templates (new and legacy collections, pgvector also through the transaction pooler), and `nodes/test/vector_wire_fixtures.py` captures their answers for the app (`apps/vector-ui/tests/fixtures/v1/live/<backend>/{documents.filter,sample.clusters,search.keyword,recommend,recommend.best_score,similarity_matrix,dialect.enriched}.json`).

### 4.5 The trash and the shared tool set (#2704's names)

The agent catalog (and DAP) has develop's six tools plus #2704's `list_documents`, `soft_delete` and `restore`; DAP callers also have the eight explorer tools (`dialect`, `chunks`, `vectors`, `sample`, `project`, `neighbors`, `recommend`, `similarity_matrix`). `WRITE_TOOLS` (`vx_write_gate`) is `upsert`, `delete`, `soft_delete`, `restore`: `allow_write` (§6.0) hides all four, and each runs `check_write` before reading its input.

**`soft_delete`** / **`restore`** (#2704's names and input; write, gated; listed for agents) — `{"object_ids":["060f…"]}` → `{"success":true,"object_ids":["060f…"],"matched_chunks":2,"moved_chunks":2,"not_found":[],"audit":{"action":"vector.soft_delete","node":"store_1","provider":"postgres","collection":"vx_demo_docs","object_ids":["060f…"],"rows":2,"caller":{…}}}` (`vector.restore` for `restore`). `object_ids` is the distinct ids in request order (external callers send at most 100, agents at most 1,000: `AGENT_WRITE_IDS_MAX`, refused with `INVALID_INPUT` before the store is read); `not_found` names the ids with nothing stored (one count of the stored documents answers for the whole list when it finds all of them or none, otherwise each id is counted); `moved_chunks` is the driver's `markDeleted` / `markActive` answer: the chunks the call moved into or out of the trash (0 for a document already in that state), or null where the backend cannot count (psycopg2's -1, a boolean or a string from a driver is null, never a made-up count). `matched_chunks` keeps #2704's meaning, the chunk rows the store holds for the ids in either state (what its UPDATE by object id matched), read with one more count over all the chunks of the stored ids (one count for the whole list, never one per id); where the store cannot count it is `moved_chunks`. The Vector Explorer reads `moved_chunks`. The extra count costs one filtered count (`countChunks`, all states) per call over the stored ids, on top of the one that tells `not_found`; it is paid for correctness (the number is what the store holds, not what the driver last changed), not skipped. Restoring a document that is not in the trash moves nothing; it is not an error. A trashed document's chunks stay stored; `search`, `objdir`, `get`, the active `list_documents`, `sample` (and so the map's duplicates and outliers), `neighbors` and `recommend` leave them out.

**Active and Trash.** A document is active when it has a live chunk and in the trash when it has a trashed chunk, so a partly trashed document (a `soft_delete` during its ingest leaves its first chunks in the trash and later ones live) is in both listings and in both `stats.documents` and `stats.deleted_documents`. A driver that lists by chunk 0 (caveat `documents_by_first_chunk`: Astra, Milvus, Pinecone, Weaviate and the default `listDocumentPage`) places a document by its chunk 0, so after that driver's last Active page `list_documents` goes on through its Trash listing and keeps the documents there that still have a live chunk and no live chunk 0: room left on the last page takes them from one page of the trash, and otherwise `next_cursor` is the tool's own cursor for this second phase (only an Active listing takes it; its pages answer `total: null`). Each trash page costs one count, and one read of at most 1,000 live chunks where the count is not 0. An Active listing asks for at most 1,000 rows of the Trash listing in all (`_TRASH_READ_MAX`; the second-phase cursor carries the rows read so far); when that bound stops the read before the trash ends, the listing ends there with the caveat `trash_scan_cut`. A store with a real document count (`countDocumentsWhere`: Weaviate here) still counts every document with a live chunk in `stats.documents`, so under `trash_scan_cut` that figure can be higher than the number of rows the Active listing served. The listing never answers an empty page with a cursor, and when the store counts no chunk in the trash it ends as before, with the driver's `total`. While the trash may hold documents, every Active page of such a driver answers `total: null`, since the listing may serve more rows than the driver's chunk-0 count. On those drivers the Trash itself still lists by chunk 0, so a document whose chunk 0 is live and a later chunk trashed (not something `soft_delete` makes: it marks every chunk) is listed in Active only, and `delete {deleted_only}` keeps it (`kept_live`).

**`IN_TRASH`** — `get` and `chunks` of a document whose chunks are all in the trash answer `{"success":false,"code":"IN_TRASH","error":"<tool>: the document '<id>' is in the trash; restore it to read it","object_id":"<id>"}`. A partly trashed document reads its live chunks.

**#2704 compatibility (merged at b76848a6f).** `list_documents`, `soft_delete` and `restore` stay methods of `VectorStoreToolMixin` itself (`document_store.py`), and `nodes/test/test_vector_tool_set.py` still holds every tool to one class and the full set to the 9 + 8 above. The six legacy agent descriptors are byte-identical to what develop builds (`LEGACY_AGENT_CATALOG_SHA256` in `test_vector_tool_envelope.py`), with these behaviours of #2704 kept in the tools: `get` of an unknown id answers `{success:false, code:"NOT_FOUND", error:"get: no document with object_id '<id>'", object_id}` (an empty page only for an offset past the end of a document that exists), of a document whose every chunk is in the trash `IN_TRASH` with `get: document '<id>' is soft-deleted; restore it to read it` (without the restore hint while `allow_write` is off, since `restore` is then not offered), and of `schema` `RESERVED_ID`; `upsert` numbers the chunks sent for one object id 0, 1, 2 … unless each carries its own `chunkId` (an explicit one may not repeat in the call), and refuses `schema`; `delete` echoes `object_ids`; `stats` answers `document_count`. #2704's driver contract (`supports_document_listing`, `listDocuments`, `countDocuments`) is gone: every driver lists through `listDocumentPage`. The drivers' `markDeleted` / `markActive` return `Optional[int]` (§4.5: moved chunks); Chroma's helper is `_setIsDeleted` and Weaviate's `_setDeleted` keeps #2704's name, arguments and `None` return, so either side's copy serves both callers.

---

## 5. Pipeline shape the contract assumes (the "VX shape")

```
ingest_1 (dropper) ─tags→ parse_1 ─text→ chunk_1 ─documents→ embed_1 ─documents→ store_1   [control: tools_1]
chat_1   (chat)    ─questions──────────────────────────→ embed_1 ─questions→ store_2 ─questions→ llm_1 ─answers→ response_1
                                                                                store_2 ─documents→ response_2 (response_documents)
tools_1  (tools)   ─control(tool)→ store_1, embed_1
```

- `store_1`/`store_2`: two instances of the same provider and collection; this avoids the `stack.cpp:337-345` rejection of a store that is both data-fed and drives a sub-pipeline. `store_2` keeps `allow_writes:false` (on `rocketride_vector` also `allow_write:false`, so it has no write tools, §6.0) and the app never lists it (`nodeFilter`, §8).
- Reachability from the tools token: `store_1`, `store_2`, `embed_1`, `llm_1`; `parse_1`/`chunk_1` are "not found in pipeline".
- Tool calls run on the anchor token (tools; chat or ingest in read-only mode). Ingest = `sendFiles` on the ingest token; chat = `chat` on the chat token.
- Degrade path (single-store pipelines): the app tries `embed` through the chat role's token with `nodeId`; if nothing reaches `embed_1`, map text queries are disabled with a reason.
- Chat answers carry `result_types.answers` and, through `response_2`, `result_types.documents`.
- Templates carry `llm_1.config.custom.apikey = 'replace-with-your-key'` and an empty `base_url`; `start_fixtures.py --llm stub` substitutes the local stub and renames the LLM component to "Local stub LLM". Templates pin `parse_1.config.index.maxFileSize = 52428800`; the engine does not apply it in this release (§1 rule 5).

---

## 6. Write gate

### 6.0 The outer gate: whether a tool exists (`expose_tools`, `allow_write`)

Two `StoreGlobalBase` switches decide which tools a store node offers at all, before any of the rules below run. `expose_tools` (class default true) offers the tool surface; `allow_write` (class default true) adds the write tools (`upsert`, `delete`, `soft_delete`, `restore`). A driver whose store is shared or managed sets either class default to false and lets the owner opt in through a config field: `rocketride_vector` sets both to false (`rrvector.expose_tools`, `rrvector.allow_write`, from #2631), because `objdir` and `get` (and `list_documents`, `chunks`) together return the whole table of a managed database. While a switch is off the affected tools are left out of `VectorStoreToolMixin._collect_tool_methods`, which the engine uses for both the tool list and dispatch, so the tools are neither listed nor callable; `vectordb_tool` runs the same check (`_vectordb_surface_refusal`) before every tool as a second line of defence and answers `{success: false, error}` naming the switch, without a `code`. The Vector Explorer opens a `rocketride_vector` store only where `expose_tools` is on; its template sets `expose_tools` on both stores and `allow_write` on `store_1` only. `store_2` hides its write tools entirely (`allow_write` off), so neither agents nor DAP callers can write there: a write sent to it fails as a tool the node has no handler for, not with `WRITES_DISABLED` as on the other providers. `allow_write` is the only barrier against agent writes on this node, so it stays off on the chat's store. The same holds on every store node, as on develop: `allow_write` alone decides whether an agent may write, and the inner gate (§6.3) has no switch of its own for agents. `dialect` reports `allow_writes` combined with `allow_write`: what a DAP caller may write in effect.

### 6.1 Switches (node config)
- `vector.allow_writes` — boolean, default `VECTOR_ALLOW_WRITES_DEFAULT` (`vx_defaults.py`, **false in this build**), "Allow document management from tool calls", defined once in `nodes/src/nodes/core/services.common.vector.json` and listed in every settings list of each vector store node's form (`test_vector_write_gate.py` pins it); `rrvector.allow_writes` for rocketride_vector. Read in `StoreGlobalBase.beginGlobal` with `parse_bool`. The templates test and the toolpath expectation table import the same constant, so a reversal is one line.
- Agents have no switch of their own: an agent's write is decided by `allow_write` (§6.0) alone, on every store node (`rrvector.allow_write`, off by default, on rocketride_vector). No form, no `StoreGlobalBase` attribute and no `dialect` key names an agent switch (`test_vector_write_gate.py` pins it).
- Where they live: like the other `vector.*` fields, both are profile fields, so in a `.pipe` they sit on the store component at `config[config.profile].allow_writes` (for example `config.local.allow_writes`; `config.cloud.allow_writes` for rocketride_vector) and the node reads them from the merged `Config.getNodeConfig` result. An absent field means the default.
- Scope: `allow_writes` governs external DAP tool calls only. With the switch **on**, the gate still refuses callers on a public (`pk_`) task key, non-tools sources, broadcasts, caller-supplied embeddings and `schema`; with it **off** (the default), SDK scripts calling `upsert`/`delete` through `client.tool()` get `WRITES_DISABLED` (no in-repo script, doc or test does so today). Data-lane ingest is unchanged except for the reserved id (§6.3).

### 6.2 Call context (engine; `packages/ai/src/ai/common/tool_context.py`)

```python
@dataclass(frozen=True)
class ToolCallContext:
    origin: str  # 'dap' | 'agent'
    source_type: Optional[str]  # provider of the calling task's source; None when unknown
    targeted: bool
    caller: Dict[str, Any]  # {'auth': 'public'|'task'|'account'|'agent'|'unknown', 'userId', 'teamId', 'orgId'}


# name of the plain instance attribute stamp_param() sets on the engine-built param
TOOL_CONTEXT_FIELD = '__tool_context__'


def current_tool_call() -> Optional[ToolCallContext]: ...
@contextmanager
def tool_call(ctx: ToolCallContext): ...
```

**The context rides on the invoke param; the dispatcher sets the ContextVar.**
1. `cmd_data.on_rrext_process` (`cmd_data.py:94-165`), for `subcommand == 'tool'`, overwrites `request['arguments']['caller']` with the server's view (`pk_` → `public`, `tk_` → `task`, else `account`), discarding anything the client sent.
2. `dc._tool` (`dc:985-1080`) builds the `IInvokeTool.Invoke` param from `tool_name` and `input` **only** and stamps it with `stamp_param(param, dap_context(source_type=..., node_id=node_id, caller=args['caller']))`. `source_type` is the provider of the component that `taskConfig.pipeline.source` names (`'tools'`, `'chat'`, `'dropper'`, ...), read from the task's own pipeline configuration; the target endpoint's logical type is not it (that is the pipeline's Null endpoint). `targeted` is whether the request named a node.
   The stamp is a plain instance attribute set with `setattr` on the param the engine built, so it never appears in `model_dump()` (which tracing serialises). `read_stamp` reads it only from the instance `__dict__`: a pydantic extra field of the same name (what `model_validate`, keyword construction, `model_construct`, `model_copy(update=...)` or `model_validate_json` make of client data) is ignored, and so is any dict op. `stamp_param` raises `TypeError` on a dict and drops a same-named extra field before stamping. A client cannot reach the stamp: nothing inside `input` is read by the gate.
3. The agent host (`host.py:206` Validate, `host.py:229` Invoke) stamps `ToolCallContext(origin='agent', source_type=None, targeted=True, caller={'auth':'agent'})` on the param it builds.
4. `IInstanceBase._dispatch_tool` (`flt:1232-1258`) reads the field and enters `tool_call(ctx)` around the method call. The method runs on the same thread as the dispatcher by construction, so no cross-hop assumption remains. (The C++ hop is inline on the calling thread as well: `cb_control` → `filter->control` → `callPython` = `LockPython` + direct call, `filter.callbacks.target.cpp:80-123`, `engLib/python/call.hpp:179-196`; a phase-0 probe pins it through the real engine.)
5. **Only the engine sets the context.** The DAP path stamps it from the server's own view of the call (steps 1 and 2) and the agent host stamps the params it builds (step 3); nothing a client sends can set or change it.
6. The mixin imports `current_tool_call` inside `try/except ImportError`; on an engine without `tool_context`, or a dispatcher that does not stamp, every call is **no context** (refused).

### 6.3 Gate (`vx_write_gate.py`), run first in `upsert`, `delete`, `soft_delete`, `restore`. **Fails closed.**

| Condition (checked in order) | Result |
|---|---|
| any id is `schema` — in the three tools **and in `StoreInstanceBase.writeDocuments` (`sib:65-75`) for the data lane**; `addChunks(checkCollection=False)` (the control-record path, `ds:535`) is exempt | `RESERVED_ID` (data lane: the pipe fails with "reserved objectId") |
| `current_tool_call()` is `None` | `WRITES_UNKNOWN_CALLER` |
| `origin == 'agent'` | allowed (logged); an agent reaches the gate only through a write tool `allow_write` exposes (§6.0) |
| `origin == 'dap'` and `allow_writes` false | `WRITES_DISABLED` |
| `source_type != 'tools'` (including `None`) | `WRITES_SOURCE` |
| `caller.auth` not in `('account','task')` | `WRITES_PUBLIC` |
| `targeted` false | `WRITES_BROADCAST` |
| external `upsert` with `embedding` | `INVALID_INPUT` |
| otherwise | allowed, audited |

Refusals return the envelope and never raise; the tools stay listed for DAP.

### 6.4 Audit
- Write tools return the `audit` block. `cmd_data` forwards a result carrying `audit` to `account.audit(user_id, source='vector', reason=audit.action, request_data={node, provider, collection, object_ids, caller.auth, teamId, source}, response_data={rows, success|code}, org_id)` (`base.py:292-315`). The node logs one line per write with ids and counts only.
- Only an action in the store tools' namespace is recorded: `audit.action` must fully match `vector\.[a-z][a-z0-9_]{0,63}` (`vector.delete`, `vector.soft_delete`, `vector.restore`, `vector.upsert`; `AUDIT_ACTION_PATTERN` in `cmd_data`). A result whose `audit` block names anything else is answered as usual and not recorded. At most 100 object ids go into one record.
- Uploads are not audited separately: they travel the ingest source's data lane like any other upload.

### 6.5 Gate tests (`nodes/test/test_vector_write_gate.py`; mirrored live by the tool-path suite)
- No context → `WRITES_UNKNOWN_CALLER`, data unchanged. Agent context → allowed whatever `allow_writes` says; with `allow_write` off the write tools are not collected and a direct call is refused by the outer gate, data unchanged. DAP context: every row of §6.3 in order. `source_type=None` → `WRITES_SOURCE`. Simulated `ImportError` → refused. A param whose `input` contains a forged `__tool_context__` → ignored. Client-sent `caller` overwritten. Audit block carries no content keys. The expectation table imports `VECTOR_ALLOW_WRITES_DEFAULT`.
- `createCollection` on an empty mocked driver succeeds; `writeDocuments` with objectId `schema` fails before `addChunks`.
- Reads (§6.6): each DAP-only read tool, stamped with a `'public'` caller and sent through the dispatcher, answers `READS_PUBLIC` without reading the store; account, task, chat-source, broadcast, agent and unstamped calls are answered. `nodes/test/test_embed_tool.py` pins the same for `embed`, with no token spent.

### 6.6 Reads (`vx_write_gate.check_read`)

`list_documents`, the DAP-only read tools (`dialect`, `chunks`, `vectors`, `sample`, `project`, `neighbors`) and `embed` run `check_read()` first. A DAP call whose `caller.auth` is `'public'`, that is, a connection signed in with a task's public key, is refused with `READS_PUBLIC` ("The store refused this request.") before anything is read or embedded and before `embed` spends a token. Every other caller reads as before: reads are not limited to Tools sources (a read-only card reads through the Chat or Ingest source) or to calls that name the node, and a call without a context or from an agent is answered. The Vector Explorer signs in with an account, so it never meets this refusal; `wording.ts` gives it the generic refusal sentence.
