#!/usr/bin/env bash
# Dependabot smoke test: pipeline node Python deps
#
# Verifies that each affected pipeline node still imports cleanly with the
# current pins in its requirements.txt / nltk.txt / spacy.txt. PR CI runs
# build/lint only and never imports these node modules, so a bumped Python
# dep can silently break a pipeline at runtime.
#
# Run from a PR branch (optionally with a path filter to only test nodes
# touched by the diff):
#
#     # test all known nodes:
#     bash tools/dependabot-smoke/smoke-nodes.sh
#
#     # test only nodes whose requirements changed in this PR:
#     bash tools/dependabot-smoke/smoke-nodes.sh --changed-only
#
# Exit 0 = every (node, package) pair imports. Exit non-zero = one or more
# imports failed; check the per-node section for the FAIL lines.
set -uo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

# Node directory → packages to import-test once requirements are installed.
# Keep import names (not pip names) here — they differ (e.g. opensearchpy
# pips as opensearch-py).
declare -A NODE_IMPORTS=(
  [nodes/src/nodes/db_mysql]="pymysql"
  [nodes/src/nodes/db_postgres]="psycopg2"
  [nodes/src/nodes/index_search]="opensearchpy"
  [nodes/src/nodes/preprocessor_langchain]="nltk spacy"
)

# Optional --changed-only flag: filter to nodes whose .txt files are in the diff.
CHANGED_ONLY=0
if [ "${1:-}" = "--changed-only" ]; then
  CHANGED_ONLY=1
fi

filter_to_changed() {
  local node="$1"
  if [ "$CHANGED_ONLY" -eq 0 ]; then
    return 0
  fi
  # Compare against develop. Works in CI (origin/develop is fetched) and locally.
  if git diff --name-only origin/develop...HEAD -- "$node" 2>/dev/null | grep -qE '\.txt$'; then
    return 0
  fi
  return 1
}

OVERALL_RC=0
for node_dir in "${!NODE_IMPORTS[@]}"; do
  imports="${NODE_IMPORTS[$node_dir]}"

  if ! filter_to_changed "$node_dir"; then
    echo "--- $node_dir: skipped (no .txt changes in this diff) ---"
    continue
  fi

  echo "--- $node_dir (imports: $imports) ---"

  VENV=$(mktemp -d)
  python3 -m venv "$VENV" >/dev/null
  "$VENV/bin/pip" install --quiet --upgrade pip

  # Install every .txt requirement file in the node dir. Some nodes split
  # heavy deps across multiple files (e.g. preprocessor_langchain has both
  # nltk.txt and spacy.txt).
  for req_file in "$node_dir"/*.txt; do
    [ -f "$req_file" ] || continue
    echo "  pip install -r $req_file"
    if ! "$VENV/bin/pip" install --quiet -r "$req_file" 2>&1 | tail -20; then
      echo "  FAIL: pip install $req_file"
      OVERALL_RC=1
    fi
  done

  # Smoke import each expected module. Use importlib.metadata for the
  # version (some packages — e.g. PyMySQL — set a misleading __version__
  # constant on the module that doesn't match the installed package).
  for module in $imports; do
    if "$VENV/bin/python" -c '
import sys
from importlib.metadata import version, PackageNotFoundError
mod = sys.argv[1]
m = __import__(mod)
# Map import name -> pip package name for the cases where they differ.
pip_name = {"opensearchpy": "opensearch-py", "psycopg2": "psycopg2-binary"}.get(mod, mod)
try:
    ver = version(pip_name)
except PackageNotFoundError:
    ver = getattr(m, "__version__", "<unknown>")
print(f"  OK: import {mod}={ver}")
' "$module"; then
      :
    else
      echo "  FAIL: import $module"
      OVERALL_RC=1
    fi
  done

  rm -rf "$VENV"
  echo
done

if [ $OVERALL_RC -eq 0 ]; then
  echo "PASS: nodes smoke test."
else
  echo "FAIL: one or more node imports failed (see FAIL lines above)."
  exit 1
fi
