"""Enrich services.json files outside the sync registry.

For providers without an API handler (Ollama local) the weekly `sync_models.py`
cron skips them. This script applies the same OpenRouter + family-fallback
heuristic used by the merger to keep them in sync.
Bedrock completion limits come from LiteLLM's model metadata.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from core import merger  # noqa: E402
from core.merger import _is_reasoning_model, _load_openrouter_cache  # noqa: E402
from core.patcher import get_profiles, patch  # noqa: E402

_PATHS = [
    'nodes/src/nodes/llm_ollama/services.json',
    'nodes/src/nodes/llm_bedrock/services.json',
]
_BEDROCK_CEILING_SOURCE = 'litellm (AWS Bedrock ceiling)'


def _bedrock_output_tokens(profile: dict) -> tuple[int, str] | None:
    if not merger._LITELLM_AVAILABLE:
        return None
    info = merger.litellm.model_cost.get(profile.get('model', ''), {})
    if info.get('litellm_provider') not in ('bedrock', 'bedrock_converse'):
        return None
    output = info.get('max_output_tokens')
    context = profile.get('modelTotalTokens')
    if not isinstance(output, int) or isinstance(output, bool) or output <= 0:
        return None
    if not isinstance(context, int) or isinstance(context, bool) or not 0 < output <= context:
        return None
    # Some records repeat the context size as the completion limit.
    if output == info.get('max_input_tokens'):
        return None
    # The native Bedrock adapter sends max_gen_len for Llama. Its ceiling
    # differs from some LiteLLM records (including Llama 3.2).
    # https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-meta.html
    if profile.get('model', '').startswith(('meta.llama3-', 'meta.llama4-')) and output > 2048:
        return 2048, _BEDROCK_CEILING_SOURCE
    return output, 'litellm'


def main() -> int:
    """
    Stamp reasoning flags and sourced completion limits for providers outside the registry.

    Returns:
        Exit code (always 0)
    """
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    _load_openrouter_cache()
    for path in _PATHS:
        profiles = get_profiles(path)
        updated, changed = {}, False
        bedrock = Path(path).parent.name == 'llm_bedrock'
        sourced, unresolved = 0, 0
        for key, p in profiles.items():
            if bedrock:
                updated[key] = p
                if not isinstance(p, dict) or key == 'custom' or p.get('deprecated'):
                    continue
                if 'modelOutputTokens' in p and p.get('_src_modelOutputTokens') not in (
                    'litellm',
                    _BEDROCK_CEILING_SOURCE,
                ):
                    continue
                limit = _bedrock_output_tokens(p)
                if limit is None:
                    unresolved += 1
                    continue
                output, source = limit
                sourced += 1
                if p.get('modelOutputTokens') != output or p.get('_src_modelOutputTokens') != source:
                    updated[key] = {**p, 'modelOutputTokens': output, '_src_modelOutputTokens': source}
                    changed = True
                continue
            cap = (p.get('capabilities') or {}) if isinstance(p, dict) else {}
            if isinstance(p, dict) and _is_reasoning_model(p.get('model', '')) and not cap.get('reasoning'):
                updated[key] = {**p, 'capabilities': {**cap, 'reasoning': True}}
                changed = True
                print(f'  {path}: {key}: capabilities.reasoning=true')
            else:
                updated[key] = p
        if changed:
            patch(path, updated, set(), set(), set(), dry_run=False)
        if bedrock:
            print(f'{path}: {sourced} sourced completion limits, {unresolved} unresolved')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
