# Vector Explorer

Vector Explorer (`apps/vector-ui`, app id `rocketride.vector`) is the shell app
for managing and visualising the documents in a vector store through a store
node in a running pipeline: a console of six tabs (Overview, Documents, Query,
Map, Collection and Trash) with staged removal, an Add documents aside for
ingest, search, comparison and an LLM question over the documents, and a map of
how close the chunks are. This page is for people changing the app, the store tools it calls, or the
drivers behind them.

- What users see is the public guide,
  <https://docs.rocketride.org/guides/apps/vector-explorer> (source:
  `docs/public/product/guides/apps/vector-explorer.md`).
- Every hook, tool, JSON shape, code, caveat and limit between the app and the
  nodes is the [Vector store tool contract](../nodes/vector-tool-contract.md).
  This page does not repeat it; it says where things live and how they fit.
- The discovery, session and role-channel code it shares with SQL Explorer and
  Graph Explorer is the [Explorer library](explorer-library.md).

## Where the pieces live

| Piece | Location |
| --- | --- |
| The app | `apps/vector-ui/` |
| The app's view of every answer, and the selection bridge between the console and the map | `apps/vector-ui/src/contract/` (`types.ts`, `bridge.ts`) |
| Discovery, roles, role channels, tool sessions | `apps/shared/src/explorer/` |
| Optional driver hooks and their defaults | `packages/ai/src/ai/common/store/document_store.py` (`DocumentStoreBase`) |
| The store tools | `packages/ai/src/ai/common/store/vx_tools.py`, mixed into `VectorStoreToolMixin` |
| The additive tools (`recommend`, `similarity_matrix`) | `packages/ai/src/ai/common/store/vx_tools_ext.py` (`VectorExplorerExtTools`, mixed in beside `VectorExplorerTools`) |
| A sample's clusters and their labels | `packages/ai/src/ai/common/store/vx_cluster.py` (union-find over the mutual kNN edges, TF-IDF labels) |
| Write gate | `packages/ai/src/ai/common/store/vx_write_gate.py` |
| Similarity, PCA, kNN, density, duplicates, sampling helpers | `packages/ai/src/ai/common/store/vx_math.py` |
| Per-instance sample cache | `packages/ai/src/ai/common/store/vx_sample_cache.py` |
| Value types, vocabularies, exceptions | `vx_types.py`, `errors.py` beside them |
| Write-switch defaults and tool limits (one source) | `packages/ai/src/ai/common/store/vx_defaults.py` |
| The shared pgvector driver (`store_postgres` and `rocketride_vector`) | `packages/ai/src/ai/common/store/pgvector/` |
| Call context of a tool invoke | `packages/ai/src/ai/common/tool_context.py` |
| Tool audience (`agent`, `dap`) | `@tool_function(audience=...)` in `packages/server/engine-lib/rocketlib-python/lib/rocketlib/filters.py` |
| The `embed` tool on the embedding nodes | `packages/ai/src/ai/common/embed_tool.py`, used by `embedding_transformer` and `embedding_openai` |
| Store nodes | `nodes/src/nodes/{store_postgres,rocketride_vector,store_qdrant,store_chroma,store_milvus,store_weaviate,store_pinecone,store_astra,store_atlas}/` |
| The write switches as node fields | `vector.allow_writes` in `nodes/src/nodes/core/services.common.vector.json`; on `rocketride_vector`, `rrvector.allow_writes` behind the outer switches `rrvector.expose_tools` and `rrvector.allow_write` (contract §6.0). Agents have no switch of their own: `allow_write` alone decides their writes |
| Starting pipelines | `apps/vector-ui/templates/*.pipe` |
| Wire fixtures and generators | `apps/vector-ui/tests/fixtures/` |
| Live acceptance (engine, containers, stub LLM, browser lanes) | `scripts/acceptance/vector-explorer/` ([README](../../../scripts/acceptance/vector-explorer/README.md)) |

## How a call travels

1. **Discovery.** The app's endpoint store is the shared library's, created
   with `VECTOR_ROLES`. It reads the running tasks and groups the three sources
   of one project (`ingest_1`, `chat_1`, `tools_1`, matched by source id or by
   the provider of the source: Drag & Drop or Webhook, Chat, Tools) into one
   connection per store node. The anchor is the Tools source when it runs;
   otherwise the Chat source, then the Ingest source, and the connection is
   read-only. With a Tools source, only the store nodes it controls are listed
   (`nodeFilter`), so the chat-side `store_2` never appears. The provider list
   is pinned from each store's `services.json`, so SQL and Graph stores are
   never listed, and Elasticsearch/OpenSearch are left out on purpose.
2. **Probe.** One `dialect` call per store node, on the anchor role's token. It
   answers the provider, backend, collection, metric, model, dimension, score
   definition, support level, write switches, capabilities, limits, health and
   caveats, and never a host, DSN, credential or database name. The console
   asks it again (`vectorEndpoints.probe`) when an upload completes, after every write, on Refresh, and once when fresh stats contradict the dialect (in a dev tool through the controller's `probe` op), so a store found empty shows its model, dimension and index
   once documents exist; until then the drawer reads them from the last
   `stats` answer, and the strip's "Empty collection" follows fresh stats.
3. **Tool calls.** `store.channel(client, endpoint, role)` returns a channel
   bound to one role's token; `invoke(tool, input, { nodeId })` sends a DAP
   `tool` request that always names the node. The engine checks the data
   permission on the calling task and dispatches inside that task's process to
   the named node. Tool calls, uploads and questions are never retried.
4. **On the node.** `VectorStoreToolMixin` wraps every tool: input
   normalisation, the `{success, ...}` envelope, numpy values to lists,
   rounding and the size check. The tool calls the driver's hooks; a hook the
   driver does not override answers with the base default or `UNSUPPORTED`.
5. **Ingest is not a tool call.** The app sends files with
   `channel('ingest').sendFiles(...)` to the Ingest source; the parser,
   chunker, embedder and `store_1` write them through the data lane. Each file
   carries `objinfo: { name: <path>, origin: 'vector-explorer' }` and never an
   `objectId`.
6. **Ask.** `channel('chat').ask(...)` runs the chat path; the answer carries
   `answers` and, through `response_2`, the retrieved `documents` the sources
   panel and the map use.
7. **Map.** `sample` returns positions computed on the node (PCA), a kNN graph
   (native on Qdrant), density, outliers and duplicates; `project`,
   `neighbors` and `search` take a query vector from `embed`. Raw vectors leave
   the node only through `vectors` (two keys at most). The browser refines the
   layout in a worker (a seeded force layout over the kNN graph, or exact t-SNE
   up to 1,000 points), and keeps the force layout only when it preserves
   neighbours at least as well as PCA (`map/quality.ts`).

### Why the pipeline has two store nodes

The templates (and the contract's §5 "VX shape") give the managed store,
`store_1`, the documents lane and the Tools source's control, and put a second
instance of the same provider and collection, `store_2`, on the chat's
questions lane. The engine rejects one store node that is both fed by the data
lane and drives the chat's sub-pipeline, so the two roles are split. `store_2`
keeps `allow_writes` false and the app never lists it. When a pipeline has only
one store node, the app falls back to reaching `embed` through the chat role
and disables text queries on the map, with the reason, when nothing reaches it.

## The app

`apps/vector-ui/src/`:

| Folder | What is in it |
| --- | --- |
| `adapters/` | The one seam to the shared library and the shell: provider list, tool names, the endpoint store with its roles and node filter, history, the announcer, the per-connection request channel for `neighbors` |
| `contract/` | The wire types and the selection bridge, changed only together with the contract (see [Changing the contract](#changing-the-contract)) |
| `vector/` | Pure modules tested under `node:test`: addresses, connections, stats, the document tree and its background pager, pure-JS SHA-1 and the uuid5 objectId, file types, upload batching, chat results, retrieval, safe markdown, wording, colours, support levels, identity changes, budgets; the workbench's tabs and focus rules (`workbench.ts`, `focus.ts`), the Overview's cards, top folders and insights (`overview.ts`), the Documents tab's folder tree and grid logic (`tree.ts`, `grid.ts`, `documents.ts`), staged removals and the confirmations' words and typed rules (`staged.ts`, `confirm.ts`), the Collection tab's fields and the drawer's sample chunks (`fields.ts`, `fieldsRead.ts`, `sampleChunks.ts`, `chunkRows.ts`), the scope and saved filters (`filters.ts`, `savedFilters.ts`), the collection charts (`charts.ts`, `chartTokens.ts`), document health (`health.ts`), the search workbench and its comparison (`searchWorkbench.ts`, `compare.ts`), the Query history and its focus rules (`queryHistory.ts`, `queryFocus.ts`), exports (`export.ts`), saved views (`savedViews.ts`) and query-word highlighting (`highlight.ts`) |
| `map/` | Renderer (WebGL points with a Canvas2D fallback, both with `snapshot` for the PNG export), camera, picking, lasso, the layouts and their worker, the layout-quality metric, query projection; clusters folded in the browser (`clusters.ts`), similarity edges and the spanning tree (`graph.ts`), isolation (`isolate.ts`), the duplicates queue (`dedupe.ts`), outlier review (`outliers.ts`), recommend examples (`recommend.ts`), matrix ordering (`matrixOrder.ts`), the PNG composite (`exportPng.ts`); the edge colours, ring and star drawing (`overlay.ts`), the contrast helpers they use (`contrast.ts`) and where a popover goes in the window (`popover.ts`); the dimming in both renderers (`renderer.webgl.ts`, `renderer.canvas2d.ts`) |
| `chat/`, `ingest/` | The chat (Ask) and upload hooks and the folder-drop traversal |
| `views/`, `components/` | Connections, the console (the default view: the header, the tab row, the banners and one panel per tab), the map and the document tab, and their parts: `WorkbenchTabs` and `TabRow` (the tab rows), `OverviewPanel` (with `StatsStrip` and `StatsCharts`), `DocumentsTab`, `FolderRail`, `VectorGrid`, `DocumentDrawer`, `PendingBar`, `TrashTab`, `QueryTab` with `SearchPanel`, `QueryCompare`, `ChatPanel` and `HistoryAside`, `CollectionPanel`, `ChunksGrid` and `ChunkDrawer`, `AddDocumentsAside`, `InlineRemoveConfirm`, and the map's `MapToolbar` and `AdvancedPopover` (`usePopover`, which `ExportMenu` and `SavedViewsMenu` use too) |

Rules the tests pin:

- **Tokens stay in memory.** No task token in a snapshot, history entry,
  preference or log. Signing out or switching organization or team clears every
  per-connection cache.
- **No raw vectors in the map.** No module under `src/map/` receives a raw
  vector; it works on the node's positions and kNN graph.
- **No `crypto.subtle`.** The collision check derives the engine's objectId
  (uuid5 of `null://Stream/<path>`) with the pure-JS SHA-1 in
  `vector/sha1.ts`, because `crypto.subtle` is missing on plain-HTTP origins
  other than localhost.
- **Safe answers.** Model output goes through `vector/markdown.ts`: no raw
  HTML, no remote images, links with `rel="noopener noreferrer nofollow"`.
- **Every code and caveat has a sentence** in `vector/wording.ts`.
- **Configuration stays private.** From a pipeline's configuration the app
  reads only the provider, node name, pipeline name and collection.
- **Same-name uploads.** The upload queue sends files whose base name repeats
  within one drop one at a time, because upload progress events are keyed by
  file name.
- **No browser storage.** Nothing under `src/` touches `localStorage` or `sessionStorage` (pinned for every source file), nor IndexedDB (pinned for the map, chat, upload and Query files). Saved filters, saved views, the reviewed
  documents, the recommend examples, the staged set, the sampled metadata fields
  and the drawer's sample chunks are per-connection state registered with the
  connection caches (or held by the connection's entry) and cleared with them.
- **The bottom line is one fixed height.** The workbench ends in one line of the
  pending bar's height (`PENDING_BAR_HEIGHT`, 32 px): the pending bar, or a write's
  result with its sentence and audit behind "Write details", or nothing
  (`bottomSlot` in `vector/workbench.ts`: a success holds the line for
  `RESULT_FIRST_MS` while documents are staged, a failure or partial result until
  the staged set changes or Show pending). What appears after a press never moves a row above it. A document surface has a slot of its own for its own Move to Trash and Restore (`components/DocumentWriteLine.tsx`, `documentSlot`): the hub's rules without a pending bar, and the full app's document tab shows only the writes asked under its own origin.
- **The grids are hand-windowed.** `VectorGrid` (with `vector/grid.ts`) is a
  keyboard grid with its own sorting, windowing and focus rules, not the shell's
  `DataGrid`, so column resize and reorder do not exist; the Documents, Trash
  and document-tab Chunks grids use it, read the rows they are given and never write to them (`tests/vector.grid.test.tsx` sorts frozen rows); their columns are declared in each tab's module, never derived from rows.
- **No modal dialogs in documents.** rocket-ui keeps hidden documents mounted, so
  the removal confirmations, the Add documents aside, the drawers and the map's
  popovers are in the document's tree. There are two exceptions, both full-app only: the replace question of an upload (`ingest/ReplaceConfirmDialog.tsx`, the shell's `ConfirmDialog`) and the Connections page's drawer (the shell's `DetailPanel`, `views/ConnectionsView.tsx`). No dev-tool frame reaches either (`tests/devtool.mounts.test.ts`). Escape is handled by the innermost handler that acts,
  which calls `preventDefault`; outer handlers skip a `defaultPrevented` event,
  and no handler calls `stopPropagation`.
- **A derived view never re-samples.** Minimum cluster size, the duplicates
  threshold, the outlier share, edges and isolation are computed from the
  sample the browser holds (`sample.knn`, `sample.density`,
  `sample.duplicates`, `clusters.labels`); `sample` is called again only for
  another size, mode, seed, scope, an expired sample, or after a write (below).
- **Writes.** The Documents and Trash tabs each list through the controller's
  one `view` (`setView('active')` / `setView('trash')`, the trash listed the
  first time it shows); **Trash (N)** is `stats.deleted_documents`. Move to
  trash (`soft_delete`) and Restore (`restore`) can be undone, so nothing is
  typed for them (Restore asks nothing at all); inside the console, Move to
  trash is staged first (`entry.staged`, `vector/staged.ts`: the grid's tick, the
  drawer, the map's review queues) and the pending bar's Apply is the one
  confirmation. A document tab's own trash button confirms at once. Delete
  permanently and Empty trash send `delete` with `deleted_only: true` (Empty
  trash over the whole `list_documents {deleted: 'deleted'}` listing), so a
  document with live chunks keeps them, and the result names the `kept_live`
  documents by path; they keep the typed confirmations (one document: its file
  name, or `1` with no path; several, or Empty trash: the count; on
  `rocketride_vector` the table name). Every write is sent once per batch of `write_ids_max` and never retried, and every write but Restore is confirmed by the console's controller only (`vector/consoleStore.ts`, `vector/confirm.ts`), inline in both mounts. A confirmation belongs to the surface that asked (its origin) and renders only there; another surface asking meanwhile is told to finish that one first. The staged
  set is never pruned against a listing; it shrinks on this realm's own removal result (moved, or `not_found`), on another frame's write that names it (`docVersions` `gone`), and on Discard and Unstage; a dev-tool frame keeps it across a reconnect and drops it only on an identity change. After any write that ran
  the console asks `stats` in full, lists both listings again, probes the dialect
  again and bumps the connection's write count, which makes the map draw its
  sample again.
- **The Query history.** Every finished Search, Compare and Ask run, while recording is on, goes to
  `env.queryHistory` (`adapters/queryHistory.ts`): the shared history store
  over the workspace preferences in the full app (`vector.history`, per
  owner), a store of its own that reads and writes nothing in a dev-tool
  mount. Both keep the first 200 characters of a question; a Compare's question
  B is held in memory beside the store and is never handed to it.
- **Exports carry no vector.** `vector/export.ts` imports nothing that calls a
  tool; its rows are words and numbers, snippets at most `snippet_chars`.

Builder tasks (see the [builder reference](../builder/reference.md)):

```bash
./builder vector-ui:build     # bundle into dist/server/static/apps, register in apps.json
./builder vector-ui:dev       # rsbuild dev server on port 3103
./builder vector-ui:test      # node:test over apps/vector-ui/tests
./builder vector-ui:e2e-live  # browser lanes against ENGINE_URL; opt-in, not part of test or CI
```

`vector-ui:test` runs every suite under `apps/vector-ui/tests` and fails when a
suite it requires is missing: every one of `ALWAYS_REQUIRED_TESTS` in
`apps/vector-ui/scripts/tasks.js`, and each suite of `FEATURE_TESTS` once the
module it is paired with is in the checkout (the enrichment's suites, so a merge
that brings a feature without its suite fails instead of passing with the suite
never run).

## As a dev tool

The app also declares `devToolFrame` and `devToolSidebar`
(`apps/vector-ui/src/AppDescriptor.ts`; manifest category `devTool`), so VS
Code and rocket-ui mount it beside the pipeline editor on the dev-tool
contract the [Explorer library](explorer-library.md#running-the-library-in-a-dev-tool-controller)
describes. The sidebar mount is the controller: it owns the endpoint store,
the bus-backed client, identity and discovery, and serves `vector.*` ops by
connection key. Every document is a frame with no client: `console:<key>`
(its tabs, the map among them, are inside it) and `document:<key>:<encoded objectId>`; the
generic frame is one empty state, and any other docKey is "not found".

- **Calls.** A frame's views call the same functions as the full app, through a
  remote role channel that maps each tool to its op. The controller resolves
  the node, waits exactly the session wait the protocol names
  (`apps/vector-ui/src/devtool/protocol.ts` `waitFor`), and answers the tool's
  raw value, so failure envelopes keep their codes for the frame's own
  readers. Results and arguments are capped before anything is sent.
- **Writes.** The frame's console controller confirms (inline) and sends one
  batch per op; the controller re-checks the console model's `writes` on its
  own record and probe for every write, sends it once, and publishes
  `docVersions`, which every other frame of the connection reads as "refetch".
- **Across frames.** The console's query text and median travel as hints
  (`queries`, `consoleSummary`); a chunk focus and keys for the map travel as
  relay ops whose requests are retained with a nonce and taken once.
- **Degraded.** Ask and Add documents need `client.chat` and file uploads, which
  the dev-tool hosts do not broker for store tools: Ask (in the Query tab, with
  **Use Search**) and the Add documents aside say so in place
  (`DEVTOOL_CHAT_NOTE`, `DEVTOOL_UPLOADS_NOTE` in `src/env.ts`). Exports fall
  back to a copy, the layout worker to PCA. Nothing is persisted in a dev-tool
  mount: the Query history is in memory and says so (`DEVTOOL_HISTORY_NOTE`).

Where the code lives and what the tests pin is in
`apps/vector-ui/docs/development.md` ("Mounts and the env seam"); the suites
are `apps/vector-ui/tests/devtool.*.test.ts`.

## The write switch

- **One source for the default.** `VECTOR_ALLOW_WRITES_DEFAULT` (false) lives
  in `vx_defaults.py`.
  `apps/vector-ui/scripts/gen_defaults.py` exports it, with the tool limits,
  to `apps/vector-ui/tests/fixtures/defaults.json`, and `--check` fails when
  the JSON is stale. The node, the app's templates test and the tool-path
  suite's expectation table all read that value, so changing a default is one
  line plus regenerating the JSON.
- **Where it lives in a pipe.** `config[config.profile].allow_writes` on the
  store component (contract §6.1). The templates set it explicitly: `true` on
  `store_1`, `false` on `store_2`.
- **The gate** (contract §6.3) runs first in `delete`, `soft_delete`,
  `restore` and `upsert`, fails closed, and answers refusals as envelopes; the write tools
  stay listed. An agent's write is decided by the outer switch `allow_write`
  alone, as on develop (#2631); the gate has no agent switch, so agent
  pipelines keep writing as before.
  `rocketride_vector` is the exception (contract §6.0): its tools, and then its
  write tools, exist only while `expose_tools` and `allow_write` are on (both
  off by default), so its agents write only where `allow_write` is on. The
  `rocketride_vector` template sets `expose_tools` on both stores and
  `allow_write` on `store_1` only: `store_2` hides its write tools entirely, so
  neither agents nor DAP callers can write there (a write to it fails as an
  unknown tool, not with `WRITES_DISABLED`).
- **Ingest is not gated by the switch.** Files dropped on the Ingest source
  are written through the data lane; only the reserved objectId `schema` (the
  collection's control record) is refused there.

## Changing the contract

A change to a hook, tool, JSON shape, code, caveat or limit is one change
across:

1. the [contract page](../nodes/vector-tool-contract.md);
2. `vx_types.py` or `vx_defaults.py`, then
   `python3 apps/vector-ui/scripts/gen_defaults.py` to refresh `defaults.json`;
3. `apps/vector-ui/src/contract/types.ts` (a component that needs more props
   extends the contract interface in its own file instead);
4. the provisional fixtures, and the live captures when the wire output
   changes (see [Fixtures](#fixtures));
5. `vector/wording.ts` for a new code or caveat;
6. the public guide when users see the difference.

New tools are `@tool_function(..., audience=('dap',))` under the
`vectordb_tool` wrapper. The agent catalog does not change: the six legacy
store tools (`search`, `stats`, `delete`, `get`, `objdir`, `upsert`) keep their
descriptors byte-for-byte, and `test_tool_audience.py` pins that. The
audience only decides what a catalog lists, not who may call: a new read tool
calls `vx_write_gate.check_read()` first, which refuses a connection signed in
with a task's public key (`READS_PUBLIC`, contract §6.6), and a new write tool
runs `check_write` (§6.3).

## Adding or changing a store driver

- Override the hooks your backend can answer natively and inherit the rest.
  List anything else the backend does natively (for example
  `sample_stratified_native` or `knn_native`) in `VX_DRIVER_CAPABILITIES`;
  `capabilities()` and `dialect` report it.
- Every hook works on **legacy collections**, written by older drivers: random
  point ids, documents whose chunk 0 is missing, no `size`/`modifyTime`/
  `ingestedAt`, and no `meta` column on pgvector.
- `describe()` and `dialect` never carry a host, port, DSN, credential or
  database name.
- The control-record path stays open: `createCollection` writes `schema`
  through `addChunks(..., checkCollection=False)`, so no driver refuses it
  there; the external write paths refuse it.
- **pgvector:** every read and write is one self-contained transaction, with
  no session-level `SET`, because the managed store reaches tenant databases
  through a transaction-mode pooler.
- **Mocks.** `nodes/test/mocks/` replaces the store clients for the whole
  engine under `ROCKETRIDE_MOCK`. A driver that starts using a new native call
  adds it to that client's mock and pairs the mocked assertion with the same
  assertion in the unmocked suite. Do not mock numpy there.
- **Support level.** `dialect.support` is the driver's class constant
  `VX_SUPPORT`. The base default is `'experimental'`, for which `dialect` also
  adds the `experimental` caveat and the app shows the Experimental badge. Set
  `VX_SUPPORT = 'supported'` only once the driver's unmocked live suite passes
  on a new and a legacy collection (and, for the two pgvector providers,
  through the pooler); a mocked test never justifies it. The public guide
  names no supported store, so changing the constant needs no change there.

## Tests

| Suite | Files | Run with |
| --- | --- | --- |
| Tool mixin, hooks, math goldens, write gate, envelope and caps | `nodes/test/test_vectordb_tool_mixin.py`, `test_vector_hooks.py`, `test_vector_math.py`, `test_vector_write_gate.py`, `test_vector_tool_envelope.py` | `./builder nodes:test` (mocked pass) |
| The `embed` tool | `nodes/test/test_embed_tool.py` | `./builder nodes:test` |
| Call context and tool audience | `test_tool_context.py`, `test_tool_audience.py` | `./builder ai:test` |
| Live `rocketride_vector` driver on new and legacy collections | `nodes/test/test_rocketride_db_full.py` | `./builder nodes:test-db`, or by name |
| Live `store_postgres`, Qdrant and Chroma drivers on new and legacy collections | `nodes/test/test_store_postgres_full.py`, `test_store_qdrant_full.py`, `test_store_chroma_full.py` | `./builder nodes:test-db`, or by name |
| Every tool through a real engine and the shipped templates | `nodes/test/test_vector_toolpath_full.py` (needs `dist/server`) | `./builder nodes:test-db`, or by name |
| Wire fixtures still match the drivers | `nodes/test/test_vector_wire_fixtures_full.py` | `./builder nodes:test-db`, or by name |
| Clusters and their labels, the sampler's listing, the table flag | `nodes/test/test_vector_clusters.py`, `test_vector_sample_ext.py` | `./builder nodes:test` |
| `recommend` and `similarity_matrix` (Qdrant's native best score through the Qdrant fake) | `nodes/test/test_vector_recommend.py`, `test_vector_similarity_matrix.py`, `store_qdrant/test_vx_recommend.py` | `./builder nodes:test` |
| The documents filter and its `filter_applied` | `nodes/test/test_vector_documents_filter.py` | `./builder nodes:test` |
| The app | `apps/vector-ui/tests/*.test.ts(x)` | `./builder vector-ui:test` |
| Browser lanes | `scripts/acceptance/vector-explorer/browser/` (`lane_vector.cjs` console, `lane_vector_map.cjs` map, `lane_vector_enrich.cjs` the enrichment, `lane_vector_perf.cjs` frame times) | `./builder vector-ui:e2e-live`, manual |
| The lanes' own self-tests (no browser or engine: every step must fail on a stand-in page) | `scripts/acceptance/vector-explorer/selftest/` | `node --test scripts/acceptance/vector-explorer/selftest/*.test.cjs`, `python3 -m unittest discover -s scripts/acceptance/vector-explorer/selftest -p 'test_*.py'` |

`./builder nodes:test-db` runs the suites listed in `DB_LIVE_SUITES` in
`nodes/scripts/tasks.js`, which holds all six vector live suites; CI runs them
against Qdrant, Chroma and a PgBouncer in front of its pgvector container. To
run one or more by name, use the engine in `dist/server`:

```bash
cd dist/server
export RR_REQUIRE_DB_TESTS=1   # an unreachable server fails the suite instead of skipping it
./engine -m pytest ../../nodes/test/test_store_postgres_full.py ../../nodes/test/test_store_qdrant_full.py ../../nodes/test/test_store_chroma_full.py -q -rs
./engine -m pytest ../../nodes/test/test_vector_toolpath_full.py -q -rs
./engine -m pytest ../../nodes/test/test_vector_wire_fixtures_full.py -q -rs
```

The tool-path suite and the wire captures start their own engine; each run
takes its own block of free task ports (from `RR_TEST_TOOLPATH_BASE_PORT`,
default 44000), so runs from two checkouts at once do not reach each other's
tasks, and `RR_TEST_TOOLPATH_ENGINE_PORT` fixes the engine's own port.

With `RR_TEST_VECTOR_LEGACY=seeded` the tool-path suite runs its legacy pass on
the shared `vx_legacy_docs` that `seed_legacy.sh` writes. It adds and removes
only documents of its own there, and checks that: it fingerprints the seeded
collection when a backend's deployment starts (each seeded document's rows,
deleted ones included, and on pgvector the soft-deleted rows) and fails after
that backend's live tests if the fingerprint changed, so a write that touched
the seed is caught by the run that made it rather than by the next
`seed_legacy.sh --verify-only`. Its counts are of active rows, and the pgvector
seed's one soft-deleted row is expected in `stats.deleted_chunks` and in the
legacy `stats.count`. A seed written before the corpus planted its keyword
token skips the keyword case on the legacy side with a `NOT RUN:` reason (the
stored text has no such word); `seed_legacy.sh --recreate` seeds it again.

Without `RR_REQUIRE_DB_TESTS` a suite whose server is unreachable skips with a
`NOT RUN:` reason, so a run can pass without touching a database; read the skip
summary that `-rs` prints. A run by name also leaves out the checks
`nodes:test-db` adds to a required run (every suite passes at least one test,
and no test skips without a `NOT RUN:` reason); see
[Live database tests](../nodes/testing.md#live-database-tests).

The pooler pass is part of the suites themselves: the driver cases in
`test_store_postgres_full.py` and the `rocketride_vector` cases in
`test_rocketride_db_full.py` run once against the database and, with
`RR_TEST_PGVECTOR_POOLER_DSN` set, once more through that transaction-mode
pooler, and `test_vector_toolpath_full.py` runs `rocketride_vector.pipe` through
it a second time. Without the variable those cases skip with `NOT RUN:`; with
it set, a required `nodes:test-db` run also fails unless both pgvector suites
passed at least one pooled case (`DB_PGVECTOR_POOLER_SUITES`). The
servers, their pinned images and the local ports are in the acceptance
[README](../../../scripts/acceptance/vector-explorer/README.md).

`test_vector_toolpath_full.py` also calls the additive surface of the contract
(§4.4): the documents filter (server on pgvector, partial on the legacy table
for ingest dates, through the pooler too), the listing's health fields, the
dialect's `size_bytes` and `keyword_match`, keyword search for the corpus's
one token (`KX4471` in `ops/memo_q3.txt`), the `objectIds` cap, `sample`
clusters and listing, `recommend` and `similarity_matrix`. Each of these runs
once the code that answers it is on the branch, judged from the branch's own
source, and is skipped with a `NEEDS:` reason until then; a tool missing from a
running engine fails.

### The enrichment lane

`lane_vector_enrich.cjs` drives the enrichment in the served shell, one of the
four supported backends per run (`node lane_vector_enrich.cjs <url> <out-dir>
<backend>`; vector-ui:e2e-live's form `<url> <out-dir> chrome [backends]` runs
it once per backend). Each step records PASS only on an explicit `true` from a
verdict that is a pure function of the page's WebSocket frames and the store's
own answers (read through the TypeScript client, never through the page);
the self-test runs every verdict on a sound and on each broken answer, and the
whole lane on two stand-in pages, where every step must fail. It needs, besides
the demo corpus:

```bash
cd dist/server
./engine ../../scripts/acceptance/vector-explorer/demo/gen_corpus.py --seed-pad 600   # scope cards (Qdrant, Chroma): 600 one-chunk documents in vx_scope_docs
./engine ../../scripts/acceptance/vector-explorer/demo/gen_corpus.py --legacy-card    # the legacy pgvector card over vx_legacy_docs (after seed_legacy.sh)
```

The lane removes demo documents (the duplicates queue, an outlier) and uploads
three files of its own, then uploads the removed documents again under their own
names and removes its own, so the corpus is as it was. Because it writes to the
stores, `vector-ui:e2e-live` runs it only when `VECTOR_UI_E2E_LANES` names it
(`enrich`; the default run and `all` leave it out), once per backend of
`VECTOR_UI_E2E_BACKENDS`.

A run accounts for every step it plans (`stepsFor`, each named through
`STEP_TITLES`): a step it never reached, because sign-in timed out or the
browser did not start, records FAIL with the error, and so does the run in a
`lane` row. Run by `vector-ui:e2e-live`, a backend whose child exited non-zero,
wrote no result, or recorded fewer rows than it planned fails, so a backend
cannot drop out of a run that reports every step passing.

The steps that read the map after something has made it sample again read it
settled, from the app's own signals and never from a quiet period: the map root
holds a sample (`data-map-state="ready"`), the toolbar shows none of the map's
busy wording (Sampling…, Embedding…, Placing the query…; the Export menu's
status beside it does not count), the last `sample` request of the map's own
connection (each open connection has a map of its own; its requests carry
that connection's Tools task token) is answered and is what the map draws
whole (`data-shown` and the legend's "Showing N of …" are its n), and none of
the map's `embed`, `project`, `search` or `neighbors` calls is unanswered. After
the scope step's last Clear, the map, shown again, must settle on a sample
asked for after the Clear, unscoped and as large as the clusters step's.
Compare first settles the map on that unscoped sample, then clicks Show A and
B; once both stars are placed it reads the map again when it has settled: both
stars still placed, the legend naming star B's question, on the same sample.
The restore step removes on the page the uploads the store holds, then removes
through the store whatever the page left behind (an upload it could not remove
still fails the step), so a failed run does not leave the next one a changed
corpus.

The lane finds the enrichment's controls by the names and data hooks the app
gives them (its `UI` table). The self-test checks each of them, and the wording
the steps read, against the code of the app's source files (comment lines left
out), skipping a file with a `NEEDS:` reason while it is still a placeholder;
`VX_APP_SRC=<tree>/apps/vector-ui/src` points that check at another tree, for
example the merged app from a lane branch whose own copy still holds the
placeholders.

The map's toolbar gives the lanes these hooks. Lasso, Fit, 3D, Edges, Edges per point and Expand selected sit inside the Advanced panel (`data-advanced-panel`,
a disclosure whose button has `aria-expanded`), so a lane opens it first
(`openAdvanced` and `withAdvanced` in `browser/common.cjs`); Table stays on the
row. The busy words and Cancel sit in one status line that is always there
(`data-map-status`). The legend's row of glyphs names the marks drawn
(`data-legend-marks`), and the map canvas reports the points and edges it drew
faded (`data-dimmed`, `data-edges-dimmed`).

A lasso is only as good as the camera under it. Isolate, Show all and Show only
cluster move the points (the shown ones fill the layout, over a short tween), so
the lane fits the map once no frame has been drawn for 700 ms and fits it again:
the camera (`data-camera` on the map canvas) must not move on the second Fit. A
lasso over part of the canvas must then take some of the points drawn but not
all of them, and one over the whole canvas every one, so the matrix step's lasso
over a cluster shown alone selects exactly that cluster, and the export step's
selection is some of the sample, never the whole of it. Before it exports, the
export step reads the Selection tab: its line ("N points selected from M
documents") and the keys its Copy keys puts on the clipboard, emptied first so
an earlier copy is not read. The CSV's rows must be exactly those keys, as many
as the canvas counted, from M documents; any other points of the sample of the
same number fail the step. The isolate step also
reads the camera the app framed by itself after Isolate and after Show all, once
the points stop: a Fit then must leave it where it is. The duplicates step
computes the queue's groups from the sample the page holds (the node's pairs and
the kNN edges at or above the threshold, groups across documents only), moves
the slider to the first position below its start at which they change, reads
the panel's groups again, and requires the sample's groups there, with no
`sample` frame.

The perf lane (`lane_vector_perf.cjs`) measures the map's edges per mode
(`EDGE_MODES`: none, tree, neighbours:3, neighbours:5) on its 2,000-point
detailed sample, at 1x and 4x CPU throttling. Before the shell loads it sets
`window.__VX_PERF_LANE__ = { edgesAutoDegrade: false }`, so the map keeps every
edge however slow its frames; each row records what the map root reports
(`data-edges-auto-degrade`, `data-edges-degraded`, `data-edge-count`), and each
mode at 4x is its own gate (p95 frame interval ≤ 33 ms), failing when it was
measured with the switch on. Each edge row also records the edges its mode must
draw over the page's own sample (`edgesExpected`, computed from the sample
answer in the page's frames as `map/graph.ts` computes them: the tree is n minus
the kNN graph's pieces, Neighbours m each point's m strongest pairs, kept once)
and fails unless the map drew exactly that, so a slow mode cannot pass by
drawing fewer edges. The points row of the edge sample records the switch too:
a page that cannot turn it off gets one row saying so, and its edge rows are not
measured. `gen_perf.py --check` says whether the perf fixture's sample can
carry every edge row.

## Fixtures

| Folder | What | How it is made |
| --- | --- | --- |
| `apps/vector-ui/tests/fixtures/provisional/` | One hand-written answer per tool and case, including the error envelopes | By hand, from the contract |
| `apps/vector-ui/tests/fixtures/v1/live/<backend>/` | Answers captured from the live drivers, on a new and a legacy collection, scrubbed of volatile values; with the additive tools on the branch also `documents.filter`, `sample.clusters`, `search.keyword`, `recommend`, `recommend.best_score` (Qdrant; `recommend.unsupported` where the store refuses it, since a refusal capture is named by its code), `similarity_matrix` and `dialect.enriched` | `nodes/test/vector_wire_fixtures.py`; `test_vector_wire_fixtures_full.py` regenerates and compares |
| `sample_*.json` among the provisional fixtures | Seeded synthetic `sample` answers for the map's tests | `apps/vector-ui/tests/fixtures/gen_sample.ts` (`--check` verifies them) |
| `defaults.json` | The write defaults and tool limits | `apps/vector-ui/scripts/gen_defaults.py` (`--check`) |
| `chunking.json` | The chunker settings every template carries | The chunking calibration run |

Regenerate the live captures only against the pinned container images: they
record each server's version.

## Running it locally

1. Build: `./builder build` (engine, nodes and the shell apps into
   `dist/server`), then `./builder vector-ui:build` after an app change.
2. Start the containers, the fake broker, the stub LLM and an engine on a
   fresh store exactly as the acceptance
   [README](../../../scripts/acceptance/vector-explorer/README.md) says. An
   engine seeds an app version once per store, so use a fresh store after a
   rebuild (see "Trying a production build on a local engine" in
   [the apps index](index.md#trying-a-production-build-on-a-local-engine)).
3. Start the fixture pipelines with `start_fixtures.py`: one template for each
   of the four stores Vector Explorer is built for, with all three sources,
   plus a RAG pipeline without a Tools source for the read-only card; no idle
   timeout, and the stub LLM in place of a model.
4. Open the engine's URL in a browser, sign in with any non-empty key on an
   OSS engine, and open Vector Explorer.

The stub LLM is a test stand-in: answers start with `[STUB-LLM]` and prove that
retrieval reached the LLM node, nothing about answer quality.
