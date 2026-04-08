# Docker — RocketRide Local Development Stack

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
