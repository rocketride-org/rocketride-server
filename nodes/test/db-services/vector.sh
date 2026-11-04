# Vector Explorer's live-lane servers (see _common.sh for the protocol; the suites
# they feed are registered in nodes/scripts/db-lanes/vector.js).
#
# Qdrant 1.17.1 and Chroma 1.5.9, pinned by digest (the images
# scripts/acceptance/vector-explorer/containers/start.sh pins), and PgBouncer in
# transaction mode in front of rr-pgvector (started by the Postgres step of
# .github/workflows/_build.yaml), through which the pgvector suites run their
# pooled cases.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=_common.sh
. "$here/_common.sh"

docker run -d --name rr-qdrant -p 56333:6333 -p 56334:6334 \
	qdrant/qdrant:v1.17.1@sha256:94728574965d17c6485dd361aa3c0818b325b9016dac5ea6afec7b4b2700865f >&2
docker run -d --name rr-chroma -p 58000:8000 \
	chromadb/chroma:1.5.9@sha256:1e0b73a187a28757c572acba508c46f48c9e8b0acaf5c20e6d95cdedce1acdf6 >&2

rr_wait rr-qdrant 60 1 curl -fsS http://127.0.0.1:56333/readyz || {
	docker logs rr-qdrant >&2 || true
	exit 1
}
rr_wait rr-chroma 60 1 curl -fsS http://127.0.0.1:58000/api/v2/heartbeat || {
	docker logs rr-chroma >&2 || true
	exit 1
}
rr_pgbouncer rr-pgvector-pgbouncer rr-pgvector pgv 56434

echo "RR_TEST_PGVECTOR_DSN=postgresql://rruser:rrpass@localhost:55432/rrtenant"
echo "RR_TEST_PGVECTOR_POOLER_DSN=postgresql://rruser:rrpass@localhost:56434/rrtenant"
echo "RR_TEST_QDRANT_URL=http://127.0.0.1:56333"
echo "RR_TEST_CHROMA_URL=http://127.0.0.1:58000"
