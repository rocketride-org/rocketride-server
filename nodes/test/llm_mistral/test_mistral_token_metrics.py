# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Token metering for the Mistral driver.

``llm_mistral`` overrides ``ChatBase.chat`` — the seam above ``_chat`` — and calls the
Mistral SDK directly, so it reaches neither ``chat_string`` nor ``LangChainAdapter``,
the capture point that meters every other provider. The usage read lives in the
override, and these tests pin it.

The node is built with ``__new__`` so the tests never touch the engine ``Config`` /
Mistral SDK plumbing: only the ``chat`` seam is under test.

Run with::

    pytest nodes/test/llm_mistral/test_mistral_token_metrics.py -v
"""

import importlib.util
import os
import sys
import types
from typing import Any, Optional

import pytest

from ai.web.metrics.metrics import metrics

_HERE = os.path.dirname(os.path.abspath(__file__))
_MOD_PATH = os.path.join(_HERE, '..', '..', 'src', 'nodes', 'llm_mistral', 'mistral.py')

_MODEL = 'mistral-large-latest'


def _load_node_module():
    """Load mistral.py standalone, stubbing the Mistral SDK (both import layouts)."""
    names = ['mistralai', 'mistralai.client']
    saved = {name: sys.modules.get(name) for name in names}
    client_mod = types.ModuleType('mistralai.client')
    client_mod.Mistral = type('Mistral', (), {'__init__': lambda self, **kw: None})
    pkg = types.ModuleType('mistralai')
    pkg.Mistral = client_mod.Mistral
    pkg.client = client_mod
    sys.modules['mistralai'] = pkg
    sys.modules['mistralai.client'] = client_mod
    try:
        spec = importlib.util.spec_from_file_location('_llm_mistral_node', _MOD_PATH)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    finally:
        for name in names:
            if saved[name] is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = saved[name]


_node = _load_node_module()


def setup_function(_):
    metrics.reset()


@pytest.fixture(autouse=True)
def _no_backoff_sleep(monkeypatch):
    """The retry path sleeps seconds between attempts; the metering is what is under test."""
    monkeypatch.setattr(_node.time, 'sleep', lambda _s: None)


def _counters():
    return metrics.report()['counters']


class _Usage:
    """``UsageInfo`` — every field is Optional in the SDK."""

    def __init__(self, prompt: Optional[int] = 0, completion: Optional[int] = 0) -> None:
        self.prompt_tokens = prompt
        self.completion_tokens = completion
        # The node never reads this; kept only so the double matches the SDK's shape.
        self.total_tokens = None


class _Response:
    def __init__(self, usage: Any, content: str = 'answer') -> None:
        self.usage = usage
        self.choices = [type('_C', (), {'message': type('_M', (), {'content': content})()})()]


class _FakeQuestion:
    expectJson = False

    def getPrompt(self) -> str:
        return 'q'


def _make_chat(response: _Response, *, fail_times: int = 0) -> Any:
    """A Chat whose SDK answers after ``fail_times`` transient failures."""

    class _Completions:
        def __init__(self) -> None:
            self.calls = 0

        def complete(self, **kwargs):
            self.calls += 1
            if self.calls <= fail_times:
                # _shouldRetry matches on the message, not the type.
                raise RuntimeError('connection timed out')
            return response

    completions = _Completions()
    chat = _node.Chat.__new__(_node.Chat)
    chat._client = type('_Client', (), {'chat': completions})()
    chat._model = _MODEL
    chat._modelTotalTokens = 100000
    chat._completions = completions
    return chat


def test_chat_reports_input_and_output():
    chat = _make_chat(_Response(_Usage(prompt=310, completion=90)))

    answer = chat.chat(_FakeQuestion())

    assert answer.getText() == 'answer'
    c = _counters()
    assert c['llm_input_tokens'] == 310
    assert c['llm_output_tokens'] == 90
    # The SDK's UsageInfo carries no cache detail, so those counters stay absent.
    assert 'llm_cache_read_tokens' not in c
    assert 'llm_cache_creation_tokens' not in c


def test_only_the_attempt_that_answered_is_metered():
    """A retried turn must not bill the attempts that raised before returning usage."""
    chat = _make_chat(_Response(_Usage(prompt=12, completion=3)), fail_times=1)

    chat.chat(_FakeQuestion())

    assert chat._completions.calls == 2
    assert _counters()['llm_input_tokens'] == 12


def test_no_usage_on_the_response_is_a_no_op():
    chat = _make_chat(_Response(usage=None))

    assert chat.chat(_FakeQuestion()).getText() == 'answer'
    assert _counters() == {}


def test_none_counts_read_as_zero():
    """Both fields are Optional in the SDK; a None must not raise mid-turn."""
    chat = _make_chat(_Response(_Usage(prompt=None, completion=None)))

    assert chat.chat(_FakeQuestion()).getText() == 'answer'
    assert _counters() == {}


def test_a_turn_that_never_answers_meters_nothing():
    chat = _make_chat(_Response(_Usage(prompt=12, completion=3)), fail_times=99)

    with pytest.raises(Exception):
        chat.chat(_FakeQuestion())

    assert _counters() == {}


def test_a_corrupt_usage_count_never_costs_the_answer():
    """The retry loop reads any raise as a provider error: a metering failure would
    turn a paid, successful response into 'Mistral API error' for the user.
    """
    chat = _make_chat(_Response(_Usage(prompt='n/a', completion=5)))

    assert chat.chat(_FakeQuestion()).getText() == 'answer'
    assert _counters() == {}
