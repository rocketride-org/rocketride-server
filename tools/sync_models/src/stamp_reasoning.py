"""Stamp `capabilities.reasoning` in services.json files outside the sync registry.

For providers without an API handler (Ollama local, GMI Cloud aggregator) the
weekly `sync_models.py` cron skips them. This script applies the same OpenRouter
+ family-fallback heuristic used by the merger to keep them in sync.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from core.merger import _is_reasoning_model, _load_openrouter_cache  # noqa: E402
from core.patcher import get_profiles, patch  # noqa: E402

_PATHS = [
    'nodes/src/nodes/llm_gmi_cloud/services.json',
    'nodes/src/nodes/llm_ollama/services.json',
]


def main() -> int:
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    _load_openrouter_cache()
    for path in _PATHS:
        profiles = get_profiles(path)
        updated, changed = {}, False
        for key, p in profiles.items():
            cap = (p.get('capabilities') or {}) if isinstance(p, dict) else {}
            if isinstance(p, dict) and _is_reasoning_model(p.get('model', '')) and not cap.get('reasoning'):
                updated[key] = {**p, 'capabilities': {**cap, 'reasoning': True}}
                changed = True
                print(f'  {path}: {key} → capabilities.reasoning=true')
            else:
                updated[key] = p
        if changed:
            patch(path, updated, set(), set(), set(), dry_run=False)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
