#!/usr/bin/env bash
# Dependabot smoke test: litellm version bumps
#
# Verifies that `tools/sync_models/src/sync_models.py` (the consumer of litellm in this repo)
# continues to work with the current pin in `tools/sync_models/requirements.txt`. PR CI runs
# build/lint only, not this tool, so a bumped litellm could silently break the
# weekly sync-models.yml cron without anyone noticing until Monday.
#
# Run from a PR branch:
#
#     bash tools/dependabot-smoke/smoke-litellm.sh
#
# Exit 0 = imports + key APIs work end-to-end. Exit non-zero = breakage; open
# the PR-trigger comment to see the captured stderr.
set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

VENV=$(mktemp -d)
trap 'rm -rf "$VENV"' EXIT

echo "==> Creating venv at $VENV"
python3 -m venv "$VENV"
"$VENV/bin/pip" install --quiet --upgrade pip

echo "==> Installing tools/sync_models/requirements.txt"
"$VENV/bin/pip" install --quiet -r tools/sync_models/requirements.txt

echo "==> Smoke: litellm import + core APIs"
"$VENV/bin/python" - <<'PY'
import litellm
from importlib.metadata import version as _pkg_version

# litellm >=1.83 dropped the module-level __version__ attribute and raises
# AttributeError on access via its custom __getattr__. Use the standard
# importlib.metadata route instead so this smoke test works across versions.
litellm_version = _pkg_version("litellm")

# 1. model_cost is the big lookup table sync_models.py reads
assert hasattr(litellm, "model_cost"), "litellm.model_cost missing"
assert isinstance(litellm.model_cost, dict), "litellm.model_cost not a dict"
assert len(litellm.model_cost) > 100, f"litellm.model_cost suspiciously small: {len(litellm.model_cost)}"

# 2. get_model_info is the direct-lookup helper merger._litellm_info uses
assert hasattr(litellm, "get_model_info"), "litellm.get_model_info missing"
info = litellm.get_model_info("gpt-4o-mini")
assert isinstance(info, dict), f"get_model_info returned {type(info).__name__}, expected dict"
assert "max_input_tokens" in info or "max_tokens" in info, \
    f"get_model_info missing context-window key; got {sorted(info.keys())}"

print(f"litellm {litellm_version}: model_cost={len(litellm.model_cost)} entries; get_model_info OK")
PY

echo "==> Smoke: project consumer imports + calls"
PYTHONPATH="$REPO_ROOT/tools/sync_models/src" "$VENV/bin/python" - <<'PY'
from core.merger import _litellm_info
# This helper does the direct-lookup + model_cost scan dance. Any breakage
# in either litellm API surfaces here.
ctx, out = _litellm_info("openai/gpt-4o-mini")
print(f"merger._litellm_info('openai/gpt-4o-mini') => ctx={ctx} out={out}")
assert ctx is not None or out is not None, "both context and output token counts came back None"
PY

echo "==> Smoke: sync_models.py --help (verifies argparse + module load)"
"$VENV/bin/python" tools/sync_models/src/sync_models.py --help > /dev/null

echo
echo "PASS: litellm smoke test."
