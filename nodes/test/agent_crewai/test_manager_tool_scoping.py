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

The fix in ``crewai_manager/manager.py`` clears ``task_obj.tools`` after the Task
is constructed. It cannot be done by passing ``tools=[]``, because ``check_tools``
runs after ``__init__`` and reads the empty list as "unset".

SCOPE: these tests do not import the real crewai. The built bundle at
``dist/server/lib/site-packages`` pulls ``pywin32``, which is absent from the
test environment, so an end-to-end assertion is not available here. What follows
pins (a) the resolution semantics above, against a double that mirrors
``check_tools`` exactly, and (b) that the manager source still performs the
clearing. Line references are given so a CrewAI upgrade can be re-verified by
hand against the vendored source.
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

        task.tools = []  # what manager.py does

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
        """The manager's own `tool` channel must actually land on the tools the
        engine resolves for it -- not just on manager_agent.tools in isolation.

        A wired channel tool (e.g. a dedup/lookup check) has to survive the same
        `task.tools or agent_to_use.tools` resolution the isolation tests above
        pin, or it is connectable but never actually usable.
        """
        delegate = _Agent('Deal Desk', ['deal_search'])
        manager = _Agent('Manager', ['dedup_lookup'])  # manager's own `tool` channel, wired
        task = _Task('work the deal', agent=delegate)
        task.tools = []  # what manager.py does

        assert _resolve_executor_tools(task, manager) == ['dedup_lookup']


# ---------------------------------------------------------------------------
# Our side of the contract
# ---------------------------------------------------------------------------


class TestManagerSourceClearsTaskTools:
    """A source guard: the clearing is a one-liner that is easy to drop in a refactor.

    The construction loop lives inline in ``CrewManager.run_agent`` and needs the
    engine's invoke seams to execute, so this asserts on the source rather than on
    behaviour. If that loop is ever extracted into a helper, replace this with a
    real call.
    """

    def test_task_tools_are_cleared(self):
        assert 'task_obj.tools = []' in _MANAGER_SRC

    def test_the_reason_is_recorded_next_to_it(self):
        """Without the why, the next reader deletes it as dead code."""
        assert 'check_tools' in _MANAGER_SRC
        assert '_get_agent_to_use' in _MANAGER_SRC

    def test_manager_agent_carries_only_its_own_channel_tools(self):
        """The manager MAY hold tools now, but only from its own `tool` channel.

        `context.tools` here is the manager node's own control-plane channel
        (wired via the `tool` invoke port), never a delegate's. Delegate tools
        still only reach a Task through `check_tools`, which `task_obj.tools = []`
        (asserted by `test_task_tools_are_cleared` above) continues to block.
        """
        start = _MANAGER_SRC.index('manager_agent = Agent(')
        block = _MANAGER_SRC[start : _MANAGER_SRC.index(')', _MANAGER_SRC.index('max_iter', start))]
        assert 'tools=manager_tools' in block
        # Bound to the exact assignment (not a bare 'context.tools.list' substring
        # search, which would also match sub_context.tools.list -- the delegates'
        # own channel a few lines up) so the test fails if manager_tools is ever
        # rebound to the wrong source.
        assert 'manager_tools = self._build_crew_tools(context, context.tools.list)' in _MANAGER_SRC


@pytest.mark.parametrize('needle', ['crewai/task.py', 'crews/utils.py', 'agent_tools'])
def test_manager_cites_the_crewai_seams_it_depends_on(needle):
    """These are private CrewAI internals; an upgrade must be re-verified against them."""
    assert needle in _MANAGER_SRC
