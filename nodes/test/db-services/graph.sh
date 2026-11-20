# Graph Explorer's live-lane servers (see _common.sh for the protocol; the suites
# they feed are registered in nodes/scripts/db-lanes/graph.js).
#
#   - PgBouncer (transaction mode) in front of rr-age, which the Postgres step of
#     .github/workflows/_build.yaml started: the cloud reaches tenant databases
#     through such a pooler, so the AGE suites also run through it (a second pass
#     of nodes:test with RR_TEST_AGE_DSN pointed here and the admin DSN direct).
#   - Neo4j and FalkorDB for the graph node live suites, pinned by digest: the
#     graph tools' read-only and result-shape guarantees are proved against these
#     exact servers (Neo4j 5.26.31 Community, FalkorDB module 6.0.1). Community
#     has no custom roles, so the read-only ROLE boundary is not exercised here;
#     the suites prove the node's own read path instead.
#
# scripts/acceptance/graph-explorer/README.md starts the same images locally.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=_common.sh
. "$here/_common.sh"

rr_pgbouncer rr-pgbouncer rr-age age 56433

docker run -d --name rr-neo4j -p 57687:7687 \
	-e NEO4J_AUTH=neo4j/rr-ci-graph-pass \
	-e NEO4J_server_memory_heap_max__size=512m \
	neo4j:5.26-community@sha256:d9cfe82983d27f5a75b3aaae8f316d04f9a698a3b7f6103a508f7caf8362f255 >&2
docker run -d --name rr-falkordb -p 56379:6379 \
	falkordb/falkordb@sha256:e2765e207e5ba4ee90e47ed31eb7491ad6dd3d42241c326e429375c02ad9882f >&2

rr_wait rr-neo4j 60 2 docker exec rr-neo4j cypher-shell -u neo4j -p rr-ci-graph-pass 'RETURN 1' || {
	docker logs rr-neo4j >&2 || true
	exit 1
}
rr_wait rr-falkordb 30 1 docker exec rr-falkordb redis-cli GRAPH.QUERY ci_smoke 'RETURN 1' || {
	docker logs rr-falkordb >&2 || true
	exit 1
}
docker exec rr-falkordb redis-cli GRAPH.DELETE ci_smoke >/dev/null 2>&1 || true

echo "RR_TEST_AGE_POOLER_DSN=postgresql://rruser:rrpass@localhost:56433/rrtenant"
echo "RR_TEST_NEO4J_URI=bolt://localhost:57687"
echo "RR_TEST_NEO4J_USER=neo4j"
echo "RR_TEST_NEO4J_PASSWORD=rr-ci-graph-pass" # gitleaks:allow — throwaway CI container password
echo "RR_TEST_FALKORDB_URL=redis://localhost:56379"
