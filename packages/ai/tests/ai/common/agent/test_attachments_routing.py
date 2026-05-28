# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Contract tests for ``AgentContext.attachments`` propagation.

The entry-point ``Question.attachments`` must be stamped
onto ``AgentContext`` at the top of ``AgentBase.run_agent`` and threaded
onto every synthesized Question in ``call_llm`` / ``call_llm_json`` so the
provider-side translators in LLMBase can auto-forward them.

The propagation is always-assign: even an empty list is stamped
onto the synthesized Question so downstream code can rely on the attribute
existing.

Run with:
  PYTHONPATH=packages/ai/src:packages/server/engine-lib/rocketlib-python \\
    python -m pytest packages/ai/tests/ai/common/agent/test_attachments_routing.py -v
"""

from __future__ import annotations

import sys
from typing import Any, List
from unittest.mock import MagicMock

# Mirror the stub setup from test_chat_id_routing.py — the global conftest
# only goes so far; the agent layer needs rocketlib.types as a submodule
# and the engine-binary natives stubbed.
_rocketlib_stub = sys.modules.get('rocketlib') or MagicMock()
_rocketlib_stub.ToolDescriptor = dict
sys.modules['rocketlib'] = _rocketlib_stub
if 'rocketlib.types' not in sys.modules:
    types_stub = MagicMock()
    sys.modules['rocketlib.types'] = types_stub
    _rocketlib_stub.types = types_stub
for _mod in ('depends', 'engLib'):
    if _mod not in sys.modules:
        _stub = MagicMock()
        if _mod == 'depends':
            _stub.depends = MagicMock(return_value=None)
        sys.modules[_mod] = _stub

from pydantic import BaseModel, Field  # noqa: E402

from ai.common.agent.agent import AgentBase  # noqa: E402
from ai.common.agent._internal.host import AgentContext  # noqa: E402


# Local mirror of the Attachment schema. The agent layer never
# introspects Attachment fields — it just carries the list through — so a
# duck-typed local definition is enough and avoids a cross-package import
# from client-python into the ai test tree.
class Attachment(BaseModel):
    attachment_id: str = Field(...)
    mime: str = Field(...)
    filename: str = Field(...)
    size_bytes: int = Field(..., ge=0)
    path: str = Field(...)


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
        return ('ok', {})


def _make_invoker():
    """Build a MagicMock IInstance that the host channels can talk to."""
    invoker = MagicMock(name='IInstance')
    invoker.instance.getControllerNodeIds.side_effect = lambda kind: {
        'llm': ['llm-node-0'],
        'tool': [],
        'memory': [],
    }.get(kind, [])
    invoker.instance.pipeId = 42
    invoker.instance.writeAnswers = MagicMock()
    return invoker


def _make_question(attachments):
    """Build a MagicMock standing in for a chat Question carrying attachments."""
    q = MagicMock(name='Question')
    q.chat_id = None
    q.attachments = attachments
    q.addInstruction = MagicMock()
    return q


def _make_attachment(name: str) -> Attachment:
    return Attachment(
        attachment_id=f'id-{name}',
        mime='image/png',
        filename=name,
        size_bytes=1,
        path=f'/tmp/{name}',
    )


# -----------------------------------------------------------------------------
# 1) Stamping AgentContext.attachments from the inbound Question
# -----------------------------------------------------------------------------


def test_agent_context_stamps_attachments_from_question(monkeypatch):
    """Question.attachments must be visible on AgentContext.attachments
    inside the driver's _run.
    """
    agent = _DummyAgent()
    invoker = _make_invoker()

    captured: List[Any] = []

    def _run_capture(self, *, context, question):  # noqa: ARG001
        captured.extend(context.attachments)
        return ('ok', {})

    monkeypatch.setattr(_DummyAgent, '_run', _run_capture)

    att_a = _make_attachment('a.png')
    att_b = _make_attachment('b.png')
    q = _make_question([att_a, att_b])

    agent.run_agent(invoker, q, emit_answers_lane=False)

    assert [a.filename for a in captured] == ['a.png', 'b.png'], (
        'AgentContext.attachments must preserve the inbound Question.attachments order'
    )


# -----------------------------------------------------------------------------
# 2) call_llm threads attachments onto the synthesized Question
# -----------------------------------------------------------------------------


def test_call_llm_threads_attachments_onto_synthesized_question(monkeypatch):
    """When call_llm synthesizes a Question from a message list it must
    stamp AgentContext.attachments onto that Question — always-assign,
    even if the list is empty.
    """
    agent = _DummyAgent()
    invoker = _make_invoker()

    captured_attachments: List[Any] = []

    def _run_inner(self, *, context, question):  # noqa: ARG001
        # Patch the LLM channel just for this run to capture the synthesized
        # Question that call_llm builds.
        def _spy_invoke(ask):
            captured_attachments.extend(list(getattr(ask.question, 'attachments', [])))
            result = MagicMock()
            result.getText = MagicMock(return_value='hi')
            return result

        monkeypatch.setattr(context.llm, 'invoke', _spy_invoke)
        self.call_llm(context, [{'role': 'user', 'content': 'hi'}])
        return ('ok', {})

    monkeypatch.setattr(_DummyAgent, '_run', _run_inner)

    att_a = _make_attachment('one.png')
    att_b = _make_attachment('two.png')
    q = _make_question([att_a, att_b])

    agent.run_agent(invoker, q, emit_answers_lane=False)

    assert [a.filename for a in captured_attachments] == ['one.png', 'two.png'], (
        'call_llm must thread context.attachments onto the synthesized Question'
    )


# -----------------------------------------------------------------------------
# 3) Caller-supplied Question wins — call_llm does NOT overwrite
# -----------------------------------------------------------------------------


def test_call_llm_preserves_attachments_when_caller_passes_a_question_directly(monkeypatch):
    """If the driver hands call_llm a pre-built Question, that Question's
    attachments stand — context.attachments must NOT clobber them.
    """
    agent = _DummyAgent()
    invoker = _make_invoker()

    captured_attachments: List[Any] = []

    att_ctx = _make_attachment('context-only.png')
    att_caller = _make_attachment('caller-supplied.png')

    def _run_inner(self, *, context, question):  # noqa: ARG001
        def _spy_invoke(ask):
            captured_attachments.extend(list(getattr(ask.question, 'attachments', [])))
            result = MagicMock()
            result.getText = MagicMock(return_value='hi')
            return result

        monkeypatch.setattr(context.llm, 'invoke', _spy_invoke)

        # Caller hands in a Question — its attachments must survive untouched.
        q_caller = MagicMock(name='QuestionCaller')
        q_caller.attachments = [att_caller]

        # Force isinstance(prompt, Question) True: monkeypatch the Question
        # symbol inside agent.py to recognize our MagicMock.
        import ai.common.agent.agent as agent_mod

        monkeypatch.setattr(agent_mod, 'Question', MagicMock, raising=True)

        self.call_llm(context, q_caller)
        return ('ok', {})

    monkeypatch.setattr(_DummyAgent, '_run', _run_inner)

    q = _make_question([att_ctx])
    agent.run_agent(invoker, q, emit_answers_lane=False)

    filenames = [a.filename for a in captured_attachments]
    assert filenames == ['caller-supplied.png'], (
        'When prompt is already a Question, call_llm must NOT overwrite its '
        f'attachments with context.attachments. Got {filenames}.'
    )
