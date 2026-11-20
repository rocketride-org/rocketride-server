#!/usr/bin/env bash
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
# Vector Explorer validation: every repository gate the feature touches, with
# real builder actions only. Run from the repository root. Each step logs to
# $LOGS/<step>.log and records its exit status; the script never stops early and
# never hides a failure: it exits non-zero when any step failed. The node steps
# include the live vector suites (test_store_postgres_full.py,
# test_store_qdrant_full.py, test_store_chroma_full.py,
# test_vector_toolpath_full.py, test_vector_wire_fixtures_full.py) and run the
# pgvector suites a second time through the transaction pooler; the manual
# fixture and browser lanes are not run here (see README.md in this folder).
# Written for the integrated branch: the vector-ui-test and apps-build steps
# run builder actions (vector-ui:test, vector-ui:build) that exist once the
# app lane is merged, so on a lane branch without the app those two fail.
# The harness's JavaScript selftests need Node >= 18 (node --test); their
# file list is expanded by the shell.
#
# Prerequisites: the containers from README.md (the nodes:test and
# nodes:test-db steps require them via RR_REQUIRE_DB_TESTS=1) and a built
# dist/server.
#
# Environment:
#   OUT_DIR       where the logs go (default: out/ next to this script, git-ignored)
#   STORE_DIR     disposable engine store for the test servers the builder starts
#                 (default: a new temporary directory). Without RR_STORE_URL the
#                 engine writes into ~/.rocketlib/store.
#   RR_TEST_PGVECTOR_POOLER_DSN  the transaction-mode pooler in front of pgvector
#                 (default: the vx-pgbouncer container,
#                 postgresql://rruser:rrpass@127.0.0.1:56434/rrtenant). This script
#                 never skips that pass; with the pooler down it fails.
#   UV_CACHE_DIR, SDKROOT, CI  passed through when set (macOS builds may need SDKROOT).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
OUT_DIR=${OUT_DIR:-$HERE/out}
LOGS=${LOGS:-$OUT_DIR/validate-$(date +%Y%m%d-%H%M%S)}
STORE_DIR=${STORE_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/rr-validate-store.XXXXXX")}
mkdir -p "$LOGS"
export CI=${CI:-true}
export RR_STORE_URL=filesystem://$STORE_DIR
export RR_TEST_PGVECTOR_POOLER_DSN=${RR_TEST_PGVECTOR_POOLER_DSN:-postgresql://rruser:rrpass@127.0.0.1:56434/rrtenant}
SUMMARY=$LOGS/SUMMARY.txt
: > "$SUMMARY"
echo "revision $(git rev-parse HEAD) dirty=$(git status --porcelain | wc -l | tr -d ' ')" | tee -a "$SUMMARY"
echo "store $RR_STORE_URL" | tee -a "$SUMMARY"
# Where a pooler pass connects. A DSN carries a password, so only a plain URL,
# scheme://[user[:password]@]host[:port][/path][?query] with no other '@', shows its
# host and port; any other form shows a placeholder.
shown() {
	local url='^[A-Za-z][A-Za-z0-9+.-]*://([^@/?#]*@)?([A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])(:[0-9]+)?([/?#][^@]*)?$'
	if [[ $1 =~ $url ]]; then
		printf '%s%s' "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
	else
		printf '(set)'
	fi
}
echo "pgvector pooler $(shown "$RR_TEST_PGVECTOR_POOLER_DSN")" | tee -a "$SUMMARY"

CONSTANTS=packages/client-typescript/src/client/constants.ts
if git diff --quiet -- "$CONSTANTS" 2>/dev/null; then constants_state=clean; else constants_state=modified; fi
echo "$CONSTANTS $constants_state before the run (each step that rewrites it gets it back as it was)" | tee -a "$SUMMARY"
# shellcheck source=validate_lib.sh
. "$HERE/validate_lib.sh"
STEPS=0
FAILED=0

# The acceptance harness's own selftests (no engine): a lane check that cannot observe what it names must fail
step harness-selftest-py python3 -m unittest discover -s "$HERE/selftest"
step harness-selftest-js node --test "$HERE"/selftest/*.test.cjs
# Templates, chunking and the write default stay generated from their sources
step corpus-check         sh -c 'd=$(mktemp -d) && python3 "$1/demo/gen_corpus.py" "$d" >/dev/null && python3 "$1/demo/gen_corpus.py" "$d" --check' sh "$HERE"
step defaults-check       python3 apps/vector-ui/scripts/gen_defaults.py --check
# Frontend unit + type gates (SQL unchanged)
step shared-test          ./builder shared:test
step sql-ui-test          ./builder sql-ui:test
step vector-ui-test       ./builder vector-ui:test
step shell-check          ./builder shell:check shell:test
# SDKs (frozen-surface tsc runs inside client-typescript:test)
step client-ts-test       ./builder client-typescript:test
step client-py-test       ./builder client-python:test
# Python: engine-side suites (store contract, tool context, audience), then the live databases
step ai-test              ./builder ai:test
step node-test-deps       sh -c 'cd dist/server && exec ./engine -c "import sys; from depends import depends; depends(sys.argv[1])" "$1"' sh "$PWD/nodes/test/requirements.txt"
step nodes-test-db        env RR_REQUIRE_DB_TESTS=1 ./builder nodes:test-db
step nodes-test           env RR_REQUIRE_DB_TESTS=1 ./builder nodes:test
# Node README + docs gates
step node-readmes         python3 scripts/validate-node-readme.py nodes/src/nodes/store_postgres nodes/src/nodes/rocketride_vector nodes/src/nodes/store_qdrant nodes/src/nodes/store_chroma nodes/src/nodes/store_milvus nodes/src/nodes/store_weaviate nodes/src/nodes/store_pinecone nodes/src/nodes/store_astra nodes/src/nodes/store_atlas nodes/src/nodes/embedding_transformer nodes/src/nodes/embedding_openai
step docs-validate        ./builder docs:validate
step docs-check           node scripts/build.js docs:check
step docs-build           ./builder docs:build
# Production app builds, then the full distribution
step apps-build           ./builder sql-ui:build vector-ui:build
step full-build           ./builder build

echo "logs: $LOGS" | tee -a "$SUMMARY"
echo "$((STEPS - FAILED)) of $STEPS steps passed" | tee -a "$SUMMARY"
if [ "$FAILED" -ne 0 ]; then exit 1; fi
