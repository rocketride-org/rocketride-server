# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Contract tests for the chat-session integration on ``AgentBase``.

Covers TDD §13 risk row "built-in recall_history reaches wrong chat" — two
consecutive Questions with different ``chat_id``s on the same IInstance must
route to the correct chat files via ``AgentContext.chat_id``.

Also exercises:
- ``_builtin_tools`` returns a ``recall_history`` descriptor.
- ``_recall_history`` returns the persistence-not-enabled sentinel when
  ``chat_id`` is None and does not touch the filesystem.
- ``call_tool`` intercepts ``recall_history`` and forwards
  ``context.chat_id`` (so the LLM cannot type a path or reach another chat).

Run with:
  PYTHONPATH=packages/ai/src:packages/server/engine-lib/rocketlib-python \\
    python -m pytest packages/ai/tests/ai/common/agent/test_chat_id_routing.py -v
"""

from __future__ import annotations

import json
import sys
from typing import Any, List, Tuple
from unittest.mock import MagicMock

# The repo's global conftest stubs ``rocketlib`` as a flat MagicMock, but the
# agent layer does ``from rocketlib.types import ...`` / ``from rocketlib import
# ToolDescriptor`` which needs ``rocketlib.types`` to look like a submodule.
# Also stub `depends` and `engLib` (engine-binary natives) so the test runs in
# a vanilla Python venv without the dist engine on the path.
_rocketlib_stub = sys.modules.get('rocketlib') or MagicMock()
_rocketlib_stub.ToolDescriptor = dict  # ToolDescriptor is a TypedDict; runtime use is structural
sys.modules['rocketlib'] = _rocketlib_stub
if 'rocketlib.types' not in sys.modules:
    types_stub = MagicMock()
    sys.modules['rocketlib.types'] = types_stub
    _rocketlib_stub.types = types_stub
for _mod in ('depends', 'engLib'):
    if _mod not in sys.modules:
        _stub = MagicMock()
        # depends.depends() is invoked at ai/__init__.py import time.
        if _mod == 'depends':
            _stub.depends = MagicMock(return_value=None)
        sys.modules[_mod] = _stub

from ai.common.agent.agent import AgentBase  # noqa: E402
from ai.common.agent._internal.host import AgentContext  # noqa: E402


class _DummyAgent(AgentBase):
    """Minimal concrete AgentBase used to test the wiring on the base class."""

    FRAMEWORK = 'test-dummy'

    def __init__(self):
        # Skip AgentBase.__init__ — it pulls instructions out of IGlobal config,
        # which is irrelevant for these wiring tests.
        self._iGlobal = None
        self._node_id = 'test'
        self._instructions: List[str] = []
        self._agent_description = ''

    def _run(self, *, context: AgentContext, question):  # noqa: D401
        # Drivers normally do real work; for the routing test we just need
        # to surface the per-call context so the test can assert against it.
        return ('ok', {'chat_id': context.chat_id})


def _make_invoker():
    """Build a MagicMock IInstance that the host channels can talk to."""
    invoker = MagicMock(name='IInstance')
    # Tools.__init__ asks for ('tool') node ids; return none so the
    # discovery loop is a no-op and self._tool_list stays empty.
    invoker.instance.getControllerNodeIds.side_effect = lambda kind: {
        'llm': ['llm-node-0'],
        'tool': [],
        'memory': [],
    }.get(kind, [])
    invoker.instance.pipeId = 42
    invoker.instance.writeAnswers = MagicMock()
    return invoker


def _make_question(chat_id: str | None):
    q = MagicMock(name='Question')
    q.chat_id = chat_id
    q.addInstruction = MagicMock()
    return q


# -----------------------------------------------------------------------------
# _builtin_tools()
# -----------------------------------------------------------------------------


def test_builtin_tools_exposes_recall_history():
    agent = _DummyAgent()
    builtins = agent._builtin_tools()
    assert isinstance(builtins, list) and builtins, 'expected at least one built-in tool'
    names = [t.get('name') for t in builtins]
    assert AgentBase._RECALL_HISTORY_TOOL_NAME in names

    desc = next(t for t in builtins if t['name'] == AgentBase._RECALL_HISTORY_TOOL_NAME)
    props = desc.get('inputSchema', {}).get('properties', {})
    assert set(props.keys()) == {'before_seq', 'limit'}, 'recall_history must NOT accept a path/chat_id arg from the LLM'


# -----------------------------------------------------------------------------
# _recall_history()
# -----------------------------------------------------------------------------


def test_recall_history_returns_persistence_note_when_chat_id_none(monkeypatch):
    agent = _DummyAgent()

    def _should_not_be_called(self, chat_id):  # noqa: ARG001
        raise AssertionError('FileStore must not be touched when chat_id is None')

    monkeypatch.setattr(AgentBase, '_read_chat_jsonl_bytes', _should_not_be_called)

    out = agent._recall_history(chat_id=None)
    assert out == {'turns': [], 'note': 'persistence not enabled'}


def test_recall_history_filters_by_before_seq_and_caps_limit(monkeypatch):
    agent = _DummyAgent()

    sample = b'\n'.join(
        [
            json.dumps({'type': 'header', 'schema_version': 1, 'guid': 'x'}).encode(),
            json.dumps({'type': 'turn', 'schema_version': 1, 'seq': 1, 'question': {}, 'answer': {}}).encode(),
            json.dumps({'type': 'turn', 'schema_version': 1, 'seq': 2, 'question': {}, 'answer': {}}).encode(),
            json.dumps({'type': 'turn', 'schema_version': 1, 'seq': 3, 'question': {}, 'answer': {}}).encode(),
            json.dumps({'type': 'turn', 'schema_version': 99, 'seq': 4, 'question': {}, 'answer': {}}).encode(),
        ]
    )

    def _fake_read(self, chat_id):  # noqa: ARG001
        assert chat_id == 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
        return sample

    monkeypatch.setattr(AgentBase, '_read_chat_jsonl_bytes', _fake_read)

    out = agent._recall_history(chat_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', before_seq=4, limit=10)
    seqs = [t['seq'] for t in out['turns']]
    assert seqs == [3, 2, 1], 'turns must be newest-first and filtered by before_seq'

    # Future-versioned line should NOT be silently dropped — it is returned
    # with a schema_version_warning so the LLM can be told to treat it as opaque.
    out_all = agent._recall_history(chat_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', limit=10)
    flagged = [t for t in out_all['turns'] if 'schema_version_warning' in t]
    assert len(flagged) == 1 and flagged[0]['seq'] == 4


def test_recall_history_routes_to_different_files_per_chat_id(monkeypatch):
    agent = _DummyAgent()
    seen_chat_ids: List[str] = []

    def _fake_read(self, chat_id):  # noqa: ARG001
        seen_chat_ids.append(chat_id)
        return b''  # empty file → empty turns

    monkeypatch.setattr(AgentBase, '_read_chat_jsonl_bytes', _fake_read)

    a = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    b = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    agent._recall_history(chat_id=a)
    agent._recall_history(chat_id=b)
    agent._recall_history(chat_id=a)

    assert seen_chat_ids == [a, b, a], 'two consecutive recalls with different chat_ids must address different files; covers TDD §13 "wrong chat" risk.'


# -----------------------------------------------------------------------------
# call_tool interception
# -----------------------------------------------------------------------------


def test_call_tool_intercepts_recall_history_with_context_chat_id(monkeypatch):
    agent = _DummyAgent()
    captured: List[Tuple[Any, ...]] = []

    def _spy(self, chat_id, **kwargs):  # noqa: ARG001
        captured.append((chat_id, kwargs))
        return {'turns': [], 'chat_id': chat_id}

    monkeypatch.setattr(AgentBase, '_recall_history', _spy)

    fake_tools = MagicMock()
    fake_tools.invoke = MagicMock(side_effect=AssertionError('built-ins must not reach Tools.invoke'))
    ctx_a = AgentContext(
        invoker=None,
        llm=None,
        tools=fake_tools,
        memory=None,
        run_id='r1',
        pipe_id=1,
        framework='test',
        started_at='t',
        chat_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    )
    ctx_b = AgentContext(
        invoker=None,
        llm=None,
        tools=fake_tools,
        memory=None,
        run_id='r2',
        pipe_id=1,
        framework='test',
        started_at='t',
        chat_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    )

    agent.call_tool(ctx_a, AgentBase._RECALL_HISTORY_TOOL_NAME, {'before_seq': 5, 'limit': 3})
    agent.call_tool(ctx_b, AgentBase._RECALL_HISTORY_TOOL_NAME, {})

    chat_ids = [c[0] for c in captured]
    assert chat_ids == [
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    ], 'call_tool must thread context.chat_id into _recall_history per call'
    assert captured[0][1] == {'before_seq': 5, 'limit': 3}


def test_call_tool_forwards_non_builtin_to_tools_invoke():
    agent = _DummyAgent()
    fake_tools = MagicMock()
    fake_tools.invoke = MagicMock(return_value='ok')
    ctx = AgentContext(
        invoker=None,
        llm=None,
        tools=fake_tools,
        memory=None,
        run_id='r',
        pipe_id=1,
        framework='test',
        started_at='t',
        chat_id=None,
    )

    out = agent.call_tool(ctx, 'some_real_tool', {'x': 1})
    assert out == 'ok'
    fake_tools.invoke.assert_called_once_with('some_real_tool', {'x': 1})


# -----------------------------------------------------------------------------
# AgentContext.chat_id wiring through run_agent
# -----------------------------------------------------------------------------


def test_run_agent_threads_question_chat_id_to_agent_context(monkeypatch):
    """Two consecutive run_agent calls on the same IInstance must thread each
    question's chat_id into its own AgentContext — establishes the "chat_id
    travels per-question, never sticks on the IInstance" invariant.
    """
    agent = _DummyAgent()
    invoker = _make_invoker()

    seen_chat_ids: List[str | None] = []

    def _run_capture(self, *, context, question):  # noqa: ARG001
        seen_chat_ids.append(context.chat_id)
        return ('ok', {})

    monkeypatch.setattr(_DummyAgent, '_run', _run_capture)

    q1 = _make_question('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
    q2 = _make_question('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
    q3 = _make_question(None)

    agent.run_agent(invoker, q1, emit_answers_lane=False)
    agent.run_agent(invoker, q2, emit_answers_lane=False)
    agent.run_agent(invoker, q3, emit_answers_lane=False)

    assert seen_chat_ids == [
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        None,
    ]
