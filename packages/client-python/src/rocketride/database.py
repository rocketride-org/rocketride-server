# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
Database API namespace for the RocketRide Python SDK.

Exposes ``client.database.query(...)`` for issuing raw SQL or Cypher directly
against a database pipeline node via the ``execute`` tool function, bypassing
the LLM translation layer that the default ``client.chat(...)`` flow uses.

Usage:
    result = await client.database.query(token=t, sql='SELECT 1 AS one')
"""

from __future__ import annotations

from enum import Enum
from typing import TYPE_CHECKING, Any, Dict

if TYPE_CHECKING:
    from .client import RocketRideClient


class DatabaseDialect(str, Enum):
    """
    Underlying database engine a pipeline is connected to.

    Returned by ``client.database.dialect(...)`` so applications can branch on
    dialect-specific behavior (e.g. SQL syntax differences, type coercion) and
    detect when they're talking to a graph DB instead of a relational one.
    """

    POSTGRES = 'postgres'
    MYSQL = 'mysql'
    NEO4J = 'neo4j'


class DatabaseApi:
    """
    Direct database-query namespace on RocketRideClient.

    Accessed via ``client.database`` -- not instantiated directly. Statements
    submitted through this namespace bypass the LLM translation layer and
    safety checks, so the caller is responsible for the SQL/Cypher they pass.
    """

    def __init__(self, client: 'RocketRideClient') -> None:
        self._client = client

    async def query(
        self,
        *,
        token: str,
        sql: str,
        node_id: str = '',
    ) -> Dict[str, Any]:
        """
        Execute a raw SQL or Cypher statement against a database pipeline node.

        Invokes the ``execute`` tool function on the target database node,
        bypassing LLM translation and SQL safety checks.

        Args:
            token: Pipeline token for authentication and resource access.
            sql: Raw SQL or Cypher statement to execute.
            node_id: Target database node ID.  When empty the call broadcasts
                to all tool-lane nodes; the first database node handles it.

        Returns:
            Dict with ``rows`` (list of row dicts) and ``affected_rows`` (int).

        Raises:
            ValueError: If ``token`` or ``sql`` is empty or whitespace-only.
            RuntimeError: If the server signals failure.
        """
        if not isinstance(token, str) or not token.strip():
            raise ValueError('token must be a non-empty string')
        if not isinstance(sql, str) or not sql.strip():
            raise ValueError('sql must be a non-empty string')

        return await self._client.tool(
            token=token,
            tool='execute',
            node_id=node_id,
            input={'sql': sql},
        )

    async def dialect(self, *, token: str, node_id: str = '') -> DatabaseDialect:
        """
        Discover the underlying database engine for a pipeline node.

        Invokes the ``dialect`` tool function on the target database node.

        Args:
            token: Pipeline token for authentication and resource access.
            node_id: Target database node ID.  When empty the call broadcasts
                to all tool-lane nodes; the first database node handles it.

        Returns:
            DatabaseDialect: The dialect reported by the node.

        Raises:
            ValueError: If ``token`` is empty/whitespace or the response is not
                a recognized dialect.
            RuntimeError: If the server signals failure.
        """
        if not isinstance(token, str) or not token.strip():
            raise ValueError('token must be a non-empty string')

        result = await self._client.tool(
            token=token,
            tool='dialect',
            node_id=node_id,
        )

        dialect_str = result.get('dialect') if isinstance(result, dict) else None
        if not dialect_str:
            raise ValueError('Pipeline returned no dialect; is the endpoint a database node?')

        return DatabaseDialect(dialect_str)
