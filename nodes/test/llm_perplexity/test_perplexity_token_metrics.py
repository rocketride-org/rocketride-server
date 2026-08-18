# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Token metering for the Perplexity driver.

``llm_perplexity`` overrides ``ChatBase.chat`` — the seam above ``_chat`` — and calls
``self._llm.invoke`` directly, so it reaches neither ``chat_string`` nor
``LangChainAdapter``, the capture point that meters every other provider. The usage
read lives in the override, and these tests pin it.

The node is built with ``__new__`` so the tests never touch the engine ``Config`` /
``ChatOpenAI`` plumbing: only the ``chat`` seam is under test.

Run with::

    pytest nodes/test/llm_perplexity/test_perplexity_token_metrics.py -v
"""

import importlib.util
import os
import sys
import types
from typing import Any, Optional

import pytest

from ai.web.metrics.metrics import metrics

_HERE = os.path.dirname(os.path.abspath(__file__))
_MOD_PATH = os.path.join(_HERE, '..', '..', 'src', 'nodes', 'llm_perplexity', 'perplexity.py')

_MODEL = 'sonar-pro'


def _load_node_module():
    """Load perplexity.py standalone, stubbing the langchain_openai client."""
    saved = sys.modules.get('langchain_openai')
    stub = types.ModuleType('langchain_openai')
    stub.ChatOpenAI = type('ChatOpenAI', (), {'__init__': lambda self, **kw: None})
    sys.modules['langchain_openai'] = stub
    try:
        spec = importlib.util.spec_from_file_location('_llm_perplexity_node', _MOD_PATH)
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


@pytest.fixture(autouse=True)
def _no_backoff_sleep(monkeypatch):
    """The retry path sleeps seconds between attempts; the metering is what is under test."""
    monkeypatch.setattr(_node.time, 'sleep', lambda _s: None)


def _counters():
    return metrics.report()['counters']


class _Result:
    def __init__(self, content: str, usage: Optional[dict]) -> None:
        self.content = content
        self.usage_metadata = usage


class _FakeQuestion:
    expectJson = False

    def getPrompt(self) -> str:
        return 'q'


def _make_chat(usage: Optional[dict], *, fail_times: int = 0) -> Any:
    """A Chat whose ChatOpenAI answers after ``fail_times`` transient failures."""

    class _LLM:
        model = _MODEL

        def __init__(self) -> None:
            self.calls = 0

        def invoke(self, prompt):
            self.calls += 1
            if self.calls <= fail_times:
                # _shouldRetry matches on the message, not the type.
                raise TimeoutError('connection timed out')
            return _Result('answer', usage)

    chat = _node.Chat.__new__(_node.Chat)
    chat._llm = _LLM()
    chat._model = _MODEL
    chat._modelTotalTokens = 100000
    return chat


def test_chat_reports_the_usage_the_adapter_would_have():
    chat = _make_chat({'input_tokens': 240, 'output_tokens': 60})

    answer = chat.chat(_FakeQuestion())

    assert answer.getText() == 'answer'
    c = _counters()
    assert c['llm_input_tokens'] == 240
    assert c['llm_output_tokens'] == 60


def test_cached_input_is_split_off_the_fresh_input():
    """Same split the shared helper applies everywhere: the four counters stay disjoint."""
    usage = {'input_tokens': 500, 'output_tokens': 20, 'input_token_details': {'cache_read': 400}}
    chat = _make_chat(usage)

    chat.chat(_FakeQuestion())

    c = _counters()
    assert c['llm_input_tokens'] == 100
    assert c['llm_cache_read_tokens'] == 400


def test_only_the_attempt_that_answered_is_metered():
    """A retried turn must not bill the attempts that raised before returning usage."""
    chat = _make_chat({'input_tokens': 10, 'output_tokens': 5}, fail_times=1)

    chat.chat(_FakeQuestion())

    assert chat._llm.calls == 2
    assert _counters()['llm_input_tokens'] == 10


def test_no_usage_metadata_is_a_no_op():
    chat = _make_chat(None)

    assert chat.chat(_FakeQuestion()).getText() == 'answer'
    assert _counters() == {}


def test_a_turn_that_never_answers_meters_nothing():
    chat = _make_chat({'input_tokens': 10, 'output_tokens': 5}, fail_times=99)

    with pytest.raises(Exception):
        chat.chat(_FakeQuestion())

    assert _counters() == {}
