"""
Offline tests for the vision and model-host providers, and for the wiring that
every provider needs (registry, config, services file, CI workflow, builder task).

The wiring tests exist because a provider registered in the tool but missing
from the workflow is never synced, and nothing else would notice.

Run: pytest tools/sync_models/test/test_new_providers.py
"""

from __future__ import annotations

import importlib
import re
import struct
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock

import pytest

import sync_models
from core import smoke
from providers.base import CloudProvider

_REPO_ROOT = Path(__file__).resolve().parents[3]
_WORKFLOW = _REPO_ROOT / '.github' / 'workflows' / 'sync-models.yml'
_TASKS_JS = _REPO_ROOT / 'tools' / 'sync_models' / 'scripts' / 'tasks.js'


def _fake_openai(monkeypatch, models):
    """
    Install a stand-in ``openai`` module whose client lists the given models.

    Args:
        monkeypatch: pytest monkeypatch fixture
        models: Objects returned by ``client.models.list().data``

    Returns:
        Dict that receives the client constructor kwargs
    """
    captured = {}

    class FakeOpenAI:
        """Records its kwargs and lists the canned models."""

        def __init__(self, **kwargs):
            """
            Args:
                **kwargs: Client constructor arguments, recorded
            """
            captured.update(kwargs)
            self.models = types.SimpleNamespace(list=lambda: types.SimpleNamespace(data=models))

    module = types.ModuleType('openai')
    module.OpenAI = FakeOpenAI
    monkeypatch.setitem(sys.modules, 'openai', module)
    return captured


def _client(data):
    """
    Build a client stand-in whose model list returns ``data``.

    Args:
        data: Model objects

    Returns:
        The client stand-in
    """
    return types.SimpleNamespace(models=types.SimpleNamespace(list=lambda: types.SimpleNamespace(data=data)))


@pytest.fixture(scope='module')
def config():
    """The parsed sync_models.config.json."""
    return sync_models._load_config()


# ---------------------------------------------------------------------------
# Wiring shared by every provider
# ---------------------------------------------------------------------------


class TestProviderWiring:
    """Everything a registered provider needs to be synced."""

    @pytest.mark.parametrize('name', sorted(sync_models._PROVIDER_REGISTRY))
    def test_each_provider_is_complete(self, name, config):
        """Config block, services file and handler class all exist and agree."""
        assert name in config['providers'], f'{name}: no config block'
        assert name in sync_models._SERVICES_JSON_PATHS, f'{name}: no services.json path'
        assert (_REPO_ROOT / sync_models._SERVICES_JSON_PATHS[name]).is_file()
        cls = sync_models._import_provider_class(sync_models._PROVIDER_REGISTRY[name])
        assert issubclass(cls, CloudProvider)
        assert cls.provider_name == name

    def test_the_workflow_syncs_every_provider_with_its_key(self, config):
        """Every enabled provider is in the workflow map, with the key its config names."""
        text = _WORKFLOW.read_text(encoding='utf-8')
        mapped = dict(re.findall(r'\[(\w+)\]=(\w+)', text))
        for name in sync_models._PROVIDER_REGISTRY:
            if config['providers'][name].get('enabled', True) is False:
                continue
            assert mapped.get(name) == config['providers'][name]['env_var'], f'{name}: missing or wrong in the workflow'

    def test_the_workflow_passes_every_key_it_maps(self):
        """Each mapped key reaches both steps that read it."""
        text = _WORKFLOW.read_text(encoding='utf-8')
        for env_var in set(re.findall(r'\[\w+\]=(\w+)', text)):
            # Once for the partition step, once for the strict sync step.
            assert text.count(f'{env_var}: ${{{{ secrets.{env_var} }}}}') == 2, f'{env_var}: not passed to both steps'

    def test_the_builder_task_formats_every_provider_file(self):
        """tasks.js mirrors the services.json paths of the registry."""
        text = _TASKS_JS.read_text(encoding='utf-8')
        block = text.split('const SERVICES_JSON_PATHS = {', 1)[1].split('};', 1)[0]
        assert dict(re.findall(r"(\w+): '([^']+)'", block)) == sync_models._SERVICES_JSON_PATHS

    def test_provider_extra_profile_fields_reach_new_profiles(self, monkeypatch, config):
        """A provider's extra_profile_fields override and extend the defaults."""
        captured = {}

        def fake_sync(self, **kwargs):
            """
            Capture the sync arguments.

            Args:
                **kwargs: CloudProvider.sync arguments
            """
            captured.update(kwargs)

        monkeypatch.setattr(CloudProvider, 'sync', fake_sync)
        sync_models.sync_provider('llm_nebius', config, _REPO_ROOT, apply=False)

        assert captured['extra_profile_fields'] == {
            'apikey': '${ROCKETRIDE_NEBIUS_KEY}',
            'base_url': 'https://api.tokenfactory.nebius.com/v1/',
        }


# ---------------------------------------------------------------------------
# Provider handlers
# ---------------------------------------------------------------------------


class TestMistral:
    """Mistral's model card and the vision handler."""

    def test_capabilities_are_kept_from_the_model_card(self):
        """The capabilities object is copied onto each entry that has one."""
        from providers.mistral import MistralProvider

        data = [
            types.SimpleNamespace(id='mistral-large-2512', capabilities={'vision': True}),
            types.SimpleNamespace(id='codestral-2508', capabilities={'vision': False}),
            types.SimpleNamespace(id='no-card'),
        ]

        assert MistralProvider({}).fetch_models(_client(data)) == [
            {'id': 'mistral-large-2512', 'capabilities': {'vision': True}},
            {'id': 'codestral-2508', 'capabilities': {'vision': False}},
            {'id': 'no-card'},
        ]

    def test_a_non_dict_capabilities_value_is_ignored(self):
        """Anything that is not dict-shaped is dropped."""
        from providers.mistral import MistralProvider

        client = MagicMock()
        client.models.list.return_value.data = [types.SimpleNamespace(id='m', capabilities='vision')]
        assert MistralProvider({}).fetch_models(client) == [{'id': 'm'}]

    def test_the_vision_handler_checks_with_an_image(self):
        """llm_vision_mistral uses the image smoke test."""
        from providers.vision_mistral import VisionMistralProvider

        assert VisionMistralProvider.smoke_type == 'vision_openai_compat'
        assert VisionMistralProvider.provider_name == 'llm_vision_mistral'


class TestVisionGemini:
    """The two Gemini vision nodes store IDs differently."""

    def test_llm_vision_gemini_keeps_the_native_prefix(self):
        """llm_vision_gemini stores "models/..." like llm_gemini."""
        from providers.vision_gemini import VisionGeminiProvider

        provider = VisionGeminiProvider({})
        assert provider.smoke_type == 'vision_gemini'
        assert provider.normalize_model_id('models/gemini-2.5-flash') == 'models/gemini-2.5-flash'
        assert provider.litellm_to_native_model_id('gemini-2.5-flash') == 'models/gemini-2.5-flash'

    def test_accessibility_describe_stores_bare_ids(self):
        """accessibility_describe stores bare IDs in every direction."""
        from providers.vision_gemini import AccessibilityDescribeProvider

        provider = AccessibilityDescribeProvider({})
        assert provider.smoke_type == 'vision_gemini'
        assert provider.normalize_model_id('models/gemini-2.5-flash') == 'gemini-2.5-flash'
        assert provider.litellm_to_native_model_id('gemini-2.5-flash') == 'gemini-2.5-flash'
        assert provider.normalize_profile_model_id('gemini-2.5-flash') == 'gemini-2.5-flash'
        assert provider.derive_title('gemini-2.5-flash', {'gemini-': 'Gemini '}) == 'Gemini 2.5 Flash'


class TestModelHosts:
    """GMI Cloud and Nebius."""

    @pytest.mark.parametrize(
        'module, cls, url',
        [
            ('providers.gmi_cloud', 'GmiCloudProvider', 'https://api.gmi-serving.com/v1'),
            ('providers.nebius', 'NebiusProvider', 'https://api.tokenfactory.nebius.com/v1/'),
        ],
    )
    def test_the_client_points_at_the_host(self, monkeypatch, module, cls, url):
        """Each host builds an OpenAI client with its own base URL."""
        captured = _fake_openai(monkeypatch, [])
        provider_cls = getattr(importlib.import_module(module), cls)

        provider_cls({}).make_client('test-key')

        assert captured == {'api_key': 'test-key', 'base_url': url}

    def test_the_context_window_is_read_whatever_the_host_calls_it(self):
        """Known field names are read; missing and non-integer values are not."""
        from providers.gmi_cloud import GmiCloudProvider

        data = [
            types.SimpleNamespace(id='Qwen/Qwen3-32B-FP8', context_length=131072),
            types.SimpleNamespace(id='meta-llama/Llama-3.3-70B-Instruct', max_model_len=65536),
            types.SimpleNamespace(id='org/no-window', context_length=None),
            types.SimpleNamespace(id='org/flag', context_window=True),
        ]

        assert GmiCloudProvider({}).fetch_models(_client(data)) == [
            {'id': 'Qwen/Qwen3-32B-FP8', 'context_window': 131072},
            {'id': 'meta-llama/Llama-3.3-70B-Instruct', 'context_window': 65536},
            {'id': 'org/no-window'},
            {'id': 'org/flag'},
        ]

    @pytest.mark.parametrize(
        'model_id, looked_up',
        [
            ('openai/gpt-5.2', 'gpt-5.2'),
            ('anthropic/claude-opus-4.5', 'claude-opus-4.5'),
            ('google/gemini-3-flash-preview', 'gemini-3-flash-preview'),
            # Open-weight models the host runs itself keep their ID, which matches
            # nothing in the databases — including the gpt-oss family.
            ('openai/gpt-oss-120b', 'openai/gpt-oss-120b'),
            ('Qwen/Qwen3-32B-FP8', 'Qwen/Qwen3-32B-FP8'),
            ('deepseek-ai/DeepSeek-R1', 'deepseek-ai/DeepSeek-R1'),
        ],
    )
    def test_only_proxied_vendor_models_are_looked_up(self, model_id, looked_up, config):
        """A resold vendor model maps to the vendor's bare ID; a self-hosted model does not."""
        from providers.gmi_cloud import GmiCloudProvider

        provider = GmiCloudProvider(config['providers']['llm_gmi_cloud'])
        assert provider.token_lookup_id(model_id) == looked_up

    def test_exclude_patterns_ignore_case(self):
        """A lowercase pattern excludes a mixed-case host ID; the include prefixes still apply."""
        from providers.gmi_cloud import GmiCloudProvider

        provider = GmiCloudProvider(
            {'model_filter': {'include_prefixes': ['meta-llama/'], 'exclude_patterns': ['guard']}}
        )
        assert not provider.should_include('meta-llama/Llama-Guard-4-12B')
        assert provider.should_include('meta-llama/Llama-3.3-70B-Instruct')
        assert not provider.should_include('BAAI/bge-m3')

    @pytest.mark.parametrize(
        'model_id, title',
        [
            ('Qwen/Qwen3-32B-FP8', 'Qwen3 32B FP8'),
            ('meta-llama/Llama-3.3-70B-Instruct', 'Llama 3.3 70B Instruct'),
            ('deepseek-ai/DeepSeek-V3.2', 'DeepSeek V3.2'),
            ('google/gemma-3-27b-it', 'Gemma 3 27b it'),
            ('openai/gpt-5.2', 'GPT-5.2'),
            ('anthropic/claude-opus-4.5', 'Claude Opus 4.5'),
        ],
    )
    def test_titles_drop_the_org_prefix(self, model_id, title):
        """Titles come from the model name; mapped names use the shared rules."""
        from providers.gmi_cloud import GmiCloudProvider

        mappings = {'gpt-': 'GPT-', 'claude-': 'Claude ', 'deepseek-': 'DeepSeek '}
        assert GmiCloudProvider({}).derive_title(model_id, mappings) == title


# ---------------------------------------------------------------------------
# Vision smoke tests
# ---------------------------------------------------------------------------


class TestVisionSmoke:
    """The image checks used for vision nodes."""

    def test_the_smoke_image_is_a_valid_png(self):
        """Signature, 64x64 header and the IEND chunk are in place."""
        png = smoke._SMOKE_IMAGE_PNG
        assert png.startswith(b'\x89PNG\r\n\x1a\n')
        width, height = struct.unpack('>II', png[16:24])
        assert (width, height) == (64, 64)
        assert png.endswith(b'IEND\xaeB`\x82')

    def test_openai_compatible_check_sends_text_and_image(self):
        """The chat call carries the text prompt and a PNG data URL."""
        client = MagicMock()
        assert smoke.run('vision_openai_compat', client, 'gpt-x').passed()

        parts = client.chat.completions.create.call_args.kwargs['messages'][0]['content']
        assert parts[0] == {'type': 'text', 'text': smoke._SMOKE_TEXT}
        assert parts[1]['image_url']['url'].startswith('data:image/png;base64,')

    def test_the_text_check_still_sends_text_only(self):
        """The existing chat check is unchanged."""
        client = MagicMock()
        smoke.run('chat_openai_compat', client, 'gpt-x')
        assert client.chat.completions.create.call_args.kwargs['messages'] == smoke._SMOKE_PROMPT

    def test_gemini_check_sends_the_image_inline(self):
        """The generateContent call carries the PNG bytes and the prompt."""
        client = MagicMock()
        assert smoke.run('vision_gemini', client, 'models/gemini-x').passed()

        contents = client.models.generate_content.call_args.kwargs['contents']
        parts = contents[0]['parts']
        assert parts[0]['inline_data'] == {'mime_type': 'image/png', 'data': smoke._SMOKE_IMAGE_PNG}
        assert parts[1] == {'text': smoke._SMOKE_TEXT}

    def test_gemini_vision_contents_are_valid_sdk_input(self):
        """google-genai accepts the dict form of the contents."""
        genai_types = pytest.importorskip('google.genai.types')
        content = genai_types.Content.model_validate(smoke._SMOKE_VISION_CONTENTS[0])
        assert content.parts[0].inline_data.data == smoke._SMOKE_IMAGE_PNG
        assert content.parts[1].text == smoke._SMOKE_TEXT

    def test_a_rejected_image_is_a_skip_not_a_retirement(self):
        """A model that refuses images is skipped, never deprecated."""
        client = MagicMock()
        client.chat.completions.create.side_effect = Exception('400 image input is not supported by this model')
        result = smoke.run('vision_openai_compat', client, 'text-only')
        assert result.outcome == 'skip'
