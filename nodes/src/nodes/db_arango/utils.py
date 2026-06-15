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

"""Shared utilities for the ArangoDB database node."""

from __future__ import annotations

import re

# ---------------------------------------------------------------------------
# AQL safety check — read-only queries only
# ---------------------------------------------------------------------------

# The five AQL data-modification keywords. An AQL query is a write query if and
# only if it uses one of these (the parser rejects more than one per query), so
# blocking them as standalone keywords is a sound read-only gate. The plan-based
# check in IGlobal (modification node types) is the primary, more precise gate;
# this regex is the defence-in-depth layer that also runs at execution time.
_UNSAFE_AQL = re.compile(
    r'\b(?:INSERT|UPDATE|REPLACE|REMOVE|UPSERT)\b',
    re.IGNORECASE,
)


def _parse_is_valid(value: object) -> bool:
    """Normalise an ``isValid`` value from LLM JSON output to a Python bool.

    Args:
        value (object): Raw value from the LLM response dict — may be a
            ``bool`` (``True``/``False``) or a ``str`` (``'true'``/``'false'``).

    Returns:
        bool: ``True`` only when the value is the boolean ``True`` or the
            case-insensitive string ``'true'``.
    """
    if isinstance(value, bool):
        return value
    return str(value).lower() == 'true'


def _is_aql_safe(aql: str) -> bool:
    """Return True when the AQL statement is read-only (no data modification).

    String literals and comments are stripped before checking, so a keyword inside
    a string/comment neither triggers a false rejection nor (via a ``//`` inside a
    string, e.g. a URL) hides a real trailing write keyword from the scan.

    Args:
        aql (str): The AQL statement to inspect.

    Returns:
        bool: ``True`` if the statement contains no INSERT/UPDATE/REPLACE/REMOVE/
            UPSERT clause, ``False`` otherwise.
    """
    # Strip string literals FIRST (handling \" / \' escapes), so a // or a DML
    # keyword inside a string can't fool the gate — a // in a string would
    # otherwise swallow a trailing write keyword and hide it.
    stripped = re.sub(r'"(?:[^"\\]|\\.)*"', '', aql)
    stripped = re.sub(r"'(?:[^'\\]|\\.)*'", '', stripped)
    # Then strip single-line (//) and block (/* */) comments.
    stripped = re.sub(r'//[^\n]*', '', stripped)
    stripped = re.sub(r'/\*.*?\*/', '', stripped, flags=re.DOTALL)
    return not bool(_UNSAFE_AQL.search(stripped))


# ---------------------------------------------------------------------------
# EXPLAIN-plan read-only gate (primary) — inspects the execution plan
# ---------------------------------------------------------------------------

# An AQL execution plan node of one of these types means the query writes data.
# Checking the plan is the PRIMARY read-only gate: it is precise (it never
# false-positives on a DML keyword that appears only inside a string literal or
# attribute name, which the keyword regex can) and it is semantic rather than
# textual, so it still holds if a write is expressed in a way the regex misses.
_MODIFICATION_NODE_TYPES = frozenset({'InsertNode', 'UpdateNode', 'ReplaceNode', 'RemoveNode', 'UpsertNode'})


def _plan_nodes(plan: object) -> list:
    """Extract the list of execution-plan node dicts from an ``explain()`` result.

    python-arango's ``explain`` returns the optimal plan as a dict (``all_plans``
    False) or a list of plans, and different server/driver versions nest the node
    list slightly differently — handle the common shapes defensively.
    """
    if isinstance(plan, dict):
        nodes = plan.get('nodes')
        if isinstance(nodes, list):
            return nodes
        inner = plan.get('plan')
        if isinstance(inner, dict) and isinstance(inner.get('nodes'), list):
            return inner['nodes']
        plans = plan.get('plans')
        if isinstance(plans, list):
            collected: list = []
            for entry in plans:
                collected.extend(_plan_nodes(entry))
            return collected
    elif isinstance(plan, list):
        collected = []
        for entry in plan:
            collected.extend(_plan_nodes(entry))
        return collected
    return []


def _plan_is_modification(plan: object) -> bool:
    """Return True when an ``explain()`` plan contains any data-modification node."""
    return any(isinstance(node, dict) and node.get('type') in _MODIFICATION_NODE_TYPES for node in _plan_nodes(plan))


def _strip_ns(tool_name: str) -> str:
    """Strip the ``'arango.'`` namespace prefix from a tool name.

    Args:
        tool_name (str): Fully-qualified tool name (e.g. ``'arango.get_data'``).

    Returns:
        str: Bare tool name without the namespace prefix.
    """
    prefix = 'arango.'
    return tool_name[len(prefix) :] if tool_name.startswith(prefix) else tool_name
