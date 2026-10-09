# Docker: RocketRide Local Development Stack

## Prerequisites

- Docker Engine >= 24.0
- Docker Compose V2 >= 2.17 (bundled with Docker Desktop or installable as a plugin)

> **Note:** `deploy.resources` limits (CPU/memory) require Docker Compose V2 ≥ 2.17
> (shipped with Engine 23.0+). Engine 24.0+ is recommended and tested. Older
> releases silently ignore resource limits.

## Quick Start

```bash
# Change into the docker directory
cd docker

# Copy the environment template and adjust if needed
cp .env.example .env

# Start the full stack (engine + PostgreSQL + Milvus + ChromaDB)
docker compose up

# Start only the engine (and its dependencies)
docker compose up engine

# Start in detached mode
docker compose up -d
```

## Services

| Service  | Default Port | Description                       |
| -------- | ------------ | --------------------------------- |
| engine   | 5565         | RocketRide processing engine      |
| postgres | 5432         | PostgreSQL 16 with pgvector       |
| milvus   | 19530        | Milvus vector database            |
| minio    | 9000 / 9001  | MinIO object storage (for Milvus) |
| etcd     | 2379         | etcd key-value store (for Milvus) |
| chroma   | 8000         | ChromaDB vector database          |

## Common Commands

```bash
# View logs for a specific service
docker compose logs -f engine

# Rebuild the engine image after code changes
docker compose build engine

# Stop all services
docker compose down

# Stop and remove all data volumes
docker compose down -v

# Check service health
docker compose ps
```

## Vector Store Startup Behavior

`docker compose up` starts all three vector stores (pgvector, Milvus, ChromaDB)
together. The engine blocks on `postgres` being healthy (pgvector is required),
but only waits for Milvus and ChromaDB to be _started_, not healthy. The engine
is expected to handle transient connection retries against optional vector
stores. If a node depends on Milvus or Chroma and the corresponding service is
unhealthy, the engine surfaces the error at request time rather than at boot.
To run with a single vector store, start only the services you need (for
example: `docker compose up engine postgres`).

## Development Overrides

The `docker-compose.override.yml` file is automatically applied during
development. It provides:

- **Hot-reloading** of Python nodes via a bind mount from `nodes/src/nodes/`
- **Debug logging** enabled by default
- **etcd port** (2379) forwarded to the host for debugging

To run without dev overrides (e.g., for staging-like testing):

```bash
docker compose -f docker-compose.yml up
```

## Image Versions

All Docker images are pinned to specific versions in `docker-compose.yml` to
ensure reproducible builds. Check upstream release pages periodically and update
the tags when newer stable versions are available.

## Configuration

All configurable values are set via environment variables. See `.env.example`
for the full list. Copy it to `.env` and customise as needed.

**Security note**: Default passwords in `.env.example` are placeholder values.
Change all passwords before any non-local deployment.

## Volumes

Named volumes persist data between restarts:

| Volume     | Used By  | Purpose              |
| ---------- | -------- | -------------------- |
| pgdata     | postgres | Database files       |
| etcddata   | etcd     | Metadata store       |
| miniodata  | minio    | Object storage       |
| milvusdata | milvus   | Vector index data    |
| chromadata | chroma   | ChromaDB persistence |

## Images

| File | Built locally as | Published as | Purpose |
| ---- | ---------------- | ------------ | ------- |
| `Dockerfile.engine-base` | `rocketride/engine-base:<version>` (`container:build`), `rocketride/engine-base:local` (compose) | `ghcr.io/rocketride-org/rocketride-engine-base:<version>` | The engine from `dist/server`, its Python baseline installed, the libc++ load check. No entrypoint. |
| `Dockerfile.engine` | the compose `engine` service | `ghcr.io/rocketride-org/rocketride-engine:<version>` and `latest` | The server: engine-base plus `static/`, runs `ai/eaas.py`. |
| `Dockerfile.node` | `rocketride/node:<version>` (`container:build`) | `ghcr.io/rocketride-org/rocketride-node:<version>`, never `latest` | One pipeline task: engine-base plus a warmed uv wheel cache; tini, no command. |

The engine and node images are built FROM the engine-base of the same version
(`--build-arg ENGINE_BASE=...`). On Linux, `./builder container:build`
builds engine-base and the node image from the local `dist/server`; elsewhere
`dist/server` is not a Linux engine and the task skips. `./builder
container:test` builds them and checks the node image as a run gets it:
with capabilities dropped the engine is non-dumpable, the shipped constraints
are accepted as they are, every requirement file the cache was warmed from
installs from it with no network, and a uid other than 1000 in the image's
group can write what a run writes and install (`docker/test-node-image.sh`).
That last one matters because a task runs as the engine's own uid and gid with
`--group-add 1000`, so the image keeps everything a run writes — site-packages,
`cache/`, the uv cache, `/opt/data`, `HOME` — writable by its group. Files whose
resolution needs a local inference runtime — torch, or onnxruntime, which
depends() installs as the 430 MB onnxruntime-gpu on Linux — are not warmed: the
warm step lists them, and fails the build unless the file is installed only
without a model server (`inference_allowed` in `docker/warm-wheel-cache.sh`) —
otherwise every run would download it. Then it runs `nodes:test` with every task
in a container (`--runtime=docker`, see the self-hosting docs) and compares
nothing by itself: the same tests pass under both runtimes. Without a daemon each
step skips loudly. A rebuild with no changes takes seconds: the builder builds
the images without a provenance attestation, which records the build time and
would give a cached engine-base a new digest every time, so the node image built
FROM it would miss its cache.
CI runs it on Linux when the image's inputs change, and the release workflow
runs the same script on the published node image before signing it. All three
published images are cosign-signed. The node image has no `latest` tag on
purpose: a server starts tasks only from the node image of its own version.
