# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""Offline regressions for catalogue stamping outside the provider registry."""

import glob
import json
import types
from pathlib import Path

import json5
import pytest

import stamp_reasoning
from core import merger
from core.patcher import get_profiles

_BEDROCK = 'anthropic.claude-sonnet-4-5-20250929-v1:0'


@pytest.fixture
def catalogue(tmp_path, monkeypatch):
    """A Bedrock catalogue with deterministic, provider-specific token data."""
    path = tmp_path / 'llm_bedrock' / 'services.json'
    path.parent.mkdir()
    monkeypatch.setattr(stamp_reasoning, '_PATHS', [str(path)])
    monkeypatch.setattr(stamp_reasoning, '_load_openrouter_cache', lambda: None)
    monkeypatch.setattr(merger, '_LITELLM_AVAILABLE', True)
    records = {}
    monkeypatch.setattr(merger, 'litellm', types.SimpleNamespace(model_cost=records))
    return path, records


def _write_profiles(path, profiles):
    """Write the same profile container used by node catalogues."""
    path.write_text(json.dumps({'preconfig': {'profiles': profiles}}, indent=4))


def _missing_outputs(directory):
    """Count absent limits using the reproduction posted in issue #2530."""
    missing_by_file = {}
    for f in sorted(glob.glob(str(directory / '*/services*.json'))):
        with open(f) as source:
            profiles = (json5.load(source).get('preconfig') or {}).get('profiles') or {}
        if not any(isinstance(p, dict) and 'modelTotalTokens' in p for p in profiles.values()):
            continue
        missing = [
            k
            for k, p in profiles.items()
            if isinstance(p, dict) and k != 'custom' and not p.get('deprecated') and 'modelOutputTokens' not in p
        ]
        if missing:
            missing_by_file[f] = missing
    return missing_by_file


def test_bedrock_profiles_get_sourced_output_limits(catalogue):
    """A built-in Claude profile stops falling back to the 4,096-token ceiling."""
    path, records = catalogue
    profiles = {
        'sonnet': {'model': _BEDROCK, 'modelTotalTokens': 200000},
        'unknown': {'model': 'cohere.command-r-v1:0', 'modelTotalTokens': 128000},
        'custom': {'model': '', 'modelTotalTokens': 256000},
        'retired': {'model': _BEDROCK, 'modelTotalTokens': 200000, 'deprecated': True},
    }
    _write_profiles(path, profiles)
    records[_BEDROCK] = {
        'litellm_provider': 'bedrock_converse',
        'max_input_tokens': 200000,
        'max_output_tokens': 64000,
        'max_tokens': 64000,
    }
    assert _missing_outputs(path.parent.parent) == {str(path): ['sonnet', 'unknown']}

    assert stamp_reasoning.main() == 0

    assert _missing_outputs(path.parent.parent) == {str(path): ['unknown']}
    updated = json5.loads(path.read_text())['preconfig']['profiles']
    assert updated['sonnet'] == {**profiles['sonnet'], 'modelOutputTokens': 64000}
    assert updated['custom'] == profiles['custom']
    assert updated['retired'] == profiles['retired']
    assert '"modelOutputTokens": 64000 // litellm' in path.read_text()


@pytest.mark.parametrize('output', [None, True, 0, -1, '64000', 200000, 200001])
def test_bedrock_rejects_unusable_output_data(catalogue, output):
    """Missing, invalid and swapped limits must not become request budgets."""
    path, records = catalogue
    _write_profiles(path, {'sonnet': {'model': _BEDROCK, 'modelTotalTokens': 200000}})
    records[_BEDROCK] = {
        'litellm_provider': 'bedrock',
        'max_input_tokens': 200000,
        'max_output_tokens': output,
    }
    stamp_reasoning.main()
    assert 'modelOutputTokens' not in get_profiles(str(path))['sonnet']


def test_bedrock_does_not_use_another_providers_limits(catalogue):
    """The matching model name is insufficient without a Bedrock data source."""
    path, records = catalogue
    _write_profiles(path, {'sonnet': {'model': _BEDROCK, 'modelTotalTokens': 200000}})
    records[_BEDROCK] = {'litellm_provider': 'anthropic', 'max_output_tokens': 64000}
    stamp_reasoning.main()
    assert 'modelOutputTokens' not in get_profiles(str(path))['sonnet']


def test_stamped_limits_refresh_without_overwriting_manual_limits(catalogue):
    """Source comments survive reruns, so automated values can be refreshed."""
    path, records = catalogue
    _write_profiles(
        path,
        {
            'sourced': {'model': _BEDROCK, 'modelTotalTokens': 200000},
            'manual': {'model': _BEDROCK, 'modelTotalTokens': 200000, 'modelOutputTokens': 16384},
        },
    )
    records[_BEDROCK] = {'litellm_provider': 'bedrock', 'max_input_tokens': 200000, 'max_output_tokens': 32000}
    stamp_reasoning.main()
    records[_BEDROCK]['max_output_tokens'] = 64000
    stamp_reasoning.main()
    profiles = get_profiles(str(path))
    assert profiles['sourced']['modelOutputTokens'] == 64000
    assert profiles['sourced']['_src_modelOutputTokens'] == 'litellm'
    assert profiles['manual']['modelOutputTokens'] == 16384
    assert '_src_modelOutputTokens' not in profiles['manual']
    before = path.read_bytes()
    stamp_reasoning.main()
    assert path.read_bytes() == before


def test_token_source_comments_are_read_without_changing_strings(tmp_path):
    """Reading provenance must leave comment-like text inside strings intact."""
    path = tmp_path / 'services.json'
    path.write_text("""{
        "preconfig": {"profiles": {
            "model": {
                "modelTotalTokens": 200000, // provider API
                "modelOutputTokens": 64000 // litellm
            },
            "custom": {"title": '\\"modelOutputTokens\\": 42, // manual'}
        }}
    }""")
    profiles = get_profiles(str(path))
    assert profiles['model']['_src_modelTotalTokens'] == 'provider API'
    assert profiles['model']['_src_modelOutputTokens'] == 'litellm'
    assert profiles['custom'] == {'title': '"modelOutputTokens": 42, // manual'}


def test_weekly_sync_runs_the_catalogue_stamper():
    """Bedrock enrichment reaches the weekly catalogue PR, without AWS keys."""
    root = Path(__file__).resolve().parents[3]
    workflow = (root / '.github/workflows/sync-models.yml').read_text()
    assert 'python tools/sync_models/src/stamp_reasoning.py' in workflow
    assert workflow.index('python tools/sync_models/src/stamp_reasoning.py') < workflow.index(
        '- name: Create Pull Request'
    )


def test_ollama_reasoning_stamping_preserves_token_sources(tmp_path, monkeypatch):
    """The existing reasoning pass retains completion-limit provenance."""
    path = tmp_path / 'llm_ollama' / 'services.json'
    path.parent.mkdir()
    path.write_text("""{
        "preconfig": {"profiles": {
            "model": {
                "model": "qwen3:8b",
                "modelOutputTokens": 8192, // provider API
                "capabilities": {}
            }
        }}
    }""")
    monkeypatch.setattr(stamp_reasoning, '_PATHS', [str(path)])
    monkeypatch.setattr(stamp_reasoning, '_load_openrouter_cache', lambda: None)
    monkeypatch.setattr(stamp_reasoning, '_is_reasoning_model', lambda model: True)
    assert stamp_reasoning.main() == 0
    profile = get_profiles(str(path))['model']
    assert profile['capabilities']['reasoning'] is True
    assert profile['modelOutputTokens'] == 8192
    assert profile['_src_modelOutputTokens'] == 'provider API'


@pytest.mark.parametrize(
    'model',
    [
        'meta.llama3-2-1b-instruct-v1:0',
        'meta.llama3-2-3b-instruct-v1:0',
        'meta.llama3-2-11b-instruct-v1:0',
        'meta.llama3-2-90b-instruct-v1:0',
        'meta.llama3-3-70b-instruct-v1:0',
        'meta.llama4-scout-17b-instruct-v1:0',
        'meta.llama4-maverick-17b-instruct-v1:0',
    ],
)
def test_llama_limits_respect_bedrock_native_ceiling(catalogue, model):
    """LiteLLM's 4096 exceeds Bedrock's native max_gen_len ceiling."""
    path, records = catalogue
    _write_profiles(path, {'llama': {'model': model, 'modelTotalTokens': 128000}})
    records[model] = {
        'litellm_provider': 'bedrock',
        'max_input_tokens': 128000,
        'max_output_tokens': 4096,
    }
    assert stamp_reasoning.main() == 0
    profile = get_profiles(str(path))['llama']
    assert profile['modelOutputTokens'] == 2048
    assert profile['_src_modelOutputTokens'] == 'litellm (AWS Bedrock ceiling)'
