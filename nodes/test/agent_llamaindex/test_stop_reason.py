# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""A LlamaIndex run reports `done` only for an answer, not for a tool call it could not parse.

llama-index is not installed here, so its ReAct pieces are stubbed. The stub parser rejects
every reply, as llama-index-core 0.14's ``ReActOutputParser`` does for both replies below: a
tool call whose input is cut off, and a ``Thought:`` with no ``Action:`` or ``Answer:``.
"""

from __future__ import annotations

import sys
import types
from types import SimpleNamespace
from typing import Any, Tuple

import pytest

from .._real_langchain import LANGCHAIN_SYMBOLS, load_adapter


class _RejectingParser:
    def parse(self, output: str) -> Any:
        raise ValueError(f'Could not parse output: {output}')


_LLAMA_INDEX = {
    'llama_index': {},
    'llama_index.core': {},
    'llama_index.core.tools': {'FunctionTool': object},
    'llama_index.core.agent': {},
    'llama_index.core.agent.react': {},
    'llama_index.core.agent.react.formatter': {
        'ReActChatFormatter': SimpleNamespace(from_defaults=lambda: SimpleNamespace(format=lambda *a, **kw: []))
    },
    'llama_index.core.agent.react.output_parser': {'ReActOutputParser': _RejectingParser},
    'llama_index.core.agent.react.types': {'ObservationReasoningStep': object},
    'llama_index.core.base': {},
    'llama_index.core.base.llms': {},
    'llama_index.core.base.llms.types': {
        'ChatMessage': lambda **kw: SimpleNamespace(**kw),
        'MessageRole': SimpleNamespace(USER='user'),
    },
}


@pytest.fixture
def adapter(monkeypatch):
    for name, attrs in _LLAMA_INDEX.items():
        module = types.ModuleType(name)
        module.__dict__.update(attrs)
        monkeypatch.setitem(sys.modules, name, module)
    return load_adapter('agent_llamaindex/llamaindex.py', '_agent_llamaindex_stop_reason', LANGCHAIN_SYMBOLS)


def _run(adapter, reply: str) -> Tuple[str, Any]:
    driver = adapter.LlamaIndexDriver.__new__(adapter.LlamaIndexDriver)
    driver.sendSSE = lambda *args, **kwargs: None
    driver.call_llm = lambda *args, **kwargs: reply
    context = SimpleNamespace(tools=SimpleNamespace(list=[]))
    return driver._run(context=context, question=SimpleNamespace(getPrompt=lambda: 'Look up record 7.'))


def test_a_tool_call_that_does_not_parse_fails_the_run(adapter):
    with pytest.raises(ValueError, match='tool call'):
        _run(adapter, 'Thought: I need the lookup tool.\nAction: lookup\nAction Input: {"id": ')


def test_a_thought_with_no_action_is_a_direct_answer(adapter):
    answer, trace = _run(adapter, 'Thought: Record 7 is closed.')

    assert (answer, trace['stop_reason']) == ('Record 7 is closed.', 'done')
