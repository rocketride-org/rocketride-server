"""
Save-time and start-time handling of the GMI Cloud endpoint URL.

Deploy-on-demand profiles ship with an empty `serverbase`: the user pastes the
endpoint their GMI Cloud console gives them. Saying so while the node is being
configured is worth a test, because the alternative is a failure at pipe start,
far from the field that is missing.
"""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

import pytest

_PACKAGE = 'gmi_cloud_under_test'


def _load_iglobal(monkeypatch, config_overrides: dict | None = None, error_name: str | None = None):
    """
    Load the node's IGlobal against stub SDKs.

    Args:
        monkeypatch: pytest monkeypatch fixture
        config_overrides: keys to change in the node configuration
        error_name: name of an openai error class the probe should raise

    Returns:
        (instance, probe requests, warnings, chats built)
    """
    requests: list[dict] = []
    warnings: list[str] = []
    chats: list[dict] = []

    ai_module = types.ModuleType('ai')
    common_module = types.ModuleType('ai.common')
    chat_module = types.ModuleType('ai.common.chat')
    config_module = types.ModuleType('ai.common.config')
    rocketlib_module = types.ModuleType('rocketlib')
    openai_module = types.ModuleType('openai')
    depends_module = types.ModuleType('depends')

    class ChatBase:
        """Stand-in for the shared chat base."""

    class Config:
        """Serves one node configuration."""

        @staticmethod
        def getNodeConfig(_logical_type, _conn_config):
            """Return the configuration under test."""
            config = {
                'apikey': 'gmi-key',
                'model': 'deepseek-ai/DeepSeek-V3-0324',
                'serverbase': 'https://api.gmi-serving.com/v1',
                'modelTotalTokens': 163840,
            }
            if config_overrides:
                config.update(config_overrides)
            return config

    class IGlobalBase:
        """Stand-in for the engine's global base."""

    class OpenAIError(Exception):
        """Stand-in for the SDK's base error."""

    class APIStatusError(OpenAIError):
        """Stand-in for an HTTP error."""

    class AuthenticationError(APIStatusError):
        """Stand-in for a rejected key."""

    class RateLimitError(APIStatusError):
        """Stand-in for a throttled call."""

    class APIConnectionError(OpenAIError):
        """Stand-in for a transport failure."""

    class FakeCompletions:
        """Records the probe request."""

        def create(self, **kwargs):
            """Record the call, then raise when the test asked for a failure."""
            requests.append(kwargs)
            if error_name is not None:
                raise getattr(openai_module, error_name)(error_name)

    class OpenAI:
        """Client stub exposing only what the node touches."""

        def __init__(self, **_kwargs):
            """Expose a chat.completions surface."""
            self.chat = types.SimpleNamespace(completions=FakeCompletions())

    class Chat:
        """Records that the node reached the point of building a client."""

        def __init__(self, provider, config, bag):
            """Record the configuration the node passed on."""
            chats.append(config)

    chat_module.ChatBase = ChatBase
    config_module.Config = Config
    rocketlib_module.IGlobalBase = IGlobalBase
    rocketlib_module.warning = warnings.append
    openai_module.OpenAI = OpenAI
    openai_module.OpenAIError = OpenAIError
    openai_module.APIStatusError = APIStatusError
    openai_module.AuthenticationError = AuthenticationError
    openai_module.RateLimitError = RateLimitError
    openai_module.APIConnectionError = APIConnectionError
    depends_module.depends = lambda _requirements: None

    node_dir = Path(__file__).resolve().parents[1] / 'src' / 'nodes' / 'llm_gmi_cloud'
    package = types.ModuleType(_PACKAGE)
    package.__path__ = [str(node_dir)]
    driver_module = types.ModuleType(f'{_PACKAGE}.gmi_cloud')
    driver_module.Chat = Chat

    for name, module in (
        ('ai', ai_module),
        ('ai.common', common_module),
        ('ai.common.chat', chat_module),
        ('ai.common.config', config_module),
        ('rocketlib', rocketlib_module),
        ('openai', openai_module),
        ('depends', depends_module),
        (_PACKAGE, package),
        (f'{_PACKAGE}.gmi_cloud', driver_module),
    ):
        monkeypatch.setitem(sys.modules, name, module)

    spec = importlib.util.spec_from_file_location(f'{_PACKAGE}.IGlobal', node_dir / 'IGlobal.py')
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)

    instance = module.IGlobal()
    instance.glb = types.SimpleNamespace(logicalType='llm_gmi_cloud', connConfig={})
    instance.IEndpoint = types.SimpleNamespace(endpoint=types.SimpleNamespace(bag={}))

    return instance, requests, warnings, chats


class TestSaveTime:
    """What the user is told while configuring the node."""

    def test_a_missing_endpoint_is_reported_not_ignored(self, monkeypatch):
        """A deploy-on-demand profile without its URL warns instead of passing silently."""
        instance, requests, warnings, _chats = _load_iglobal(monkeypatch, {'serverbase': ''})

        instance.validateConfig()

        assert requests == []
        assert len(warnings) == 1
        assert 'Endpoint URL is required' in warnings[0]
        assert 'GMI Cloud console' in warnings[0]

    def test_a_configured_endpoint_is_probed(self, monkeypatch):
        """With an endpoint set, the node probes the API as before."""
        instance, requests, warnings, _chats = _load_iglobal(monkeypatch)

        instance.validateConfig()

        assert warnings == []
        assert [r['model'] for r in requests] == ['deepseek-ai/DeepSeek-V3-0324']

    def test_an_incomplete_configuration_stays_quiet(self, monkeypatch):
        """Nothing to say before the model and key are entered."""
        instance, requests, warnings, _chats = _load_iglobal(monkeypatch, {'model': '', 'serverbase': ''})

        instance.validateConfig()

        assert (requests, warnings) == ([], [])


class TestPipelineStart:
    """What happens when a pipeline using the node starts."""

    def test_a_missing_endpoint_stops_the_start_with_a_usable_message(self, monkeypatch):
        """No silent fallback to the shared endpoint: that would 404 later, on the model."""
        instance, _requests, _warnings, chats = _load_iglobal(monkeypatch, {'serverbase': ''})

        with pytest.raises(ValueError, match='endpoint URL is required'):
            instance.beginGlobal()

        assert chats == []

    def test_a_foreign_host_is_refused(self, monkeypatch):
        """The SSRF guard still rejects an endpoint outside gmi-serving.com."""
        instance, _requests, _warnings, chats = _load_iglobal(
            monkeypatch, {'serverbase': 'https://evil.example.com/v1'}
        )

        with pytest.raises(ValueError, match='gmi-serving.com'):
            instance.beginGlobal()

        assert chats == []

    def test_a_configured_endpoint_builds_the_client(self, monkeypatch):
        """The happy path reaches Chat with the endpoint the profile carries."""
        instance, _requests, _warnings, chats = _load_iglobal(monkeypatch)

        instance.beginGlobal()

        assert [c['serverbase'] for c in chats] == ['https://api.gmi-serving.com/v1']
