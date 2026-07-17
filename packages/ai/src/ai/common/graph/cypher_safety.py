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

"""Cypher safety checks shared by every graph database node.

Mirrors ``ai.common.database.sql_safety`` for the graph side.

This is a client-side guard, not the primary defence. A driver whose engine can
refuse writes server-side should rely on that instead and use this only as
defence-in-depth: a regex cannot be made airtight against every Cypher dialect.
The implemented example is FalkorDB, whose ``GRAPH.RO_QUERY`` rejects writes at
the server; a future Neo4j driver on this base should open sessions in READ
access mode for the same guarantee.
"""

from __future__ import annotations

import re

_UNSAFE_CYPHER = re.compile(
    r'\b(?:CREATE|MERGE|DELETE|DETACH\s+DELETE|SET|REMOVE|DROP|FOREACH|LOAD\s+CSV|'
    r'CALL\s+apoc\.(?:create|merge|delete|periodic\.commit|refactor|load))\b',
    re.IGNORECASE,
)


def is_cypher_safe(cypher: str) -> bool:
    """Return True when the Cypher statement is read-only (MATCH/RETURN/schema CALLs).

    Args:
        cypher (str): The Cypher statement to inspect.

    Returns:
        bool: ``True`` if the statement contains no write or admin clauses.
    """
    # Strip line and block comments so a commented-out DELETE can't hide a live one.
    stripped = re.sub(r'//[^\n]*', '', cypher)
    stripped = re.sub(r'/\*.*?\*/', '', stripped, flags=re.DOTALL)
    return not bool(_UNSAFE_CYPHER.search(stripped))
