# Vector Explorer containers (disposable, local only)

`start.sh` brings up the containers the Vector Explorer's live suites and
acceptance lanes talk to. Every one is published on `127.0.0.1` only, and every
credential is a throwaway local-only test value for these containers. Never
point the suites at a server that holds data you care about.

```bash
scripts/acceptance/vector-explorer/containers/start.sh            # make all four run
scripts/acceptance/vector-explorer/containers/start.sh vx-qdrant  # just one (dependencies are not implied)
scripts/acceptance/vector-explorer/containers/start.sh --check    # change nothing; exit 1 if any is missing or silent
scripts/acceptance/vector-explorer/containers/start.sh --dry-run  # change nothing; say what would be done
bash scripts/acceptance/vector-explorer/containers/selftest.sh    # the script's own test, against a fake docker
```

The script is idempotent: a running container is left exactly as it is (never
recreated, restarted or removed), a stopped one is started in place, and a
missing one is created from its pinned image. After starting or creating a
container it waits until the container answers (`VX_HEALTH_TIMEOUT_S`, default
90 s). If a running container uses another image than the pinned one, the
script says so and leaves it alone.

## Containers and pinned images

| Container | Image (tag and digest) | Address | Used by |
| --- | --- | --- | --- |
| `gx-pgvector` | `pgvector/pgvector:0.8.0-pg16@sha256:a132765ec351c65111b5b675928a3a0515a466a40f97277329db8b8209ad8bc9` | `127.0.0.1:55432`, database `rrtenant` | pgvector and RocketRide Vector suites (shared with the Graph Explorer lanes) |
| `vx-pgbouncer` | `edoburu/pgbouncer@sha256:9c78945868a6a142c7fc40ccd843bbe5a606df163c7ffce4de70e0d628d696a2` | `127.0.0.1:56434` | the pooled pass: `pool_mode = transaction`, `default_pool_size = 4`, in front of `gx-pgvector` (linked as `pgv`) |
| `vx-qdrant` | `qdrant/qdrant:v1.17.1@sha256:94728574965d17c6485dd361aa3c0818b325b9016dac5ea6afec7b4b2700865f` | `127.0.0.1:56333` (REST), `127.0.0.1:56334` (gRPC) | `nodes/test/test_store_qdrant_full.py`, the Qdrant fixtures |
| `vx-chroma` | `chromadb/chroma:1.5.9@sha256:1e0b73a187a28757c572acba508c46f48c9e8b0acaf5c20e6d95cdedce1acdf6` | `127.0.0.1:58000` | `nodes/test/test_store_chroma_full.py`, the Chroma fixtures |

`vx-pgbouncer` is created only once `gx-pgvector` runs, since it links to it.
The Chroma 1.5.9 server reports its API version (`1.0.0`) as its version.

## Running the live store suites

```bash
cd dist/server
./engine -m pytest ../../nodes/test/test_store_qdrant_full.py ../../nodes/test/test_store_chroma_full.py -v
```

Each suite creates and drops its own `vx_contract_*` collections and only reads
the seeded `vx_legacy_docs` collection. Without a reachable server a suite skips
with a `NOT RUN:` reason; with `RR_REQUIRE_DB_TESTS=1` it fails instead.
`RR_TEST_QDRANT_URL`, `RR_TEST_CHROMA_HOST` and `RR_TEST_CHROMA_PORT` point them
elsewhere.
