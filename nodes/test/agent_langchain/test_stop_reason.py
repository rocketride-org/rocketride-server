# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""A LangChain run reports `done` only when the model gave a final answer.

Runs the real ``create_agent`` graph, with the host LLM replaced by a fixed reply.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any, Tuple

import pytest

from .._real_langchain import LANGCHAIN_SYMBOLS, load_adapter, real_langchain_or_skip


@pytest.fixture(scope='module')
def adapter():
    restore = real_langchain_or_skip()
    yield load_adapter('agent_langchain/langchain.py', '_agent_langchain_stop_reason', LANGCHAIN_SYMBOLS)
    restore()


def _run(adapter, reply: str) -> Tuple[str, Any]:
    driver = adapter.LangChainDriver.__new__(adapter.LangChainDriver)
    driver.sendSSE = lambda *args, **kwargs: None
    driver.call_llm = lambda *args, **kwargs: reply
    context = SimpleNamespace(tools=SimpleNamespace(list=[]))
    return driver._run(context=context, question=SimpleNamespace(getPrompt=lambda: 'What is 2 + 2?'))


def test_a_final_answer_is_done(adapter):
    answer, trace = _run(adapter, '{"type": "final", "content": "4"}')

    assert (answer, trace['stop_reason']) == ('4', 'done')


def test_a_model_that_never_follows_the_protocol_is_an_error(adapter):
    answer, trace = _run(adapter, 'The answer is 4.')

    assert 'unparseable output after 3 attempts' in answer
    assert trace['stop_reason'] == 'error'
