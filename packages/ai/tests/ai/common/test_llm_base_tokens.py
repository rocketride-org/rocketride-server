# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Tests for the two ``answer.tokens`` seams on ``LLMBase``: writeQuestions and ask.

This is the plain LLM-node lane — every ``llm_*`` node emits its answer through
``writeQuestions``, and ``ask`` is the per-invoke seam the Trace "Tokens" row rests on.
The agent lane's equivalent is covered in ``agent/test_agent_base.py``.

The driver is built with ``__new__`` so the tests never touch the engine
``iGlobal`` / ``Config`` plumbing; ``_question`` is replaced by a fake that reports
usage exactly where the Adapter seam does.

Run with::

    pytest packages/ai/tests/ai/common/test_llm_base_tokens.py -v
"""

from __future__ import annotations

from typing import Any, Callable, List

from rocketride import Answer

import ai.common.llm_adapter as _adapter
from ai.common.llm_adapter import report_llm_tokens
from ai.common.llm_base import LLMBase
from ai.web.metrics.metrics import metrics


def setup_function(_):
    metrics.reset()
    # No turn is open between tests; reset the per-turn collector so a leaked scope
    # from one test cannot seed the next.
    _adapter._TURN_CALLS.set(None)


# ---------------------------------------------------------------------------
# Test doubles
# ---------------------------------------------------------------------------


class _FakeInner:
    """Stands in for ``iInstance.instance``."""

    def __init__(self) -> None:
        self.written: List[Any] = []

    def writeAnswers(self, answer: Any) -> None:
        self.written.append(answer)

    def sendSSE(self, *args: Any, **kwargs: Any) -> None:
        pass


class _FakeQuestion:
    def __init__(self, text: str = 'q') -> None:
        self.question = text


def _make_node(question_impl: Callable[..., Answer]) -> LLMBase:
    """Build an LLMBase whose ``_question`` is the given fake (no engine plumbing)."""

    class _StubNode(LLMBase):
        def _question(self, question, **kwargs):
            return question_impl(question, **kwargs)

    node = _StubNode.__new__(_StubNode)
    node.instance = _FakeInner()
    return node


def _answer(text: str = 'ok') -> Answer:
    a = Answer()
    a.setAnswer(text)
    return a


def _two_calls(_question, **_kwargs) -> Answer:
    """A turn that reaches the model twice, as report_llm_tokens does at the Adapter seam."""
    report_llm_tokens(10, 4, model='m1')
    report_llm_tokens(20, 8, model='m2')
    return _answer('It is sunny in NYC.')


def _no_call(_question, **_kwargs) -> Answer:
    """A cached/short-circuited turn: an answer with no model call behind it."""
    return _answer('cached')


# ---------------------------------------------------------------------------
# writeQuestions — the answers lane every plain llm_* node emits through
# ---------------------------------------------------------------------------


def test_write_questions_answer_carries_the_turn_token_usage():
    node = _make_node(_two_calls)

    node.writeQuestions(_FakeQuestion())

    tokens = node.instance.written[0].tokens
    assert tokens['calls'] == 2
    assert tokens['input'] == 30 and tokens['output'] == 12
    assert len(tokens['breakdown']) == 2


def test_write_questions_has_no_tokens_when_no_model_was_called():
    """No call must render no grid at all, not an empty one."""
    node = _make_node(_no_call)

    node.writeQuestions(_FakeQuestion())

    assert node.instance.written[0].tokens is None


# ---------------------------------------------------------------------------
# ask — the per-invoke seam an agent drives
# ---------------------------------------------------------------------------


def test_ask_answer_carries_its_own_call():
    node = _make_node(lambda _q, **_kw: (report_llm_tokens(7, 3, model='m1'), _answer())[1])

    answer = node.ask(_FakeQuestion())

    # One call renders as plain totals — no redundant breakdown of itself.
    assert answer.tokens == {'input': 7, 'output': 3, 'cache_read': 0, 'cache_creation': 0, 'model': 'm1'}


def test_a_second_ask_does_not_inherit_the_first_ones_tokens():
    """The bug class this PR was redesigned twice to fix, pinned at the ask seam.

    Each invoke opens its own scope, so invoke 2 shows its own cost — not the running
    total of everything the instance has asked for.
    """
    calls = iter([(7, 3, 'm1'), (100, 40, 'm2')])

    def _one_call(_q, **_kw) -> Answer:
        i, o, m = next(calls)
        report_llm_tokens(i, o, model=m)
        return _answer()

    node = _make_node(_one_call)

    first = node.ask(_FakeQuestion())
    second = node.ask(_FakeQuestion())

    assert first.tokens['input'] == 7
    # Not 107 input / 2 calls: the second invoke reads only its own scope.
    assert second.tokens == {'input': 100, 'output': 40, 'cache_read': 0, 'cache_creation': 0, 'model': 'm2'}
