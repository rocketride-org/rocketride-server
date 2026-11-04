#!/usr/bin/env bash
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
# Graph Explorer validation: every repository gate the feature touches, with real
# builder actions only. Run from the repository root. Each step logs to
# $LOGS/<step>.log and records its exit status; the script never stops early and
# never hides a failure: it exits non-zero when any step failed. The node steps
# include test_graph_toolpath_full.py (the engine, the shipped templates and
# their graph tools through the Python SDK, as CI's Linux leg runs it); the
# manual SDK acceptance, lifecycle and browser lanes are not run here (see
# README.md in this folder).
#
# Prerequisites: the database containers from README.md (the nodes:test and
# nodes:test-db steps require them via RR_REQUIRE_DB_TESTS=1), started from the
# images CI pins in nodes/test/db-services/ (graph.sh, _common.sh), and a built dist/server. The
# db-versions step checks first that the servers report the versions the
# committed wire captures were taken on (check_db_versions.py): the wire-fixture
# suite compares those exactly, so a container from a newer image fails it for
# a reason that has nothing to do with the code. That check imports the
# database drivers, which a plain build does not install (nodes:test and
# nodes:test-db install them first), so the node-test-deps step before it
# installs nodes/test/requirements.txt into the engine the same way.
#
# Environment:
#   OUT_DIR       where the logs go (default: out/ next to this script, git-ignored)
#   STORE_DIR     disposable engine store for the test servers the builder starts
#                 (default: a new temporary directory). Without RR_STORE_URL the
#                 engine writes into ~/.rocketlib/store.
#   RR_TEST_AGE_POOLER_DSN  the transaction-mode pooler in front of AGE (default:
#                 the gx-pgbouncer container from README.md,
#                 postgresql://rruser:rrpass@127.0.0.1:56433/rrtenant). CI always
#                 sets it, so nodes:test runs the AGE suites a second time through
#                 PgBouncer; this script does the same and never skips that pass
#                 (an empty value also gets the default). With the pooler down the
#                 required pass fails, as it would in CI.
#   UV_CACHE_DIR, SDKROOT, CI  passed through when set (macOS builds may need SDKROOT).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
OUT_DIR=${OUT_DIR:-$HERE/out}
LOGS=${LOGS:-$OUT_DIR/validate-$(date +%Y%m%d-%H%M%S)}
STORE_DIR=${STORE_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/rr-validate-store.XXXXXX")}
mkdir -p "$LOGS"
export CI=${CI:-true}
export RR_STORE_URL=filesystem://$STORE_DIR
export RR_TEST_AGE_POOLER_DSN=${RR_TEST_AGE_POOLER_DSN:-postgresql://rruser:rrpass@127.0.0.1:56433/rrtenant}
SUMMARY=$LOGS/SUMMARY.txt
: > "$SUMMARY"
echo "revision $(git rev-parse HEAD) dirty=$(git status --porcelain | grep -v constants.ts | wc -l | tr -d ' ')" | tee -a "$SUMMARY"
echo "store $RR_STORE_URL" | tee -a "$SUMMARY"
# Where the AGE pooler pass connects. The DSN carries a password, so only a plain URL,
# scheme://[user[:password]@]host[:port][/path][?query] with no other '@', shows its host
# and port; any other form (libpq key/value, several hosts, an unencoded '@' or '/' in the
# password) shows a placeholder.
pooler_shown() {
	local url='^[A-Za-z][A-Za-z0-9+.-]*://([^@/?#]*@)?([A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])(:[0-9]+)?([/?#][^@]*)?$'
	if [[ $1 =~ $url ]]; then
		printf '%s%s' "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
	else
		printf '(set)'
	fi
}
echo "pooler $(pooler_shown "$RR_TEST_AGE_POOLER_DSN")" | tee -a "$SUMMARY"

step() {
	local name=$1; shift
	"$@" > "$LOGS/$name.log" 2>&1
	local rc=$?
	# The builder rewrites this file during builds; never leave it modified.
	git checkout -- packages/client-typescript/src/client/constants.ts 2>/dev/null
	printf '%-28s exit=%s\n' "$name" "$rc" | tee -a "$SUMMARY"
	STEPS=$((STEPS + 1))
	if [ "$rc" -ne 0 ]; then FAILED=$((FAILED + 1)); fi
}
STEPS=0
FAILED=0

# Frontend unit + type gates
step shared-test        ./builder shared:test
step sql-ui-test        ./builder sql-ui:test
step graph-ui-test      ./builder graph-ui:test
step shell-check        ./builder shell:check shell:test
# SDKs (frozen-surface tsc runs inside client-typescript:test)
step client-ts-test     ./builder client-typescript:test
step client-py-test     ./builder client-python:test
# Python: engine-side suites, graph suites, live databases (required, not skippable;
# the node steps also run the AGE suites through the pooler, RR_TEST_AGE_POOLER_DSN)
step ai-test            ./builder ai:test
# The version check needs neo4j, falkordb and psycopg2 in the engine: install the node test
# dependencies first, as nodes:install-test-deps does (depends(), engine constraints).
step node-test-deps     sh -c 'cd dist/server && exec ./engine -c "import sys; from depends import depends; depends(sys.argv[1])" "$1"' sh "$PWD/nodes/test/requirements.txt"
step db-versions        sh -c 'cd dist/server && exec ./engine "$1"' sh "$HERE/check_db_versions.py"
step nodes-test-db      env RR_REQUIRE_DB_TESTS=1 ./builder nodes:test-db
step nodes-test         env RR_REQUIRE_DB_TESTS=1 ./builder nodes:test
# Node README + docs gates
step node-readmes       python3 scripts/validate-node-readme.py nodes/src/nodes/graph_neo4j nodes/src/nodes/graph_falkordb nodes/src/nodes/rocketride_graph nodes/src/nodes/rocketride_sql nodes/src/nodes/db_postgres
step docs-validate      ./builder docs:validate
step docs-check         node scripts/build.js docs:check
step docs-build         ./builder docs:build
# Production app builds, then the full distribution
step apps-build         ./builder sql-ui:build graph-ui:build
step full-build         ./builder build

echo "logs: $LOGS" | tee -a "$SUMMARY"
echo "$((STEPS - FAILED)) of $STEPS steps passed" | tee -a "$SUMMARY"
if [ "$FAILED" -ne 0 ]; then exit 1; fi
