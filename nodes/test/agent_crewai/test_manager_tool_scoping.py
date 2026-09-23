# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Network-free unit tests for the hierarchical manager's tool isolation.

The CRM Manager prompt declares a strict tool split -- Deal Desk owns deals,
Accounts & Identity owns search, Activity & Comms owns notes -- and states the
manager itself holds no CRM tools. A pipeline trace showed the opposite: the
manager's own system prompt listed every ``tool_pipedrive_*`` tool and it called
Pipedrive directly rather than delegating.

That is not a wiring mistake. It is CrewAI, in three steps:

1. ``crewai/task.py`` ``check_tools`` is an ``@model_validator(mode='after')``
   that copies ``self.agent.tools`` into ``self.tools`` whenever ``self.tools``
   is falsy. Every Task we build with ``agent=<delegate>`` therefore acquires
   that delegate's toolset, even though we never pass ``tools=``.
2. ``crewai/crews/utils.py`` resolves the toolset for a task as
   ``task.tools or agent_to_use.tools or []``.
3. ``crewai/crew.py`` ``Crew._get_agent_to_use`` returns ``self.manager_agent``
   for ``Process.hierarchical``.

Composed: the manager executes each task carrying the *delegate's* tools.

The fix in ``crewai_manager/manager.py`` overwrites ``task_obj.tools`` after the
Task is constructed. It cannot be done by passing ``tools=[]``, because
``check_tools`` runs after ``__init__`` and reads the empty list as "unset".

That same assignment carries the manager's OWN ``tool`` channel, because a fourth
rule closes the obvious alternative:

4. ``crewai/crew.py`` ``Crew._create_manager_agent`` -- reached from
   ``akickoff() -> _arun_hierarchical_process()`` -- rejects a supplied
   ``manager_agent`` that carries tools, raising
   ``Exception("Manager agent should not have tools")``. Only the wired case
   trips it, which is how it reached ``develop``.

Reproduced against both bounds of the ``crewai>=1.14.1,<2`` pin: 1.14.1
(crew.py:1352) and 1.15.21 (crew.py:1532).

SCOPE: these tests do not import the real crewai. The built bundle at
``dist/server/lib/site-packages`` pulls ``pywin32``, which is absent from the
test environment, so an end-to-end assertion is not available here. What follows
pins (a) the resolution semantics above, against doubles that mirror
``check_tools``, ``_create_manager_agent`` and ``_prepare_tools``, and (b) that
the manager source still performs the overwrite and still builds the manager
Agent without tools. Line references are given so a CrewAI upgrade can be
re-verified by hand against the vendored source.
"""

from __future__ import annotations

from pathlib import Path

import pytest

_MANAGER_SRC = (
    Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'agent_crewai' / 'crewai_manager' / 'manager.py'
).read_text(encoding='utf-8')


# ---------------------------------------------------------------------------
# A faithful double of the CrewAI seams described above
# ---------------------------------------------------------------------------


class _Agent:
    def __init__(self, role: str, tools: list[str] | None = None):
        self.role = role
        self.tools = list(tools or [])


class _Task:
    """Mirrors crewai.Task's tool back-fill.

    ``check_tools`` is an after-validator, so it runs on construction only --
    crewai.Task declares ``model_config = {'arbitrary_types_allowed': True}`` with
    no ``validate_assignment``, which is why a later assignment is not revalidated.
    """

    def __init__(self, description: str, agent: _Agent, tools: list[str] | None = None):
        self.description = description
        self.agent = agent
        self.tools = list(tools or [])
        # crewai/task.py check_tools
        if not self.tools and self.agent and self.agent.tools:
            self.tools = self.agent.tools


def _resolve_executor_tools(task: _Task, manager: _Agent) -> list[str]:
    """crewai/crews/utils.py, for a hierarchical crew.

    ``_get_agent_to_use`` returns the manager, so ``agent_to_use`` below is the
    manager and never the delegate.
    """
    agent_to_use = manager
    return task.tools or agent_to_use.tools or []


class _Crew:
    """Mirrors the two crewai.Crew seams a hierarchical kickoff runs through.

    Identical in 1.14.1 and 1.15.21, the bounds of the ``crewai>=1.14.1,<2`` pin.
    """

    def __init__(self, agents: list[_Agent], tasks: list[_Task], manager_agent: _Agent):
        self.agents = list(agents)
        self.tasks = list(tasks)
        self.manager_agent = manager_agent

    def create_manager_agent(self) -> None:
        """crewai/crew.py ``_create_manager_agent``, supplied-manager branch.

        The real one clears the list and then raises, so clearing is not a fallback.
        """
        self.manager_agent.allow_delegation = True
        manager = self.manager_agent
        if manager.tools is not None and len(manager.tools) > 0:
            manager.tools = []
            raise ValueError('Manager agent should not have tools')

    def prepare_tools(self, task: _Task) -> list[str]:
        """crewai/crew.py ``_prepare_tools`` -> ``_update_manager_tools`` -> ``_merge_tools``.

        ``_merge_tools`` drops name collisions, then appends -- existing tools survive.
        """
        tools = _resolve_executor_tools(task, self.manager_agent)
        delegation = [f'delegate_to_{task.agent.role}']
        return [t for t in tools if t not in delegation] + delegation


# ---------------------------------------------------------------------------
# The mechanism
# ---------------------------------------------------------------------------


class TestCrewAIToolBackfill:
    """Why the bug happens, and why the obvious fix does not work."""

    def test_task_inherits_its_agents_tools(self):
        delegate = _Agent('Deal Desk', ['deal_search', 'deal_create'])
        task = _Task('work the deal', agent=delegate)
        assert task.tools == ['deal_search', 'deal_create']

    def test_constructor_tools_empty_list_does_not_survive(self):
        """The reason the fix is a post-construction assignment, not a kwarg."""
        delegate = _Agent('Deal Desk', ['deal_search'])
        task = _Task('work the deal', agent=delegate, tools=[])
        assert task.tools == ['deal_search'], 'an empty list reads as "unset" to check_tools'

    def test_manager_inherits_the_delegates_tools_when_task_is_untouched(self):
        """The observed failure: the manager can work the tools instead of delegating."""
        delegate = _Agent('Deal Desk', ['deal_search'])
        manager = _Agent('Manager', [])
        task = _Task('work the deal', agent=delegate)
        assert _resolve_executor_tools(task, manager) == ['deal_search']

    def test_clearing_task_tools_isolates_the_manager(self):
        delegate = _Agent('Deal Desk', ['deal_search'])
        manager = _Agent('Manager', [])
        task = _Task('work the deal', agent=delegate)

        task.tools = []  # what manager.py does when the manager's `tool` port is empty

        assert _resolve_executor_tools(task, manager) == []

    def test_clearing_the_task_leaves_the_delegate_armed(self):
        """Delegation must still work: agent_tools builds a fresh Task per handoff."""
        delegate = _Agent('Deal Desk', ['deal_search'])
        task = _Task('work the deal', agent=delegate)
        task.tools = []

        assert delegate.tools == ['deal_search']
        # crewai/tools/agent_tools/base_agent_tools.py constructs a new Task bound
        # to the coworker, which back-fills from that agent's own tools.
        handoff = _Task('sub-request', agent=delegate)
        assert handoff.tools == ['deal_search']

    def test_a_wired_manager_tool_reaches_the_resolved_executor_set(self):
        """The manager's own `tool` channel must land on the tools the engine
        resolves for it, or the port is connectable but never actually usable.

        The channel rides on the TASK, not on the manager Agent -- see
        TestManagerAgentMustNotCarryTools for why the Agent cannot hold it.
        """
        delegate = _Agent('Deal Desk', ['deal_search'])
        manager = _Agent('Manager', [])  # manager.py builds it with no tools
        task = _Task('work the deal', agent=delegate)
        task.tools = ['dedup_lookup']  # what manager.py assigns: list(manager_tools)

        assert _resolve_executor_tools(task, manager) == ['dedup_lookup']

    def test_the_delegates_tools_lose_to_the_managers_channel(self):
        """Overwriting the task both blocks the delegate's tools and delivers the
        manager's own -- the two halves are the same assignment.
        """
        delegate = _Agent('Deal Desk', ['deal_search'])
        manager = _Agent('Manager', [])
        task = _Task('work the deal', agent=delegate)
        assert task.tools == ['deal_search'], 'check_tools back-filled the delegate'

        task.tools = ['dedup_lookup']  # what manager.py assigns

        assert _resolve_executor_tools(task, manager) == ['dedup_lookup']
        assert 'deal_search' not in _resolve_executor_tools(task, manager)


class TestManagerAgentMustNotCarryTools:
    """CrewAI rejects a supplied ``manager_agent`` that carries tools.

    This is the seam the first `tool` port attempt missed: it passed the channel
    to ``Agent(tools=...)``, which every hierarchical kickoff rejects. The empty
    case is accepted, which is why nothing caught it -- no test wired the port,
    so ``manager_tools`` was always ``[]`` and the check never fired.
    """

    def test_crew_rejects_a_manager_agent_that_carries_tools(self):
        """Tools on the manager Agent end the run before any LLM call."""
        delegate = _Agent('Deal Desk', ['deal_search'])
        manager = _Agent('Manager', ['dedup_lookup'])
        task = _Task('work the deal', agent=delegate)
        crew = _Crew([delegate], [task], manager_agent=manager)

        with pytest.raises(ValueError, match='should not have tools'):
            crew.create_manager_agent()

    def test_an_unwired_port_is_accepted(self):
        """Why the defect was invisible: nothing wired means nothing to reject."""
        delegate = _Agent('Deal Desk', ['deal_search'])
        manager = _Agent('Manager', [])
        task = _Task('work the deal', agent=delegate)
        crew = _Crew([delegate], [task], manager_agent=manager)

        crew.create_manager_agent()

        assert manager.tools == []

    def test_channel_tools_on_the_task_are_accepted_and_still_reach_the_manager(self):
        """The fix: the tools ride on the task, so the Agent stays empty."""
        delegate = _Agent('Deal Desk', ['deal_search'])
        manager = _Agent('Manager', [])
        task = _Task('work the deal', agent=delegate)
        task.tools = ['dedup_lookup']  # list(manager_tools)
        crew = _Crew([delegate], [task], manager_agent=manager)

        crew.create_manager_agent()

        assert _resolve_executor_tools(task, manager) == ['dedup_lookup']

    def test_delegation_survives_the_manager_holding_its_own_tools(self):
        """``_merge_tools`` adds the delegation tools, it does not replace them."""
        delegate = _Agent('Deal Desk', ['deal_search'])
        manager = _Agent('Manager', [])
        task = _Task('work the deal', agent=delegate)
        task.tools = ['dedup_lookup']
        crew = _Crew([delegate], [task], manager_agent=manager)
        crew.create_manager_agent()

        assert crew.prepare_tools(task) == ['dedup_lookup', 'delegate_to_Deal Desk']

    def test_delegation_still_works_with_an_unwired_port(self):
        """The no-tools path must keep its delegation tool too."""
        delegate = _Agent('Deal Desk', ['deal_search'])
        manager = _Agent('Manager', [])
        task = _Task('work the deal', agent=delegate)
        task.tools = []
        crew = _Crew([delegate], [task], manager_agent=manager)
        crew.create_manager_agent()

        assert crew.prepare_tools(task) == ['delegate_to_Deal Desk']


# ---------------------------------------------------------------------------
# Our side of the contract
# ---------------------------------------------------------------------------


class TestManagerSourceOverwritesTaskTools:
    """A source guard: the overwrite is a one-liner that is easy to drop in a refactor.

    The construction loop lives inline in ``CrewManager.run_agent`` and needs the
    engine's invoke seams to execute, so this asserts on the source rather than on
    behaviour. If that loop is ever extracted into a helper, replace this with a
    real call.
    """

    def test_task_tools_are_overwritten_with_the_managers_channel(self):
        """A copy per task, so no two tasks share one mutable toolset."""
        assert 'task_obj.tools = list(manager_tools)' in _MANAGER_SRC

    def test_the_reason_is_recorded_next_to_it(self):
        """Without the why, the next reader deletes it as dead code."""
        assert 'check_tools' in _MANAGER_SRC
        assert '_get_agent_to_use' in _MANAGER_SRC

    def test_the_manager_agent_is_built_without_tools(self):
        """The regression guard for this fix.

        ``Crew._create_manager_agent`` raises on a supplied manager_agent that
        carries tools, so a ``tools=`` kwarg here breaks every run that wires the
        port. ``TestManagerAgentMustNotCarryTools`` pins the CrewAI side; this
        pins ours.
        """
        start = _MANAGER_SRC.index('manager_agent = Agent(')
        block = _MANAGER_SRC[start : _MANAGER_SRC.index(')', _MANAGER_SRC.index('max_iter', start))]
        assert 'tools=' not in block, 'manager_agent must be built with no tools'

    def test_the_channel_is_sourced_from_the_managers_own_context(self):
        """Bound to the exact assignment (not a bare 'context.tools.list' substring
        search, which would also match sub_context.tools.list -- the delegates' own
        channel) so the test fails if manager_tools is ever rebound to the wrong
        source.
        """
        assert 'manager_tools = self._build_crew_tools(context, context.tools.list)' in _MANAGER_SRC

    def test_the_rejection_is_recorded_where_the_agent_is_built(self):
        """The next person to add `tools=` needs to find the reason at the call site."""
        assert '_create_manager_agent' in _MANAGER_SRC
        assert 'should not have tools' in _MANAGER_SRC


@pytest.mark.parametrize('needle', ['crewai/task.py', 'crews/utils.py', 'agent_tools', 'crewai/crew.py'])
def test_manager_cites_the_crewai_seams_it_depends_on(needle):
    """These are private CrewAI internals; an upgrade must be re-verified against them."""
    assert needle in _MANAGER_SRC
