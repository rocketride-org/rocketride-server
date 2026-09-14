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
Tool grouping for the Tenki Sandbox node.

The node's full surface is 22 tools, more than an LLM chooses between reliably, and
several of them reach past the disposable VM: public URLs, workspace storage, billed
snapshots and raw sockets. Every tool is therefore tagged with a group, and the node
only publishes the groups named in the ``tenki.toolGroups`` config field. The filter
lives in ``IInstance._collect_tool_methods()``, so a tool that is not published is
invisible to ``tool.query`` and rejected by ``tool.invoke`` alike.

This module is the single source of truth for the group names. ``services.json`` lists
them for the editor but does not repeat the default set: its ``toolGroups`` default is
empty, which ``normalize_groups`` resolves to ``DEFAULT_GROUPS`` here.
"""

from __future__ import annotations

from typing import Callable

from rocketlib import tool_function

#: Every group this node implements.
ALL_GROUPS = frozenset({'execution', 'filesystem', 'git', 'ports', 'volumes', 'snapshots', 'remote_access'})

#: Published when the operator has not chosen otherwise: running code and commands,
#: editing files and working in a repository, all confined to the session's own VM. The
#: other groups are deliberate opt-ins. ``ports`` publishes a service at a public URL,
#: ``volumes`` attaches workspace storage that other sessions share and that outlives this
#: one, ``snapshots`` creates billed storage that also outlives it, and ``remote_access``
#: exchanges raw bytes with processes inside the VM instead of returning structured results.
DEFAULT_GROUPS = frozenset({'execution', 'filesystem', 'git'})


def group_names(raw) -> list[str]:
    """The non-empty names in a configured ``toolGroups`` value, as the operator typed them.

    Accepts a list or a comma-separated string; anything else yields no names. This is the
    shared front end of ``normalize_groups`` and ``unknown_groups``, so the runtime selection
    and the editor warning can never disagree about what was configured.
    """
    if isinstance(raw, str):
        raw = raw.split(',')
    if not isinstance(raw, (list, tuple, set, frozenset)):
        return []
    return [str(g).strip() for g in raw if str(g).strip()]


def normalize_groups(raw) -> frozenset:
    """Turn the configured ``toolGroups`` value into the set of groups to publish.

    Matching is case-insensitive, and ``all`` (or ``*``) means every group. An empty or
    missing value means "not configured" and resolves to ``DEFAULT_GROUPS``. A value that
    names groups but matches none of them raises instead: falling back to the defaults would
    turn a typo into a wider tool set than the operator asked for. A partially unknown value
    narrows to the names that matched.

    Raises:
        ValueError: If ``raw`` names at least one group but none of them is a group this
            node implements.
    """
    names = {name.lower() for name in group_names(raw)}
    if not names:
        return DEFAULT_GROUPS
    if 'all' in names or '*' in names:
        return ALL_GROUPS
    selected = names & ALL_GROUPS
    if not selected:
        raise ValueError(
            'tenki.toolGroups matched no known tool group: '
            f'{", ".join(sorted(names))}. Valid groups: {", ".join(sorted(ALL_GROUPS))}, '
            'or "all". Leave the field empty for the default set.'
        )
    return frozenset(selected)


def unknown_groups(raw) -> list[str]:
    """Configured group names this node does not implement, as the operator typed them.

    Matches exactly what ``normalize_groups`` accepts, so a name that works at runtime is
    never reported as unknown in the editor.
    """
    known = ALL_GROUPS | {'all', '*'}
    return sorted({name for name in group_names(raw) if name.lower() not in known})


def tenki_tool(*, group: str, input_schema=None, description=None, output_schema=None) -> Callable:
    """``@tool_function`` plus the group the tool belongs to.

    The group is stamped on the function so ``IInstance._collect_tool_methods()`` can filter
    the published tools without a separate registry to keep in sync. An unknown group name
    raises here, at import time, so a typo fails loudly instead of leaving a tool that never
    reaches the agent.
    """
    if group not in ALL_GROUPS:
        raise ValueError(f'tenki_tool: unknown group "{group}"')

    def decorator(fn: Callable) -> Callable:
        fn = tool_function(input_schema=input_schema, description=description, output_schema=output_schema)(fn)
        fn.__tenki_group__ = group
        return fn

    return decorator
