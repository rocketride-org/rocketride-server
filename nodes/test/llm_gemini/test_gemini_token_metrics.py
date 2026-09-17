# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Token metering for the Gemini driver.

``llm_gemini`` overrides ``ChatBase._chat`` and sets ``_client`` instead of ``_llm``,
so the streaming gate in ``chat.py`` is never true and no call — streaming or not —
reaches ``LangChainAdapter``, the capture point that meters every other provider.
The usage read therefore lives in the override, and these tests pin it.

The node is built with ``__new__`` so the tests never touch the engine ``Config`` /
``genai.Client`` plumbing: only the ``_chat`` seam is under test.

Run with::

    pytest nodes/test/llm_gemini/test_gemini_token_metrics.py -v
"""

import importlib.util
import os
import sys
import types
from typing import Any, Optional

import pytest

from ai.web.metrics.metrics import metrics

_HERE = os.path.dirname(os.path.abspath(__file__))
_MOD_PATH = os.path.join(_HERE, '..', '..', 'src', 'nodes', 'llm_gemini', 'gemini.py')

_MODEL = 'gemini-3-pro'


def _load_node_module():
    """Load gemini.py standalone, stubbing the google-genai client."""
    saved = sys.modules.get('google.genai')
    saved_pkg = sys.modules.get('google')
    stub = types.ModuleType('google.genai')
    stub.Client = type('Client', (), {'__init__': lambda self, **kw: None})
    pkg = types.ModuleType('google')
    pkg.genai = stub
    sys.modules['google'] = pkg
    sys.modules['google.genai'] = stub
    try:
        spec = importlib.util.spec_from_file_location('_llm_gemini_node', _MOD_PATH)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    finally:
        for name, saved_mod in (('google', saved_pkg), ('google.genai', saved)):
            if saved_mod is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = saved_mod


_node = _load_node_module()


def setup_function(_):
    metrics.reset()


def _counters():
    return metrics.report()['counters']


class _Usage:
    """The fields ``GenerateContentResponseUsageMetadata`` carries, all optional."""

    def __init__(
        self,
        prompt: Optional[int] = None,
        candidates: Optional[int] = None,
        cached: Optional[int] = None,
        thoughts: Optional[int] = None,
    ) -> None:
        self.prompt_token_count = prompt
        self.candidates_token_count = candidates
        self.cached_content_token_count = cached
        self.thoughts_token_count = thoughts


class _Candidate:
    """The one field of a candidate this node reads when there is no text."""

    def __init__(self, finish_reason: Any = None) -> None:
        self.finish_reason = finish_reason


class _Feedback:
    def __init__(self, block_reason: Any = None) -> None:
        self.block_reason = block_reason


class _Response:
    def __init__(
        self,
        usage: Any = None,
        text: Optional[str] = 'hi',
        candidates: Any = None,
        prompt_feedback: Any = None,
    ) -> None:
        self.usage_metadata = usage
        self.text = text
        self.candidates = candidates
        self.prompt_feedback = prompt_feedback


def _make_chat(response: _Response):
    """A Chat whose client returns the given response, with no __init__ plumbing."""

    class _Models:
        def generate_content(self, model: str, contents: str) -> _Response:
            return response

    chat = _node.Chat.__new__(_node.Chat)
    chat._client = type('_Client', (), {'models': _Models()})()
    chat._model = _MODEL
    return chat


def test_chat_reports_the_four_counters():
    chat = _make_chat(_Response(_Usage(prompt=1000, candidates=40, cached=800)))

    assert chat._chat('q') == 'hi'

    c = _counters()
    # prompt_token_count includes the cached prefix, so fresh input is 1000 - 800.
    assert c['llm_input_tokens'] == 200
    assert c['llm_output_tokens'] == 40
    assert c['llm_cache_read_tokens'] == 800
    # Gemini bills cache creation through a separate caches.create call, not this response.
    assert 'llm_cache_creation_tokens' not in c


def test_thoughts_are_billed_as_output():
    """Reasoning tokens ride the output counter — Google bills them at the output rate."""
    chat = _make_chat(_Response(_Usage(prompt=30, candidates=12, thoughts=500)))

    chat._chat('q')

    assert _counters()['llm_output_tokens'] == 512
    assert _counters()['llm_input_tokens'] == 30


def test_no_usage_on_the_response_is_a_no_op():
    chat = _make_chat(_Response(usage=None))

    assert chat._chat('q') == 'hi'
    assert _counters() == {}


@pytest.mark.parametrize('field', ['prompt_token_count', 'candidates_token_count'])
def test_a_missing_count_does_not_break_the_turn(field):
    """Every field on the SDK type is Optional; a None must read as zero, not raise."""
    usage = _Usage(prompt=50, candidates=10)
    setattr(usage, field, None)
    chat = _make_chat(_Response(usage))

    assert chat._chat('q') == 'hi'


def test_a_cache_larger_than_the_prompt_never_reports_negative_input():
    chat = _make_chat(_Response(_Usage(prompt=100, candidates=5, cached=140)))

    chat._chat('q')

    # Clamped at zero: a negative count would corrupt the billing rollup.
    assert 'llm_input_tokens' not in _counters()
    assert _counters()['llm_cache_read_tokens'] == 140


def test_a_corrupt_usage_count_never_costs_the_answer():
    """Metering is best-effort: the caller is a retry loop that would read a raise
    as a provider error, losing a response the user already paid for.
    """
    chat = _make_chat(_Response(_Usage(prompt='n/a', candidates=5)))

    assert chat._chat('q') == 'hi'
    assert _counters() == {}


# ---------------------------------------------------------------------------
# A response that carried no text
# ---------------------------------------------------------------------------


def test_a_text_free_response_raises_with_the_reason_named():
    """
    `.text` is None — not '' — when the candidate carried no text parts:
    safety-blocked, the budget spent mid-thought, or non-text parts only.
    Returned as-is the None surfaces downstream as a token-counting crash that
    says nothing about why. The node names the API's own reasons instead.
    """
    chat = _make_chat(
        _Response(
            _Usage(prompt=30, candidates=0),
            text=None,
            candidates=[_Candidate(finish_reason='SAFETY')],
            prompt_feedback=_Feedback(block_reason='SAFETY'),
        )
    )

    with pytest.raises(Exception) as caught:
        chat._chat('q')

    assert 'no text' in str(caught.value)
    assert 'finish_reason=SAFETY' in str(caught.value)
    assert 'block_reason=SAFETY' in str(caught.value)


def test_a_text_free_response_is_still_billed():
    """
    THE REASON THE USAGE REPORT COMES FIRST. A blocked response still burned
    tokens, and a safety block is exactly the run somebody will be asking about
    when they look at the bill. Raising before the report would lose it.
    """
    chat = _make_chat(_Response(_Usage(prompt=30, candidates=0, thoughts=500), text=None))

    with pytest.raises(Exception):
        chat._chat('q')

    assert _counters()['llm_input_tokens'] == 30
    assert _counters()['llm_output_tokens'] == 500


def test_a_text_free_response_is_asked_once_not_retried():
    """
    A SAFETY BLOCK IS AN ANSWER, NOT AN OUTAGE.

    ChatBase retries anything it does not recognise, so a refusal would be
    re-sent — and re-billed — for the same verdict. The retry loop must see it
    as terminal and stop after the first call.
    """
    calls = []
    blocked = _Response(_Usage(prompt=30, candidates=0), text=None, candidates=[_Candidate(finish_reason='SAFETY')])

    class _Models:
        def generate_content(self, model: str, contents: str) -> _Response:
            calls.append(contents)
            return blocked

    chat = _make_chat(blocked)
    chat._client = type('_Client', (), {'models': _Models()})()

    with pytest.raises(_node.GeminiNoTextError):
        chat._chat_with_retries('q')

    assert len(calls) == 1
    assert chat.is_retryable_error(_node.GeminiNoTextError('x')) is False
    # Everything else still goes through ChatBase's classification.
    assert chat.is_retryable_error(TimeoutError('timed out')) is True


def test_no_candidates_at_all_still_says_something():
    """The reason is unavailable, so the message says that rather than nothing."""
    chat = _make_chat(_Response(_Usage(prompt=5, candidates=0), text=None, candidates=[]))

    with pytest.raises(Exception) as caught:
        chat._chat('q')

    assert 'no candidates' in str(caught.value)


def test_an_empty_string_answer_is_an_answer_not_a_failure():
    """
    Only None means "no text parts". An empty string is a model that chose to
    say nothing, and counting it is not the same as failing the turn.
    """
    chat = _make_chat(_Response(_Usage(prompt=5, candidates=0), text=''))

    assert chat._chat('q') == ''


def test_getTokens_counts_nothing_as_zero():
    """
    Token accounting must not be the place that discovers a text-free response:
    `len(None.split())` is an AttributeError several frames from the cause.
    """
    chat = _make_chat(_Response())

    assert chat.getTokens('') == 0
    assert chat.getTokens(None) == 0
