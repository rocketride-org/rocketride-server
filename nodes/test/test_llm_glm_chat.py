"""Unit tests for llm_glm's Chat construction — the cloud-key guard.

Loads nodes/src/nodes/llm_glm/glm.py with stubbed heavy imports
(ai.common, langchain_openai), same approach as
test_baidu_qianfan_global_validation.py, and verifies the fail-fast
cloud-key guard in Chat.__init__: a Z.ai/Zhipu cloud serverbase requires a
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


def _load_glm(monkeypatch, config_overrides: dict | None = None):
    """Load glm.py from source with stubbed dependencies.

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
            """Set the minimal attributes glm.Chat.__init__ reads from its base."""
            self._model = 'glm-5.2'
            self._modelOutputTokens = 32768

    class Config:
        @staticmethod
        def getNodeConfig(_logical_type, _conn_config):
            """Return the default cloud-profile config, with overrides applied."""
            config = {
                'apikey': 'test-glm-key',
                'model': 'glm-5.2',
                'serverbase': 'https://api.z.ai/api/paas/v4',
            }
            if config_overrides:
                config.update(config_overrides)
            return config

    class ChatOpenAI:
        def __init__(self, **_kwargs):
            """Accept and ignore the client kwargs glm.Chat passes."""

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

    module_path = Path(__file__).parent.parent / 'src' / 'nodes' / 'llm_glm' / 'glm.py'
    spec = importlib.util.spec_from_file_location('glm_under_test', module_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_cloud_profile_without_key_raises(monkeypatch):
    """A cloud serverbase with no apikey fails fast instead of sending a keyless request."""
    module = _load_glm(monkeypatch, config_overrides={'apikey': ''})
    with pytest.raises(ValueError, match='API key is required'):
        module.Chat('llm_glm', {}, {})


def test_cloud_profile_with_whitespace_key_raises(monkeypatch):
    """A whitespace-only apikey is treated as missing, not sent as credentials."""
    module = _load_glm(monkeypatch, config_overrides={'apikey': '   '})
    with pytest.raises(ValueError, match='API key is required'):
        module.Chat('llm_glm', {}, {})


def test_self_hosted_profile_without_key_is_allowed(monkeypatch):
    """A local vLLM/SGLang serverbase builds fine with no apikey (dummy token)."""
    module = _load_glm(monkeypatch, config_overrides={'apikey': '', 'serverbase': 'http://localhost:8000/v1'})
    module.Chat('llm_glm', {}, {})


def test_cloud_profile_with_key_builds(monkeypatch):
    """The default cloud config with a key constructs without raising."""
    module = _load_glm(monkeypatch)
    module.Chat('llm_glm', {}, {})
