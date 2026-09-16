"""Unit tests for llm_nemotron's Chat construction — the cloud-key guard.

Loads nodes/src/nodes/llm_nemotron/nemotron.py with stubbed heavy imports
(ai.common, langchain_openai), same approach as
test_baidu_qianfan_global_validation.py, and verifies the fail-fast
cloud-key guard in Chat.__init__: an NVIDIA cloud serverbase requires a
non-blank apikey, while self-hosted endpoints build with the dummy token.

<think>-block handling is not tested here: the node has no local strip —
ChatBase._chat returns text through the shared LangChainAdapter, whose
think-tag splitter owns that behaviour (covered by the adapter's own tests).
"""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

import pytest


def _load_node_module(monkeypatch, name: str):
    """Load ``nodes/src/nodes/llm_nemotron/<name>.py`` as a submodule of a synthetic package.

    The node modules import the shared ``endpoint`` helper relatively, so a
    bare ``spec_from_file_location`` would fail with "no known parent
    package". Registering a package whose ``__path__`` is the node directory
    lets that relative import resolve; every module goes through
    ``monkeypatch.setitem`` so nothing leaks into ``sys.modules``.
    """
    node_dir = Path(__file__).resolve().parents[1] / 'src' / 'nodes' / 'llm_nemotron'
    pkg_name = 'llm_nemotron_under_test'
    pkg = types.ModuleType(pkg_name)
    pkg.__path__ = [str(node_dir)]
    pkg.__package__ = pkg_name
    monkeypatch.setitem(sys.modules, pkg_name, pkg)
    for sub in ('endpoint', name):
        spec = importlib.util.spec_from_file_location(f'{pkg_name}.{sub}', node_dir / f'{sub}.py')
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        monkeypatch.setitem(sys.modules, f'{pkg_name}.{sub}', module)
        spec.loader.exec_module(module)
    return module


def _load_nemotron(monkeypatch, config_overrides: dict | None = None):
    """Load nemotron.py from source with stubbed dependencies.

    Installs fake ai.common.chat / ai.common.config / langchain_openai
    modules in sys.modules, then imports the node module for testing.
    ``config_overrides`` is merged over the default cloud-profile config.
    """
    ai_module = types.ModuleType('ai')
    common_module = types.ModuleType('ai.common')
    chat_module = types.ModuleType('ai.common.chat')
    config_module = types.ModuleType('ai.common.config')
    langchain_openai_module = types.ModuleType('langchain_openai')

    class ChatBase:
        def __init__(self, _provider, _conn_config, _bag):
            """Set the minimal attributes nemotron.Chat.__init__ reads from its base."""
            self._model = 'nvidia/nemotron-3-super-120b-a12b'
            self._modelOutputTokens = 32768

    class Config:
        @staticmethod
        def getNodeConfig(_logical_type, _conn_config):
            """Return the default cloud-profile config, with overrides applied."""
            config = {
                'apikey': 'nvapi-test-key',
                'model': 'nvidia/nemotron-3-super-120b-a12b',
                'serverbase': 'https://integrate.api.nvidia.com/v1',
            }
            if config_overrides:
                config.update(config_overrides)
            return config

    class ChatOpenAI:
        def __init__(self, **_kwargs):
            """Accept and ignore the client kwargs nemotron.Chat passes."""

    chat_module.ChatBase = ChatBase
    config_module.Config = Config
    langchain_openai_module.ChatOpenAI = ChatOpenAI
    ai_module.common = common_module
    common_module.chat = chat_module
    common_module.config = config_module

    monkeypatch.setitem(sys.modules, 'ai', ai_module)
    monkeypatch.setitem(sys.modules, 'ai.common', common_module)
    monkeypatch.setitem(sys.modules, 'ai.common.chat', chat_module)
    monkeypatch.setitem(sys.modules, 'ai.common.config', config_module)
    monkeypatch.setitem(sys.modules, 'langchain_openai', langchain_openai_module)

    return _load_node_module(monkeypatch, 'nemotron')


def test_cloud_profile_without_key_raises(monkeypatch):
    """A cloud serverbase with no apikey fails fast instead of sending a keyless request."""
    module = _load_nemotron(monkeypatch, config_overrides={'apikey': ''})
    with pytest.raises(ValueError, match='API key is required'):
        module.Chat('llm_nemotron', {}, {})


def test_cloud_profile_with_whitespace_key_raises(monkeypatch):
    """A whitespace-only apikey is treated as missing, not sent as credentials."""
    module = _load_nemotron(monkeypatch, config_overrides={'apikey': '   '})
    with pytest.raises(ValueError, match='API key is required'):
        module.Chat('llm_nemotron', {}, {})


def test_self_hosted_profile_without_key_is_allowed(monkeypatch):
    """A local NIM/vLLM serverbase builds fine with no apikey (dummy token)."""
    module = _load_nemotron(monkeypatch, config_overrides={'apikey': '', 'serverbase': 'http://localhost:8000/v1'})
    module.Chat('llm_nemotron', {}, {})


def test_cloud_profile_with_key_builds(monkeypatch):
    """The default cloud config with a key constructs without raising."""
    module = _load_nemotron(monkeypatch)
    module.Chat('llm_nemotron', {}, {})


def test_cloud_key_guard_decides_by_hostname_not_substring(monkeypatch):
    """A self-hosted URL that merely mentions api.nvidia.com in its query is not cloud: no key needed."""
    module = _load_nemotron(
        monkeypatch, config_overrides={'apikey': '', 'serverbase': 'http://localhost:8000/v1?upstream=api.nvidia.com'}
    )
    module.Chat('llm_nemotron', {}, {})


def test_other_nvidia_api_subdomains_still_require_a_key(monkeypatch):
    """ai.api.nvidia.com is NVIDIA's hosted API too, so an empty key must fail fast there."""
    module = _load_nemotron(monkeypatch, config_overrides={'apikey': '', 'serverbase': 'https://ai.api.nvidia.com/v1'})
    with pytest.raises(ValueError, match='NVIDIA API key is required'):
        module.Chat('llm_nemotron', {}, {})


@pytest.mark.parametrize(
    ('serverbase', 'expected'),
    [
        ('https://integrate.api.nvidia.com/v1', True),
        ('integrate.api.nvidia.com/v1', True),  # scheme-less still parses
        ('HTTPS://INTEGRATE.API.NVIDIA.COM/v1', True),
        ('https://api.nvidia.com', True),
        ('https://api.nvidia.com.example.com/v1', False),  # look-alike host
        ('http://localhost:8000/v1?upstream=api.nvidia.com', False),  # only the query mentions it
        ('http://localhost:8000/api.nvidia.com/v1', False),  # only the path mentions it
        ('', False),
        (None, False),
    ],
)
def test_is_nvidia_cloud_endpoint_parses_the_hostname(monkeypatch, serverbase, expected):
    """The shared predicate looks at the hostname only."""
    endpoint = _load_node_module(monkeypatch, 'endpoint')
    assert endpoint.is_nvidia_cloud_endpoint(serverbase) is expected
