# Vector Explorer acceptance lanes (manual)

Live checks for Vector Explorer that the unit suites cannot make: a real engine
runs the shipped templates (`apps/vector-ui/templates`) against real vector
stores, the SDKs call the store tools, and a browser drives the app.

**These lanes are manual. They are not wired into CI**, and nothing in
`./builder test` runs them. The two live node suites they feed
(`nodes/test/test_vector_toolpath_full.py`, `nodes/test/test_vector_wire_fixtures_full.py`)
run with `./builder nodes:test-db` once they are registered there.

Everything here is for **disposable local containers only**. The fixtures write
into their own tables and collections (named below), and every credential the
scripts default to is a throwaway local-only test value for those containers,
not a secret. Never point them at a database that holds data you care about.

## What is here

| File | What it does |
| --- | --- |
| `vx_fixtures.py` | Settings and pipeline builders the scripts share: the fixture table (names, fixed local-only project ids, connections), the template loader, the stock-RAG shape, the stub LLM substitution, start/stop helpers and the objectId an upload name gets. |
| `start_fixtures.py` | Starts the fixture pipelines with `ttl=0` (the engine otherwise stops a task after 15 idle minutes); only what is not running yet. `--only`, `--llm stub\|template`, `--stop`. Warms the tiktoken cache first. |
| `demo/gen_corpus.py` | The fictional demo corpus: 40 documents in 11 folders (topic clusters, a 160-procedure manual, two near-duplicate pairs, one boilerplate paragraph ending six files, an OCR-junk file, an HTML table). Deterministic; `--check` compares a written copy. |
| `demo/seed_demo.sh` | Uploads the corpus into the fixtures as `C:/demo/<folder>/<file>` (two folders into `stock_rag` through its webhook); `--pager` fills the 1,500-document Qdrant fixture; `--if-empty` skips stores that already hold documents (a store holding only its control record counts as empty). |
| `seed_legacy.sh` | Seeds and verifies the legacy-shaped collections `vx_legacy_docs` (see below). |
| `calibrate_chunking.py` | Measures the templates' chunk sizes on the demo corpus and, with `--write N`, records the choice in `apps/vector-ui/tests/fixtures/chunking.json` and every template's `chunk_1`. |
| `stub_llm.py` | A local test stub of an OpenAI-compatible chat server, **not a model**: deterministic answers tagged `[STUB-LLM]` that quote the prompt, plain and streamed (SSE); `--tool-call NAME` answers one request with a tool call. Logs request bodies to `out/` (git-ignored). |
| `fake_broker.py` | Local stand-in for the DB broker's `/provision` endpoint, so `rocketride_vector` resolves a local database: the direct gx-pgvector DSN, or with `--pooler` the vx-pgbouncer one (both with `sslmode=disable`: the local containers serve no TLS). |
| `browser/lane_vector.cjs` | The console lane (gate G3; Playwright, Chrome): connections, console, upload, chat, the trash (move to the trash, restore, delete permanently), paging, sign-out, privacy. Writes one JSON verdict per step to `out/lane_vector.json`. |
| `browser/lane_vector_map.cjs` | The map lane (gate G4): both sample modes, hover, neighbours, lasso, query star and rays, the Table alternative, chunk path, duplicates, outliers, keyboard sectors, the layout-quality rule, the Qdrant legend, t-SNE's limit, Cancel, privacy. Writes `out/lane_vector_map.json` (with what each step measured). |
| `browser/ui.cjs` | Every selector, sentence and canvas data attribute the two lanes look for, in one table. |
| `browser/common.cjs` | What the lanes share: the step recorder, the WebSocket frame capture, the store's side through the TypeScript client, the privacy property. |
| `validate_all.sh` | Every repository gate the feature touches, with real builder actions; never stops early, exits non-zero when a step failed. A step that rewrites the TypeScript client's `constants.ts` (the builder does) gets the file back as it was before that step, an uncommitted edit included (`validate_lib.sh`). |
| `env.cjs` | Settings shared by the Node scripts and the browser lane, read from the environment. |
| `selftest/` | Self-tests of the harness itself (no engine, database or browser): the corpus, the calibration writer, the legacy seed's verdicts, the fixture builders, the stand-ins, `validate_all.sh`'s step runner, and the browser lane run against an empty stand-in page, where every check must fail. |

## Ports

| Service | Address |
| --- | --- |
| Engine under test | `http://127.0.0.1:5590` (`ENGINE_URL`; each worktree runs its own engine on its own port) |
| Fake broker | `http://127.0.0.1:18788/provision`, token `local-broker-placeholder` (start a second one on another port for the pooled pass) |
| Stub LLM | `http://127.0.0.1:18901/v1` |
| pgvector (`gx-pgvector`) | `127.0.0.1:55432`, database `rrtenant` |
| PgBouncer, transaction mode, in front of `gx-pgvector` (`vx-pgbouncer`) | `127.0.0.1:56434` |
| Qdrant (`vx-qdrant`) | `127.0.0.1:56333` (REST), `127.0.0.1:56334` (gRPC) |
| Chroma (`vx-chroma`) | `127.0.0.1:58000` |

## Prerequisites

### 1. Builds

```bash
./builder build                    # engine, nodes and the shell apps, into dist/server
./builder client-typescript:build  # for the Node scripts (dist/cjs)
```

### 2. Containers

Published on 127.0.0.1 only, with throwaway local values. The images are pinned
so the live suites compare like with like.

```bash
docker run -d --name gx-pgvector -p 127.0.0.1:55432:5432 \
  -e POSTGRES_USER=rruser -e POSTGRES_PASSWORD=rrpass -e POSTGRES_DB=rrtenant \
  pgvector/pgvector:0.8.0-pg16
# A transaction-mode pooler in front of gx-pgvector (the pooled pass)
docker run -d --name vx-pgbouncer --link gx-pgvector:pgv -p 127.0.0.1:56434:5432 \
  -e DB_HOST=pgv -e DB_USER=rruser -e DB_PASSWORD=rrpass -e DB_NAME=rrtenant \
  -e POOL_MODE=transaction -e AUTH_TYPE=scram-sha-256 -e DEFAULT_POOL_SIZE=4 -e MAX_CLIENT_CONN=200 \
  edoburu/pgbouncer@sha256:9c78945868a6a142c7fc40ccd843bbe5a606df163c7ffce4de70e0d628d696a2
docker run -d --name vx-qdrant -p 127.0.0.1:56333:6333 -p 127.0.0.1:56334:6334 \
  qdrant/qdrant:v1.17.1@sha256:94728574965d17c6485dd361aa3c0818b325b9016dac5ea6afec7b4b2700865f
docker run -d --name vx-chroma -p 127.0.0.1:58000:8000 \
  chromadb/chroma:1.5.9@sha256:1e0b73a187a28757c572acba508c46f48c9e8b0acaf5c20e6d95cdedce1acdf6
```

### 3. Fake broker, stub LLM and engine

```bash
ACC=$PWD/scripts/acceptance/vector-explorer
python3 $ACC/fake_broker.py &        # direct DSN; --pooler (on another --port) for the pooled pass
python3 $ACC/stub_llm.py &

STORE_DIR=$(mktemp -d)   # a fresh, disposable store; never your ~/.rocketlib/store
(cd dist/server && \
  RR_STORE_URL=filesystem://$STORE_DIR \
  ROCKETRIDE_DB_BROKER_URL=http://127.0.0.1:18788/provision \
  ROCKETRIDE_DB_BROKER_TOKEN=local-broker-placeholder \
  ./engine ai/eaas.py --host=127.0.0.1 --port=5590) &
```

Leave `ROCKETRIDE_APIKEY` unset: an OSS engine then accepts any non-empty key,
and the scripts sign in with `RR_TEST_APIKEY` (a local label, default
`local-acceptance-key`).

## Fixtures

| Key | Display name | What it is |
| --- | --- | --- |
| `postgres` | vx-local Vector (pgvector) | `postgres.pipe` on gx-pgvector, table `vx_demo_docs` |
| `rocketride_vector` | vx-local Vector (RocketRide Vector) | `rocketride_vector.pipe` through the fake broker, table `vx_demo_rr` |
| `qdrant` | vx-local Vector (Qdrant) | `qdrant.pipe` on vx-qdrant, collection `vx_demo_docs` |
| `chroma` | vx-local Vector (Chroma) | `chroma.pipe` on vx-chroma, collection `vx_demo_docs` |
| `stock_rag` | vx-local Stock RAG (pgvector) | the shape of `examples/rag-pipeline.pipe`: a webhook ingest, a chat with its own embedding and store node, **no Tools source** (the explorer's read-only case); table `vx_stock_rag`, writes on so a write through the chat source shows the source check |
| `qdrant_pager` | vx-local 1,500 documents (Qdrant) | `qdrant.pipe` on collection `vx_pager_docs`, filled by `demo/seed_demo.sh --pager` (the directory's background paging); started only when named |

```bash
(cd dist/server && ./engine $ACC/start_fixtures.py)                        # the first five, stub LLM
(cd dist/server && ./engine $ACC/start_fixtures.py --only qdrant_pager)    # one
(cd dist/server && ./engine $ACC/start_fixtures.py --stop)                 # terminate them
$ACC/demo/seed_demo.sh --if-empty                                          # the demo corpus
$ACC/demo/seed_demo.sh --only qdrant_pager --pager                         # 1,500 documents (about 25 s warm)
```

The first start installs and loads the embedding model (`all-MiniLM-L6-v2`),
which can take a minute or more; later starts take seconds. Every source of a
template fixture loads its own copy of the model. The stores create their
collection on the first upload; the scripts never create, drop or rewrite a
table or collection (`seed_legacy.sh --recreate` drops only `vx_legacy_` names).

## Legacy collections

`seed_legacy.sh` writes `vx_legacy_docs` on pgvector, Qdrant and Chroma the way
the store drivers did before the explorer, so every explorer tool is also
tested on old data: random point ids, no file size or ingest time, no `meta`
column on pgvector, and one document without its first chunk. Run it once with
an engine whose drivers are still the old ones; later runs only verify. The
seed ingests through `ENGINE_URL`, so point that at such an engine: the default
(`http://127.0.0.1:5590`) is the integration engine, whose drivers are the new
ones once the driver lanes are merged, and the seed then refuses (below).

```bash
ENGINE_URL=http://127.0.0.1:<old-driver engine port> $ACC/seed_legacy.sh             # seed what is missing, verify
ENGINE_URL=http://127.0.0.1:<old-driver engine port> $ACC/seed_legacy.sh --recreate  # drop vx_legacy_docs, seed again
$ACC/seed_legacy.sh --verify-only                                                        # no engine needed
```

- **pgvector**: the table is created with the old driver's DDL plus the
  `signature` column its insert writes, and the control row exactly as
  `createCollection` writes it; `postgres.pipe` uploads the corpus as
  `/srv/legacy/<folder>/<file>` and `rocketride_vector.pipe` (through the broker)
  the `kitchen` folder again as `/srv/legacy-rr/...`.
- **Qdrant, Chroma**: the old drivers create the collection.
- Then the first chunk of `manuals/long_manual.md` is deleted through each
  database's own client. A fresh upload never loses chunk 0 by itself: the
  chunker hands every text chunk of a document to the embedding node in one
  call, so the store sees one write per document.

Verified after seeding: one control record, exactly the long manual without
chunk 0, every corpus document present by its objectId, at least 64 rows left
for the long manual and a median chunk of 400-1,200 characters, and the old
drivers' shape: on Qdrant and Chroma only random (version 4) point ids, none of
them the `objectId#chunkId` uuid5 the new drivers derive, and only the old
metadata keys (no `ingestedAt`, `size` or `modifyTime`; on Qdrant no payload key
besides `content` and `meta`); on pgvector exactly the old columns, with a
`meta` column allowed only once a newer driver has opened the table (never
right after a seed) and no row carrying `meta`.

What the collections in your containers hold right now is a fact about the
containers, not about this file: `seed_legacy.sh --verify-only` (no engine
needed) prints their `facts` and the `problems` found, and exits 1 when any
check fails. Read those before relying on the shape.

Before it creates or drops anything named `vx_legacy_docs`, the seed asks the
engine at `ENGINE_URL` twice, and refuses with exit 1 and the engine's answer
under `refused` when either answer is wrong, so a `--recreate` on the wrong
engine leaves the existing collections as they are:

- **Chunking.** The templates' `ingest_1 -> parse_1 -> chunk_1` lanes run on
  the engine with a `response_documents` answer (no model, no store, seconds)
  over the corpus; the manual must give more than 64 chunks and the median
  chunk must be 400-1,200 characters. The calibrated shape needs a chunker
  that passes `strlen` to its splitter, as `preprocessor_langchain` does from
  this build on; an engine running an older checkout's chunker does not (see
  "What these lanes found" below): there the manual becomes 36 chunks and the
  median about 3,400 characters. What this checkout's own
  chunker node would cut is reported as `checkout_node`, but the engine's
  answer decides (the engine may run another checkout's code).
- **Drivers.** One small corpus file is written through every driver the seed
  would use (pgvector through `postgres.pipe` and `rocketride_vector.pipe`) into
  `vx_legacy_probe`, which must come out in the old drivers' shape above; the
  probe is dropped again either way.

## Live node suites

```bash
cd dist/server
./engine -m pytest ../../nodes/test/test_vector_toolpath_full.py -q -rs
RR_TEST_VECTOR_LEGACY=seeded ./engine -m pytest ../../nodes/test/test_vector_toolpath_full.py -q -rs   # on vx_legacy_docs
RR_TEST_PGVECTOR_POOLER_DSN=postgresql://rruser:rrpass@127.0.0.1:56434/rrtenant ./engine -m pytest ../../nodes/test/test_vector_toolpath_full.py -q -rs
./engine -m pytest ../../nodes/test/test_vector_wire_fixtures_full.py -q -rs
(cd ../../nodes && ../dist/server/engine test/vector_wire_fixtures.py ../apps/vector-ui/tests/fixtures/v1/live)   # regenerate the captures
```

The tool-path suite starts its own engine (free port), broker stand-in and stub
LLM, and drops only `vx_tp_` collections. By default its legacy pass builds a
legacy-shaped copy of its own collection; `RR_TEST_VECTOR_LEGACY=seeded` uses
`vx_legacy_docs` and only adds and removes documents of its own there.

## Browser lanes

```bash
PLAYWRIGHT_DIR=<a folder whose node_modules has playwright> ENGINE_URL=http://127.0.0.1:5590 node $ACC/browser/lane_vector.cjs
PLAYWRIGHT_DIR=<...> ENGINE_URL=http://127.0.0.1:5590 node $ACC/browser/lane_vector_map.cjs   # the map (qdrant fixture)
```

Both need the fixtures running and seeded (`demo/seed_demo.sh`, and
`--only qdrant_pager --pager` for the steps that need more than 1,000 points),
and the app built into the engine (`./builder vector-ui:build`). Each step
records PASS or FAIL with what it saw in `out/lane_vector.json` /
`out/lane_vector_map.json`; screenshots go next to them. A step passes only
when it returns `true`: a lane that cannot observe what a step names fails
it, which the selftest checks on two stand-in pages (one empty, one where
every element is visible but says nothing).

The app keeps every open connection's console and map mounted, hidden
behind the shell tab in front, so the lanes read only what is visible: the
map lane scopes its locators to the visible `.vector-map`, the console's
document count is the visible stats figure (`data-figure="documents"`), an
upload is finished when its own row in the upload list says so
(`data-status`), and `openConnection` returns to the Connections shell tab
before it opens (or focuses) a console. Map actions taken in a document tab
must bring the console back to the front by themselves; the chunk-path step
fails when they do not. `vector-ui:e2e-live` runs the console lane once per
backend in a child process that keeps the runner's own Node options (for
example a `-r` preload).

The lanes look for the app's wording as its design states it;
`browser/ui.cjs` is the single place to adjust when the app's wording or
structure differs. The map draws on a canvas, so the map lane also reads
these data attributes on the element that carries `data-points` (the
PointCanvas root, which must also be the element that takes the arrow keys):

| Attribute | Value |
| --- | --- |
| `data-points` | points drawn |
| `data-mode` | `detailed` or `light` |
| `data-layout` | the layout drawn: `pca`, `neighbour-graph` or `tsne` |
| `data-star` | `1` while a query star is drawn, else `0` |
| `data-rays` | rays drawn from the star |
| `data-links` | neighbour links drawn from the selected point |
| `data-chunk-path` | points on the chunk path drawn |
| `data-selected`, `data-focused` | index of the inspected / keyboard-focused point, empty for none |
| `data-selection` | points in the lasso selection |
| `data-overlap-pca`, `data-overlap-layout` | `quality.knnOverlap` (k = 15) of PCA and of the last refined layout, empty before one ran |

What G4 asks and where it is checked:

| G4 | Checked by |
| --- | --- |
| `data-points` = `sample.n` in both modes | map lane: detailed, light |
| hover, click lists 12 neighbours, lasso count | map lane: hover, click, lasso |
| Run query draws the star and rays (to the true top-k) | map lane: query (the rays' results equal the store's own `search` for the embedded vector) |
| chunk path, Duplicates and Outliers from the seeded corpus | map lane: chunk path (the long manual), duplicates (both planted pairs), outliers (the OCR scan first) |
| keyboard sector path and Table alternative | map lane: keyboard (each move checked against the sample's PCA coordinates), table |
| t-SNE refuses above 1,000; Cancel stops a layout | map lane on `qdrant_pager` |
| force layout kept only when kNN overlap >= PCA's | map lane: kNN overlap (both numbers in the lane JSON) |
| Qdrant legend says "neighbour graph computed by Qdrant" (a sample of up to 500 points; a larger one gets the store node's graph); on the other stores it says "neighbour graph computed by the store node", never the backend's name | map lane: legend (run on each fixture) |
| privacy property | both lanes, with `dialect.dimension` read from the store; the columns of a `sample`, `project` or `neighbors` answer (`points.*`, `density`, `knn.sims`, `similarities`, `scores`) are not counted as vectors when they hold exactly the answer's own count (the sample's `n`, its edge count, the named sample's `n`, the scope's length), so a dimension-long float array there is still caught |
| `a11y.contrast` in six themes | the app's unit test `tests/a11y.contrast.map.test.ts` |
| 2,000 points at 4x throttle, p95 frame <= 33 ms | the performance lane `browser/lane_vector_perf.cjs` (the map lane does not measure frame times) |

## Selftest

```bash
python3 -m unittest discover -s scripts/acceptance/vector-explorer/selftest -v
node --test scripts/acceptance/vector-explorer/selftest/*.test.cjs   # the shell expands the glob
```

## Settings

All optional; the defaults match the containers above.

| Variable | Default | Used for |
| --- | --- | --- |
| `ENGINE_URL` | `http://127.0.0.1:5590` | the engine under test |
| `RR_TEST_APIKEY` | `local-acceptance-key` | sign-in on an OSS engine without `ROCKETRIDE_APIKEY` |
| `OUT_DIR` | `out/` in this folder (git-ignored) | results, screenshots, logs |
| `VX_TEMPLATES_DIR` | `apps/vector-ui/templates` | the templates the fixtures start from |
| `VX_STUB_LLM_URL` | `http://127.0.0.1:18901/v1` | the stub LLM the fixtures point at |
| `VX_COLLECTION` | `vx_demo_docs` | table / collection of the pgvector, Qdrant and Chroma fixtures |
| `VX_RR_TABLE` | `vx_demo_rr` | table of the RocketRide Vector fixture |
| `VX_STOCK_RAG_TABLE` | `vx_stock_rag` | table of the stock-RAG fixture |
| `VX_PAGER_COLLECTION` | `vx_pager_docs` | collection of the paging fixture |
| `VX_PG_HOST`, `VX_PG_PORT`, `VX_PG_USER`, `VX_PG_PASSWORD`, `VX_PG_DATABASE` | `gx-pgvector` | the pgvector fixtures' and seeds' connection |
| `VX_QDRANT_HOST`, `VX_QDRANT_PORT` | `127.0.0.1`, `56333` | the Qdrant connection |
| `VX_CHROMA_HOST`, `VX_CHROMA_PORT` | `127.0.0.1`, `58000` | the Chroma connection |
| `RR_TEST_PGVECTOR_DSN`, `RR_TEST_PGVECTOR_POOLER_DSN`, `RR_TEST_QDRANT_URL`, `RR_TEST_CHROMA_URL` | the containers above (pooler: unset) | the live node suites |
| `RR_TEST_VECTOR_LEGACY` | `emulated` | the tool-path suite's legacy pass (`seeded`: `vx_legacy_docs`) |

## What these lanes found about the engine

These shape the templates and the tests; each was measured on a local engine.

- **The parser's size cap is not applied to these pipelines.** The parser reads
  `index.maxFileSize` from the task's own configuration, which the engine
  builds from the pipeline without an `index` section, so neither the
  templates' `parse_1.config.index.maxFileSize` nor a pipeline-level `index`
  is honoured (a 5.3 KB file went through with the cap at 1,000 bytes in both
  places). The templates keep the value; the app's own upload limits are the
  only ones, and a file over them is excluded, not ingested. The phase-0 pin
  `phase0/test_g0_1_template_start.py` fails the day the engine applies the cap.
- **Upload names**: a name starting with `/` is stored without its leading
  slash (`/srv/legacy/a.md` becomes the path `srv/legacy/a.md`), while the
  objectId is derived from the name as sent: `uuid5(NAMESPACE_URL, 'null://Stream/' + name)`.
- **What the Tools token addresses** (the store tools through `client.tool`):
  `store_1`, `store_2`, `embed_1` and `llm_1`; `parse_1` and `chunk_1` answer
  "not found in pipeline". The lanes rely on nothing else.
- **Upload errors arrive garbled**: a failed upload reports a UTF-8 decode error
  instead of the store's message, so a failure can only be shown as a failure.

Fixed in this build (the lanes and suites now rely on the fix):

- **The chunk size setting had no effect.** `preprocessor_langchain` filtered
  the splitter's keyword arguments by the splitter class's own `__init__`
  signature, and LangChain's splitters take `chunk_size`, `chunk_overlap` and
  `length_function` through `**kwargs`, so every chunk was up to LangChain's
  4,000-character default whatever `strlen` said (on the demo corpus: 81
  chunks, median 3,409 characters). The filter now reads every `__init__`
  along the splitter's MRO; `strlen` 1,000 gives a median chunk of 806
  characters, which the templates carry, and
  `apps/vector-ui/tests/fixtures/chunking.json` records `effective: true`
  (`calibrate_chunking.py --sync` keeps it in step with the node).
- **The pgvector drivers could not create a table**: their DDL lacked the
  `signature` column their insert wrote. The shared pgvector driver creates
  tables with `signature` and `meta`. The legacy seed still creates its table
  itself, with the old shape, on purpose.
- **Chroma's `objdir` listed nothing**: it filtered on a metadata key
  (`chunk`) the driver never wrote. It now lists every document with a first
  chunk.

## Notes

- The fixture pipelines carry the templates' write switch: the writes (move
  to the trash, restore, delete permanently) are on for `store_1` and off for
  `store_2`.
- The stub LLM is a test stand-in. Answers tagged `[STUB-LLM]` prove that
  retrieval reached the LLM node, nothing about answer quality.
- The stub's request log and the engine's run logs hold document text; keep
  `out/` and the store directory local and delete them when done.
