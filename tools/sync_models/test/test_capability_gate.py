"""
Offline tests for capability filtering and key-only providers.

A vision node must only take models that accept images. The provider's own
answer wins (Mistral reports ``capabilities.vision``); otherwise OpenRouter and
LiteLLM are asked. Unknown counts as no, and existing profiles are never dropped.

Run: pytest tools/sync_models/test/test_capability_gate.py
"""

from __future__ import annotations

import types
from typing import Any, Dict, List
from unittest.mock import MagicMock

import pytest

from core import capabilities, merger
from providers.base import CloudProvider

_KEY_ENV = 'ROCKETRIDE_TEST_VISION_KEY'


class _FakeVisionProvider(CloudProvider):
    """Provider whose model list is canned; its models report capabilities themselves."""

    provider_name = 'llm_test_vision'
    display_name = 'Test'
    smoke_type = 'vision_openai_compat'

    def __init__(self, config: Dict[str, Any], models: List[Dict[str, Any]], client: MagicMock):
        """
        Args:
            config: Provider config block
            models: Entries fetch_models returns
            client: SDK client stand-in used by the smoke test
        """
        super().__init__(config)
        self._models = models
        self._client = client

    def make_client(self, api_key: str) -> object:
        """
        Args:
            api_key: Ignored

        Returns:
            The canned client
        """
        return self._client

    def fetch_models(self, client: object) -> List[Dict[str, Any]]:
        """
        Args:
            client: Ignored

        Returns:
            The canned model entries
        """
        return [dict(m) for m in self._models]


def _profiles() -> Dict[str, Any]:
    """
    Build one existing profile whose model the provider says is text-only.

    Returns:
        A profiles dict
    """
    return {
        'old-text-model': {
            'title': 'Old Text Model',
            'model': 'old-text-model',
            'modelSource': 'provider',
            'modelTotalTokens': 32768,
            'modelOutputTokens': 4096,
            'apikey': '',
        }
    }


def _config(**extra: Any) -> Dict[str, Any]:
    """
    Build a provider config that requires vision.

    Args:
        **extra: Extra config keys

    Returns:
        The config block
    """
    return {'env_var': _KEY_ENV, 'model_filter': {'require_capabilities': ['vision']}, **extra}


def _run(provider: CloudProvider, profiles: Dict[str, Any]):
    """
    Run a dry sync with discovery on and the provider as the only source.

    Args:
        provider: The provider under test
        profiles: Current profiles

    Returns:
        The ProviderReport
    """
    return provider.sync(
        current_profiles=profiles,
        title_mappings={},
        output_token_overrides={},
        default_output_tokens=4096,
        extra_profile_fields={'apikey': ''},
        apply=False,
        services_json_path='unused.json',
        model_sources=['provider'],
        enable_discovery=True,
    )


@pytest.fixture(autouse=True)
def _no_openrouter_network(monkeypatch):
    """Keep every test offline: an empty, already-loaded OpenRouter cache."""
    if merger._OPENROUTER_CACHE is None:
        monkeypatch.setattr(merger, '_OPENROUTER_CACHE', {})


class TestCapabilityGate:
    """The gate on newly discovered models."""

    def test_only_new_models_known_to_have_the_capability_are_added(self, monkeypatch):
        """A text model, an unknown model and the existing profile all stay out of the additions."""
        monkeypatch.setenv(_KEY_ENV, 'key')
        models = [
            {'id': 'old-text-model', 'capabilities': {'vision': False}},
            {'id': 'new-vision-model', 'capabilities': {'vision': True}},
            {'id': 'new-text-model', 'capabilities': {'vision': False}},
            {'id': 'new-unknown-model'},
        ]
        provider = _FakeVisionProvider(_config(), models, MagicMock())

        report = _run(provider, _profiles())

        assert [key for key, _ in report.added] == ['new-vision-model']
        # The existing profile stays: the gate never removes what is already there.
        assert report.deprecated == []

    def test_new_models_are_checked_with_an_image(self, monkeypatch):
        """The smoke call for a vision provider carries an image part."""
        monkeypatch.setenv(_KEY_ENV, 'key')
        client = MagicMock()
        provider = _FakeVisionProvider(
            _config(), [{'id': 'new-vision-model', 'capabilities': {'vision': True}}], client
        )

        _run(provider, _profiles())

        messages = client.chat.completions.create.call_args.kwargs['messages']
        parts = messages[0]['content']
        assert any(p.get('type') == 'image_url' for p in parts)

    def test_a_provider_without_the_requirement_is_unchanged(self, monkeypatch):
        """Without require_capabilities a text model is added as before."""
        monkeypatch.setenv(_KEY_ENV, 'key')
        models = [{'id': 'new-text-model', 'capabilities': {'vision': False}}]
        provider = _FakeVisionProvider({'env_var': _KEY_ENV}, models, MagicMock())

        report = _run(provider, _profiles())

        assert [key for key, _ in report.added] == ['new-text-model']


class TestRequireApiKey:
    """Providers that are synced only through their own API."""

    def test_a_key_only_provider_is_skipped_without_its_key(self, monkeypatch):
        """No key: a warning naming the variable, no client, no changes."""
        monkeypatch.delenv(_KEY_ENV, raising=False)
        provider = _FakeVisionProvider(_config(require_api_key=True), [], MagicMock())
        provider.make_client = MagicMock(side_effect=AssertionError('must not build a client'))

        report = _run(provider, _profiles())

        assert _KEY_ENV in report.warning
        assert not report.has_changes()
        assert report.deprecated == []

    def test_a_key_only_provider_runs_with_its_key(self, monkeypatch):
        """With the key the provider syncs normally."""
        monkeypatch.setenv(_KEY_ENV, 'key')
        models = [{'id': 'old-text-model'}, {'id': 'new-vision-model', 'capabilities': {'vision': True}}]
        provider = _FakeVisionProvider(_config(require_api_key=True), models, MagicMock())

        report = _run(provider, _profiles())

        assert report.warning is None
        assert [key for key, _ in report.added] == ['new-vision-model']


class TestAllowedSources:
    """Providers that trust only some sources for token data."""

    def test_unlisted_sources_are_never_consulted(self, monkeypatch):
        """With allowed_sources ["provider"], OpenRouter and LiteLLM are not asked, even when the run lists them."""
        monkeypatch.setenv(_KEY_ENV, 'key')

        def forbidden(*args):
            """Fail the test if a disallowed source is consulted."""
            raise AssertionError('disallowed source consulted')

        monkeypatch.setattr(merger, '_openrouter_info', forbidden)
        monkeypatch.setattr(merger, '_litellm_info', forbidden)
        monkeypatch.setattr(merger, '_LITELLM_AVAILABLE', True)
        models = [{'id': 'old-text-model', 'context_window': 65536}, {'id': 'org/new-model', 'context_window': 8192}]
        provider = _FakeVisionProvider({'env_var': _KEY_ENV, 'allowed_sources': ['provider']}, models, MagicMock())

        report = provider.sync(
            current_profiles=_profiles(),
            title_mappings={},
            output_token_overrides={},
            default_output_tokens=4096,
            extra_profile_fields={'apikey': ''},
            apply=False,
            services_json_path='unused.json',
            model_sources=['provider', 'openrouter', 'litellm'],
            enable_discovery=True,
        )

        assert [(key, p['modelTotalTokens']) for key, p in report.added] == [('org-new-model', 8192)]
        assert ('old-text-model', 'modelTotalTokens', 32768, 65536) in report.updated

    def test_a_mapped_id_is_what_the_databases_are_asked_for(self, monkeypatch):
        """token_lookup_id decides the database key; a model it leaves alone finds nothing."""
        monkeypatch.setattr(merger, '_OPENROUTER_CACHE', {'gpt-5.2': (400000, 128000, 'OpenAI: GPT-5.2', None, False)})
        monkeypatch.setenv(_KEY_ENV, 'key')
        models = [{'id': 'openai/gpt-5.2'}, {'id': 'Qwen/Qwen3-32B-FP8'}]
        provider = _FakeVisionProvider(
            {'env_var': _KEY_ENV, 'allowed_sources': ['provider', 'openrouter']}, models, MagicMock()
        )
        provider.token_lookup_id = lambda mid: mid.split('/', 1)[-1].lower() if mid.startswith('openai/') else mid

        report = provider.sync(
            current_profiles={},
            title_mappings={},
            output_token_overrides={},
            default_output_tokens=4096,
            extra_profile_fields={'apikey': ''},
            apply=False,
            services_json_path='unused.json',
            model_sources=['provider', 'openrouter'],
            enable_discovery=True,
        )

        added = {key: profile for key, profile in report.added}
        assert added['openai-gpt-5-2']['modelTotalTokens'] == 400000
        assert added['openai-gpt-5-2']['modelOutputTokens'] == 128000
        # No source knows this one, so it falls back rather than borrowing another host's numbers.
        assert added['qwen-qwen3-32b-fp8']['_src_modelTotalTokens'] == 'estimated'


class TestModelCapability:
    """How a provider answers for one model."""

    def test_the_providers_answer_wins_over_the_databases(self, monkeypatch):
        """A flag on the entry is used even when a database says otherwise."""
        monkeypatch.setattr('providers.base.lookup_capability', lambda *a: True)
        provider = _FakeVisionProvider({'env_var': _KEY_ENV}, [], MagicMock())
        entry = {'id': 'm', 'capabilities': {'vision': False}}
        assert provider.model_capability(entry, 'vision', ['openrouter']) is False

    def test_the_databases_are_asked_with_the_bare_id(self, monkeypatch):
        """Provider-specific prefixes are removed before the database lookup."""
        seen = []

        def fake_lookup(model_id, capability, sources):
            """
            Record the lookup and answer True.

            Args:
                model_id: Looked-up ID
                capability: Capability name
                sources: Source order

            Returns:
                True
            """
            seen.append((model_id, capability, sources))
            return True

        monkeypatch.setattr('providers.base.lookup_capability', fake_lookup)
        provider = _FakeVisionProvider({'env_var': _KEY_ENV}, [], MagicMock())
        provider.normalize_profile_model_id = lambda mid: mid.removeprefix('models/')

        assert provider.model_capability({'id': 'models/gemini-x'}, 'vision', ['litellm']) is True
        assert seen == [('gemini-x', 'vision', ['litellm'])]


class TestLookupCapability:
    """The third-party databases."""

    def test_sources_are_asked_in_order_and_unknown_falls_through(self, monkeypatch):
        """An unknown answer moves on to the next source."""
        monkeypatch.setattr(capabilities, 'openrouter_capability', lambda m, c: None)
        monkeypatch.setattr(capabilities, 'litellm_capability', lambda m, c: False)
        assert capabilities.lookup_capability('m', 'vision', ['provider', 'openrouter', 'litellm']) is False

    def test_the_first_known_answer_wins(self, monkeypatch):
        """The source order decides between conflicting answers."""
        monkeypatch.setattr(capabilities, 'openrouter_capability', lambda m, c: True)
        monkeypatch.setattr(capabilities, 'litellm_capability', lambda m, c: False)
        assert capabilities.lookup_capability('m', 'vision', ['openrouter', 'litellm']) is True
        assert capabilities.lookup_capability('m', 'vision', ['litellm', 'openrouter']) is False

    def test_no_source_means_unknown(self):
        """The provider source is not a database, so it alone answers nothing."""
        assert capabilities.lookup_capability('m', 'vision', ['provider']) is None

    def test_openrouter_reads_image_input(self, monkeypatch):
        """Vision means 'image' among OpenRouter's input modalities."""
        monkeypatch.setattr(merger, '_OPENROUTER_CACHE', {})  # loaded: no network
        monkeypatch.setattr(
            merger,
            '_OPENROUTER_INPUT_MODALITIES',
            {'seeing': frozenset({'text', 'image'}), 'blind': frozenset({'text'})},
        )
        assert capabilities.openrouter_capability('seeing', 'vision') is True
        assert capabilities.openrouter_capability('blind', 'vision') is False
        assert capabilities.openrouter_capability('unlisted', 'vision') is None
        assert capabilities.openrouter_capability('seeing', 'teleport') is None

    def test_litellm_reads_the_supports_flag(self, monkeypatch):
        """Any True wins, False needs an explicit flag, no flag is unknown."""
        model_cost = {
            'gemini/seeing': {'supports_vision': True},
            'seeing': {'supports_vision': False},  # another host's entry for the same model
            'mistral/blind': {'supports_vision': False},
            'silent': {'max_tokens': 1},
        }
        monkeypatch.setattr(merger, '_LITELLM_AVAILABLE', True)
        monkeypatch.setattr(merger, 'litellm', types.SimpleNamespace(model_cost=model_cost), raising=False)
        assert capabilities.litellm_capability('seeing', 'vision') is True
        assert capabilities.litellm_capability('blind', 'vision') is False
        assert capabilities.litellm_capability('silent', 'vision') is None
        assert capabilities.litellm_capability('unlisted', 'vision') is None

    def test_litellm_missing_means_unknown(self, monkeypatch):
        """Without the package there is no answer."""
        monkeypatch.setattr(merger, '_LITELLM_AVAILABLE', False)
        assert capabilities.litellm_capability('anything', 'vision') is None
