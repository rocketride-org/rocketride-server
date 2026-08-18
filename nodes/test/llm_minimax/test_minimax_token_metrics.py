# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Token metering for the MiniMax driver.

``llm_minimax`` overrides ``ChatBase._chat`` to strip ``<think>`` blocks, and that
override bypasses ``LangChainAdapter.collect()`` — the capture point that meters every
other non-streaming call. Streaming stayed metered (its ``_llm`` is a ``ChatOpenAI``),
but every ``expectJson`` and every agent ``ask`` without an ``on_chunk`` billed zero.
The override now reports for itself, and these tests pin that plus the stripping it
already did.

Run with::

    pytest nodes/test/llm_minimax/test_minimax_token_metrics.py -v
"""

import importlib.util
import os
import sys
import types
from typing import Any, Optional

from ai.web.metrics.metrics import metrics

_HERE = os.path.dirname(os.path.abspath(__file__))
_MOD_PATH = os.path.join(_HERE, '..', '..', 'src', 'nodes', 'llm_minimax', 'minimax.py')

_MODEL = 'MiniMax-M2'


def _load_node_module():
    """Load minimax.py standalone, stubbing the langchain_openai client."""
    saved = sys.modules.get('langchain_openai')
    stub = types.ModuleType('langchain_openai')
    stub.ChatOpenAI = type('ChatOpenAI', (), {'__init__': lambda self, **kw: None})
    sys.modules['langchain_openai'] = stub
    try:
        spec = importlib.util.spec_from_file_location('_llm_minimax_node', _MOD_PATH)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    finally:
        if saved is None:
            sys.modules.pop('langchain_openai', None)
        else:
            sys.modules['langchain_openai'] = saved


_node = _load_node_module()


def setup_function(_):
    metrics.reset()


def _counters():
    return metrics.report()['counters']


class _Result:
    def __init__(self, content: str, usage: Optional[dict]) -> None:
        self.content = content
        self.usage_metadata = usage


def _make_chat(content: str, usage: Optional[dict]) -> Any:
    """A Chat whose ChatOpenAI returns the given message, with no __init__ plumbing."""

    class _LLM:
        model = _MODEL

        def invoke(self, prompt):
            return _Result(content, usage)

    chat = _node.Chat.__new__(_node.Chat)
    chat._llm = _LLM()
    return chat


def test_chat_reports_the_usage_the_adapter_would_have():
    chat = _make_chat('answer', {'input_tokens': 90, 'output_tokens': 25})

    assert chat._chat('q') == 'answer'

    c = _counters()
    assert c['llm_input_tokens'] == 90
    assert c['llm_output_tokens'] == 25


def test_cached_input_is_split_off_the_fresh_input():
    """Same split the shared helper applies everywhere: the four counters stay disjoint."""
    usage = {'input_tokens': 1000, 'output_tokens': 10, 'input_token_details': {'cache_read': 700}}
    chat = _make_chat('answer', usage)

    chat._chat('q')

    c = _counters()
    assert c['llm_input_tokens'] == 300
    assert c['llm_cache_read_tokens'] == 700


def test_a_think_block_is_still_stripped_and_the_call_still_meters():
    """Metering must not disturb what the override exists to do."""
    chat = _make_chat('<think>weighing it up</think>the answer', {'input_tokens': 5, 'output_tokens': 2})

    assert chat._chat('q') == 'the answer'
    assert _counters()['llm_input_tokens'] == 5


def test_no_usage_metadata_is_a_no_op():
    chat = _make_chat('answer', None)

    assert chat._chat('q') == 'answer'
    assert _counters() == {}
