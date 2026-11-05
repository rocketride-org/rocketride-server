# Vector Explorer Phase-0 pins (manual)

Pytest pins that check, against a live engine, the facts the Vector Explorer
build relies on. Each one fails loudly when what it pins does not hold,
including when the engine or a container is missing. **They are manual: not
wired into CI**, and nothing in `./builder test` runs them.

Everything here is for **disposable local containers only**; every default is a
throwaway local-only value, not a secret.

| File | Pins |
| --- | --- |
| `test_g0_1_template_start.py` | **G0-1**: a template started through `start_fixtures.py --llm stub` runs `tools_1`, `chat_1` and `ingest_1` under the fixture's project id with no idle timeout, and its `parse_1` pins `index.maxFileSize`. An upload over that cap is parsed, not excluded (the upload answers `complete` and the ingest task gains no `Excluded` status warning): the engine does not apply the template's cap, so the app's own limit is the only one (see below). **G0-1b**: the raw template (placeholder key, empty `base_url`) starts its chat source, and a chat answers with the LLM error as its answer text. |
| `test_g0_2_reachability.py` | **G0-2**: on the Tools and Chat tokens, `store_1`, `store_2`, `embed_1` and `llm_1` are in the call chain ("No handler found" for a tool they lack); `parse_1` and `chunk_1` are not ("not found in pipeline"). |
| `test_g0_3_context_sources.py` | **G0-3**: the call context's `source_type` is the provider of the calling task's source (`tools`, `chat`, `dropper`), and `caller.auth` follows the key kind (account key, `tk_` task token, `pk_` public task key). |
| `test_g0_5_services.py` | **G0-5**: `vx-qdrant` and `vx-chroma` answer health and their clients connect; `psycopg2` and `psql` reach `rrtenant` through `vx-pgbouncer`. |
| `test_g0_7_call_context.py` | **G0-7**: through the real engine, an agent-style call reads origin `agent`, a plain invoke reads no context (and does not inherit its caller's), a context forged in the tool input is ignored, a DAP call reads origin `dap` with the server's caller (a client-sent caller is replaced), and the agent catalog leaves out tools listed for external callers only. Against a real store (`store_postgres`, default switches) an agent upsert succeeds while the same upsert through `client.tool()` answers `WRITES_DISABLED`. |
| `test_g0_8_payload.py` | **G0-8**: 1 MB and 4 MB tool answers round-trip through the Python client and the TypeScript client (`ts_payload.cjs`), with latencies and the trace-trim cost recorded. |

G0-6 (chunking calibration) lives with the templates, not here.

## Running them

1. The containers, fake broker and stub LLM from `../README.md`.
2. An engine started with the probe nodes (test-only nodes that load only with
   `--node_path`):

   ```bash
   (cd dist/server && \
     RR_STORE_URL=filesystem://$(mktemp -d) \
     ROCKETRIDE_DB_BROKER_URL=http://127.0.0.1:18788/provision \
     ROCKETRIDE_DB_BROKER_TOKEN=local-broker-placeholder \
     ./engine ai/eaas.py --host=127.0.0.1 --port=5590 \
       --node_path=$PWD/../../nodes/test/vx_context_probe) &
   ```

3. For G0-8, the TypeScript client's CommonJS build
   (`./builder client-typescript:build`).
4. Run the pins with the engine's Python:

   ```bash
   (cd dist/server && ENGINE_URL=http://127.0.0.1:5590 \
     ./engine -m pytest ../../scripts/acceptance/vector-explorer/phase0)
   ```

The first G0-1 start installs and loads the embedding model; later starts take
seconds. The pins start their own pipelines with `ttl=0` and terminate them at
the end (set `VX_PHASE0_KEEP=1` to leave them running).

| Variable | Default | Used for |
| --- | --- | --- |
| `ENGINE_URL` | `http://127.0.0.1:5590` | the engine under test |
| `RR_TEST_APIKEY` | `local-acceptance-key` | sign-in on an OSS engine without `ROCKETRIDE_APIKEY` |
| `VX_PHASE0_FIXTURES` | `postgres` | which `start_fixtures.py` fixtures G0-1/G0-2 start (comma-separated) |
| `VX_PHASE0_COLLECTION` | `vx_phase0_docs` | the table / collection those fixtures use |
| `VX_PHASE0_RR_TABLE` | `vx_phase0_rr` | the table the RocketRide Vector fixture uses |
| `VX_PHASE0_RAW_COLLECTION` | `vx_phase0_raw` | the (empty) table the G0-1b raw-template chat reads |
| `VX_PHASE0_KEEP` | unset | `1` leaves the pins' pipelines running |
| `OUT_DIR` | `../out` | observations land in `out/phase0/*.json` (git-ignored) |
| `VX_QDRANT_*`, `VX_CHROMA_*`, `RR_TEST_PGVECTOR_POOLER_DSN` | the containers in `../README.md` | G0-5 |

## What the pins observed (engine at the Vector Explorer day-0 tip)

- **Parser size cap.** A 51 MB upload through `ingest_1` is parsed: the parser
  reads `maxFileSize` from the task configuration's `index` section, and the
  engine builds the task configuration without one, so `parse_1.config.index`
  in the templates is not applied. Until that changes the upload limit is the
  app's alone. When the task configuration does carry the section (tried with
  a local, uncommitted engine change), the parser excludes the file: the
  upload still answers `complete`, with no `result.error`, and the ingest
  task's status `warnings` gain `Excluded*Skipping <file> due to file size
  <n> which exceeds processing configured limit <cap>`. The oversize pin
  checks that no such warning appears, so it fails the day the engine starts
  applying the template's cap.
- **Source type.** The data connection's target endpoint is the pipeline's
  Null endpoint (logical type `null` for every task); the source type comes
  from the task's pipeline configuration (`pipeline.source` and that
  component's provider).
- **Raw template chat.** With the placeholder key the chat answers
  `**LLM error** — ValueError: Invalid API key.` (with network access to the
  provider; offline the error text names the connection failure instead).
- **Large answers.** 1 MB answers take about 0.16 s and 4 MB about 0.6–0.7 s
  through either client on a local engine; trimming a 4 MB answer for the
  tool trace costs about 70 ms per call.
