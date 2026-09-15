from __future__ import annotations

import sys
import types


def test_nemotron_provider_registered():
    """The provider and its services.json path are wired into the registries."""
    from sync_models import _PROVIDER_REGISTRY, _SERVICES_JSON_PATHS

    assert _PROVIDER_REGISTRY['llm_nemotron'] == 'providers.nemotron:NemotronProvider'
    assert _SERVICES_JSON_PATHS['llm_nemotron'] == 'nodes/src/nodes/llm_nemotron/services.json'


def test_nemotron_provider_uses_nvidia_openai_compatible_endpoint(monkeypatch):
    """make_client targets the NVIDIA endpoint and fetch_models maps ids."""
    fake_openai = types.ModuleType('openai')
    captured = {}

    class FakeModel:
        def __init__(self, model_id: str):
            """Store the fake model id."""
            self.id = model_id

    class FakeModels:
        def list(self):
            """Return a canned two-model catalog."""
            return types.SimpleNamespace(
                data=[
                    FakeModel('nvidia/nemotron-3-super-120b-a12b'),
                    FakeModel('nvidia/nemotron-3.5-lightning-30b-a3b'),
                ]
            )

    class FakeOpenAI:
        def __init__(self, **kwargs):
            """Capture client kwargs and expose the fake models endpoint."""
            captured.update(kwargs)
            self.models = FakeModels()

    fake_openai.OpenAI = FakeOpenAI
    monkeypatch.setitem(sys.modules, 'openai', fake_openai)

    from providers.nemotron import NemotronProvider

    provider = NemotronProvider({})
    client = provider.make_client('test-key')

    assert captured == {
        'api_key': 'test-key',
        'base_url': 'https://integrate.api.nvidia.com/v1',
    }
    assert provider.fetch_models(client) == [
        {'id': 'nvidia/nemotron-3-super-120b-a12b'},
        {'id': 'nvidia/nemotron-3.5-lightning-30b-a3b'},
    ]


def test_litellm_bare_id_gets_the_nvidia_prefix():
    """LiteLLM stores Nemotron models bare; services.json stores them vendor-prefixed."""
    from providers.nemotron import NemotronProvider

    provider = NemotronProvider({})

    assert provider.litellm_to_native_model_id('nemotron-3-super-120b-a12b') == 'nvidia/nemotron-3-super-120b-a12b'
    assert (
        provider.litellm_to_native_model_id('nvidia/nemotron-3-super-120b-a12b') == 'nvidia/nemotron-3-super-120b-a12b'
    )


def _real_provider():
    """Build the provider from the shipped config entry, not an empty dict.

    The converter test alone passed while the fallback path was broken: an
    empty config has no ``include_prefixes``, so nothing was ever rejected.
    The fallback tests below must run against the real filter rules.
    """
    from sync_models import _load_config
    from providers.nemotron import NemotronProvider

    return NemotronProvider(_load_config()['providers']['llm_nemotron'])


def test_fallback_aliases_map_to_the_nvidia_catalog_ids():
    """OpenRouter's Lightning / Nano spellings become the IDs NVIDIA actually serves."""
    provider = _real_provider()

    assert provider.litellm_to_native_model_id('nemotron-3.5-lightning') == 'nvidia/nemotron-3.5-lightning-30b-a3b'
    assert (
        provider.litellm_to_native_model_id('nvidia/nemotron-3.5-lightning') == 'nvidia/nemotron-3.5-lightning-30b-a3b'
    )
    assert provider.litellm_to_native_model_id('nemotron-3-nano-30b-a3b') == 'nvidia/nemotron-nano-3-30b-a3b'


def test_should_include_filters_bare_ids_as_if_native():
    """The config's nvidia/ prefixes must match bare fallback IDs too, and only Nemotron chat models."""
    provider = _real_provider()

    assert provider.should_include('nemotron-3-super-120b-a12b')
    assert provider.should_include('nvidia/nemotron-3-super-120b-a12b')
    assert not provider.should_include('nemotron-3-super-120b-a12b:free')
    assert not provider.should_include('nemotron-3.5-content-safety')
    assert not provider.should_include('nemotron-3-nano-omni-30b-a3b-reasoning')
    assert not provider.should_include('mistralai/mistral-nemotron')
    assert not provider.should_include('llama-3.3-70b-instruct')


# Bare (vendor-stripped) IDs exactly as the OpenRouter cache indexed them, 2026-09.
_OPENROUTER_LIVE_BARE_IDS = [
    'nemotron-3-nano-30b-a3b',
    'nemotron-3-nano-omni-30b-a3b-reasoning:free',
    'nemotron-3-super-120b-a12b',
    'nemotron-3-super-120b-a12b:free',
    'nemotron-3-ultra-550b-a55b',
    'nemotron-3-ultra-550b-a55b:free',
    'nemotron-3.5-content-safety',
    'nemotron-3.5-content-safety:free',
    'nemotron-3.5-lightning',
    'nemotron-3.5-lightning:free',
    'llama-3.3-70b-instruct',
    'claude-sonnet-4-6',
]


def test_openrouter_fallback_discovers_native_nemotron_ids(monkeypatch):
    """The keyless OpenRouter path yields the Nemotron chat models in native form and nothing else."""
    import providers.base as base

    cache = {bare: (131072, 32768, bare, None, True) for bare in _OPENROUTER_LIVE_BARE_IDS}
    monkeypatch.setattr(base, 'get_openrouter_cache', lambda: cache)
    provider = _real_provider()

    models = provider._fetch_openrouter_models()

    assert sorted(m['id'] for m in models) == [
        'nvidia/nemotron-3-super-120b-a12b',
        'nvidia/nemotron-3-ultra-550b-a55b',
        'nvidia/nemotron-3.5-lightning-30b-a3b',
        'nvidia/nemotron-nano-3-30b-a3b',
    ]
    assert {m['_source'] for m in models} == {'openrouter'}


def test_litellm_fallback_discovers_native_nemotron_ids(monkeypatch):
    """The LiteLLM path strips one provider prefix; what remains must filter and normalise the same way."""
    fake_litellm = types.ModuleType('litellm')
    fake_litellm.model_cost = {
        'sample_spec': {'max_tokens': 'documentation entry, not a model'},
        'openrouter/nvidia/nemotron-3-super-120b-a12b': {'max_tokens': 262144},
        'openrouter/nvidia/nemotron-3-super-120b-a12b:free': {'max_tokens': 65536},
        'nebius/nvidia/nemotron-3-super-120b-a12b': {'max_tokens': 131072},  # duplicate: first wins
        'deepinfra/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B': {'max_tokens': 131072},  # not NVIDIA's spelling
        'openrouter/nvidia/nemotron-3.5-lightning': {'max_tokens': 65536},
        'openrouter/nvidia/nemotron-3.5-content-safety': {'max_tokens': 8192},
        'nvidia.nemotron-super-3-120b': {'max_tokens': 131072},  # Bedrock's bare key
        'azure_ai/FW-Nemotron-3-Ultra-NVFP4': {'max_tokens': 131072},
        'openai/gpt-4o': {'max_tokens': 128000},
    }
    monkeypatch.setitem(sys.modules, 'litellm', fake_litellm)
    provider = _real_provider()

    models = provider._fetch_litellm_models()

    assert {m['id']: m.get('context_window') for m in models} == {
        'nvidia/nemotron-3-super-120b-a12b': 262144,
        'nvidia/nemotron-3.5-lightning-30b-a3b': 65536,
    }
    assert {m['_source'] for m in models} == {'litellm'}


_SEEDED_CLOUD_PROFILES = {
    'nemotron-3-super': {
        'title': 'Nemotron 3 Super 120B',
        'model': 'nvidia/nemotron-3-super-120b-a12b',
        'modelSource': 'provider',
        'modelTotalTokens': 1000000,
        'modelOutputTokens': 32768,
        'apikey': '',
    },
    'nemotron-3-ultra': {
        'title': 'Nemotron 3 Ultra 550B',
        'model': 'nvidia/nemotron-3-ultra-550b-a55b',
        'modelSource': 'provider',
        'modelTotalTokens': 1000000,
        'modelOutputTokens': 32768,
        'apikey': '',
    },
    'nemotron-3-5-lightning': {
        'title': 'Nemotron 3.5 Lightning 30B',
        'model': 'nvidia/nemotron-3.5-lightning-30b-a3b',
        'modelSource': 'provider',
        'modelTotalTokens': 262144,
        'modelOutputTokens': 32768,
        'apikey': '',
    },
}


def _keyless_openrouter_sync(monkeypatch, tmp_path, bare_ids):
    """Run the real sync() the way the scheduled fallback job does: no NVIDIA key, OpenRouter as the source."""
    import providers.base as base

    cache = {bare: (131072, 32768, bare, None, True) for bare in bare_ids}
    monkeypatch.setattr(base, 'get_openrouter_cache', lambda: cache)
    monkeypatch.setattr(base, 'is_openrouter_available', lambda: True)
    monkeypatch.delenv('ROCKETRIDE_NVIDIA_KEY', raising=False)
    provider = _real_provider()
    return provider.sync(
        current_profiles={k: dict(v) for k, v in _SEEDED_CLOUD_PROFILES.items()},
        title_mappings={},
        output_token_overrides={},
        default_output_tokens=4096,
        extra_profile_fields={'apikey': ''},
        apply=False,
        services_json_path=str(tmp_path / 'services.json'),
        model_sources=['openrouter'],
        enable_discovery=True,
        allow_fallback_discovery=True,
        global_protected_profiles=['custom'],
    )


def test_keyless_openrouter_sync_discovers_instead_of_no_op(monkeypatch, tmp_path):
    """The scheduled fallback (no ROCKETRIDE_NVIDIA_KEY) keeps the seeded profiles and proposes what NVIDIA serves."""
    report = _keyless_openrouter_sync(monkeypatch, tmp_path, _OPENROUTER_LIVE_BARE_IDS)

    assert report.error is None
    assert [profile['model'] for _key, profile in report.added] == ['nvidia/nemotron-nano-3-30b-a3b']
    assert report.deprecated == []


def test_sync_fails_loudly_when_the_source_matches_nothing(monkeypatch, tmp_path):
    """An empty discovery result is a filter bug, not an empty catalogue: the run must not succeed silently."""
    report = _keyless_openrouter_sync(monkeypatch, tmp_path, ['claude-sonnet-4-6', 'llama-3.3-70b-instruct'])

    assert report.error is not None
    assert 'listed no models matching the llm_nemotron filter' in report.error
    assert report.added == []
    assert report.deprecated == []
