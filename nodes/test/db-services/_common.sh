# Shared helpers for the live-database service scripts in this folder
# (sourced by them, never run: the CI step skips names that start with "_").
#
# Protocol of a service script (run by the "Start DB live-lane services" step in
# .github/workflows/_build.yaml, in sorted order, after the Postgres step has
# started rr-pgvector and rr-age):
#   - stdout carries ONLY NAME=value lines: the test environment the script's
#     servers need. The step appends them to $GITHUB_ENV, and only after the
#     script exited 0, so a server that never became healthy exports nothing.
#   - everything else (docker output, progress) goes to stderr.
#   - a script that cannot make its servers healthy exits non-zero.
# RR_REQUIRE_DB_TESTS (exported by the Postgres step) then turns an unreachable
# server into a failure of the suites, never a skip.

# One PgBouncer image for every pooler, pinned by digest (1.26).
RR_PGBOUNCER_IMAGE='edoburu/pgbouncer@sha256:9c78945868a6a142c7fc40ccd843bbe5a606df163c7ffce4de70e0d628d696a2'

# rr_wait DESCRIPTION TRIES SLEEP_SECONDS COMMAND...
# Retries COMMAND until it succeeds; on failure prints the description and exits 1.
rr_wait() {
	local what=$1 tries=$2 delay=$3 i
	shift 3
	for i in $(seq 1 "$tries"); do
		if "$@" >/dev/null 2>&1; then return 0; fi
		sleep "$delay"
	done
	echo "$what did not become ready" >&2
	return 1
}

# rr_pgbouncer NAME TARGET_CONTAINER TARGET_ALIAS HOST_PORT
# A transaction-mode PgBouncer (scram-sha-256) in front of the Postgres container
# TARGET_CONTAINER, published on HOST_PORT, ready when a query through it works.
# The cloud reaches tenant databases through such a pooler.
rr_pgbouncer() {
	local name=$1 target=$2 alias=$3 port=$4 ip
	docker run -d --name "$name" --link "$target:$alias" -p "$port:5432" \
		-e DB_HOST="$alias" -e DB_USER=rruser -e DB_PASSWORD=rrpass -e DB_NAME=rrtenant \
		-e POOL_MODE=transaction -e AUTH_TYPE=scram-sha-256 -e DEFAULT_POOL_SIZE=4 -e MAX_CLIENT_CONN=200 \
		"$RR_PGBOUNCER_IMAGE" >&2
	ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$name")
	# psql inside the target container reaches the pooler by its bridge address.
	if ! rr_wait "$name" 30 1 docker exec "$target" psql "postgresql://rruser:rrpass@${ip}:5432/rrtenant" -tAc 'SELECT 1'; then
		docker logs "$name" >&2 || true
		return 1
	fi
}
