# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
Tool grouping for the GoHighLevel node.

This node implements 101 tools, which is far more than an LLM can choose between
reliably. Every tool is therefore tagged with a resource group, and the node only
publishes the groups named in the ``gohighlevel.toolGroups`` config field. Tools that
change state are tagged too, and are dropped from the published set when the node is
in read-only mode. Both filters happen in ``IInstance._collect_tool_methods()``, so a
tool that is not published is invisible to ``tool.query`` and rejected by
``tool.invoke`` alike.

This module is the single source of truth for the group names. ``services.json`` does
not repeat the default set: its ``toolGroups`` default is empty, which ``normalize_groups``
resolves to ``DEFAULT_GROUPS`` here.
"""

from __future__ import annotations

from typing import Callable

from rocketlib import tool_function

#: Every group this node implements.
ALL_GROUPS = frozenset(
    {
        'appointment_notes',
        'appointments',
        'businesses',
        'calendar_groups',
        'calendars',
        'contact_notes',
        'contact_tasks',
        'contacts',
        'conversations',
        'custom_fields',
        'custom_values',
        'location_tags',
        'locations',
        'message_sending',
        'messages',
        'opportunities',
        'pipelines',
        'users',
    }
)

#: Published when the operator has not chosen otherwise: the set an agent needs to
#: run lead nurture and appointment booking end to end, at 71 of the 101 tools.
#: ``users`` is in here despite being administrative because it is 3 read-only tools
#: and it is the only way to resolve the user ids that ``assignedTo``, ``followers``
#: and ``assignedUserId`` need across contacts, opportunities, tasks and appointments.
#: ``message_sending`` is deliberately absent: ``message_send`` and the two
#: schedule-cancels are the only tools whose write path has never been exercised
#: against the live API (a trial sub-account has no phone or email provider), and a
#: bad send is a real SMS or email from an unattended pipeline, which cannot be
#: recalled. Reading messages stays default; originating them is an explicit opt-in.
DEFAULT_GROUPS = frozenset(
    {
        'appointments',
        'calendars',
        'contact_notes',
        'contact_tasks',
        'contacts',
        'conversations',
        'custom_fields',
        'messages',
        'opportunities',
        'pipelines',
        'users',
    }
)

#: The generic escape-hatch tool, gated by ``gohighlevel.allowRawRequest`` instead
#: of by a tool group.
RAW_REQUEST_TOOL = 'request'


def group_names(raw) -> list[str]:
    """The non-empty names in a configured ``toolGroups`` value, as the operator typed them.

    Accepts a list or a comma-separated string; anything else yields no names. This is
    the shared front end of ``normalize_groups`` and ``unknown_groups`` so the runtime
    selection and the editor warning can never disagree about what was configured.
    """
    if isinstance(raw, str):
        raw = raw.split(',')
    if not isinstance(raw, (list, tuple, set, frozenset)):
        return []
    return [str(g).strip() for g in raw if str(g).strip()]


def normalize_groups(raw) -> frozenset:
    """Turn the configured ``toolGroups`` value into a set of known group names.

    Matching is case-insensitive and ``all`` means every implemented group. An empty or
    missing value falls back to the defaults; that is "not configured", and the default
    set is the documented meaning of leaving the field alone.

    A configured value that matches nothing is different: it raises. Falling back to the
    defaults there would turn one misspelled group name into 71 published tools, most of
    them write-capable, which widens exposure past what the operator asked for.
    ``beginGlobal`` already refuses to start on a missing token or location id, so a
    config that selects nothing fails the same way, loudly and at startup. A partially
    unknown value narrows to the names that matched; ``IGlobal`` reports the dropped
    names as a runtime warning, and ``validateConfig`` warns about them in the editor.

    Raises:
        ValueError: If ``raw`` names at least one group but none of the names is a
            group this node implements.
    """
    names = {name.lower() for name in group_names(raw)}
    if not names:
        return DEFAULT_GROUPS
    if 'all' in names or '*' in names:
        return ALL_GROUPS
    selected = names & ALL_GROUPS
    if not selected:
        raise ValueError(
            'gohighlevel.toolGroups matched no known tool group: '
            f'{", ".join(sorted(names))}. Valid groups: {", ".join(sorted(ALL_GROUPS))}, '
            'or "all". Leave the field empty for the default set.'
        )
    return frozenset(selected)


def unknown_groups(raw) -> list[str]:
    """Configured group names this node does not implement.

    Matches exactly what ``normalize_groups`` accepts, so a name that works at runtime
    is never reported as unknown in the editor, and a typo in the comma-separated string
    form is caught rather than skipped. Names come back as the operator typed them.
    """
    known = ALL_GROUPS | {'all', '*'}
    return sorted({name for name in group_names(raw) if name.lower() not in known})


def gohighlevel_tool(
    *, group: str, writes: bool = False, input_schema=None, description=None, output_schema=None
) -> Callable:
    """``@tool_function`` plus the resource group the tool belongs to.

    The group is stamped on the function so ``IInstance._collect_tool_methods()``
    can filter the published tool list without a separate registry to keep in sync.
    An unknown group name raises here, at import time, so a typo is a module-load
    failure rather than a tool that silently never reaches the agent.

    ``writes=True`` marks a tool that creates, updates or deletes something. It is
    stamped as ``__gohighlevel_writes__`` and read by the same filter, which drops
    write tools from the published set when ``gohighlevel.readOnly`` is on. That is a
    deliberate deviation from tool_pipedrive, which publishes its write tools in
    read-only mode and refuses them at ``tool.invoke``: an agent cannot know in advance
    that a published tool is blocked, so it spends a turn discovering it, and roughly
    40 tools it can only ever fail on are 40 tools' worth of wasted context. Hiding
    beats refusing. ``GoHighLevelToolsBase._require_write`` still guards invoke, both
    as defence in depth and because the raw ``request`` tool carries no group at all.
    """
    if group not in ALL_GROUPS:
        raise ValueError(f'gohighlevel_tool: unknown group "{group}"')

    def decorator(fn: Callable) -> Callable:
        fn = tool_function(input_schema=input_schema, description=description, output_schema=output_schema)(fn)
        fn.__gohighlevel_group__ = group
        fn.__gohighlevel_writes__ = bool(writes)
        return fn

    return decorator
