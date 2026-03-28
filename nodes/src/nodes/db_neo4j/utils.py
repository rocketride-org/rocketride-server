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

"""Shared utilities for the Neo4J database node."""

from __future__ import annotations

import re


# ---------------------------------------------------------------------------
# Cypher safety check — read-only queries only
# ---------------------------------------------------------------------------

_UNSAFE_CYPHER = re.compile(
    r'\b(?:CREATE|MERGE|DELETE|DETACH\s+DELETE|SET|REMOVE|DROP|FOREACH|LOAD\s+CSV|'
    r'CALL\s+apoc\.(?:create|merge|delete|periodic\.commit|refactor|load))\b',
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


def _is_cypher_safe(cypher: str) -> bool:
    """Return True when the Cypher statement is read-only (MATCH/RETURN/CALL schema only).

    Args:
        cypher (str): The Cypher statement to inspect.

    Returns:
        bool: ``True`` if the statement contains no write or admin clauses,
            ``False`` otherwise.
    """
    # Strip both single-line and block comments before checking.
    stripped = re.sub(r'//[^\n]*', '', cypher)
    stripped = re.sub(r'/\*.*?\*/', '', stripped, flags=re.DOTALL)
    return not bool(_UNSAFE_CYPHER.search(stripped))


def _strip_ns(tool_name: str) -> str:
    """Strip the ``'neo4j.'`` namespace prefix from a tool name.

    Args:
        tool_name (str): Fully-qualified tool name (e.g. ``'neo4j.get_data'``).

    Returns:
        str: Bare tool name without the namespace prefix.
    """
    prefix = 'neo4j.'
    return tool_name[len(prefix) :] if tool_name.startswith(prefix) else tool_name
