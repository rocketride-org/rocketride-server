"""Unit tests for llm_glm's <think>-block stripping.

Loads nodes/src/nodes/llm_glm/glm.py with stubbed heavy imports
(ai.common, langchain_openai), same approach as
test_baidu_qianfan_global_validation.py, and verifies that reasoning content
never leaks downstream — including when generation is truncated at max_tokens
before the closing </think> tag is emitted.
"""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

import pytest


def _load_glm(monkeypatch, response_content: str, config_overrides: dict | None = None):
    """Load glm.py from source with stubbed dependencies.

    Installs fake ai.common.chat / ai.common.config / langchain_openai
    modules in sys.modules, with the stubbed LLM's invoke() returning
    ``response_content``, then imports the node module for testing.
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

        def _chat(self, prompt: str) -> str:
            """Mirror ai.common.chat.ChatBase._chat: invoke the LLM, return its content."""
            return self._llm.invoke(prompt).content

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

        def invoke(self, _prompt):
            """Return a canned LLM message whose content is ``response_content``."""
            return types.SimpleNamespace(content=response_content)

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


def _chat(monkeypatch, response_content: str) -> str:
    """Build a stubbed glm.Chat whose LLM returns ``response_content`` and invoke it once.

    Returns the node's post-processed (think-stripped) answer string, having
    exercised the full ``Chat._chat -> super()._chat -> llm.invoke`` delegation path.
    """
    module = _load_glm(monkeypatch, response_content)
    chat = module.Chat('llm_glm', {}, {})
    return chat._chat('test prompt')


def test_terminated_think_block_is_stripped(monkeypatch):
    """A well-formed <think>...</think> block is removed, leaving only the answer."""
    answer = _chat(monkeypatch, '<think>step 1... step 2...</think>The answer is 4.')
    assert answer == 'The answer is 4.'


def test_unterminated_think_block_is_stripped(monkeypatch):
    """A think block truncated at max_tokens (no closing tag) must not leak as the answer."""
    answer = _chat(monkeypatch, '<think>step 1... step 2... and then we')
    assert answer == ''


def test_plain_answer_passes_through(monkeypatch):
    """A response with no think block is returned unchanged."""
    answer = _chat(monkeypatch, 'The answer is 4.')
    assert answer == 'The answer is 4.'


def test_multiple_think_blocks_are_stripped(monkeypatch):
    """Every think block is removed when several appear in one response."""
    answer = _chat(monkeypatch, '<think>a</think>First. <think>b</think>Second.')
    assert answer == 'First. Second.'


def test_cloud_profile_without_key_raises(monkeypatch):
    """A cloud serverbase with no apikey fails fast instead of sending a keyless request."""
    module = _load_glm(monkeypatch, '', config_overrides={'apikey': ''})
    with pytest.raises(ValueError, match='API key is required'):
        module.Chat('llm_glm', {}, {})


def test_self_hosted_profile_without_key_is_allowed(monkeypatch):
    """A local vLLM/SGLang serverbase builds fine with no apikey (dummy token)."""
    module = _load_glm(monkeypatch, '', config_overrides={'apikey': '', 'serverbase': 'http://localhost:8000/v1'})
    module.Chat('llm_glm', {}, {})


def test_cloud_profile_with_whitespace_key_raises(monkeypatch):
    """A whitespace-only apikey is treated as missing, not sent as credentials."""
    module = _load_glm(monkeypatch, '', config_overrides={'apikey': '   '})
    with pytest.raises(ValueError, match='API key is required'):
        module.Chat('llm_glm', {}, {})
