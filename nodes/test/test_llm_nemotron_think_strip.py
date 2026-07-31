"""Unit tests for llm_nemotron's <think>-block stripping.

Loads nodes/src/nodes/llm_nemotron/nemotron.py with stubbed heavy imports
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


def _load_nemotron(monkeypatch, response_content: str):
    """Load nemotron.py from source with stubbed dependencies.

    Installs fake ai.common.chat / ai.common.config / langchain_openai
    modules in sys.modules, with the stubbed LLM's invoke() returning
    ``response_content``, then imports the node module for testing.
    """
    ai_module = types.ModuleType('ai')
    common_module = types.ModuleType('ai.common')
    chat_module = types.ModuleType('ai.common.chat')
    config_module = types.ModuleType('ai.common.config')
    langchain_openai_module = types.ModuleType('langchain_openai')

    class ChatBase:
        def __init__(self, _provider, _conn_config, _bag):
            self._model = 'nvidia/nemotron-3-super-120b-a12b'
            self._modelOutputTokens = 32768

    class Config:
        @staticmethod
        def getNodeConfig(_logical_type, _conn_config):
            return {
                'apikey': 'nvapi-test-key',
                'model': 'nvidia/nemotron-3-super-120b-a12b',
                'serverbase': 'https://integrate.api.nvidia.com/v1',
            }

    class ChatOpenAI:
        def __init__(self, **_kwargs):
            pass

        def invoke(self, _prompt):
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

    module_path = Path(__file__).parent.parent / 'src' / 'nodes' / 'llm_nemotron' / 'nemotron.py'
    spec = importlib.util.spec_from_file_location('nemotron_under_test', module_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _chat(monkeypatch, response_content: str) -> str:
    module = _load_nemotron(monkeypatch, response_content)
    chat = module.Chat('llm_nemotron', {}, {})
    return chat._chat('test prompt')


def test_terminated_think_block_is_stripped(monkeypatch):
    answer = _chat(monkeypatch, '<think>step 1... step 2...</think>The answer is 4.')
    assert answer == 'The answer is 4.'


def test_unterminated_think_block_is_stripped(monkeypatch):
    # Generation truncated at max_tokens mid-reasoning: no closing tag. The
    # partial reasoning must not leak downstream as the answer.
    answer = _chat(monkeypatch, '<think>step 1... step 2... and then we')
    assert answer == ''


def test_plain_answer_passes_through(monkeypatch):
    answer = _chat(monkeypatch, 'The answer is 4.')
    assert answer == 'The answer is 4.'


def test_multiple_think_blocks_are_stripped(monkeypatch):
    answer = _chat(monkeypatch, '<think>a</think>First. <think>b</think>Second.')
    assert answer == 'First. Second.'
