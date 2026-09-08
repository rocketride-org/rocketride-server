# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
End-to-end integration tests for the ``require_tool_call`` guard, driving the
**real** RocketRide Wave driver loop (planner -> executor -> AgentBase.call_tool
-> AgentBase.run_agent guard) rather than a stub ``_run``.

Only the LLM planning call is scripted (via an instance override of
``call_llm_json``); everything else — the wave loop, parallel tool execution,
memory.peek local-read handling, the tool-invocation counter, and the guard —
runs for real. This is the closest thing to a live pipeline run that works
without a built engine.

Run (with the engine-stub harness) via the command in the PR's test notes.
"""

from __future__ import annotations

from typing import Any, Dict, List

import pytest

from ai.common.schema import Question
from nodes.agent_rocketride.rocketride_agent import RocketRideDriver


# ---------------------------------------------------------------------------
# Fakes for the host channels + IInstance
# ---------------------------------------------------------------------------


class _FakeTools:
    """Host Tools channel: a discoverable weather tool + recorded invocations."""

    def __init__(self) -> None:
        self.list: List[Dict[str, Any]] = [
            {
                'name': 'weather.get',
                'description': 'Get the weather for a city.',
                'inputSchema': {'type': 'object', 'properties': {'city': {'type': 'string'}}},
            }
        ]
        self.invocations: List[tuple] = []

    def invoke(self, tool_name: str, args: Dict[str, Any]) -> Any:
        self.invocations.append((tool_name, args))
        return {'temp': 72, 'condition': 'sunny', 'city': args.get('city')}


class _DictMemory:
    """Dict-backed Memory channel mirroring the {ok, value} contract."""

    def __init__(self) -> None:
        self.store: Dict[str, Any] = {}

    def put(self, key: str, value: Any) -> Dict[str, Any]:
        self.store[key] = value
        return {'ok': True}

    def get(self, key: str) -> Dict[str, Any]:
        if key in self.store:
            return {'ok': True, 'value': self.store[key]}
        return {'ok': False}

    def clear(self, key: str = None) -> Dict[str, Any]:
        if key is None:
            self.store.clear()
        else:
            self.store.pop(key, None)
        return {'ok': True}

    def list(self) -> Dict[str, Any]:
        return {'ok': True, 'keys': list(self.store)}


class _FakeHost:
    def __init__(self) -> None:
        self.llm = object()
        self.tools = _FakeTools()
        self.memory = _DictMemory()


class _FakeInner:
    def __init__(self) -> None:
        self.pipeId = 1
        self.written: List[Any] = []

    def writeAnswers(self, answer: Any) -> None:
        self.written.append(answer)

    def sendSSE(self, *args: Any, **kwargs: Any) -> None:
        pass


class _FakeIInstance:
    def __init__(self) -> None:
        self._agent_host = _FakeHost()
        self.instance = _FakeInner()


def _driver(plans: List[Dict[str, Any]], *, require_tool_call: bool) -> RocketRideDriver:
    """A RocketRideDriver with __init__ bypassed and the planner LLM scripted.

    ``call_tool`` is left REAL so the invocation counter is genuinely exercised.
    """
    d = RocketRideDriver.__new__(RocketRideDriver)
    d._instructions = []
    d._agent_description = ''
    d._require_tool_call = require_tool_call
    d._max_waves = 10
    plan_iter = iter(plans)
    # Instance attribute shadows the bound method; planner calls
    # agent_base.call_llm_json(context, wave_prompt) -> returns the next plan.
    d.call_llm_json = lambda context, prompt, **kw: next(plan_iter)
    return d


def _question() -> Question:
    q = Question()
    q.addQuestion('What is the weather in NYC?')
    return q


# ---------------------------------------------------------------------------
# Fabrication vs grounding through the real loop
# ---------------------------------------------------------------------------


def test_fabrication_on_wave0_trips_guard():
    # Planner "narrates" a final answer on the first wave without any tool call.
    d = _driver(
        [{'done': True, 'answer': 'It is sunny in NYC (no tool called).', 'scratch': ''}], require_tool_call=True
    )
    ii = _FakeIInstance()
    payload = d.run_agent(ii, _question(), emit_answers_lane=False)

    assert payload['stack'][0]['kind'] == 'RocketRide.agent.guard.v1'
    assert payload['meta']['tool_calls'] == 0
    assert ii._agent_host.tools.invocations == []  # nothing actually ran
    assert 'without invoking any tool' in payload['content']


def test_grounded_run_passes_guard():
    plans = [
        {'tool_calls': [{'tool': 'weather.get', 'args': {'city': 'NYC'}}], 'thought': 'fetch', 'scratch': ''},
        {'done': True, 'answer': 'Sunny, 72F in NYC.', 'scratch': ''},
    ]
    d = _driver(plans, require_tool_call=True)
    ii = _FakeIInstance()
    payload = d.run_agent(ii, _question(), emit_answers_lane=False)

    assert payload['content'] == 'Sunny, 72F in NYC.'
    assert payload['meta']['tool_calls'] == 1
    assert payload['stack'][0]['kind'] == 'RocketRide.agent.raw.v1'
    assert ii._agent_host.tools.invocations == [('weather.get', {'city': 'NYC'})]


def test_guard_off_allows_fabrication_backward_compat():
    d = _driver([{'done': True, 'answer': 'narrated answer', 'scratch': ''}], require_tool_call=False)
    ii = _FakeIInstance()
    payload = d.run_agent(ii, _question(), emit_answers_lane=False)

    assert payload['content'] == 'narrated answer'
    assert payload['stack'][0]['kind'] == 'RocketRide.agent.raw.v1'
    assert payload['meta']['tool_calls'] == 0


def test_memory_peek_only_does_not_satisfy_guard():
    # memory.peek is a LOCAL read handled inside the executor — it never routes
    # through call_tool, so a peek-only run must still trip the guard.
    plans = [
        {
            'tool_calls': [{'tool': 'memory.peek', 'args': {'key': 'seed', 'path': 'value'}}],
            'thought': 'peek',
            'scratch': '',
        },
        {'done': True, 'answer': 'answer from a peek only', 'scratch': ''},
    ]
    d = _driver(plans, require_tool_call=True)
    ii = _FakeIInstance()
    ii._agent_host.memory.store['seed'] = {'value': 42}  # pre-seed so the peek succeeds

    payload = d.run_agent(ii, _question(), emit_answers_lane=False)

    assert payload['stack'][0]['kind'] == 'RocketRide.agent.guard.v1'
    assert payload['meta']['tool_calls'] == 0
    assert ii._agent_host.tools.invocations == []  # peek never hit the tool channel


def test_parallel_tools_in_one_wave_all_counted():
    # Two tool calls in a single wave run on parallel threads; both must be
    # counted (also exercises the thread-safe append to context.invoked_tools).
    plans = [
        {
            'tool_calls': [
                {'tool': 'weather.get', 'args': {'city': 'NYC'}},
                {'tool': 'weather.get', 'args': {'city': 'LA'}},
            ],
            'thought': 'fetch both',
            'scratch': '',
        },
        {'done': True, 'answer': 'Two cities fetched.', 'scratch': ''},
    ]
    d = _driver(plans, require_tool_call=True)
    ii = _FakeIInstance()
    payload = d.run_agent(ii, _question(), emit_answers_lane=False)

    assert payload['meta']['tool_calls'] == 2
    assert payload['stack'][0]['kind'] == 'RocketRide.agent.raw.v1'
    assert len(ii._agent_host.tools.invocations) == 2


def test_guard_trip_is_emitted_on_answers_lane():
    d = _driver([{'done': True, 'answer': 'narrated', 'scratch': ''}], require_tool_call=True)
    ii = _FakeIInstance()
    d.run_agent(ii, _question(), emit_answers_lane=True)
    assert len(ii.instance.written) == 1


# ---------------------------------------------------------------------------
# LangChain framework-wrapper loop (one of the two nodes named in #1403).
# Skips where the optional langchain dependency is not installed.
# ---------------------------------------------------------------------------


def _langchain_driver(envelopes: List[str], *, require_tool_call: bool):
    from nodes.agent_langchain.langchain import LangChainDriver

    d = LangChainDriver.__new__(LangChainDriver)
    d._instructions = []
    d._agent_description = ''
    d._require_tool_call = require_tool_call
    env_iter = iter(envelopes)
    # The tool-calling chat-model adapter calls agent_base.call_llm(...) each turn;
    # script it to return the raw JSON envelope the driver's parser expects.
    d.call_llm = lambda context, prompt, **kw: next(env_iter)
    return d


def test_langchain_fabrication_trips_guard():
    pytest.importorskip('langchain')
    d = _langchain_driver(['{"type":"final","content":"It is sunny (narrated, no tool)."}'], require_tool_call=True)
    ii = _FakeIInstance()
    payload = d.run_agent(ii, _question(), emit_answers_lane=False)

    assert payload['stack'][0]['kind'] == 'RocketRide.agent.guard.v1'
    assert payload['meta']['tool_calls'] == 0
    assert ii._agent_host.tools.invocations == []


def test_langchain_grounded_passes_guard():
    pytest.importorskip('langchain')
    d = _langchain_driver(
        [
            '{"type":"tool_call","name":"weather.get","args":{"city":"NYC"}}',
            '{"type":"final","content":"Sunny, 72F in NYC."}',
        ],
        require_tool_call=True,
    )
    ii = _FakeIInstance()
    payload = d.run_agent(ii, _question(), emit_answers_lane=False)

    assert payload['meta']['tool_calls'] >= 1
    assert payload['stack'][0]['kind'] == 'RocketRide.agent.raw.v1'
    assert ('weather.get', {'city': 'NYC'}) in ii._agent_host.tools.invocations
