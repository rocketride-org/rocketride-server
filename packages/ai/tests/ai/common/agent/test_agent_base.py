# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit tests for the ``require_tool_call`` fabrication guard on ``AgentBase``.

Covers the framework-agnostic pieces added to catch a planning model that
*narrates* a tool chain in prose instead of actually calling the tools:

* ``AgentBase.call_tool`` records each invocation on ``context.invoked_tools``.
* ``AgentBase.run_agent`` fails a run with a ``RocketRide.agent.guard.v1`` answer
  when ``require_tool_call`` is on and no tool was invoked, and passes it through
  otherwise (guard off, or at least one tool invoked).
* Sub-agent drivers can share the parent's tally by threading ``invoked_tools``
  into a child ``AgentContext`` (the crewai-manager / deepagent contract).

The driver is a tiny in-test ``AgentBase`` subclass built via ``__new__`` so the
tests never touch the engine ``iGlobal`` / ``Config`` plumbing; the host channels
and IInstance are lightweight fakes.

Run with::

    pytest packages/ai/tests/ai/common/agent/test_agent_base.py -v
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Tuple

import pytest

from ai.common.agent import AgentBase, AgentContext
from ai.common.llm_adapter import report_llm_tokens
from ai.common.utils import parse_bool


# ---------------------------------------------------------------------------
# Test doubles
# ---------------------------------------------------------------------------


class _FakeTools:
    """Host Tools channel stub — records invocations, returns a canned result."""

    def __init__(self) -> None:
        self.invocations: List[Tuple[str, Dict[str, Any]]] = []

    def invoke(self, tool_name: str, args: Dict[str, Any]) -> Any:
        self.invocations.append((tool_name, args))
        return {'ok': True, 'echo': args}


class _FakeHost:
    """Stands in for the cached ``iInstance._agent_host``."""

    def __init__(self) -> None:
        self.llm = object()
        self.tools = _FakeTools()
        self.memory = None


class _FakeInner:
    """Stands in for ``iInstance.instance``."""

    def __init__(self) -> None:
        self.pipeId = 42
        self.written: List[Any] = []

    def writeAnswers(self, answer: Any) -> None:
        self.written.append(answer)

    def sendSSE(self, *args: Any, **kwargs: Any) -> None:
        pass


class _FakeIInstance:
    """Minimal IInstance: pre-set ``_agent_host`` so run_agent skips host build."""

    def __init__(self) -> None:
        self._agent_host = _FakeHost()
        self.instance = _FakeInner()


class _FakeQuestion:
    def addInstruction(self, *args: Any, **kwargs: Any) -> None:
        pass


RunImpl = Callable[[AgentBase, AgentContext, Any], Tuple[str, Any]]


def _make_driver(run_impl: RunImpl, *, require_tool_call: bool) -> AgentBase:
    """Build an AgentBase subclass instance without running __init__ (which needs
    an engine iGlobal + Config).
    """

    class _StubDriver(AgentBase):
        FRAMEWORK = 'stub'

        def _run(self, *, context: AgentContext, question: Any) -> Tuple[str, Any]:
            return run_impl(self, context, question)

    driver = _StubDriver.__new__(_StubDriver)
    driver._instructions = []
    driver._agent_description = ''
    driver._require_tool_call = require_tool_call
    return driver


def _context(host: _FakeHost) -> AgentContext:
    return AgentContext(
        invoker=None,
        llm=host.llm,
        tools=host.tools,
        memory=host.memory,
        run_id='run-1',
        pipe_id=1,
        framework='stub',
        started_at='t0',
    )


# ---------------------------------------------------------------------------
# call_tool counting
# ---------------------------------------------------------------------------


def test_call_tool_records_invocation_and_forwards():
    host = _FakeHost()
    ctx = _context(host)
    driver = _make_driver(lambda d, c, q: ('', None), require_tool_call=False)

    out = driver.call_tool(ctx, 'weather.get', {'city': 'NYC'})

    assert ctx.invoked_tools == ['weather.get']
    assert host.tools.invocations == [('weather.get', {'city': 'NYC'})]
    assert out == {'ok': True, 'echo': {'city': 'NYC'}}


def test_call_tool_counts_even_when_tool_raises():
    # A tool that errors is still a genuine grounding attempt, not fabrication.
    class _Boom(_FakeTools):
        def invoke(self, tool_name, args):
            super().invoke(tool_name, args)
            raise RuntimeError('tool blew up')

    host = _FakeHost()
    host.tools = _Boom()
    ctx = _context(host)
    driver = _make_driver(lambda d, c, q: ('', None), require_tool_call=False)

    with pytest.raises(RuntimeError):
        driver.call_tool(ctx, 'weather.get', {})

    assert ctx.invoked_tools == ['weather.get']


# ---------------------------------------------------------------------------
# run_agent guard
# ---------------------------------------------------------------------------


def _narrate(_driver, _context, _question):
    return ('I called the weather tool and it is sunny.', {'raw': 'narrated'})


def _call_one_tool(driver, context, _question):
    driver.call_tool(context, 'weather.get', {'city': 'NYC'})
    return ('It is sunny in NYC.', {'raw': 'grounded'})


def test_guard_trips_when_no_tool_invoked():
    driver = _make_driver(_narrate, require_tool_call=True)
    payload = driver.run_agent(_FakeIInstance(), _FakeQuestion(), emit_answers_lane=False)

    assert 'without invoking any tool' in payload['content']
    assert payload['meta']['tool_calls'] == 0
    assert payload['stack'][0]['kind'] == 'RocketRide.agent.guard.v1'
    assert payload['stack'][0]['name'] == 'tool_call_required'
    # The narrated (ungrounded) content must not be delivered.
    assert 'it is sunny' not in payload['content'].lower()
    # ...but the rejected framework output is retained on the stack for diagnosis.
    raw_entries = [s for s in payload['stack'] if s['kind'] == 'RocketRide.agent.raw.v1']
    assert raw_entries and raw_entries[0]['payload'] == {'raw': 'narrated'}


def test_guard_passes_when_a_tool_is_invoked():
    driver = _make_driver(_call_one_tool, require_tool_call=True)
    payload = driver.run_agent(_FakeIInstance(), _FakeQuestion(), emit_answers_lane=False)

    assert payload['content'] == 'It is sunny in NYC.'
    assert payload['meta']['tool_calls'] == 1
    assert payload['stack'][0]['kind'] == 'RocketRide.agent.raw.v1'


def test_guard_off_allows_a_tool_free_answer():
    driver = _make_driver(_narrate, require_tool_call=False)
    payload = driver.run_agent(_FakeIInstance(), _FakeQuestion(), emit_answers_lane=False)

    assert payload['content'] == 'I called the weather tool and it is sunny.'
    assert payload['meta']['tool_calls'] == 0
    assert payload['stack'][0]['kind'] == 'RocketRide.agent.raw.v1'


def test_guard_answer_is_emitted_on_the_answers_lane():
    ii = _FakeIInstance()
    driver = _make_driver(_narrate, require_tool_call=True)
    driver.run_agent(ii, _FakeQuestion(), emit_answers_lane=True)

    # Even a tripped guard still emits exactly one answer downstream.
    assert len(ii.instance.written) == 1


# ---------------------------------------------------------------------------
# Token usage on the emitted answer
# ---------------------------------------------------------------------------


def _report_two_calls(_driver, _context, _question):
    """Driver body that reports two model calls, as report_llm_tokens does at the seam."""
    report_llm_tokens(10, 4, model='claude-haiku-4-5')
    report_llm_tokens(20, 8, model='claude-haiku-4-5')
    return ('It is sunny in NYC.', {'raw': 'grounded'})


def test_answer_carries_the_turn_token_usage():
    """An agentic turn calls the model N times; the answer must carry the total.

    Without this the Trace "Tokens" grid renders for a plain LLM node but never for
    an agent, because the agent emits its own Answer here rather than going through the
    LLM node's questions lane. Usage accrues DURING the run (report_llm_tokens at the
    Adapter seam), read back by run_agent's turn scope.
    """
    from ai.web.metrics.metrics import metrics

    metrics.reset()
    ii = _FakeIInstance()
    driver = _make_driver(_report_two_calls, require_tool_call=False)
    driver.run_agent(ii, _FakeQuestion(), emit_answers_lane=True)

    tokens = ii.instance.written[0].tokens
    assert tokens['input'] == 30 and tokens['output'] == 12 and tokens['calls'] == 2
    assert len(tokens['breakdown']) == 2


def test_answer_has_no_tokens_when_none_were_reported():
    """A run with no model call must not invent an empty grid."""
    from ai.web.metrics.metrics import metrics

    metrics.reset()
    ii = _FakeIInstance()
    driver = _make_driver(_call_one_tool, require_tool_call=False)
    driver.run_agent(ii, _FakeQuestion(), emit_answers_lane=True)

    assert ii.instance.written[0].tokens is None


def test_a_prior_turn_does_not_bleed_into_the_next():
    """Two questions in a row: the second answer carries only its own calls.

    The agent reaches the model through ask(), which never cleared the old contextvar;
    the turn scope now bounds each run so question 2 can't inherit question 1's tokens.
    """
    from ai.web.metrics.metrics import metrics

    metrics.reset()
    driver = _make_driver(_report_two_calls, require_tool_call=False)

    ii1 = _FakeIInstance()
    driver.run_agent(ii1, _FakeQuestion(), emit_answers_lane=True)
    ii2 = _FakeIInstance()
    driver.run_agent(ii2, _FakeQuestion(), emit_answers_lane=True)

    # Not 4 calls / 60 input — each turn is independent.
    assert ii2.instance.written[0].tokens['calls'] == 2
    assert ii2.instance.written[0].tokens['input'] == 30


def test_outer_agent_total_includes_sub_agent_calls():
    """An agent can drive sub-agents; the outer answer's total includes theirs.

    The sub-agent's run_agent opens a nested turn scope: it reads only its own calls,
    but the outer scope still sees them for the turn total (the collector is shared and
    cleared only by the outermost scope).
    """
    from ai.web.metrics.metrics import metrics

    metrics.reset()
    sub_driver = _make_driver(_report_two_calls, require_tool_call=False)  # 2 calls: 30 in / 12 out

    def _outer_run(_driver, _context, _question):
        report_llm_tokens(5, 2, model='outer')  # the outer agent's own call
        sub_driver.run_agent(_FakeIInstance(), _FakeQuestion(), emit_answers_lane=False)
        return ('done', {'raw': 'x'})

    ii = _FakeIInstance()
    outer = _make_driver(_outer_run, require_tool_call=False)
    outer.run_agent(ii, _FakeQuestion(), emit_answers_lane=True)

    tokens = ii.instance.written[0].tokens
    assert tokens['calls'] == 3  # outer's 1 + sub-agent's 2
    assert tokens['input'] == 35 and tokens['output'] == 14


# ---------------------------------------------------------------------------
# Sub-context threading (crewai manager / deepagent contract)
# ---------------------------------------------------------------------------


def test_subcontext_sharing_counts_delegated_tool_calls():
    parent = _context(_FakeHost())
    child_host = _FakeHost()
    # A sub-agent context that inherits the parent's tally, as the crewai
    # manager and deepagent drivers build it.
    child = AgentContext(
        invoker=None,
        llm=child_host.llm,
        tools=child_host.tools,
        memory=child_host.memory,
        run_id=parent.run_id,
        pipe_id=parent.pipe_id,
        framework=parent.framework,
        started_at=parent.started_at,
        invoked_tools=parent.invoked_tools,
    )
    driver = _make_driver(lambda d, c, q: ('', None), require_tool_call=False)

    driver.call_tool(child, 'db.query', {'sql': 'select 1'})

    # The delegated call is visible to the parent run's guard.
    assert parent.invoked_tools == ['db.query']
    assert parent.invoked_tools is child.invoked_tools


def test_independent_contexts_do_not_share_a_tally():
    a = _context(_FakeHost())
    b = _context(_FakeHost())
    assert a.invoked_tools is not b.invoked_tools
    a.invoked_tools.append('x.y')
    assert b.invoked_tools == []


# ---------------------------------------------------------------------------
# Regression guards for the adversarial-review findings
# ---------------------------------------------------------------------------


def test_context_stays_hashable_with_the_tool_tally():
    # invoked_tools is a mutable list on a frozen dataclass; compare=False keeps
    # AgentContext hashable (a plain list field would make __hash__ raise).
    ctx = _context(_FakeHost())
    h = hash(ctx)  # must not raise
    ctx.invoked_tools.append('srv.tool')
    assert hash(ctx) == h  # the mutable tally is excluded from the hash


def test_require_tool_call_coercion_is_string_safe():
    # AgentBase.__init__ reads the flag with parse_bool, not bool(), so a
    # stringified "false"/"0"/"no" leaves the guard OFF instead of enabling it
    # (plain bool("false") is True and would wrongly turn the guard on).
    assert parse_bool('false', False) is False
    assert parse_bool('0', False) is False
    assert parse_bool('no', False) is False
    assert parse_bool(False, False) is False
    assert parse_bool(None, False) is False
    assert parse_bool(True, False) is True
    assert parse_bool('true', False) is True


def _boom_after_tool(driver, context, _question):
    driver.call_tool(context, 'srv.tool', {})
    raise RuntimeError('kaboom')


def test_error_path_still_reports_tool_calls():
    # A run that errors after calling a tool reports tool_calls in meta too, so
    # the key is present on success, guard, AND error answers.
    driver = _make_driver(_boom_after_tool, require_tool_call=False)
    payload = driver.run_agent(_FakeIInstance(), _FakeQuestion(), emit_answers_lane=False)

    assert payload['stack'][0]['kind'] == 'RocketRide.agent.error.v1'
    assert payload['meta']['tool_calls'] == 1
