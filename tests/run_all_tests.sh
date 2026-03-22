#!/bin/bash
# Run all RocketRide test suites.
# Usage: ./tests/run_all_tests.sh
#
# Requires:
#   - dist/server/engine (built RocketRide engine for Python tests)
#   - pnpm (for React component tests)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENGINE="$ROOT_DIR/dist/server/engine"
PASS=0
FAIL=0
SKIP=0

echo "============================================"
echo "  RocketRide Test Suite"
echo "  $(date)"
echo "============================================"
echo ""

# Python tests (need engine binary)
if [ -f "$ENGINE" ]; then
    echo ">>> Python: smoke tests"
    if "$ENGINE" -m pytest "$ROOT_DIR/nodes/test/test_smoke.py" -q 2>&1 | tail -1; then
        PASS=$((PASS + 1))
    else
        FAIL=$((FAIL + 1))
    fi
    echo ""

    echo ">>> Python: node module tests"
    if "$ENGINE" -m pytest "$ROOT_DIR/nodes/test/test_node_smoke.py" -q 2>&1 | tail -1; then
        PASS=$((PASS + 1))
    else
        FAIL=$((FAIL + 1))
    fi
    echo ""

    echo ">>> Python: SQL injection tests"
    if "$ENGINE" -m pytest "$ROOT_DIR/nodes/test/test_sql_injection.py" -q 2>&1 | tail -1; then
        PASS=$((PASS + 1))
    else
        FAIL=$((FAIL + 1))
    fi
    echo ""

    echo ">>> Python: API key redaction tests"
    if "$ENGINE" -m pytest "$ROOT_DIR/nodes/test/test_redaction.py" -q 2>&1 | tail -1; then
        PASS=$((PASS + 1))
    else
        FAIL=$((FAIL + 1))
    fi
    echo ""
else
    echo ">>> Python tests SKIPPED (engine not built)"
    SKIP=$((SKIP + 4))
fi

# React tests (need pnpm)
if command -v pnpm &>/dev/null; then
    echo ">>> React: chat-ui"
    if pnpm --filter @rocketride/chat-ui exec vitest run 2>&1 | tail -3; then
        PASS=$((PASS + 1))
    else
        FAIL=$((FAIL + 1))
    fi
    echo ""

    echo ">>> React: dropper-ui"
    if pnpm --filter @rocketride/dropper-ui exec vitest run 2>&1 | tail -3; then
        PASS=$((PASS + 1))
    else
        FAIL=$((FAIL + 1))
    fi
    echo ""
else
    echo ">>> React tests SKIPPED (pnpm not found)"
    SKIP=$((SKIP + 2))
fi

# Summary
echo "============================================"
echo "  SUMMARY"
echo "============================================"
echo "  Suites passed:  $PASS"
echo "  Suites failed:  $FAIL"
echo "  Suites skipped: $SKIP"
echo ""

if [ $FAIL -gt 0 ]; then
    echo "  RESULT: FAILED"
    exit 1
else
    echo "  RESULT: PASSED"
    exit 0
fi
