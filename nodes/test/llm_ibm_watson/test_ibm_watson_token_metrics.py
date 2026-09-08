# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Token metering for the IBM Watson driver.

``llm_ibm_watson`` overrides ``ChatBase._chat`` to call ``ModelInference.chat``
directly, so it never reaches ``LangChainAdapter`` — the capture point that meters
every other provider. The usage read lives in the override, and these tests pin it.

The node is built with ``__new__`` so the tests never touch the engine ``Config`` /
IBM SDK plumbing: only the ``_chat`` seam is under test.

Run with::

    pytest nodes/test/llm_ibm_watson/test_ibm_watson_token_metrics.py -v
"""

import importlib.util
import os
import sys
import types
from typing import Any, Dict, Optional

import pytest

from ai.web.metrics.metrics import metrics

_HERE = os.path.dirname(os.path.abspath(__file__))
_MOD_PATH = os.path.join(_HERE, '..', '..', 'src', 'nodes', 'llm_ibm_watson', 'ibm_watson.py')

_MODEL = 'ibm/granite-13b-chat-v2'


def _load_node_module():
    """Load ibm_watson.py standalone, stubbing the IBM SDK."""
    stub_names = [
        'ibm_watsonx_ai',
        'ibm_watsonx_ai.foundation_models',
        'ibm_watsonx_ai.foundation_models.schema',
    ]
    saved = {name: sys.modules.get(name) for name in stub_names}
    for name in stub_names:
        stub = types.ModuleType(name)
        if name == 'ibm_watsonx_ai':
            stub.Credentials = type('Credentials', (), {})
        if name == 'ibm_watsonx_ai.foundation_models':
            stub.ModelInference = type('ModelInference', (), {})
        if name == 'ibm_watsonx_ai.foundation_models.schema':
            stub.TextChatParameters = type('TextChatParameters', (), {})
        sys.modules[name] = stub
    try:
        spec = importlib.util.spec_from_file_location('_llm_ibm_watson_node', _MOD_PATH)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    finally:
        for name in stub_names:
            if saved[name] is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = saved[name]


_node = _load_node_module()


def setup_function(_):
    metrics.reset()


def _counters():
    return metrics.report()['counters']


def _response(usage: Optional[Dict[str, Any]], content: str = 'hi') -> Dict[str, Any]:
    """The OpenAI-compatible shape watsonx answers with."""
    out: Dict[str, Any] = {'choices': [{'message': {'content': content}}]}
    if usage is not None:
        out['usage'] = usage
    return out


def _make_chat(response: Dict[str, Any]):
    """A Chat whose ModelInference returns the given response, with no __init__ plumbing."""

    class _Inference:
        def chat(self, messages):
            return response

    chat = _node.Chat.__new__(_node.Chat)
    chat._llm = _Inference()
    chat._model = _MODEL
    return chat


def test_chat_reports_input_and_output():
    chat = _make_chat(_response({'prompt_tokens': 120, 'completion_tokens': 45, 'total_tokens': 165}))

    assert chat._chat('q') == 'hi'

    c = _counters()
    assert c['llm_input_tokens'] == 120
    assert c['llm_output_tokens'] == 45
    # watsonx reports no cache detail, so those counters stay absent rather than zeroed.
    assert 'llm_cache_read_tokens' not in c
    assert 'llm_cache_creation_tokens' not in c


def test_an_empty_answer_is_still_metered():
    """The prompt was burnt even though the completion came back empty.

    The report has to run before the empty-answer guard, or the one turn a user
    complains about is also the one turn that bills nothing.
    """
    chat = _make_chat(_response({'prompt_tokens': 300, 'completion_tokens': 0}, content=''))

    with pytest.raises(ValueError, match='Response is empty'):
        chat._chat('q')

    assert _counters()['llm_input_tokens'] == 300


def test_no_usage_key_is_a_no_op():
    chat = _make_chat(_response(usage=None))

    assert chat._chat('q') == 'hi'
    assert _counters() == {}


def test_a_corrupt_usage_count_never_costs_the_answer():
    """Metering is best-effort: the caller is a retry loop that would read a raise
    as a provider error, losing a response the user already paid for.
    """
    chat = _make_chat(_response({'prompt_tokens': 'n/a', 'completion_tokens': 5}))

    assert chat._chat('q') == 'hi'
    assert _counters() == {}
