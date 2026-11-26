# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""CrewAI events forwarded to the status stream say which agent run sent them.

The listener and runner load from ``nodes/src`` by file path, under a package whose
``__init__`` does not run because it imports the engine glue. ``ai.common`` is the real
one. Only ``crewai`` is stubbed, since the listener needs nothing from it to dispatch.
"""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path
from typing import Any, Dict, List, Tuple

import pytest

from ai.common.agent import AgentContext

_NODE_DIR = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'agent_crewai'
_PKG = 'agent_crewai_listener_under_test'
_RUN_ID = 'run-1'


class _Instance:
    """The engine instance: records what the listener sends."""

    def __init__(self) -> None:
        self.sse: List[Tuple[str, Dict[str, Any]]] = []

    def sendSSE(self, type: str, **data: Any) -> None:
        self.sse.append((type, data))


class _Invoker:
    def __init__(self) -> None:
        self.instance = _Instance()


class _Event:
    """A CrewAI event as the listener reads it."""

    type = 'task_started'

    def __init__(self, fields: Dict[str, Any]) -> None:
        self._fields = fields

    def to_json(self, exclude: Any = None) -> Dict[str, Any]:
        return dict(self._fields)


class _UnreadableEvent(_Event):
    def to_json(self, exclude: Any = None) -> Dict[str, Any]:
        raise ValueError('event cannot be serialized')


def _stub(monkeypatch: pytest.MonkeyPatch, name: str, **attrs: Any) -> None:
    module = types.ModuleType(name)
    module.__dict__.update(attrs)
    monkeypatch.setitem(sys.modules, name, module)


def _load(monkeypatch: pytest.MonkeyPatch, name: str) -> Any:
    full_name = f'{_PKG}.{name}'
    spec = importlib.util.spec_from_file_location(full_name, _NODE_DIR / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, full_name, module)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def dispatch(monkeypatch: pytest.MonkeyPatch) -> Any:
    """Return a function that dispatches one event inside a run, and the invoker it reports to."""
    _stub(monkeypatch, 'crewai')
    _stub(monkeypatch, 'crewai.events', BaseEventListener=object)
    _stub(monkeypatch, 'crewai.events.base_events', BaseEvent=object)
    _stub(monkeypatch, 'crewai.events.types')
    _stub(monkeypatch, 'crewai.events.types.agent_events')
    _stub(monkeypatch, 'crewai.events.types.llm_events', LLMStreamChunkEvent=type('LLMStreamChunkEvent', (), {}))
    _stub(
        monkeypatch,
        'crewai.events.types.logging_events',
        AgentLogsExecutionEvent=type('AgentLogsExecutionEvent', (), {}),
        AgentLogsStartedEvent=type('AgentLogsStartedEvent', (), {}),
    )
    package = types.ModuleType(_PKG)
    package.__path__ = [str(_NODE_DIR)]
    monkeypatch.setitem(sys.modules, _PKG, package)
    runner = _load(monkeypatch, 'crewai_runner')
    listener = _load(monkeypatch, 'crewai_listener')

    invoker = _Invoker()
    context = AgentContext(
        invoker=invoker,
        llm=None,
        tools=None,
        memory=None,
        run_id=_RUN_ID,
        pipe_id=1,
        framework='crewai',
        started_at='t0',
    )

    def send(event: _Event) -> List[Tuple[str, Dict[str, Any]]]:
        token = runner.crewContext.set(context)
        try:
            listener._dispatch(None, event)
        finally:
            runner.crewContext.reset(token)
        return invoker.instance.sse

    return send


def test_crew_events_carry_the_run_id_and_keep_their_fields(dispatch: Any) -> None:
    """CrewAI's own agent_id stays: it names the crew member, and run_id names the run."""
    sent = dispatch(_Event({'type': 'task_started', 'agent_id': 'crew-member-1', 'task_name': 'research'}))

    assert sent == [
        (
            'thinking',
            {'message': 'Task started', 'agent_id': 'crew-member-1', 'task_name': 'research', 'run_id': _RUN_ID},
        )
    ]


def test_an_event_field_named_run_id_does_not_lose_the_event(dispatch: Any) -> None:
    """Two keywords of one name would raise, and the listener drops an event whose send raises."""
    sent = dispatch(_Event({'run_id': 'crew-internal', 'agent_id': 'crew-member-1'}))

    assert sent[0][1]['run_id'] == _RUN_ID
    assert sent[0][1]['agent_id'] == 'crew-member-1'


def test_an_event_that_cannot_be_read_still_carries_the_run_id(dispatch: Any) -> None:
    assert dispatch(_UnreadableEvent({})) == [('thinking', {'message': 'Task started', 'run_id': _RUN_ID})]


def test_a_failure_event_error_has_no_engine_path(dispatch: Any) -> None:
    """CrewAI puts str() of the exception in a failure event's error, and the client gets it."""
    sent = dispatch(_Event({'error': 'Exception: Invalid API key. at (/opt/rocketride/ai/common/chat.py:412)'}))

    assert sent[0][1]['error'] == 'Exception: Invalid API key.'
