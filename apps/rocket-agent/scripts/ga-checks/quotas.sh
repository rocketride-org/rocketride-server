#!/usr/bin/env bash
#
# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
#
# ---------------------------------------------------------------------------
# Task 5.2b — GA quota-enforcement checklist (STAGING, HUMAN-RUN).
#
# This script is NOT executed by Claude, NOT part of CI, and NOT meant to run
# against a live/production cluster. It is a GA-checklist artifact an operator
# runs by hand against a STAGING deployment before sign-off, using plain curl.
# `tests/quotas.test.ts` in this package is the automated (Jest, real
# SessionManager, fake upstreams) evidence for the same four quotas — this
# script is the black-box confirmation that the same limits bite through the
# real deployed edge, ALB, and rate limiter.
#
# Two checks below run live against staging (session-cap loop, MCP rate-limit
# hammer). The other two quotas (2h idle TTL, 30-day retention) are too slow
# to assert synchronously in a shell loop — for those this script prints the
# exact kubectl/redis commands an operator runs by hand, and does not attempt
# to execute them.
#
# Usage:
#   AGENT_BASE_URL=https://agent-staging.rocketride.ai \
#   AGENT_TEST_TOKEN=<bearer token for a disposable staging test-tenant> \
#   MCP_URL=https://api-staging.rocketride.ai/mcp \
#   RR_KEY=rr_<staging test key> \
#   ./quotas.sh
#
# Optional overrides:
#   SESSIONS_TO_CREATE   default 11   (must be maxSessionsPerTenant + 1 for the target tenant)
#   MCP_CALLS            default 130  (must be > 120 to clear the Phase 1 per-minute limit)
#   MCP_CONCURRENCY      default 20   (parallel curl workers — see the MCP check's comment on why this matters)
#   CURL_MAX_TIME        default 10   (seconds, per request)
#
# Exit code: 0 if every executable check PASSED, non-zero on the FIRST failure
# (the script stops immediately — later checks do not run against a cluster
# already known to be in a bad state).
# ---------------------------------------------------------------------------

set -euo pipefail

# --- usage / required env -----------------------------------------------------

usage() {
	cat <<'EOF'
Usage:
  AGENT_BASE_URL=<rocket-agent base URL>   \
  AGENT_TEST_TOKEN=<bearer token, staging test tenant>  \
  MCP_URL=<edge /mcp endpoint URL>         \
  RR_KEY=<rr_ key with MCP dispatch scope> \
  ./quotas.sh

Required env vars:
  AGENT_BASE_URL     rocket-agent's own API base, e.g. https://agent-staging.rocketride.ai
  AGENT_TEST_TOKEN    Bearer token for a DISPOSABLE staging test tenant (Check 1 will push
                      this tenant to its session cap — do not point this at a real tenant)
  MCP_URL             Full MCP Streamable HTTP endpoint, e.g. https://api-staging.rocketride.ai/mcp
  RR_KEY               An rr_-prefixed API key with MCP tool-dispatch scope, staging only

Optional env vars (defaults shown):
  SESSIONS_TO_CREATE=11   MCP_CALLS=130   MCP_CONCURRENCY=20   CURL_MAX_TIME=10
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
	usage
	exit 0
fi

: "${AGENT_BASE_URL:?Missing AGENT_BASE_URL. Run with -h/--help for usage.}"
: "${AGENT_TEST_TOKEN:?Missing AGENT_TEST_TOKEN. Run with -h/--help for usage.}"
: "${MCP_URL:?Missing MCP_URL. Run with -h/--help for usage.}"
: "${RR_KEY:?Missing RR_KEY. Run with -h/--help for usage.}"

SESSIONS_TO_CREATE="${SESSIONS_TO_CREATE:-11}"
MCP_CALLS="${MCP_CALLS:-130}"
MCP_CONCURRENCY="${MCP_CONCURRENCY:-20}"
CURL_MAX_TIME="${CURL_MAX_TIME:-10}"

if (( MCP_CALLS <= 120 )); then
	echo "MCP_CALLS must be > 120 to exercise the Phase 1 rate limiter (got ${MCP_CALLS})" >&2
	exit 1
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT

# --- PASS/FAIL helpers ---------------------------------------------------------

pass() { echo "PASS: $1"; }
fail() {
	echo "FAIL: $1" >&2
	exit 1
}

# --- Check 1: 11th concurrent session for one tenant -> 429 -------------------
#
# Mirrors tests/quotas.test.ts Scenario 1, but through the real deployed edge:
# create SESSIONS_TO_CREATE sessions for the SAME disposable test tenant;
# every create up to maxSessionsPerTenant must succeed (201), and the one past
# it must be rejected 429. Session ids are captured so they can be archived
# again at the end, leaving the tenant's quota clean for the next run.

echo "--- Check 1: session cap (expect 429 on session #${SESSIONS_TO_CREATE}) ---"

created_session_ids=()
session_check_failed=0

for i in $(seq 1 "${SESSIONS_TO_CREATE}"); do
	response_file="${WORKDIR}/session_${i}.json"
	http_code=$(curl -sS --max-time "${CURL_MAX_TIME}" \
		-o "${response_file}" -w '%{http_code}' \
		-X POST "${AGENT_BASE_URL}/agent/sessions" \
		-H "authorization: Bearer ${AGENT_TEST_TOKEN}" \
		-H 'content-type: application/json' \
		-d "{\"title\":\"ga-check-quota-${i}\"}")

	if [[ "${i}" -lt "${SESSIONS_TO_CREATE}" ]]; then
		if [[ "${http_code}" != "201" ]]; then
			echo "  session #${i}: expected 201, got ${http_code} — $(cat "${response_file}")" >&2
			session_check_failed=1
			break
		fi
		# Best-effort sessionId capture for cleanup below; degrade gracefully without jq.
		if command -v jq >/dev/null 2>&1; then
			sid=$(jq -r '.sessionId // empty' "${response_file}")
		else
			sid=$(grep -o '"sessionId":"[^"]*"' "${response_file}" | head -1 | cut -d'"' -f4)
		fi
		[[ -n "${sid}" ]] && created_session_ids+=("${sid}")
		echo "  session #${i}: 201 (sessionId=${sid:-unknown})"
	else
		# The final, over-cap create: must be rejected.
		if [[ "${http_code}" == "429" ]]; then
			echo "  session #${i} (over cap): 429 as expected — $(cat "${response_file}")"
		else
			echo "  session #${i} (over cap): expected 429, got ${http_code} — $(cat "${response_file}")" >&2
			session_check_failed=1
		fi
	fi
done

# Cleanup: archive every session this check created, regardless of outcome,
# so a re-run (or the next GA check) doesn't start already at the cap.
for sid in "${created_session_ids[@]:-}"; do
	[[ -z "${sid}" ]] && continue
	curl -sS --max-time "${CURL_MAX_TIME}" -o /dev/null \
		-X DELETE "${AGENT_BASE_URL}/agent/sessions/${sid}" \
		-H "authorization: Bearer ${AGENT_TEST_TOKEN}" || true
done

if [[ "${session_check_failed}" -ne 0 ]]; then
	fail "Check 1 (session cap): the ${SESSIONS_TO_CREATE}th session did not behave as expected — see log above"
fi
pass "Check 1 (session cap): sessions 1..$((SESSIONS_TO_CREATE - 1)) created, #${SESSIONS_TO_CREATE} rejected 429"

# --- Check 2: rr_ key hammer at >120 MCP calls/min -> 429 ----------------------
#
# Fires MCP_CALLS (>120) cheap, non-mutating JSON-RPC frames (tools/list) at
# MCP_URL as fast as MCP_CONCURRENCY parallel curl workers can go, all under
# the SAME rr_ key, and asserts at least one 429 shows up in the burst.
#
# MCP_CONCURRENCY matters: 130 calls run one-at-a-time over a slow network can
# take longer than 60s end to end, in which case the per-minute window never
# actually sees >120 calls and this check would false-negative. Running them
# concurrently keeps the whole burst well inside one rate-limit window.

echo ""
echo "--- Check 2: MCP rate limit (${MCP_CALLS} calls, expect >=1 429) ---"

codes_file="${WORKDIR}/mcp_codes.txt"
: > "${codes_file}"

mcp_call() {
	curl -sS --max-time "${CURL_MAX_TIME}" -o /dev/null -w '%{http_code}\n' \
		-X POST "${MCP_URL}" \
		-H "authorization: Bearer ${RR_KEY}" \
		-H 'content-type: application/json' \
		-d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
}
export -f mcp_call
export MCP_URL RR_KEY CURL_MAX_TIME

seq 1 "${MCP_CALLS}" | xargs -P "${MCP_CONCURRENCY}" -I{} bash -c 'mcp_call' >> "${codes_file}" 2>/dev/null || true

total_calls=$(wc -l < "${codes_file}" | tr -d ' ')
throttled_calls=$(grep -c '^429$' "${codes_file}" || true)

echo "  fired ${total_calls}/${MCP_CALLS} calls, ${throttled_calls} returned 429"

if [[ "${throttled_calls}" -lt 1 ]]; then
	fail "Check 2 (MCP rate limit): 0 of ${total_calls} calls were throttled — expected >=1 429 after ${MCP_CALLS} calls/min"
fi
pass "Check 2 (MCP rate limit): ${throttled_calls}/${total_calls} calls throttled with 429"

# --- Reminders: the two SLOW checks (not executable here) ---------------------
#
# 2h idle TTL and 30-day retention cannot be asserted synchronously — printed
# as reminder lines with the exact commands an operator runs by hand.

# NOTE: RedisSessionIndex (apps/rocket-agent/src/sessionIndex.ts) stores each session record
# as ONE JSON blob under key `<prefix>:s:<sessionId>` (default prefix "ragent") via plain
# SET/GET — not a hash — so backdating a field means GET, edit with jq, SET back, not HSET.

echo ""
echo "--- REMINDER: idle TTL (2h) — not executed by this script ---"
cat <<EOF
  1. Create a session (Check 1's loop above, or manually) and note its sessionId.
  2. Either wait >2h with no activity on it, OR fast-forward it in Redis (backdate
     lastActivity 3h, past the 2h default TTL — record is one JSON blob, not a hash):
       redis-cli -h <staging-redis-host> GET ragent:s:<sessionId> \\
         | jq --argjson t "\$(( \$(date +%s%3N) - 3*60*60*1000 ))" '.lastActivity = \$t' \\
         | xargs -0 redis-cli -h <staging-redis-host> SET ragent:s:<sessionId>
     (adjust the "ragent" prefix if the deployment overrides RedisSessionIndex's default —
     see apps/rocket-agent/src/sessionIndex.ts's RedisSessionIndex doc comment)
  3. Wait up to 60s (the reaper's sweep interval) and confirm the session archived:
       kubectl -n rocketride-staging logs deploy/rocket-agent --since=2m | grep -i reap
       curl -sS -H "authorization: Bearer \$AGENT_TEST_TOKEN" \\
         "\$AGENT_BASE_URL/agent/sessions" | jq '.[] | select(.sessionId=="<sessionId>") | .status'
     Expect status: "archived".
EOF

echo ""
echo "--- REMINDER: retention purge (30 days) — not executed by this script ---"
cat <<EOF
  1. Find (or create + archive, then backdate) a session archived >30 days ago
     (again: one JSON blob per session, GET/edit-with-jq/SET back):
       redis-cli -h <staging-redis-host> GET ragent:s:<sessionId> \\
         | jq --argjson t "\$(( \$(date +%s%3N) - 40*24*60*60*1000 ))" \\
           '.lastActivity = \$t | .status = "archived"' \\
         | xargs -0 redis-cli -h <staging-redis-host> SET ragent:s:<sessionId>
  2. Wait for the next reaper sweep (<=60s) and confirm both the index entry and
     the on-disk session dir are gone:
       redis-cli -h <staging-redis-host> GET ragent:s:<sessionId>        # expect (nil)
       kubectl -n rocketride-staging exec deploy/rocket-agent -- \\
         test -d /var/lib/rocket-agent/sessions/<sessionId> && echo STILL THERE || echo purged
     (path is Dockerfile's RR_AGENT_DATA_DIR=/var/lib/rocket-agent + sessionRoot()'s "sessions/<id>")
EOF

echo ""
echo "All executable checks PASSED."
